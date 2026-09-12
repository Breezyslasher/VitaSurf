/*
 * QuickJS JavaScript engine for NetSurf, hand-written DOM bindings.
 *
 * This implements the engine-facing interface in
 * deps/netsurf/content/handlers/javascript/js.h with quickjs-ng instead
 * of Duktape. It is an alternative engine for phase 6: the build selects
 * one or the other with VITASURF_JS_ENGINE, and both are kept so their
 * memory use and page-load time can be compared (see the log lines the
 * input layer writes).
 *
 * The binding surface is the part of the DOM that ordinary pages use:
 * window (timers, location, navigator, console), document (lookups,
 * creation, body, title, cookie), a generic node/element wrapper
 * (properties, attributes, innerHTML, tree edits, form values,
 * addEventListener), and events. It is not the whole DOM that nsgenbind
 * produces for Duktape; unknown properties simply read as undefined.
 *
 * This file is compiled and linked by CMake, not built into libnetsurf.a,
 * so it provides the js_* symbols the NetSurf core leaves undefined when
 * built with the quickjs engine branch (patch 0011).
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <ctype.h>
#include <string.h>
#include <strings.h>

#include <quickjs.h>

#include "utils/errors.h"
#include "utils/nsurl.h"
#include "utils/corestrings.h"
#include "netsurf/browser_window.h"
#include "netsurf/misc.h"
#include "netsurf/mouse.h"
#include "netsurf/window.h"
#include "content/urldb.h"
#include "content/fetch.h"
#include "content/handlers/javascript/js.h"
#include "content/handlers/javascript/content.h"

#include <dom/dom.h>
#include <dom/bindings/hubbub/parser.h>
#include <nsutils/time.h>

#include "utils/useragent.h"

#include "vita_platform.h"

/* guit->misc->schedule lives behind the core's gui table. */
#include "desktop/gui_internal.h"
#include "netsurf/misc.h"

/* html_content, for the document node and browser window. */
#include "content/handlers/html/private.h"
#include "content/handlers/html/box.h"
#include "content/handlers/html/box_construct.h"
#include "content/handlers/html/box_inspect.h"
#include "desktop/browser_private.h"
#include "desktop/scrollbar.h"

/* ------------------------------------------------------------------------ */
/* Heap and thread                                                          */

struct jsheap {
	JSRuntime *rt;
	int timeout;          /**< script time budget, seconds */
	bool pending_destroy;
	int live_threads;
};

struct js_listener;
struct js_xhr;

/*
 * One JS object per DOM node, so that a node fetched twice compares equal
 * and expando properties (el.style, el.dataset, handlers) survive. The
 * cache holds a reference; wrappers are released when the thread dies.
 */
#define WRAPPER_BUCKETS 128
struct js_wrapper {
	struct dom_node *node;
	JSValue obj;
	struct js_wrapper *next;
};

struct jsthread {
	jsheap *heap;
	JSContext *ctx;
	struct browser_window *win;
	html_content *htmlc;
	uint64_t deadline_ms;     /**< when the running script must stop */
	const char *current_script; /**< URL of the script js_exec is running */
	struct js_listener *listeners; /**< event listeners, freed on close */
	struct js_timer *timers;       /**< live timers, cancelled on close */
	struct js_wrapper *wrappers[WRAPPER_BUCKETS];
	struct js_xhr *xhrs;           /**< requests in flight */
	int next_xhr_id;
	bool closed;
	bool dom_dirty;           /**< scripts changed the DOM since the last layout */
	bool relayout_pending;    /**< relayout_callback is scheduled */
	bool relayout_off;        /**< document too large to rebuild */
	unsigned dom_elements;    /**< elements in the document, 0 if not counted */
	int event_depth;          /**< DOM event dispatches in progress */
	int js_dispatch_depth;    /**< of which were started by dispatchEvent */
	struct js_dispatch *dispatches; /**< events dispatchEvent is delivering */
};

/* A JS-created event being dispatched through libdom (dispatchEvent). */
struct js_dispatch {
	struct js_dispatch *next;
	struct dom_event *evt;
	JSValue obj;
};

/* A DOM event listener that calls a JS function. */
struct js_listener {
	struct js_listener *next;
	struct jsthread *thread;
	struct dom_node *node;
	struct dom_event_listener *dom_listener;
	JSValue func;
};

/* A scheduled setTimeout/setInterval callback. */
struct js_timer {
	struct js_timer *next;
	struct jsthread *thread;
	JSValue func;
	int interval_ms;      /**< 0 for a one-shot timeout */
	int handle;
	bool dead;
};

static JSClassID node_class_id;
static int next_timer_handle = 1;

#define RELAYOUT_DELAY_MS 40    /**< coalesce a burst of handlers into one */
#define RELAYOUT_RETRY_MS 500   /**< page busy (dragging, typing): try later */
#define RELAYOUT_MAX_DELAY_MS 2000 /**< longest wait a slow page earns */
/*
 * A rebuild costs a full box construction and style selection for the
 * whole document, and it runs in one go. On a Wikipedia article, which
 * is about five and a half thousand elements, that is tens of seconds on
 * the Vita and the browser is frozen for all of it, which is a far worse
 * page than the one the rebuild would have improved. Documents above
 * this size therefore keep the layout they were parsed with.
 */
#define RELAYOUT_MAX_ELEMENTS 3000

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */

static uint64_t now_ms(void)
{
	uint64_t ms = 0;
	nsu_getmonotonic_ms(&ms);
	return ms;
}

/** Interrupt handler: stop a script that has run past its deadline. */
static int qjs_interrupt(JSRuntime *rt, void *opaque)
{
	jsthread *thread = opaque;

	(void)rt;
	if (thread == NULL || thread->deadline_ms == 0) {
		return 0;
	}
	if (now_ms() > thread->deadline_ms) {
		vita_log("qjs: script exceeded its time budget");
		return 1; /* abort */
	}
	return 0;
}

/** QuickJS's own allocation total for the runtime, in KB. */
static unsigned runtime_kb(JSRuntime *rt)
{
	JSMemoryUsage u;

	JS_ComputeMemoryUsage(rt, &u);
	return (unsigned)(u.malloc_size / 1024);
}

/**
 * Log the source around the position the stack trace names, so a log from
 * hardware shows which call failed without the page source at hand.
 */
static void log_source_excerpt(const char *stack, const char *name,
			       const char *src, size_t len)
{
	const char *p;
	size_t nlen = strlen(name);
	unsigned long line = 0, col = 0;
	size_t i, line_start, pos, from, to;
	char buf[160];
	size_t n = 0;

	/* first frame that names this script: "(name:line:col)" */
	for (p = strstr(stack, name); p != NULL; p = strstr(p + 1, name)) {
		if (p[nlen] == ':' &&
		    sscanf(p + nlen, ":%lu:%lu", &line, &col) == 2) {
			break;
		}
	}
	if (p == NULL || line == 0) {
		return;
	}
	line_start = 0;
	for (i = 0; i < len && line > 1; i++) {
		if (src[i] == '\n') {
			line--;
			line_start = i + 1;
		}
	}
	if (line > 1) {
		return;
	}
	pos = line_start + (col > 0 ? col - 1 : 0);
	if (pos > len) pos = len;
	from = pos > 90 ? pos - 90 : 0;
	if (from < line_start) from = line_start;
	to = pos + 30 < len ? pos + 30 : len;
	for (i = from; i < to && n < sizeof(buf) - 1; i++) {
		char c = src[i];
		if (c == '\n') break;
		buf[n++] = (c == '\t') ? ' ' : c;
	}
	buf[n] = 0;
	vita_log("qjs:   source: %s", buf);
	vita_log("qjs:   %*s^ column %lu", (int)(pos - from) + 8, "", col);
}

/**
 * Log a pending exception and clear it. When the script source that ran
 * is known (name, src, len), the offending source line is logged too.
 */
static void qjs_report_exception_src(JSContext *ctx, const char *name,
				     const char *src, size_t len)
{
	JSValue exc = JS_GetException(ctx);
	const char *msg = JS_ToCString(ctx, exc);

	vita_log("qjs: uncaught %s", msg != NULL ? msg : "(error)");
	if (msg != NULL) {
		JS_FreeCString(ctx, msg);
	}
	if (JS_IsObject(exc)) {
		JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
		if (!JS_IsUndefined(stack)) {
			const char *s = JS_ToCString(ctx, stack);
			if (s != NULL) {
				vita_log("qjs:   %s", s);
				if (name != NULL && src != NULL) {
					log_source_excerpt(s, name, src, len);
				}
				JS_FreeCString(ctx, s);
			}
		}
		JS_FreeValue(ctx, stack);
	}
	JS_FreeValue(ctx, exc);
}

static void qjs_report_exception(JSContext *ctx)
{
	qjs_report_exception_src(ctx, NULL, NULL, 0);
}

/** A dom_string from a NUL-terminated C string, or NULL. */
static dom_string *to_dom_string(const char *s)
{
	dom_string *out = NULL;

	if (s == NULL) {
		return NULL;
	}
	if (dom_string_create((const uint8_t *)s, strlen(s), &out) != DOM_NO_ERR) {
		return NULL;
	}
	return out;
}

/* ------------------------------------------------------------------------ */
/* Node wrapper                                                             */

/*
 * Each wrapper owns a reference on its dom_node, dropped in the finalizer.
 * Wrappers are created fresh on demand; identity across accesses is not
 * preserved, which is enough for the scripts this engine targets.
 */

static JSValue wrap_node(JSContext *ctx, struct dom_node *node)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct js_wrapper *w;
	unsigned h;
	JSValue obj;

	if (node == NULL) {
		return JS_NULL;
	}
	h = (unsigned)(((uintptr_t)node) >> 4) % WRAPPER_BUCKETS;
	if (thread != NULL) {
		for (w = thread->wrappers[h]; w != NULL; w = w->next) {
			if (w->node == node) {
				return JS_DupValue(ctx, w->obj);
			}
		}
	}
	obj = JS_NewObjectClass(ctx, node_class_id);
	if (JS_IsException(obj)) {
		return obj;
	}
	dom_node_ref(node);
	JS_SetOpaque(obj, node);
	if (thread != NULL) {
		w = malloc(sizeof(*w));
		if (w != NULL) {
			w->node = node;
			w->obj = JS_DupValue(ctx, obj);
			w->next = thread->wrappers[h];
			thread->wrappers[h] = w;
		}
	}
	return obj;
}

static void free_wrappers(jsthread *thread)
{
	unsigned h;

	for (h = 0; h < WRAPPER_BUCKETS; h++) {
		struct js_wrapper *w = thread->wrappers[h];
		while (w != NULL) {
			struct js_wrapper *next = w->next;
			JS_FreeValue(thread->ctx, w->obj);
			free(w);
			w = next;
		}
		thread->wrappers[h] = NULL;
	}
}

static void node_finalizer(JSRuntime *rt, JSValue val)
{
	struct dom_node *node = JS_GetOpaque(val, node_class_id);

	(void)rt;
	if (node != NULL) {
		dom_node_unref(node);
	}
}

static JSClassDef node_class = {
	"Node",
	.finalizer = node_finalizer,
};

static struct dom_node *this_node(JSContext *ctx, JSValueConst this_val)
{
	return JS_GetOpaque2(ctx, this_val, node_class_id);
}

/**
 * Whether a node is an element.
 *
 * libdom dispatches the element methods through a vtable that only
 * element nodes carry. Calling one on a text node, a comment or a
 * document fragment reads past the end of that node's smaller vtable and
 * jumps through whatever follows it, so every binding that uses an
 * element method checks first (VitaSurf).
 */
static bool node_is_element(struct dom_node *node)
{
	dom_node_type type = DOM_TEXT_NODE;

	return node != NULL &&
		dom_node_get_node_type(node, &type) == DOM_NO_ERR &&
		type == DOM_ELEMENT_NODE;
}

/** The element this is called on, or NULL when it is not an element. */
static struct dom_node *this_element(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = JS_GetOpaque2(ctx, this_val, node_class_id);

	return node_is_element(node) ? node : NULL;
}

/*
 * The right-hand simple selector of a group in a selector list, as
 * prelude.js compiled it. find_in_subtree() below returns the elements
 * under a node that match at least one of them.
 */
struct find_key {
	char *tag;        /**< upper case element name, or NULL for any */
	char *id;         /**< id attribute to match, or NULL */
	char **classes;   /**< class names that must all be present */
	int nclasses;
};

static JSValue find_in_subtree(JSContext *ctx, struct dom_node *root,
			       const struct find_key *keys, int nkeys);

/*
 * NetSurf builds its box tree once, after parsing; nothing scripts do to
 * the DOM afterwards reaches the screen on its own. Every binding that
 * changes the document marks the layout stale, and once the running
 * script (or handler, or timer) is done the box tree is rebuilt from the
 * DOM and laid out again (html_relayout, VitaSurf patch).
 */
static void mark_dirty(JSContext *ctx)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	if (thread != NULL) {
		thread->dom_dirty = true;
	}
}

/** Return a dom_string property as a JS string, or "" . */
static JSValue str_result(JSContext *ctx, dom_string *s)
{
	JSValue v;

	if (s == NULL) {
		return JS_NewString(ctx, "");
	}
	v = JS_NewStringLen(ctx, dom_string_data(s), dom_string_byte_length(s));
	dom_string_unref(s);
	return v;
}

/* --- node getters --- */

static JSValue node_get_node_name(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_node_name(node, &s);
	return str_result(ctx, s);
}

static JSValue node_get_tag_name(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_element(ctx, this_val);
	dom_string *s = NULL;

	/* only elements have a tag name */
	if (node == NULL) return JS_UNDEFINED;
	if (dom_element_get_tag_name(node, &s) != DOM_NO_ERR) {
		return JS_UNDEFINED;
	}
	return str_result(ctx, s);
}

static JSValue node_get_node_type(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_node_type type = 0;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_node_type(node, &type);
	return JS_NewInt32(ctx, (int)type);
}

static JSValue node_get_text_content(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_text_content(node, &s);
	return str_result(ctx, s);
}

static JSValue node_set_text_content(JSContext *ctx, JSValueConst this_val,
				     JSValueConst val)
{
	struct dom_node *node = this_node(ctx, this_val);
	const char *s = JS_ToCString(ctx, val);
	dom_string *d;

	if (node == NULL) return JS_EXCEPTION;
	d = to_dom_string(s != NULL ? s : "");
	if (d != NULL) {
		dom_node_set_text_content(node, d);
		dom_string_unref(d);
		mark_dirty(ctx);
	}
	if (s != NULL) JS_FreeCString(ctx, s);
	return JS_UNDEFINED;
}

static JSValue node_get_attr_prop(JSContext *ctx, JSValueConst this_val,
				  const char *name)
{
	struct dom_node *node = this_element(ctx, this_val);
	dom_string *key = to_dom_string(name);
	dom_string *val = NULL;

	if (node == NULL || key == NULL) {
		if (key != NULL) dom_string_unref(key);
		return JS_NewString(ctx, "");
	}
	dom_element_get_attribute(node, key, &val);
	dom_string_unref(key);
	return str_result(ctx, val);
}

static JSValue node_get_id(JSContext *ctx, JSValueConst this_val)
{
	return node_get_attr_prop(ctx, this_val, "id");
}

static JSValue node_get_class_name(JSContext *ctx, JSValueConst this_val)
{
	return node_get_attr_prop(ctx, this_val, "class");
}

static JSValue node_set_attr_prop(JSContext *ctx, JSValueConst this_val,
				  const char *name, JSValueConst val)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *s = JS_ToCString(ctx, val);
	dom_string *key = to_dom_string(name);
	dom_string *dv = to_dom_string(s != NULL ? s : "");

	if (node != NULL && key != NULL && dv != NULL) {
		dom_element_set_attribute(node, key, dv);
		mark_dirty(ctx);
	}
	if (key != NULL) dom_string_unref(key);
	if (dv != NULL) dom_string_unref(dv);
	if (s != NULL) JS_FreeCString(ctx, s);
	return JS_UNDEFINED;
}

static JSValue node_set_id(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
	return node_set_attr_prop(ctx, this_val, "id", v);
}

static JSValue node_set_class_name(JSContext *ctx, JSValueConst this_val,
				   JSValueConst v)
{
	return node_set_attr_prop(ctx, this_val, "class", v);
}

static JSValue node_get_parent(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *p = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_parent_node(node, &p);
	r = wrap_node(ctx, p);
	if (p != NULL) dom_node_unref(p);
	return r;
}

static JSValue node_get_first_child(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_first_child(node, &c);
	r = wrap_node(ctx, c);
	if (c != NULL) dom_node_unref(c);
	return r;
}

static JSValue node_get_next_sibling(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_next_sibling(node, &c);
	r = wrap_node(ctx, c);
	if (c != NULL) dom_node_unref(c);
	return r;
}

static JSValue node_get_last_child(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_last_child(node, &c);
	r = wrap_node(ctx, c);
	if (c != NULL) dom_node_unref(c);
	return r;
}

static JSValue node_get_previous_sibling(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_previous_sibling(node, &c);
	r = wrap_node(ctx, c);
	if (c != NULL) dom_node_unref(c);
	return r;
}

static JSValue nodelist_to_array(JSContext *ctx, struct dom_nodelist *list);

static JSValue node_get_child_nodes(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_nodelist *list = NULL;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_child_nodes(node, &list);
	return nodelist_to_array(ctx, list);
}

static JSValue node_get_node_value(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_node_value(node, &s);
	if (s == NULL) return JS_NULL;
	return str_result(ctx, s);
}

/* --- node methods --- */

static JSValue node_get_attribute(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *name;
	dom_string *key, *val = NULL;
	JSValue r;

	if (node == NULL || argc < 1) return JS_NULL;
	name = JS_ToCString(ctx, argv[0]);
	key = to_dom_string(name);
	if (key == NULL) {
		if (name) JS_FreeCString(ctx, name);
		return JS_NULL;
	}
	dom_element_get_attribute(node, key, &val);
	dom_string_unref(key);
	JS_FreeCString(ctx, name);
	if (val == NULL) {
		return JS_NULL;
	}
	r = JS_NewStringLen(ctx, dom_string_data(val), dom_string_byte_length(val));
	dom_string_unref(val);
	return r;
}

static JSValue node_set_attribute(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *name, *value;
	dom_string *key, *val;

	if (node == NULL || argc < 2) return JS_UNDEFINED;
	name = JS_ToCString(ctx, argv[0]);
	value = JS_ToCString(ctx, argv[1]);
	key = to_dom_string(name);
	val = to_dom_string(value != NULL ? value : "");
	if (node != NULL && key != NULL && val != NULL) {
		dom_element_set_attribute(node, key, val);
		mark_dirty(ctx);
	}
	if (key) dom_string_unref(key);
	if (val) dom_string_unref(val);
	if (name) JS_FreeCString(ctx, name);
	if (value) JS_FreeCString(ctx, value);
	return JS_UNDEFINED;
}

static JSValue node_has_attribute(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *name;
	dom_string *key;
	bool has = false;

	if (node == NULL || argc < 1) return JS_NewBool(ctx, false);
	name = JS_ToCString(ctx, argv[0]);
	key = to_dom_string(name);
	if (key != NULL) {
		dom_element_has_attribute(node, key, &has);
		dom_string_unref(key);
	}
	if (name) JS_FreeCString(ctx, name);
	return JS_NewBool(ctx, has);
}

static JSValue node_remove_attribute(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *name;
	dom_string *key;

	if (node == NULL || argc < 1) return JS_UNDEFINED;
	name = JS_ToCString(ctx, argv[0]);
	key = to_dom_string(name);
	if (key != NULL) {
		dom_element_remove_attribute(node, key);
		mark_dirty(ctx);
		dom_string_unref(key);
	}
	if (name) JS_FreeCString(ctx, name);
	return JS_UNDEFINED;
}

static JSValue node_insert_before(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *child, *before = NULL, *ref = NULL;

	if (node == NULL || argc < 1) return JS_UNDEFINED;
	child = JS_GetOpaque(argv[0], node_class_id);
	if (child == NULL) return JS_UNDEFINED;
	mark_dirty(ctx);
	if (argc >= 2) {
		before = JS_GetOpaque(argv[1], node_class_id);
	}
	if (before == NULL) {
		if (dom_node_append_child(node, child, &ref) == DOM_NO_ERR &&
		    ref != NULL) {
			dom_node_unref(ref);
		}
	} else if (dom_node_insert_before(node, child, before, &ref) == DOM_NO_ERR &&
		   ref != NULL) {
		dom_node_unref(ref);
	}
	return JS_DupValue(ctx, argv[0]);
}

static JSValue node_replace_child(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *child, *old, *ref = NULL;

	if (node == NULL || argc < 2) return JS_UNDEFINED;
	child = JS_GetOpaque(argv[0], node_class_id);
	old = JS_GetOpaque(argv[1], node_class_id);
	if (child == NULL || old == NULL) return JS_UNDEFINED;
	mark_dirty(ctx);
	if (dom_node_replace_child(node, child, old, &ref) == DOM_NO_ERR &&
	    ref != NULL) {
		dom_node_unref(ref);
	}
	return JS_DupValue(ctx, argv[1]);
}

static JSValue node_clone_node(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *copy = NULL;
	bool deep = false;
	JSValue r;

	if (node == NULL) return JS_NULL;
	if (argc >= 1) deep = JS_ToBool(ctx, argv[0]) > 0;
	if (dom_node_clone_node(node, deep, &copy) != DOM_NO_ERR || copy == NULL) {
		return JS_NULL;
	}
	r = wrap_node(ctx, copy);
	dom_node_unref(copy);
	return r;
}

static JSValue node_get_elements_by_tag_name(JSContext *ctx, JSValueConst this_val,
					     int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	const char *name;
	dom_string *key;
	struct dom_nodelist *list = NULL;

	if (node == NULL || argc < 1) return JS_NewArray(ctx);
	name = JS_ToCString(ctx, argv[0]);
	if (name == NULL) return JS_NewArray(ctx);

	if (!node_is_element(node)) {
		/* a document fragment has no element vtable, so walk it */
		struct find_key k;
		size_t i, len = strlen(name);
		JSValue out;

		memset(&k, 0, sizeof(k));
		if (strcmp(name, "*") != 0) {
			k.tag = malloc(len + 1);
			if (k.tag == NULL) {
				JS_FreeCString(ctx, name);
				return JS_NewArray(ctx);
			}
			for (i = 0; i < len; i++) {
				k.tag[i] = (char)toupper((unsigned char)name[i]);
			}
			k.tag[len] = 0;
		}
		JS_FreeCString(ctx, name);
		out = find_in_subtree(ctx, node, &k, 1);
		free(k.tag);
		return out;
	}

	key = to_dom_string(name);
	if (key != NULL) {
		dom_element_get_elements_by_tag_name(node, key, &list);
		dom_string_unref(key);
	}
	JS_FreeCString(ctx, name);
	return nodelist_to_array(ctx, list);
}

static JSValue node_append_child(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *child, *ref = NULL;

	if (node == NULL || argc < 1) return JS_UNDEFINED;
	child = JS_GetOpaque(argv[0], node_class_id);
	if (child == NULL) return JS_UNDEFINED;
	mark_dirty(ctx);
	if (dom_node_append_child(node, child, &ref) == DOM_NO_ERR && ref != NULL) {
		dom_node_unref(ref);
	}
	return JS_DupValue(ctx, argv[0]);
}

static JSValue node_remove_child(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *child, *ref = NULL;

	if (node == NULL || argc < 1) return JS_UNDEFINED;
	child = JS_GetOpaque(argv[0], node_class_id);
	if (child == NULL) return JS_UNDEFINED;
	mark_dirty(ctx);
	if (dom_node_remove_child(node, child, &ref) == DOM_NO_ERR && ref != NULL) {
		dom_node_unref(ref);
	}
	return JS_DupValue(ctx, argv[0]);
}

/* Replace the element's children with parsed HTML (innerHTML setter). */
static void set_inner_html(struct dom_node *node, const char *html, size_t len)
{
	dom_hubbub_parser_params params;
	dom_hubbub_parser *parser = NULL;
	struct dom_document *doc = NULL;
	struct dom_document_fragment *fragment = NULL;
	struct dom_node *child = NULL, *htmlnode = NULL, *body = NULL;
	struct dom_nodelist *bodies = NULL;

	if (dom_node_get_owner_document(node, &doc) != DOM_NO_ERR) {
		return;
	}
	memset(&params, 0, sizeof(params));
	params.enc = "UTF-8";
	params.fix_enc = true;
	params.enable_script = false;
	if (dom_hubbub_fragment_parser_create(&params, doc, &parser,
					      &fragment) != DOM_HUBBUB_OK) {
		goto out;
	}
	if (dom_hubbub_parser_parse_chunk(parser, (const uint8_t *)html,
					  len) != DOM_HUBBUB_OK) {
		goto out;
	}
	if (dom_hubbub_parser_completed(parser) != DOM_HUBBUB_OK) {
		goto out;
	}
	/* empty the target */
	dom_node_get_first_child(node, &child);
	while (child != NULL) {
		struct dom_node *cref = NULL;
		dom_node_remove_child(node, child, &cref);
		dom_node_unref(child);
		if (cref) dom_node_unref(cref);
		child = NULL;
		dom_node_get_first_child(node, &child);
	}
	/* migrate fragment's body children into the target */
	dom_node_get_first_child(fragment, &htmlnode);
	if (!node_is_element(htmlnode)) goto out;
	dom_element_get_elements_by_tag_name(htmlnode, corestring_dom_BODY, &bodies);
	if (bodies == NULL) goto out;
	dom_nodelist_item(bodies, 0, &body);
	if (body == NULL) goto out;
	dom_node_get_first_child(body, &child);
	while (child != NULL) {
		struct dom_node *cref = NULL;
		dom_node_remove_child(body, child, &cref);
		if (cref) dom_node_unref(cref);
		dom_node_append_child(node, child, &cref);
		if (cref) dom_node_unref(cref);
		dom_node_unref(child);
		child = NULL;
		dom_node_get_first_child(body, &child);
	}
out:
	if (parser) dom_hubbub_parser_destroy(parser);
	if (doc) dom_node_unref(doc);
	if (fragment) dom_node_unref(fragment);
	if (htmlnode) dom_node_unref(htmlnode);
	if (bodies) dom_nodelist_unref(bodies);
	if (body) dom_node_unref(body);
}

static JSValue node_set_inner_html(JSContext *ctx, JSValueConst this_val,
				   JSValueConst val)
{
	struct dom_node *node = this_node(ctx, this_val);
	size_t len = 0;
	const char *s;

	if (node == NULL) return JS_EXCEPTION;
	s = JS_ToCStringLen(ctx, &len, val);
	if (s != NULL) {
		set_inner_html(node, s, len);
		JS_FreeCString(ctx, s);
		mark_dirty(ctx);
	}
	return JS_UNDEFINED;
}

static JSValue node_get_inner_html(JSContext *ctx, JSValueConst this_val)
{
	/* Serialising the DOM back to HTML is not implemented; report empty. */
	(void)this_val;
	return JS_NewString(ctx, "");
}

/* --- addEventListener --- */

static void listener_trampoline(struct dom_event *evt, void *pw);

static struct dom_document *thread_document(jsthread *thread)
{
	if (thread == NULL || thread->htmlc == NULL) {
		return NULL;
	}
	return thread->htmlc->document;
}

/** Register func as a listener for event type on node. */
static JSValue add_listener(JSContext *ctx, struct dom_node *node,
			    JSValueConst type_v, JSValueConst func)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *type;
	dom_string *type_dom;
	struct js_listener *l;
	struct dom_event_listener *dl = NULL;

	if (node == NULL || thread == NULL || !JS_IsFunction(ctx, func)) {
		return JS_UNDEFINED;
	}
	type = JS_ToCString(ctx, type_v);
	type_dom = to_dom_string(type);
	if (type_dom == NULL) {
		if (type) JS_FreeCString(ctx, type);
		return JS_UNDEFINED;
	}

	l = calloc(1, sizeof(*l));
	if (l == NULL) {
		dom_string_unref(type_dom);
		JS_FreeCString(ctx, type);
		return JS_UNDEFINED;
	}
	if (dom_event_listener_create(listener_trampoline, l, &dl) != DOM_NO_ERR) {
		free(l);
		dom_string_unref(type_dom);
		JS_FreeCString(ctx, type);
		return JS_UNDEFINED;
	}
	l->thread = thread;
	l->node = node;
	dom_node_ref(node);
	l->dom_listener = dl;
	l->func = JS_DupValue(ctx, func);
	l->next = thread->listeners;
	thread->listeners = l;

	dom_event_target_add_event_listener(node, type_dom, dl, false);
	dom_string_unref(type_dom);
	JS_FreeCString(ctx, type);
	return JS_UNDEFINED;
}

static JSValue node_add_event_listener(JSContext *ctx, JSValueConst this_val,
				       int argc, JSValueConst *argv)
{
	if (argc < 2) return JS_UNDEFINED;
	return add_listener(ctx, this_node(ctx, this_val), argv[0], argv[1]);
}

/*
 * window and document listeners live on the document node: DOMContentLoaded
 * is dispatched there by NetSurf and load bubbles up to it from the body.
 */
static JSValue doc_add_event_listener(JSContext *ctx, JSValueConst this_val,
				      int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	(void)this_val;
	if (argc < 2) return JS_UNDEFINED;
	return add_listener(ctx, (struct dom_node *)thread_document(thread),
			    argv[0], argv[1]);
}

static JSValue noop(JSContext *ctx, JSValueConst this_val,
		    int argc, JSValueConst *argv)
{
	(void)ctx; (void)this_val; (void)argc; (void)argv;
	return JS_UNDEFINED;
}

/* --- node property and method table --- */

static const JSCFunctionListEntry node_proto[] = {
	JS_CGETSET_DEF("nodeName", node_get_node_name, NULL),
	JS_CGETSET_DEF("tagName", node_get_tag_name, NULL),
	JS_CGETSET_DEF("nodeType", node_get_node_type, NULL),
	JS_CGETSET_DEF("textContent", node_get_text_content, node_set_text_content),
	JS_CGETSET_DEF("innerHTML", node_get_inner_html, node_set_inner_html),
	JS_CGETSET_DEF("id", node_get_id, node_set_id),
	JS_CGETSET_DEF("className", node_get_class_name, node_set_class_name),
	JS_CGETSET_DEF("parentNode", node_get_parent, NULL),
	JS_CGETSET_DEF("firstChild", node_get_first_child, NULL),
	JS_CGETSET_DEF("nextSibling", node_get_next_sibling, NULL),
	JS_CGETSET_DEF("lastChild", node_get_last_child, NULL),
	JS_CGETSET_DEF("previousSibling", node_get_previous_sibling, NULL),
	JS_CGETSET_DEF("childNodes", node_get_child_nodes, NULL),
	JS_CGETSET_DEF("nodeValue", node_get_node_value, NULL),
	JS_CFUNC_DEF("getAttribute", 1, node_get_attribute),
	JS_CFUNC_DEF("setAttribute", 2, node_set_attribute),
	JS_CFUNC_DEF("hasAttribute", 1, node_has_attribute),
	JS_CFUNC_DEF("removeAttribute", 1, node_remove_attribute),
	JS_CFUNC_DEF("appendChild", 1, node_append_child),
	JS_CFUNC_DEF("removeChild", 1, node_remove_child),
	JS_CFUNC_DEF("insertBefore", 2, node_insert_before),
	JS_CFUNC_DEF("replaceChild", 2, node_replace_child),
	JS_CFUNC_DEF("cloneNode", 1, node_clone_node),
	JS_CFUNC_DEF("getElementsByTagName", 1, node_get_elements_by_tag_name),
	JS_CFUNC_DEF("addEventListener", 2, node_add_event_listener),
	JS_CFUNC_DEF("removeEventListener", 2, noop),
};

/* ------------------------------------------------------------------------ */
/* document                                                                 */

static JSValue doc_get_element_by_id(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *id;
	dom_string *key;
	struct dom_element *el = NULL;
	JSValue r;

	(void)this_val;
	if (doc == NULL || argc < 1) return JS_NULL;
	id = JS_ToCString(ctx, argv[0]);
	key = to_dom_string(id);
	if (key == NULL) {
		if (id) JS_FreeCString(ctx, id);
		return JS_NULL;
	}
	dom_document_get_element_by_id(doc, key, &el);
	dom_string_unref(key);
	JS_FreeCString(ctx, id);
	r = wrap_node(ctx, (struct dom_node *)el);
	if (el != NULL) dom_node_unref((struct dom_node *)el);
	return r;
}

/* Return a plain array of elements for a tag or class name query. */
static JSValue nodelist_to_array(JSContext *ctx, struct dom_nodelist *list)
{
	JSValue arr = JS_NewArray(ctx);
	uint32_t len = 0, i;

	if (list == NULL) {
		return arr;
	}
	dom_nodelist_get_length(list, &len);
	for (i = 0; i < len; i++) {
		struct dom_node *n = NULL;
		dom_nodelist_item(list, i, &n);
		if (n != NULL) {
			JS_SetPropertyUint32(ctx, arr, i, wrap_node(ctx, n));
			dom_node_unref(n);
		}
	}
	dom_nodelist_unref(list);
	return arr;
}

static JSValue doc_get_elements_by_tag_name(JSContext *ctx, JSValueConst this_val,
					    int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *name;
	dom_string *key;
	struct dom_nodelist *list = NULL;

	(void)this_val;
	if (doc == NULL || argc < 1) return JS_NewArray(ctx);
	name = JS_ToCString(ctx, argv[0]);
	key = to_dom_string(name);
	if (key != NULL) {
		dom_document_get_elements_by_tag_name(doc, key, &list);
		dom_string_unref(key);
	}
	if (name) JS_FreeCString(ctx, name);
	return nodelist_to_array(ctx, list);
}

static JSValue doc_create_element(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *name;
	dom_string *key;
	struct dom_element *el = NULL;
	JSValue r;

	(void)this_val;
	if (doc == NULL || argc < 1) return JS_NULL;
	name = JS_ToCString(ctx, argv[0]);
	key = to_dom_string(name);
	if (key == NULL) {
		if (name) JS_FreeCString(ctx, name);
		return JS_NULL;
	}
	dom_document_create_element(doc, key, &el);
	dom_string_unref(key);
	JS_FreeCString(ctx, name);
	r = wrap_node(ctx, (struct dom_node *)el);
	if (el != NULL) dom_node_unref((struct dom_node *)el);
	return r;
}

static JSValue doc_create_text_node(JSContext *ctx, JSValueConst this_val,
				    int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *text;
	dom_string *d;
	struct dom_text *node = NULL;
	JSValue r;

	(void)this_val;
	if (doc == NULL || argc < 1) return JS_NULL;
	text = JS_ToCString(ctx, argv[0]);
	d = to_dom_string(text != NULL ? text : "");
	if (d == NULL) {
		if (text) JS_FreeCString(ctx, text);
		return JS_NULL;
	}
	dom_document_create_text_node(doc, d, &node);
	dom_string_unref(d);
	if (text) JS_FreeCString(ctx, text);
	r = wrap_node(ctx, (struct dom_node *)node);
	if (node != NULL) dom_node_unref((struct dom_node *)node);
	return r;
}

static JSValue doc_create_document_fragment(JSContext *ctx, JSValueConst this_val,
					    int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	struct dom_document_fragment *frag = NULL;
	JSValue r;

	(void)this_val; (void)argc; (void)argv;
	if (doc == NULL) return JS_NULL;
	dom_document_create_document_fragment(doc, &frag);
	r = wrap_node(ctx, (struct dom_node *)frag);
	if (frag != NULL) dom_node_unref((struct dom_node *)frag);
	return r;
}

/*
 * document.currentScript: the <script src> whose URL matches the script
 * being executed. Inline scripts cannot be told apart, so they read null.
 */
static JSValue doc_get_current_script(JSContext *ctx, JSValueConst this_val)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	struct dom_nodelist *list = NULL;
	uint32_t len = 0, i;
	JSValue r = JS_NULL;

	(void)this_val;
	if (doc == NULL || thread->current_script == NULL ||
	    thread->htmlc->base_url == NULL ||
	    strchr(thread->current_script, ':') == NULL) {
		return JS_NULL;
	}
	dom_document_get_elements_by_tag_name(doc, corestring_dom_SCRIPT, &list);
	if (list == NULL) {
		return JS_NULL;
	}
	dom_nodelist_get_length(list, &len);
	for (i = 0; i < len && JS_IsNull(r); i++) {
		struct dom_node *n = NULL;
		dom_string *src = NULL;
		nsurl *url = NULL;

		dom_nodelist_item(list, i, &n);
		if (n == NULL) continue;
		dom_element_get_attribute(n, corestring_dom_src, &src);
		if (src != NULL) {
			if (nsurl_join(thread->htmlc->base_url,
				       dom_string_data(src), &url) == NSERROR_OK) {
				if (strcmp(nsurl_access(url),
					   thread->current_script) == 0) {
					r = wrap_node(ctx, n);
				}
				nsurl_unref(url);
			}
			dom_string_unref(src);
		}
		dom_node_unref(n);
	}
	dom_nodelist_unref(list);
	return r;
}

static JSValue doc_get_body(JSContext *ctx, JSValueConst this_val)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	struct dom_html_element *body = NULL;
	JSValue r;

	(void)this_val;
	if (doc == NULL) return JS_NULL;
	dom_html_document_get_body(doc, &body);
	r = wrap_node(ctx, (struct dom_node *)body);
	if (body != NULL) dom_node_unref((struct dom_node *)body);
	return r;
}

static JSValue doc_get_title(JSContext *ctx, JSValueConst this_val)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	dom_string *s = NULL;

	(void)this_val;
	if (doc == NULL) return JS_NewString(ctx, "");
	dom_html_document_get_title(doc, &s);
	return str_result(ctx, s);
}

static JSValue doc_set_title(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *s = JS_ToCString(ctx, v);
	dom_string *d;

	(void)this_val;
	if (doc != NULL && s != NULL) {
		d = to_dom_string(s);
		if (d != NULL) {
			dom_html_document_set_title(doc, d);
			dom_string_unref(d);
		}
	}
	if (s) JS_FreeCString(ctx, s);
	return JS_UNDEFINED;
}

static JSValue doc_get_cookie(JSContext *ctx, JSValueConst this_val)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	nsurl *url = NULL;
	char *cookies;
	JSValue r;

	(void)this_val;
	if (thread == NULL || thread->win == NULL) return JS_NewString(ctx, "");
	if (browser_window_get_url(thread->win, false, &url) != NSERROR_OK ||
	    url == NULL) {
		return JS_NewString(ctx, "");
	}
	cookies = urldb_get_cookie(url, false);
	nsurl_unref(url);
	if (cookies == NULL) {
		return JS_NewString(ctx, "");
	}
	r = JS_NewString(ctx, cookies);
	free(cookies);
	return r;
}

static JSValue doc_set_cookie(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	nsurl *url = NULL;
	const char *s = JS_ToCString(ctx, v);

	(void)this_val;
	if (thread != NULL && thread->win != NULL && s != NULL &&
	    browser_window_get_url(thread->win, false, &url) == NSERROR_OK &&
	    url != NULL) {
		urldb_set_cookie(s, url, NULL);
		nsurl_unref(url);
	}
	if (s) JS_FreeCString(ctx, s);
	return JS_UNDEFINED;
}

static JSValue doc_get_document_element(JSContext *ctx, JSValueConst this_val)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	struct dom_element *el = NULL;
	JSValue r;

	(void)this_val;
	if (doc == NULL) return JS_NULL;
	dom_document_get_document_element(doc, &el);
	r = wrap_node(ctx, (struct dom_node *)el);
	if (el != NULL) dom_node_unref((struct dom_node *)el);
	return r;
}

static const JSCFunctionListEntry document_proto[] = {
	JS_CGETSET_DEF("body", doc_get_body, NULL),
	JS_CGETSET_DEF("documentElement", doc_get_document_element, NULL),
	JS_CGETSET_DEF("title", doc_get_title, doc_set_title),
	JS_CGETSET_DEF("cookie", doc_get_cookie, doc_set_cookie),
	JS_CGETSET_DEF("currentScript", doc_get_current_script, NULL),
	JS_CFUNC_DEF("getElementById", 1, doc_get_element_by_id),
	JS_CFUNC_DEF("getElementsByTagName", 1, doc_get_elements_by_tag_name),
	JS_CFUNC_DEF("createElement", 1, doc_create_element),
	JS_CFUNC_DEF("createTextNode", 1, doc_create_text_node),
	JS_CFUNC_DEF("createDocumentFragment", 0, doc_create_document_fragment),
	JS_CFUNC_DEF("addEventListener", 2, doc_add_event_listener),
	JS_CFUNC_DEF("removeEventListener", 2, noop),
	JS_PROP_STRING_DEF("readyState", "interactive", 0),
};

/* ------------------------------------------------------------------------ */
/* window: console, navigator, location, timers                            */

static JSValue console_log(JSContext *ctx, JSValueConst this_val,
			   int argc, JSValueConst *argv)
{
	int i;
	char line[512];
	size_t pos = 0;

	(void)this_val;
	for (i = 0; i < argc; i++) {
		const char *s = JS_ToCString(ctx, argv[i]);
		if (s != NULL) {
			int n = snprintf(line + pos, sizeof(line) - pos,
					 "%s%s", i ? " " : "", s);
			if (n > 0) pos += (size_t)n;
			JS_FreeCString(ctx, s);
			if (pos >= sizeof(line)) break;
		}
	}
	vita_log("console: %s", line);
	return JS_UNDEFINED;
}

static JSValue win_navigate(JSContext *ctx, jsthread *thread, const char *href)
{
	nsurl *cur = NULL, *url = NULL;

	if (thread == NULL || thread->win == NULL || href == NULL) {
		return JS_UNDEFINED;
	}
	if (browser_window_get_url(thread->win, false, &cur) == NSERROR_OK &&
	    cur != NULL) {
		nsurl_join(cur, href, &url);
		nsurl_unref(cur);
	} else {
		nsurl_create(href, &url);
	}
	if (url != NULL) {
		vita_log("qjs: script navigates to %s", nsurl_access(url));
		browser_window_navigate(thread->win, url, NULL,
					BW_NAVIGATE_HISTORY, NULL, NULL, NULL);
		nsurl_unref(url);
	}
	(void)ctx;
	return JS_UNDEFINED;
}

static JSValue loc_get_href(JSContext *ctx, JSValueConst this_val)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	nsurl *url = NULL;
	JSValue r;

	(void)this_val;
	if (thread == NULL || thread->win == NULL) return JS_NewString(ctx, "");
	if (browser_window_get_url(thread->win, false, &url) != NSERROR_OK ||
	    url == NULL) {
		return JS_NewString(ctx, "");
	}
	r = JS_NewString(ctx, nsurl_access(url));
	nsurl_unref(url);
	return r;
}

static JSValue loc_set_href(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *s = JS_ToCString(ctx, v);
	JSValue r;

	(void)this_val;
	r = win_navigate(ctx, thread, s);
	if (s) JS_FreeCString(ctx, s);
	return r;
}

static JSValue loc_assign(JSContext *ctx, JSValueConst this_val,
			  int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *s;
	JSValue r;

	(void)this_val;
	if (argc < 1) return JS_UNDEFINED;
	s = JS_ToCString(ctx, argv[0]);
	r = win_navigate(ctx, thread, s);
	if (s) JS_FreeCString(ctx, s);
	return r;
}

static const JSCFunctionListEntry location_proto[] = {
	JS_CGETSET_DEF("href", loc_get_href, loc_set_href),
	JS_CFUNC_DEF("assign", 1, loc_assign),
	JS_CFUNC_DEF("replace", 1, loc_assign),
};

static JSValue nav_get_user_agent(JSContext *ctx, JSValueConst this_val)
{
	(void)this_val;
	return JS_NewString(ctx, user_agent_string());
}

static const JSCFunctionListEntry navigator_proto[] = {
	JS_CGETSET_DEF("userAgent", nav_get_user_agent, NULL),
	JS_PROP_STRING_DEF("appName", "Netscape", 0),
	JS_PROP_STRING_DEF("appCodeName", "Mozilla", 0),
	JS_PROP_STRING_DEF("platform", "PlayStation Vita", 0),
	JS_PROP_STRING_DEF("product", "Gecko", 0),
};

/* --- timers --- */

static void timer_callback(void *p);

static JSValue win_set_timer(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv, int repeat)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct js_timer *t;
	int32_t ms = 0;

	(void)this_val;
	if (thread == NULL || argc < 1 || !JS_IsFunction(ctx, argv[0])) {
		return JS_NewInt32(ctx, 0);
	}
	if (argc >= 2) {
		JS_ToInt32(ctx, &ms, argv[1]);
	}
	if (ms < 10) ms = 10;

	t = calloc(1, sizeof(*t));
	if (t == NULL) {
		return JS_NewInt32(ctx, 0);
	}
	t->thread = thread;
	t->func = JS_DupValue(ctx, argv[0]);
	t->interval_ms = repeat ? ms : 0;
	t->handle = next_timer_handle++;
	t->next = thread->timers;
	thread->timers = t;

	guit->misc->schedule(ms, timer_callback, t);
	return JS_NewInt32(ctx, t->handle);
}

static JSValue win_set_timeout(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	return win_set_timer(ctx, this_val, argc, argv, 0);
}

static JSValue win_set_interval(JSContext *ctx, JSValueConst this_val,
				int argc, JSValueConst *argv)
{
	return win_set_timer(ctx, this_val, argc, argv, 1);
}

static JSValue win_clear_timer(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct js_timer *t;
	int32_t handle = 0;

	(void)this_val;
	if (thread == NULL || argc < 1) return JS_UNDEFINED;
	JS_ToInt32(ctx, &handle, argv[0]);
	for (t = thread->timers; t != NULL; t = t->next) {
		if (t->handle == handle) {
			t->dead = true;
			guit->misc->schedule(-1, timer_callback, t);
			break;
		}
	}
	return JS_UNDEFINED;
}

/* ------------------------------------------------------------------------ */
/* Deadline management around calls into script                             */

static void begin_script(jsthread *thread)
{
	if (thread->heap->timeout > 0) {
		thread->deadline_ms = now_ms() +
			(uint64_t)thread->heap->timeout * 1000;
	} else {
		thread->deadline_ms = 0;
	}
}

static void schedule_relayout(jsthread *thread, int ms);

static void end_script(jsthread *thread)
{
	thread->deadline_ms = 0;
	/* run microtasks (promise jobs) the script queued */
	for (;;) {
		JSContext *c = NULL;
		int r = JS_ExecutePendingJob(thread->heap->rt, &c);
		if (r <= 0) {
			if (r < 0 && c != NULL) {
				qjs_report_exception(c);
			}
			break;
		}
	}
	if (thread->dom_dirty) {
		schedule_relayout(thread, RELAYOUT_DELAY_MS);
	}
}

/* ------------------------------------------------------------------------ */
/* Layout after DOM changes                                                 */

/** Number of element nodes under root, for the rebuild size budget. */
static unsigned count_elements(struct dom_node *root)
{
	struct dom_node *n = NULL;
	unsigned count = 0;

	if (dom_node_get_first_child(root, &n) != DOM_NO_ERR) {
		return 0;
	}
	while (n != NULL) {
		struct dom_node *next = NULL;
		dom_node_type type = DOM_TEXT_NODE;

		if (dom_node_get_node_type(n, &type) == DOM_NO_ERR &&
		    type == DOM_ELEMENT_NODE) {
			count++;
		}
		if (dom_node_get_first_child(n, &next) != DOM_NO_ERR) {
			next = NULL;
		}
		if (next == NULL) {
			struct dom_node *cur = dom_node_ref(n);

			while (cur != NULL) {
				struct dom_node *sib = NULL, *parent = NULL;

				if (cur == root) {
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_next_sibling(cur, &sib) == DOM_NO_ERR &&
				    sib != NULL) {
					next = sib;
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_parent_node(cur, &parent) != DOM_NO_ERR) {
					parent = NULL;
				}
				dom_node_unref(cur);
				cur = parent;
			}
		}
		dom_node_unref(n);
		n = next;
	}
	return count;
}

static void relayout_callback(void *p)
{
	jsthread *thread = p;
	html_content *htmlc;
	nserror err;
	uint64_t t0;

	thread->relayout_pending = false;
	if (thread->closed || !thread->dom_dirty || thread->relayout_off) {
		return;
	}
	htmlc = thread->htmlc;
	if (htmlc == NULL) {
		thread->dom_dirty = false;
		return;
	}
	if (htmlc->layout == NULL) {
		if (htmlc->box_conversion_context != NULL) {
			/* being built from a document that just changed */
			guit->misc->schedule(RELAYOUT_RETRY_MS, relayout_callback, thread);
			thread->relayout_pending = true;
		} else {
			/* the first conversion has not run yet; it will see the changes */
			thread->dom_dirty = false;
		}
		return;
	}
	/*
	 * Wait for the page to finish loading. A rebuild in the middle of
	 * one throws away work still arriving and holds up everything the
	 * user is waiting for.
	 */
	if (htmlc->base.status != CONTENT_STATUS_DONE ||
	    htmlc->base.active > 0) {
		guit->misc->schedule(RELAYOUT_RETRY_MS, relayout_callback, thread);
		thread->relayout_pending = true;
		return;
	}

	if (thread->dom_elements == 0) {
		struct dom_document *doc = thread_document(thread);

		if (doc != NULL) {
			thread->dom_elements = count_elements((struct dom_node *)doc);
		}
	}
	if (thread->dom_elements > RELAYOUT_MAX_ELEMENTS) {
		vita_log("qjs: not rebuilding the layout, %u elements is over "
			 "the %u the Vita can rebuild in reasonable time",
			 thread->dom_elements,
			 (unsigned)RELAYOUT_MAX_ELEMENTS);
		thread->relayout_off = true;
		thread->dom_dirty = false;
		return;
	}

	t0 = now_ms();
	err = html_relayout(htmlc);
	if (err == NSERROR_INVALID) {
		/* busy, or a rebuild is already running */
		guit->misc->schedule(RELAYOUT_RETRY_MS, relayout_callback, thread);
		thread->relayout_pending = true;
		return;
	}
	thread->dom_dirty = false;
	/* the rebuild runs to completion here, so this is also how long
	 * the page was frozen for */
	vita_log("qjs: layout rebuilt after script changes in %u ms "
		 "(%u elements)%s",
		 (unsigned)(now_ms() - t0), thread->dom_elements,
		 err == NSERROR_OK ? "" : " (failed)");
}

/*
 * A rebuild costs the whole box tree, so changes are coalesced. While the
 * page is still loading more are certain to come, and a rebuild already
 * running makes html_relayout() ask to be called back later, so at most
 * one runs at a time.
 */
static void schedule_relayout(jsthread *thread, int ms)
{
	if (thread->relayout_pending || thread->closed) {
		return;
	}
	if (thread->htmlc != NULL && thread->htmlc->base.active > 0 &&
	    ms < RELAYOUT_MAX_DELAY_MS) {
		ms = RELAYOUT_MAX_DELAY_MS;
	}
	if (guit->misc->schedule(ms, relayout_callback, thread) == NSERROR_OK) {
		thread->relayout_pending = true;
	}
}

/*
 * Whether there is a layout to read geometry from. A rebuild after a DOM
 * change runs from the scheduler, not from here: NetSurf's conversion
 * yields as it goes and code holding box pointers can be on the stack, so
 * a script that measures right after changing the document reads the
 * previous layout rather than forcing one.
 */
static bool layout_current(jsthread *thread)
{
	html_content *htmlc = thread->htmlc;

	return htmlc != NULL && htmlc->layout != NULL;
}

static void timer_callback(void *p)
{
	struct js_timer *t = p;
	jsthread *thread;
	JSContext *ctx;
	JSValue global, ret;

	if (t->dead) {
		return;
	}
	thread = t->thread;
	if (thread == NULL || thread->closed) {
		return;
	}
	ctx = thread->ctx;
	begin_script(thread);
	global = JS_GetGlobalObject(ctx);
	ret = JS_Call(ctx, t->func, global, 0, NULL);
	if (JS_IsException(ret)) {
		qjs_report_exception(ctx);
	}
	JS_FreeValue(ctx, ret);
	JS_FreeValue(ctx, global);
	end_script(thread);

	if (t->interval_ms > 0 && !t->dead) {
		guit->misc->schedule(t->interval_ms, timer_callback, t);
	} else {
		t->dead = true;
	}
}


/* ------------------------------------------------------------------------ */
/* XMLHttpRequest transport                                                 */

/*
 * The JS side (prelude.js) implements XMLHttpRequest and fetch() on top of
 * __vitaFetch(url, method, headers, body, timeoutMs, callback), which runs
 * one request through NetSurf's fetch layer (so cookies, the CA bundle and
 * the user agent are the browser's) and calls back once with
 * (status, headersText, bodyText, errorOrNull, finalUrl). Cross-origin
 * responses are only handed over when Access-Control-Allow-Origin allows
 * the page's origin; redirects are followed up to a limit.
 */

#define XHR_MAX_BODY      (8 * 1024 * 1024)
#define XHR_MAX_HEADERS   (64 * 1024)
#define XHR_MAX_REDIRECTS 5

struct js_xhr {
	jsthread *thread;
	int id;
	JSValue callback;
	struct fetch *fetch;
	nsurl *url;
	nsurl *referer;      /**< the page; also the origin for CORS */
	char *post;          /**< request body, NULL for GET */
	char **headers;      /**< NULL-terminated "Name: value" strings */
	int status;
	char *rheaders;
	size_t rheaders_len;
	char *body;
	size_t body_len;
	char *acao;          /**< Access-Control-Allow-Origin, if any */
	bool cross_origin;
	int redirects;
	int timeout_ms;
	bool timer_set;
	struct js_xhr *next;
};

static void xhr_timeout_cb(void *p);

/** scheme://host:port of a URL, malloc'd, or NULL. */
static char *url_origin(nsurl *url)
{
	char *s = NULL;
	size_t l;

	if (url == NULL ||
	    nsurl_get(url, NSURL_SCHEME | NSURL_HOST | NSURL_PORT, &s, &l) != NSERROR_OK) {
		return NULL;
	}
	return s;
}

static bool same_origin(nsurl *a, nsurl *b)
{
	char *oa = url_origin(a), *ob = url_origin(b);
	bool same = (oa != NULL && ob != NULL && strcasecmp(oa, ob) == 0);

	free(oa);
	free(ob);
	return same;
}

static void xhr_unlink(struct js_xhr *x)
{
	struct js_xhr **pp;

	if (x->thread == NULL) return;
	for (pp = &x->thread->xhrs; *pp != NULL; pp = &(*pp)->next) {
		if (*pp == x) {
			*pp = x->next;
			break;
		}
	}
}

static void xhr_free(struct js_xhr *x)
{
	int i;

	if (x->timer_set) {
		guit->misc->schedule(-1, xhr_timeout_cb, x);
	}
	if (x->fetch != NULL) {
		fetch_abort(x->fetch);
	}
	if (x->headers != NULL) {
		for (i = 0; x->headers[i] != NULL; i++) free(x->headers[i]);
		free(x->headers);
	}
	if (x->url) nsurl_unref(x->url);
	if (x->referer) nsurl_unref(x->referer);
	free(x->post);
	free(x->rheaders);
	free(x->body);
	free(x->acao);
	free(x);
}

/** Deliver the result to the JS callback and free the request. */
static void xhr_complete(struct js_xhr *x, const char *err)
{
	jsthread *thread = x->thread;

	x->fetch = NULL; /* the fetcher frees it after the final message */
	if (x->timer_set) {
		guit->misc->schedule(-1, xhr_timeout_cb, x);
		x->timer_set = false;
	}
	if (err == NULL && x->cross_origin) {
		char *origin = url_origin(x->referer);

		if (x->acao == NULL ||
		    (strcmp(x->acao, "*") != 0 &&
		     (origin == NULL || strcasecmp(x->acao, origin) != 0))) {
			err = "cross-origin response not allowed by the server";
		}
		free(origin);
	}
	xhr_unlink(x);
	if (thread != NULL && !thread->closed) {
		JSContext *ctx = thread->ctx;
		JSValue args[5], ret;
		int i;

		if (err != NULL) {
			vita_log("xhr: %s: %s", nsurl_access(x->url), err);
		}
		begin_script(thread);
		args[0] = JS_NewInt32(ctx, x->status);
		args[1] = JS_NewStringLen(ctx, x->rheaders != NULL ? x->rheaders : "",
					  x->rheaders_len);
		args[2] = err != NULL ? JS_NewString(ctx, "") :
			JS_NewStringLen(ctx, x->body != NULL ? x->body : "", x->body_len);
		args[3] = err != NULL ? JS_NewString(ctx, err) : JS_NULL;
		args[4] = JS_NewString(ctx, nsurl_access(x->url));
		ret = JS_Call(ctx, x->callback, JS_UNDEFINED, 5, args);
		if (JS_IsException(ret)) {
			qjs_report_exception(ctx);
		}
		JS_FreeValue(ctx, ret);
		for (i = 0; i < 5; i++) JS_FreeValue(ctx, args[i]);
		JS_FreeValue(ctx, x->callback);
		end_script(thread);
	}
	x->thread = NULL;
	xhr_free(x);
}

static bool xhr_start(struct js_xhr *x);

static void xhr_fetch_callback(const fetch_msg *msg, void *p)
{
	struct js_xhr *x = p;

	switch (msg->type) {
	case FETCH_HEADER: {
		const char *h = (const char *)msg->data.header_or_data.buf;
		size_t len = msg->data.header_or_data.len;

		while (len > 0 && (h[len - 1] == '\r' || h[len - 1] == '\n')) len--;
		if (len >= 5 && strncasecmp(h, "HTTP/", 5) == 0) {
			int code = 0;
			if (sscanf(h, "HTTP/%*[0-9.] %d", &code) == 1) {
				x->status = code;
			}
			/* a new status line (100 Continue, retries) restarts the headers */
			x->rheaders_len = 0;
			free(x->acao);
			x->acao = NULL;
		} else if (len > 0 && x->rheaders_len + len + 2 <= XHR_MAX_HEADERS) {
			char *grown = realloc(x->rheaders, x->rheaders_len + len + 2);
			if (grown != NULL) {
				x->rheaders = grown;
				memcpy(x->rheaders + x->rheaders_len, h, len);
				x->rheaders_len += len;
				x->rheaders[x->rheaders_len++] = '\n';
				x->rheaders[x->rheaders_len] = '\0';
			}
			if (len > 28 && strncasecmp(h, "Access-Control-Allow-Origin:", 28) == 0) {
				const char *v = h + 28;
				size_t vl = len - 28;
				while (vl > 0 && (*v == ' ' || *v == '\t')) { v++; vl--; }
				free(x->acao);
				x->acao = malloc(vl + 1);
				if (x->acao != NULL) {
					memcpy(x->acao, v, vl);
					x->acao[vl] = '\0';
				}
			}
		}
		break;
	}
	case FETCH_DATA: {
		size_t len = msg->data.header_or_data.len;
		char *grown;

		if (x->body_len + len > XHR_MAX_BODY) {
			fetch_abort(x->fetch);
			x->fetch = NULL;
			xhr_complete(x, "response larger than 8 MB");
			break;
		}
		grown = realloc(x->body, x->body_len + len + 1);
		if (grown == NULL) {
			fetch_abort(x->fetch);
			x->fetch = NULL;
			xhr_complete(x, "out of memory");
			break;
		}
		x->body = grown;
		memcpy(x->body + x->body_len, msg->data.header_or_data.buf, len);
		x->body_len += len;
		x->body[x->body_len] = '\0';
		break;
	}
	case FETCH_REDIRECT: {
		nsurl *next = NULL;

		x->fetch = NULL;
		if (++x->redirects > XHR_MAX_REDIRECTS) {
			xhr_complete(x, "too many redirects");
			break;
		}
		if (msg->data.redirect == NULL ||
		    nsurl_join(x->url, msg->data.redirect, &next) != NSERROR_OK) {
			xhr_complete(x, "bad redirect");
			break;
		}
		nsurl_unref(x->url);
		x->url = next;
		/* redirected requests are re-issued as GET, as browsers do for 30x */
		free(x->post);
		x->post = NULL;
		x->status = 0;
		x->rheaders_len = 0;
		x->body_len = 0;
		free(x->acao);
		x->acao = NULL;
		x->cross_origin = !same_origin(x->url, x->referer);
		if (!xhr_start(x)) {
			xhr_complete(x, "cannot start fetch");
		}
		break;
	}
	case FETCH_FINISHED:
	case FETCH_NOTMODIFIED:
	case FETCH_AUTH:
		xhr_complete(x, NULL);
		break;
	case FETCH_TIMEDOUT:
		xhr_complete(x, "timeout");
		break;
	case FETCH_CERT_ERR:
		xhr_complete(x, "certificate error");
		break;
	case FETCH_ERROR:
		xhr_complete(x, msg->data.error != NULL ? msg->data.error : "fetch error");
		break;
	default:
		break;
	}
}

static void xhr_timeout_cb(void *p)
{
	struct js_xhr *x = p;

	x->timer_set = false;
	if (x->fetch != NULL) {
		fetch_abort(x->fetch);
		x->fetch = NULL;
	}
	xhr_complete(x, "timeout");
}

static bool xhr_start(struct js_xhr *x)
{
	const char **hdrs;
	char *origin_hdr = NULL;
	int n = 0, i;
	nserror err;

	while (x->headers != NULL && x->headers[n] != NULL) n++;
	hdrs = calloc((size_t)n + 2, sizeof(*hdrs));
	if (hdrs == NULL) {
		return false;
	}
	for (i = 0; i < n; i++) hdrs[i] = x->headers[i];
	if (x->cross_origin) {
		char *origin = url_origin(x->referer);
		if (origin != NULL) {
			size_t l = strlen(origin) + 9;
			origin_hdr = malloc(l);
			if (origin_hdr != NULL) {
				snprintf(origin_hdr, l, "Origin: %s", origin);
				hdrs[n++] = origin_hdr;
			}
			free(origin);
		}
	}
	hdrs[n] = NULL;
	err = fetch_start(x->url, x->referer, xhr_fetch_callback, x, false,
			  x->post, NULL, true, false, hdrs, &x->fetch);
	free(origin_hdr);
	free(hdrs);
	if (err != NSERROR_OK) {
		x->fetch = NULL;
		return false;
	}
	if (x->timeout_ms > 0 && !x->timer_set) {
		guit->misc->schedule(x->timeout_ms, xhr_timeout_cb, x);
		x->timer_set = true;
	}
	return true;
}

/* __vitaFetch(url, method, headers[], body, timeoutMs, callback) -> id */
static JSValue win_vita_fetch(JSContext *ctx, JSValueConst this_val,
			      int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct js_xhr *x;
	nsurl *page = NULL, *url = NULL;
	const char *url_s, *method = NULL, *body = NULL;
	int32_t timeout = 0;
	const char *scheme;

	(void)this_val;
	if (argc < 6 || thread == NULL || thread->closed || thread->win == NULL ||
	    !JS_IsFunction(ctx, argv[5])) {
		return JS_NewInt32(ctx, 0);
	}
	if (browser_window_get_url(thread->win, false, &page) != NSERROR_OK ||
	    page == NULL) {
		return JS_NewInt32(ctx, 0);
	}
	url_s = JS_ToCString(ctx, argv[0]);
	if (url_s == NULL || nsurl_join(page, url_s, &url) != NSERROR_OK) {
		if (url_s) JS_FreeCString(ctx, url_s);
		nsurl_unref(page);
		return JS_NewInt32(ctx, 0);
	}
	JS_FreeCString(ctx, url_s);
	scheme = nsurl_access(url);
	if (strncasecmp(scheme, "http:", 5) != 0 && strncasecmp(scheme, "https:", 6) != 0) {
		vita_log("xhr: refusing %s (only http and https)", scheme);
		nsurl_unref(url);
		nsurl_unref(page);
		return JS_NewInt32(ctx, 0);
	}

	x = calloc(1, sizeof(*x));
	if (x == NULL) {
		nsurl_unref(url);
		nsurl_unref(page);
		return JS_NewInt32(ctx, 0);
	}
	x->thread = thread;
	x->id = ++thread->next_xhr_id;
	x->url = url;
	x->referer = page;
	x->callback = JS_DupValue(ctx, argv[5]);
	JS_ToInt32(ctx, &timeout, argv[4]);
	x->timeout_ms = timeout > 0 ? timeout : 0;
	x->cross_origin = !same_origin(url, page);

	method = JS_ToCString(ctx, argv[1]);
	if (!JS_IsNull(argv[3]) && !JS_IsUndefined(argv[3])) {
		body = JS_ToCString(ctx, argv[3]);
	}
	if (method != NULL && strcasecmp(method, "GET") != 0 &&
	    strcasecmp(method, "HEAD") != 0) {
		/* the fetch layer knows GET and POST; other verbs go as POST */
		x->post = strdup(body != NULL ? body : "");
		if (strcasecmp(method, "POST") != 0) {
			vita_log("xhr: %s sent as POST (fetch layer limit)", method);
		}
	}
	if (method) JS_FreeCString(ctx, method);
	if (body) JS_FreeCString(ctx, body);

	if (JS_IsArray(argv[2])) {
		JSValue lenv = JS_GetPropertyStr(ctx, argv[2], "length");
		int32_t n = 0, i, k = 0;

		JS_ToInt32(ctx, &n, lenv);
		JS_FreeValue(ctx, lenv);
		if (n > 32) n = 32;
		x->headers = calloc((size_t)n + 1, sizeof(char *));
		for (i = 0; x->headers != NULL && i < n; i++) {
			JSValue hv = JS_GetPropertyUint32(ctx, argv[2], (uint32_t)i);
			const char *hs = JS_ToCString(ctx, hv);
			if (hs != NULL && strchr(hs, ':') != NULL &&
			    strchr(hs, '\n') == NULL && strchr(hs, '\r') == NULL) {
				x->headers[k++] = strdup(hs);
			}
			if (hs) JS_FreeCString(ctx, hs);
			JS_FreeValue(ctx, hv);
		}
	}

	x->next = thread->xhrs;
	thread->xhrs = x;
	if (!xhr_start(x)) {
		xhr_unlink(x);
		JS_FreeValue(ctx, x->callback);
		x->thread = NULL;
		xhr_free(x);
		return JS_NewInt32(ctx, 0);
	}
	return JS_NewInt32(ctx, x->id);
}

static JSValue win_vita_fetch_abort(JSContext *ctx, JSValueConst this_val,
				    int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct js_xhr *x;
	int32_t id = 0;

	(void)this_val;
	if (argc < 1 || thread == NULL) return JS_UNDEFINED;
	JS_ToInt32(ctx, &id, argv[0]);
	for (x = thread->xhrs; x != NULL; x = x->next) {
		if (x->id == id) {
			xhr_unlink(x);
			JS_FreeValue(ctx, x->callback);
			x->thread = NULL;
			xhr_free(x); /* aborts the fetch; no callback follows */
			break;
		}
	}
	return JS_UNDEFINED;
}

/** Abort every request of a closing page. */
static void xhr_close_all(jsthread *thread)
{
	struct js_xhr *x = thread->xhrs;

	thread->xhrs = NULL;
	while (x != NULL) {
		struct js_xhr *next = x->next;
		JS_FreeValue(thread->ctx, x->callback);
		x->thread = NULL;
		xhr_free(x);
		x = next;
	}
}

/* ------------------------------------------------------------------------ */
/* Event dispatch                                                           */

static JSValue ev_prevent_default(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	(void)argc; (void)argv;
	JS_SetPropertyStr(ctx, this_val, "defaultPrevented", JS_NewBool(ctx, true));
	return JS_UNDEFINED;
}

static JSValue ev_stop_propagation(JSContext *ctx, JSValueConst this_val,
				   int argc, JSValueConst *argv)
{
	(void)argc; (void)argv;
	JS_SetPropertyStr(ctx, this_val, "cancelBubble", JS_NewBool(ctx, true));
	return JS_UNDEFINED;
}

static JSValue wrap_event(JSContext *ctx, struct dom_event *evt)
{
	JSValue obj = JS_NewObject(ctx);
	dom_string *type = NULL;
	struct dom_event_target *target = NULL;

	if (dom_event_get_type(evt, &type) == DOM_NO_ERR && type != NULL) {
		JS_SetPropertyStr(ctx, obj, "type",
			JS_NewStringLen(ctx, dom_string_data(type),
					dom_string_byte_length(type)));
		dom_string_unref(type);
	}
	if (dom_event_get_target(evt, &target) == DOM_NO_ERR &&
	    target != NULL) {
		JS_SetPropertyStr(ctx, obj, "target",
				  wrap_node(ctx, (struct dom_node *)target));
		dom_node_unref((struct dom_node *)target);
	}
	target = NULL;
	if (dom_event_get_current_target(evt, &target) == DOM_NO_ERR &&
	    target != NULL) {
		JS_SetPropertyStr(ctx, obj, "currentTarget",
				  wrap_node(ctx, (struct dom_node *)target));
		dom_node_unref((struct dom_node *)target);
	}
	JS_SetPropertyStr(ctx, obj, "defaultPrevented", JS_NewBool(ctx, false));
	JS_SetPropertyStr(ctx, obj, "cancelBubble", JS_NewBool(ctx, false));
	JS_SetPropertyStr(ctx, obj, "preventDefault",
			  JS_NewCFunction(ctx, ev_prevent_default, "preventDefault", 0));
	JS_SetPropertyStr(ctx, obj, "stopPropagation",
			  JS_NewCFunction(ctx, ev_stop_propagation, "stopPropagation", 0));
	JS_SetPropertyStr(ctx, obj, "stopImmediatePropagation",
			  JS_NewCFunction(ctx, ev_stop_propagation, "stopImmediatePropagation", 0));
	return obj;
}

static void listener_trampoline(struct dom_event *evt, void *pw)
{
	struct js_listener *l = pw;
	jsthread *thread = l->thread;
	JSContext *ctx;
	JSValue global, event_obj, ret, args[1], flag;
	struct js_dispatch *d;

	if (thread == NULL || thread->closed) {
		return;
	}
	ctx = thread->ctx;
	thread->event_depth++;
	begin_script(thread);
	/* this is the element the listener was added to */
	global = wrap_node(ctx, l->node);
	/* an event dispatchEvent created keeps its JS object (detail etc) */
	for (d = thread->dispatches; d != NULL; d = d->next) {
		if (d->evt == evt) {
			break;
		}
	}
	if (d != NULL) {
		struct dom_event_target *target = NULL;

		event_obj = JS_DupValue(ctx, d->obj);
		if (dom_event_get_target(evt, &target) == DOM_NO_ERR &&
		    target != NULL) {
			JS_SetPropertyStr(ctx, event_obj, "target",
					  wrap_node(ctx, (struct dom_node *)target));
			dom_node_unref((struct dom_node *)target);
		}
		JS_SetPropertyStr(ctx, event_obj, "currentTarget",
				  JS_DupValue(ctx, global));
	} else {
		event_obj = wrap_event(ctx, evt);
	}
	args[0] = event_obj;
	ret = JS_Call(ctx, l->func, global, 1, args);
	if (JS_IsException(ret)) {
		qjs_report_exception(ctx);
	}
	JS_FreeValue(ctx, ret);
	/* carry the listener's decisions back into the DOM dispatch */
	flag = JS_GetPropertyStr(ctx, event_obj, "defaultPrevented");
	if (JS_ToBool(ctx, flag) == 1) {
		dom_event_prevent_default(evt);
	}
	JS_FreeValue(ctx, flag);
	flag = JS_GetPropertyStr(ctx, event_obj, "cancelBubble");
	if (JS_ToBool(ctx, flag) == 1) {
		dom_event_stop_propagation(evt);
	}
	JS_FreeValue(ctx, flag);
	JS_FreeValue(ctx, event_obj);
	JS_FreeValue(ctx, global);
	end_script(thread);
	thread->event_depth--;
}

/* ------------------------------------------------------------------------ */
/* Selector candidate search                                                */

static void free_keys(struct find_key *keys, int n)
{
	int i, j;

	for (i = 0; i < n; i++) {
		free(keys[i].tag);
		free(keys[i].id);
		for (j = 0; j < keys[i].nclasses; j++) {
			free(keys[i].classes[j]);
		}
		free(keys[i].classes);
	}
	free(keys);
}

/** strdup of a JS string property, or NULL when absent. */
static char *key_string(JSContext *ctx, JSValueConst obj, const char *name)
{
	JSValue v = JS_GetPropertyStr(ctx, obj, name);
	const char *cs;
	char *out = NULL;

	if (!JS_IsString(v)) {
		JS_FreeValue(ctx, v);
		return NULL;
	}
	cs = JS_ToCString(ctx, v);
	if (cs != NULL) {
		out = strdup(cs);
		JS_FreeCString(ctx, cs);
	}
	JS_FreeValue(ctx, v);
	return out;
}

static struct find_key *build_keys(JSContext *ctx, JSValueConst arr, int *count)
{
	struct find_key *keys;
	uint32_t n = 0, i;
	JSValue len = JS_GetPropertyStr(ctx, arr, "length");

	JS_ToUint32(ctx, &n, len);
	JS_FreeValue(ctx, len);
	if (n == 0 || n > 64) {
		return NULL;
	}
	keys = calloc(n, sizeof(*keys));
	if (keys == NULL) {
		return NULL;
	}
	for (i = 0; i < n; i++) {
		JSValue k = JS_GetPropertyUint32(ctx, arr, i);
		JSValue cls, clen;
		uint32_t c = 0, j;

		keys[i].tag = key_string(ctx, k, "tag");
		keys[i].id = key_string(ctx, k, "id");
		cls = JS_GetPropertyStr(ctx, k, "classes");
		clen = JS_GetPropertyStr(ctx, cls, "length");
		JS_ToUint32(ctx, &c, clen);
		JS_FreeValue(ctx, clen);
		if (c > 0 && c <= 16) {
			keys[i].classes = calloc(c, sizeof(char *));
			if (keys[i].classes != NULL) {
				for (j = 0; j < c; j++) {
					JSValue cv = JS_GetPropertyUint32(ctx, cls, j);
					const char *cs = JS_ToCString(ctx, cv);

					if (cs != NULL) {
						keys[i].classes[keys[i].nclasses++] = strdup(cs);
						JS_FreeCString(ctx, cs);
					}
					JS_FreeValue(ctx, cv);
				}
			}
		}
		JS_FreeValue(ctx, cls);
		JS_FreeValue(ctx, k);
	}
	*count = (int)n;
	return keys;
}

/** Whether a class attribute contains name as a whole word. */
static bool class_present(const char *list, size_t len, const char *name)
{
	size_t nlen = strlen(name);
	size_t i = 0;

	while (i < len) {
		size_t start;

		while (i < len && (list[i] == ' ' || list[i] == '\t' ||
				   list[i] == '\n' || list[i] == '\r' ||
				   list[i] == '\f')) {
			i++;
		}
		start = i;
		while (i < len && !(list[i] == ' ' || list[i] == '\t' ||
				    list[i] == '\n' || list[i] == '\r' ||
				    list[i] == '\f')) {
			i++;
		}
		if (i - start == nlen && memcmp(list + start, name, nlen) == 0) {
			return true;
		}
	}
	return false;
}

static bool key_matches(struct dom_node *n, const struct find_key *k,
			dom_string *tag, dom_string *id, dom_string *cls)
{
	int i;

	(void)n;
	if (k->tag != NULL) {
		size_t tl = strlen(k->tag);

		if (tag == NULL || dom_string_byte_length(tag) != tl ||
		    strncasecmp(dom_string_data(tag), k->tag, tl) != 0) {
			return false;
		}
	}
	if (k->id != NULL) {
		size_t il = strlen(k->id);

		if (id == NULL || dom_string_byte_length(id) != il ||
		    memcmp(dom_string_data(id), k->id, il) != 0) {
			return false;
		}
	}
	for (i = 0; i < k->nclasses; i++) {
		if (cls == NULL ||
		    !class_present(dom_string_data(cls),
				   dom_string_byte_length(cls),
				   k->classes[i])) {
			return false;
		}
	}
	return true;
}

/*
 * __vitaFind(root, keys): every element under root matching at least one
 * key, in document order. root may be a node or null for the document.
 */
static JSValue win_vita_find(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_node *root = NULL;
	struct find_key *keys;
	int nkeys = 0;
	JSValue out;

	(void)this_val;
	if (argc < 2 || thread == NULL) {
		return JS_NewArray(ctx);
	}
	if (JS_IsObject(argv[0])) {
		root = JS_GetOpaque(argv[0], node_class_id);
	}
	if (root == NULL) {
		root = (struct dom_node *)thread_document(thread);
	}
	if (root == NULL) {
		return JS_NewArray(ctx);
	}
	keys = build_keys(ctx, argv[1], &nkeys);
	if (keys == NULL) {
		return JS_NewArray(ctx);
	}
	out = find_in_subtree(ctx, root, keys, nkeys);
	free_keys(keys, nkeys);
	return out;
}

/*
 * Every element under root matching at least one key, in document order.
 * Matching in C keeps the selector engine from wrapping every node in the
 * document: a class lookup over a long article cost hundreds of
 * milliseconds per query when the walk was in JavaScript.
 */
static JSValue find_in_subtree(JSContext *ctx, struct dom_node *root,
			       const struct find_key *keys, int nkeys)
{
	struct dom_node *n = NULL;
	uint32_t out_n = 0;
	bool want_id = false, want_cls = false;
	JSValue out = JS_NewArray(ctx);
	int i;

	for (i = 0; i < nkeys; i++) {
		if (keys[i].id != NULL) want_id = true;
		if (keys[i].nclasses > 0) want_cls = true;
	}
	/* iterative pre-order walk; root itself is not a candidate */
	if (dom_node_get_first_child(root, &n) != DOM_NO_ERR) {
		n = NULL;
	}
	while (n != NULL) {
		struct dom_node *next = NULL;
		dom_node_type type = DOM_ELEMENT_NODE;

		if (dom_node_get_node_type(n, &type) == DOM_NO_ERR &&
		    type == DOM_ELEMENT_NODE) {
			dom_string *tag = NULL, *id = NULL, *cls = NULL;

			dom_element_get_tag_name(n, &tag);
			if (want_id) {
				dom_element_get_attribute(n, corestring_dom_id, &id);
			}
			if (want_cls) {
				dom_element_get_attribute(n, corestring_dom_class, &cls);
			}
			for (i = 0; i < nkeys; i++) {
				if (key_matches(n, &keys[i], tag, id, cls)) {
					JS_SetPropertyUint32(ctx, out, out_n++,
							     wrap_node(ctx, n));
					break;
				}
			}
			if (tag != NULL) dom_string_unref(tag);
			if (id != NULL) dom_string_unref(id);
			if (cls != NULL) dom_string_unref(cls);
		}

		if (dom_node_get_first_child(n, &next) != DOM_NO_ERR) {
			next = NULL;
		}
		if (next == NULL) {
			struct dom_node *cur = dom_node_ref(n);

			while (cur != NULL) {
				struct dom_node *sib = NULL, *parent = NULL;

				if (cur == root) {
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_next_sibling(cur, &sib) == DOM_NO_ERR &&
				    sib != NULL) {
					next = sib;
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_parent_node(cur, &parent) != DOM_NO_ERR) {
					parent = NULL;
				}
				dom_node_unref(cur);
				cur = parent;
			}
		}
		dom_node_unref(n);
		n = next;
	}
	return out;
}

/* ------------------------------------------------------------------------ */
/* Geometry, scrolling and event dispatch                                   */

static void set_index(JSContext *ctx, JSValue arr, int i, int v)
{
	JS_SetPropertyUint32(ctx, arr, (uint32_t)i, JS_NewInt32(ctx, v));
}

/*
 * __vitaBox(node): the laid-out box of an element as
 * [x, y, width, height, clientWidth, clientHeight, borderLeft, borderTop,
 *  scrollWidth, scrollHeight, scrollLeft, scrollTop] in CSS px, document
 * coordinates, border box; null when the element has no box.
 */
static JSValue win_vita_box(JSContext *ctx, JSValueConst this_val,
			    int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_node *node;
	struct box *box;
	int x, y, cw, ch, sw, sh;
	JSValue arr;

	(void)this_val;
	if (argc < 1 || thread == NULL) {
		return JS_NULL;
	}
	node = JS_GetOpaque(argv[0], node_class_id);
	if (node == NULL || !layout_current(thread)) {
		return JS_NULL;
	}
	box = box_for_node(node);
	if (box == NULL) {
		return JS_NULL;
	}
	box_coords(box, &x, &y);
	cw = box->padding[LEFT] + box->width + box->padding[RIGHT];
	ch = box->padding[TOP] + box->height + box->padding[BOTTOM];
	sw = box->descendant_x1 > cw ? box->descendant_x1 : cw;
	sh = box->descendant_y1 > ch ? box->descendant_y1 : ch;
	arr = JS_NewArray(ctx);
	set_index(ctx, arr, 0, x - box->border[LEFT].width);
	set_index(ctx, arr, 1, y - box->border[TOP].width);
	set_index(ctx, arr, 2, cw + box->border[LEFT].width + box->border[RIGHT].width);
	set_index(ctx, arr, 3, ch + box->border[TOP].width + box->border[BOTTOM].width);
	set_index(ctx, arr, 4, cw);
	set_index(ctx, arr, 5, ch);
	set_index(ctx, arr, 6, box->border[LEFT].width);
	set_index(ctx, arr, 7, box->border[TOP].width);
	set_index(ctx, arr, 8, sw);
	set_index(ctx, arr, 9, sh);
	set_index(ctx, arr, 10, box->scroll_x != NULL ? scrollbar_get_offset(box->scroll_x) : 0);
	set_index(ctx, arr, 11, box->scroll_y != NULL ? scrollbar_get_offset(box->scroll_y) : 0);
	return arr;
}

static struct gui_window *thread_gui_window(jsthread *thread)
{
	if (thread == NULL || thread->win == NULL) {
		return NULL;
	}
	return thread->win->window;
}

/* __vitaScroll(): [scrollX, scrollY, viewportWidth, viewportHeight] in CSS px */
static JSValue win_vita_scroll(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct gui_window *gw = thread_gui_window(thread);
	int sx = 0, sy = 0, vw = 0, vh = 0;
	float scale;
	JSValue arr;

	(void)this_val; (void)argc; (void)argv;
	if (thread == NULL || thread->win == NULL) {
		return JS_NULL;
	}
	if (gw != NULL) {
		guit->window->get_scroll(gw, &sx, &sy);
		guit->window->get_dimensions(gw, &vw, &vh);
	} else {
		/* an iframe has no window of its own: its browser window
		 * carries the size and the scroll offsets instead */
		vw = thread->win->width;
		vh = thread->win->height;
		if (thread->win->scroll_x != NULL) {
			sx = scrollbar_get_offset(thread->win->scroll_x);
		}
		if (thread->win->scroll_y != NULL) {
			sy = scrollbar_get_offset(thread->win->scroll_y);
		}
	}
	scale = browser_window_get_scale(thread->win);
	if (scale <= 0.0f) {
		scale = 1.0f;
	}
	arr = JS_NewArray(ctx);
	set_index(ctx, arr, 0, (int)(sx / scale));
	set_index(ctx, arr, 1, (int)(sy / scale));
	set_index(ctx, arr, 2, (int)(vw / scale));
	set_index(ctx, arr, 3, (int)(vh / scale));
	return arr;
}

/* __vitaScrollTo(x, y): scroll the window, CSS px */
static JSValue win_vita_scroll_to(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct gui_window *gw = thread_gui_window(thread);
	double x = 0, y = 0;
	float scale;
	struct rect r;

	(void)this_val;
	if (gw == NULL || argc < 2) {
		return JS_UNDEFINED;
	}
	JS_ToFloat64(ctx, &x, argv[0]);
	JS_ToFloat64(ctx, &y, argv[1]);
	if (x < 0 || x != x) x = 0;
	if (y < 0 || y != y) y = 0;
	scale = browser_window_get_scale(thread->win);
	if (scale <= 0.0f) {
		scale = 1.0f;
	}
	r.x0 = r.x1 = (int)(x * scale);
	r.y0 = r.y1 = (int)(y * scale);
	guit->window->set_scroll(gw, &r);
	return JS_UNDEFINED;
}

/*
 * __vitaDispatch(node or null, event): deliver a JS-created Event through
 * libdom to node (the document for null), so listeners registered from
 * NetSurf and from other scripts see it. Returns false when a listener
 * called preventDefault().
 */
static JSValue win_vita_dispatch(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_node *node = NULL;
	struct dom_event *evt = NULL;
	dom_string *type_dom;
	const char *type;
	JSValue v;
	bool bubbles, cancelable, success = false, prevented;
	struct js_dispatch d;

	(void)this_val;
	if (thread == NULL || argc < 2 || !JS_IsObject(argv[1])) {
		return JS_TRUE;
	}
	if (JS_IsObject(argv[0])) {
		node = JS_GetOpaque(argv[0], node_class_id);
	}
	if (node == NULL) {
		node = (struct dom_node *)thread_document(thread);
	}
	if (node == NULL) {
		return JS_TRUE;
	}
	v = JS_GetPropertyStr(ctx, argv[1], "type");
	type = JS_ToCString(ctx, v);
	JS_FreeValue(ctx, v);
	if (type == NULL) {
		return JS_TRUE;
	}
	type_dom = to_dom_string(type);
	JS_FreeCString(ctx, type);
	if (type_dom == NULL) {
		return JS_TRUE;
	}
	v = JS_GetPropertyStr(ctx, argv[1], "bubbles");
	bubbles = JS_ToBool(ctx, v) == 1;
	JS_FreeValue(ctx, v);
	v = JS_GetPropertyStr(ctx, argv[1], "cancelable");
	cancelable = JS_ToBool(ctx, v) == 1;
	JS_FreeValue(ctx, v);
	if (dom_event_create(&evt) != DOM_NO_ERR) {
		dom_string_unref(type_dom);
		return JS_TRUE;
	}
	dom_event_init(evt, type_dom, bubbles, cancelable);
	dom_string_unref(type_dom);

	d.evt = evt;
	d.obj = JS_DupValue(ctx, argv[1]);
	d.next = thread->dispatches;
	thread->dispatches = &d;
	thread->js_dispatch_depth++;
	dom_event_target_dispatch_event(node, evt, &success);
	thread->js_dispatch_depth--;
	thread->dispatches = d.next;
	JS_FreeValue(ctx, d.obj);
	dom_event_unref(evt);

	v = JS_GetPropertyStr(ctx, argv[1], "defaultPrevented");
	prevented = JS_ToBool(ctx, v) == 1;
	JS_FreeValue(ctx, v);
	return JS_NewBool(ctx, !prevented);
}

/* ------------------------------------------------------------------------ */
/* Global object setup                                                      */

static JSValue node_ctor(JSContext *ctx, JSValueConst new_target,
			 int argc, JSValueConst *argv)
{
	(void)new_target; (void)argc; (void)argv;
	return JS_ThrowTypeError(ctx, "Illegal constructor");
}

/*
 * The JavaScript half of the bindings lives in vita/js/prelude.js; CMake
 * embeds it as a NUL-terminated byte array in prelude_js.h. It runs once
 * per page context after the C bindings are installed.
 */
#include "prelude_js.h"

static void setup_globals(jsthread *thread)
{
	JSContext *ctx = thread->ctx;
	JSValue global = JS_GetGlobalObject(ctx);
	JSValue doc, console, nav, loc, node_proto_obj;

	/* window aliases */
	JS_SetPropertyStr(ctx, global, "self", JS_DupValue(ctx, global));
	JS_SetPropertyStr(ctx, global, "window", JS_DupValue(ctx, global));

	/* node prototype registered against the class */
	node_proto_obj = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, node_proto_obj, node_proto,
				   (int)(sizeof(node_proto) / sizeof(node_proto[0])));
	JS_SetClassProto(ctx, node_class_id, node_proto_obj);

	/* document */
	doc = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, doc, document_proto,
				   (int)(sizeof(document_proto) / sizeof(document_proto[0])));
	JS_SetPropertyStr(ctx, global, "document", doc);

	/* console */
	console = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, console, "log",
			  JS_NewCFunction(ctx, console_log, "log", 1));
	JS_SetPropertyStr(ctx, console, "warn",
			  JS_NewCFunction(ctx, console_log, "warn", 1));
	JS_SetPropertyStr(ctx, console, "error",
			  JS_NewCFunction(ctx, console_log, "error", 1));
	JS_SetPropertyStr(ctx, console, "info",
			  JS_NewCFunction(ctx, console_log, "info", 1));
	JS_SetPropertyStr(ctx, console, "debug",
			  JS_NewCFunction(ctx, console_log, "debug", 1));
	JS_SetPropertyStr(ctx, global, "console", console);

	/* navigator */
	nav = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, nav, navigator_proto,
				   (int)(sizeof(navigator_proto) / sizeof(navigator_proto[0])));
	JS_SetPropertyStr(ctx, global, "navigator", nav);

	/* location, on both window and document */
	loc = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, loc, location_proto,
				   (int)(sizeof(location_proto) / sizeof(location_proto[0])));
	JS_SetPropertyStr(ctx, global, "location", JS_DupValue(ctx, loc));
	JS_SetPropertyStr(ctx, doc, "location", loc);

	/* timers and window helpers */
	JS_SetPropertyStr(ctx, global, "setTimeout",
			  JS_NewCFunction(ctx, win_set_timeout, "setTimeout", 2));
	JS_SetPropertyStr(ctx, global, "setInterval",
			  JS_NewCFunction(ctx, win_set_interval, "setInterval", 2));
	JS_SetPropertyStr(ctx, global, "clearTimeout",
			  JS_NewCFunction(ctx, win_clear_timer, "clearTimeout", 1));
	JS_SetPropertyStr(ctx, global, "clearInterval",
			  JS_NewCFunction(ctx, win_clear_timer, "clearInterval", 1));
	JS_SetPropertyStr(ctx, global, "alert",
			  JS_NewCFunction(ctx, console_log, "alert", 1));

	/* transport for XMLHttpRequest and fetch (prelude.js) */
	JS_SetPropertyStr(ctx, global, "__vitaFetch",
			  JS_NewCFunction(ctx, win_vita_fetch, "__vitaFetch", 6));
	JS_SetPropertyStr(ctx, global, "__vitaFetchAbort",
			  JS_NewCFunction(ctx, win_vita_fetch_abort, "__vitaFetchAbort", 1));

	/* layout geometry, scrolling and event dispatch (prelude.js) */
	JS_SetPropertyStr(ctx, global, "__vitaFind",
			  JS_NewCFunction(ctx, win_vita_find, "__vitaFind", 2));
	JS_SetPropertyStr(ctx, global, "__vitaBox",
			  JS_NewCFunction(ctx, win_vita_box, "__vitaBox", 1));
	JS_SetPropertyStr(ctx, global, "__vitaScroll",
			  JS_NewCFunction(ctx, win_vita_scroll, "__vitaScroll", 0));
	JS_SetPropertyStr(ctx, global, "__vitaScrollTo",
			  JS_NewCFunction(ctx, win_vita_scroll_to, "__vitaScrollTo", 2));
	JS_SetPropertyStr(ctx, global, "__vitaDispatch",
			  JS_NewCFunction(ctx, win_vita_dispatch, "__vitaDispatch", 2));

	/* window listeners live on the document node (see add_listener) */
	JS_SetPropertyStr(ctx, global, "addEventListener",
			  JS_NewCFunction(ctx, doc_add_event_listener, "addEventListener", 2));
	JS_SetPropertyStr(ctx, global, "removeEventListener",
			  JS_NewCFunction(ctx, noop, "removeEventListener", 2));

	/* Node, Element and HTMLElement all share the node prototype */
	{
		JSValue ctor = JS_NewCFunction2(ctx, node_ctor, "Node", 0,
						JS_CFUNC_constructor, 0);
		JS_SetConstructor(ctx, ctor, node_proto_obj);
		JS_SetPropertyStr(ctx, global, "Node", JS_DupValue(ctx, ctor));
		JS_SetPropertyStr(ctx, global, "Element", JS_DupValue(ctx, ctor));
		JS_SetPropertyStr(ctx, global, "HTMLElement", JS_DupValue(ctx, ctor));
		JS_SetPropertyStr(ctx, global, "EventTarget", ctor);
	}
	JS_FreeValue(ctx, global);

	{
		const char *src = (const char *)prelude_js;
		size_t len = sizeof(prelude_js) - 1;
		JSValue r = JS_Eval(ctx, src, len, "<prelude>", JS_EVAL_TYPE_GLOBAL);
		if (JS_IsException(r)) {
			qjs_report_exception_src(ctx, "<prelude>", src, len);
		}
		JS_FreeValue(ctx, r);
	}
}

/* ------------------------------------------------------------------------ */
/* js.h interface                                                           */

void js_initialise(void)
{
	nserror err;

	/*
	 * Register the JavaScript content type. Without this the HTML
	 * handler finds no handler for text/javascript and silently skips
	 * every script, which looks like a very fast engine in the log.
	 */
	err = javascript_init();
	vita_log("qjs: QuickJS engine initialised (content handler %s)",
		 err == NSERROR_OK ? "registered" : "FAILED");
}

void js_finalise(void)
{
}

nserror js_newheap(int timeout, jsheap **heap)
{
	jsheap *ret = calloc(1, sizeof(*ret));

	if (ret == NULL) {
		return NSERROR_NOMEM;
	}
	ret->rt = JS_NewRuntime();
	if (ret->rt == NULL) {
		free(ret);
		return NSERROR_NOMEM;
	}
	ret->timeout = timeout;
	/* keep a page's scripts within a sensible slice of the heap */
	JS_SetMemoryLimit(ret->rt, 32 * 1024 * 1024);
	JS_SetMaxStackSize(ret->rt, 512 * 1024);
	/* register the shared node class once per runtime */
	JS_NewClassID(ret->rt, &node_class_id);
	JS_NewClass(ret->rt, node_class_id, &node_class);
	*heap = ret;
	return NSERROR_OK;
}

void js_destroyheap(jsheap *heap)
{
	if (heap == NULL) {
		return;
	}
	if (heap->live_threads > 0) {
		heap->pending_destroy = true;
		return;
	}
	JS_FreeRuntime(heap->rt);
	free(heap);
}

nserror js_newthread(jsheap *heap, void *win_priv, void *doc_priv,
		     jsthread **thread)
{
	jsthread *ret = calloc(1, sizeof(*ret));

	if (ret == NULL) {
		return NSERROR_NOMEM;
	}
	ret->ctx = JS_NewContext(heap->rt);
	if (ret->ctx == NULL) {
		free(ret);
		return NSERROR_NOMEM;
	}
	ret->heap = heap;
	ret->win = win_priv;
	ret->htmlc = doc_priv;
	JS_SetContextOpaque(ret->ctx, ret);
	JS_SetInterruptHandler(heap->rt, qjs_interrupt, ret);
	setup_globals(ret);
	heap->live_threads++;
	*thread = ret;
	vita_log("qjs: new thread win=%p doc=%p", win_priv, doc_priv);
	return NSERROR_OK;
}

/*
 * Close a page's scripts. NetSurf keeps the html content (and this thread)
 * alive in its cache for a while after navigating away, so the JS context
 * and everything it owns are released here rather than in destroy: a
 * page's scripts can hold tens of MB and the runtime's memory limit is
 * shared by every page in the window.
 */
nserror js_closethread(jsthread *thread)
{
	struct js_timer *t;
	struct js_listener *l;

	if (thread == NULL || thread->closed) {
		return NSERROR_OK;
	}
	thread->closed = true;
	if (thread->relayout_pending) {
		guit->misc->schedule(-1, relayout_callback, thread);
		thread->relayout_pending = false;
	}
	/* cancel timers; the scheduler holds pointers to them */
	for (t = thread->timers; t != NULL; t = t->next) {
		if (!t->dead) {
			t->dead = true;
			guit->misc->schedule(-1, timer_callback, t);
		}
		JS_FreeValue(thread->ctx, t->func);
		t->func = JS_UNDEFINED;
	}
	/*
	 * Listener structs stay allocated: libdom still holds them as the
	 * private word of registered listeners. With thread cleared the
	 * trampoline ignores any late event.
	 */
	for (l = thread->listeners; l != NULL; l = l->next) {
		JS_FreeValue(thread->ctx, l->func);
		l->func = JS_UNDEFINED;
		l->thread = NULL;
	}
	xhr_close_all(thread);
	free_wrappers(thread);
	JS_FreeContext(thread->ctx);
	thread->ctx = NULL;
	JS_RunGC(thread->heap->rt);
	vita_log("qjs: page closed, runtime memory now %u KB",
		 runtime_kb(thread->heap->rt));
	return NSERROR_OK;
}

void js_destroythread(jsthread *thread)
{
	struct js_listener *l;
	struct js_timer *t;

	if (thread == NULL) {
		return;
	}
	js_closethread(thread); /* releases the context if still open */
	l = thread->listeners;
	while (l != NULL) {
		struct js_listener *next = l->next;
		if (l->dom_listener != NULL) {
			dom_event_listener_unref(l->dom_listener);
		}
		if (l->node != NULL) {
			dom_node_unref(l->node);
		}
		free(l);
		l = next;
	}
	t = thread->timers;
	while (t != NULL) {
		struct js_timer *next = t->next;
		free(t);
		t = next;
	}
	thread->heap->live_threads--;
	if (thread->heap->pending_destroy && thread->heap->live_threads == 0) {
		jsheap *heap = thread->heap;
		JS_FreeRuntime(heap->rt);
		free(heap);
	}
	free(thread);
}

/*
 * Scripts above this size are skipped. Application bundles of several
 * megabytes (YouTube's main bundle is one) take tens of seconds to parse
 * on the Vita and their bytecode alone can exceed the runtime's memory
 * limit; the sites this browser targets do not ship them.
 */
#define SCRIPT_MAX_BYTES (2 * 1024 * 1024)

bool js_exec(jsthread *thread, const uint8_t *txt, size_t txtlen, const char *name)
{
	JSValue ret;
	bool ok;
	char *src;

	if (thread == NULL || thread->closed || txt == NULL || txtlen == 0) {
		return false;
	}
	if (txtlen > SCRIPT_MAX_BYTES) {
		vita_log("qjs: skipping %u KB script (limit %u KB): %s",
			 (unsigned)(txtlen / 1024),
			 (unsigned)(SCRIPT_MAX_BYTES / 1024),
			 name != NULL ? name : "<script>");
		return false;
	}
	/*
	 * QuickJS requires the source to be NUL terminated (the lexer uses
	 * the terminator as its end sentinel). NetSurf hands over fetched
	 * script data as a plain buffer, and parsing past its end produced
	 * random syntax errors that changed from one load to the next.
	 */
	src = malloc(txtlen + 1);
	if (src == NULL) {
		return false;
	}
	memcpy(src, txt, txtlen);
	src[txtlen] = 0;
	if (name == NULL) {
		name = "<script>";
	}
	begin_script(thread);
	thread->current_script = name;
	ret = JS_Eval(thread->ctx, src, txtlen, name, JS_EVAL_TYPE_GLOBAL);
	ok = !JS_IsException(ret);
	if (!ok) {
		qjs_report_exception_src(thread->ctx, name, src, txtlen);
	}
	JS_FreeValue(thread->ctx, ret);
	thread->current_script = NULL;
	end_script(thread);
	free(src);
	return ok;
}

bool js_fire_event(jsthread *thread, const char *type,
		   struct dom_document *doc, struct dom_node *target)
{
	struct dom_event *evt;
	struct dom_element *body = NULL;
	dom_string *type_dom;
	bool success = false;

	if (thread == NULL || thread->closed) {
		return true;
	}
	if (strcmp(type, "load") == 0) {
		vita_log("qjs: load event, runtime memory %u KB",
			 runtime_kb(thread->heap->rt));
	}
	type_dom = to_dom_string(type);
	if (type_dom == NULL) {
		return true;
	}
	if (dom_event_create(&evt) != DOM_NO_ERR) {
		dom_string_unref(type_dom);
		return true;
	}
	dom_event_init(evt, type_dom, true, true);
	dom_string_unref(type_dom);

	if (target != NULL) {
		dom_event_target_dispatch_event(target, evt, &success);
	} else if (doc != NULL) {
		/*
		 * Window-targetted events (load) go to the body element and
		 * bubble up to the document node, where window and document
		 * listeners are registered.
		 */
		dom_html_document_get_body(doc, &body);
		if (body != NULL) {
			dom_event_target_dispatch_event(body, evt, &success);
			dom_node_unref((struct dom_node *)body);
		} else {
			dom_event_target_dispatch_event(doc, evt, &success);
		}
	}
	dom_event_unref(evt);
	return true;
}

bool js_dom_event_add_listener(jsthread *thread,
			       struct dom_document *document,
			       struct dom_node *node,
			       struct dom_string *event_type_dom,
			       void *js_funcval)
{
	/*
	 * This entry point is used by the Duktape bindings' inline handler
	 * registration (onclick attributes and the like). The QuickJS
	 * bindings register listeners through addEventListener instead, and
	 * inline on* attributes are not wired up, so there is nothing to do.
	 */
	(void)thread;
	(void)document;
	(void)node;
	(void)event_type_dom;
	(void)js_funcval;
	return false;
}

/*
 * Register inline handlers (onclick="..." and the like) on a freshly
 * inserted element: each on* attribute becomes a function taking `event`
 * and is added as a listener for the event named after the attribute.
 */
void js_handle_new_element(jsthread *thread, struct dom_element *node)
{
	struct dom_namednodemap *attrs = NULL;
	uint32_t n = 0, i;
	bool has = false;
	JSContext *ctx;

	if (thread == NULL || thread->closed || node == NULL) {
		return;
	}
	/* called for every inserted element, so leave quickly when nothing to do */
	if (dom_node_has_attributes(node, &has) != DOM_NO_ERR || !has) {
		return;
	}
	if (dom_node_get_attributes(node, &attrs) != DOM_NO_ERR || attrs == NULL) {
		return;
	}
	ctx = thread->ctx;
	dom_namednodemap_get_length(attrs, &n);
	for (i = 0; i < n; i++) {
		struct dom_node *attr = NULL;
		dom_string *name = NULL, *value = NULL;
		const char *aname;

		if (dom_namednodemap_item(attrs, i, &attr) != DOM_NO_ERR ||
		    attr == NULL) {
			continue;
		}
		dom_attr_get_name(attr, &name);
		aname = name != NULL ? dom_string_data(name) : NULL;
		if (aname != NULL && aname[0] == 'o' && aname[1] == 'n' &&
		    aname[2] != 0) {
			dom_attr_get_value(attr, &value);
			if (value != NULL) {
				size_t vlen = dom_string_byte_length(value);
				size_t blen = vlen + 48;
				char *body = malloc(blen);
				if (body != NULL) {
					JSValue fn;
					int len = snprintf(body, blen,
						"(function(event){%.*s\n})",
						(int)vlen, dom_string_data(value));
					fn = JS_Eval(ctx, body, (size_t)len,
						     "<inline handler>",
						     JS_EVAL_TYPE_GLOBAL);
					if (JS_IsException(fn)) {
						qjs_report_exception(ctx);
					} else {
						JSValue type = JS_NewString(ctx, aname + 2);
						add_listener(ctx, (struct dom_node *)node,
							     type, fn);
						JS_FreeValue(ctx, type);
					}
					JS_FreeValue(ctx, fn);
					free(body);
				}
				dom_string_unref(value);
			}
		}
		if (name != NULL) dom_string_unref(name);
		dom_node_unref(attr);
	}
	dom_namednodemap_unref(attrs);
}

void js_event_cleanup(jsthread *thread, struct dom_event *evt)
{
	(void)thread;
	(void)evt;
}
