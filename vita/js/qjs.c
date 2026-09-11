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
#include <string.h>

#include <quickjs.h>

#include "utils/errors.h"
#include "utils/nsurl.h"
#include "utils/corestrings.h"
#include "netsurf/browser_window.h"
#include "netsurf/misc.h"
#include "netsurf/mouse.h"
#include "content/urldb.h"
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

/* ------------------------------------------------------------------------ */
/* Heap and thread                                                          */

struct jsheap {
	JSRuntime *rt;
	int timeout;          /**< script time budget, seconds */
	bool pending_destroy;
	int live_threads;
};

struct js_listener;

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
	struct js_listener *listeners; /**< event listeners, freed on close */
	struct js_timer *timers;       /**< live timers, cancelled on close */
	struct js_wrapper *wrappers[WRAPPER_BUCKETS];
	bool closed;
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
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_EXCEPTION;
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
	}
	if (s != NULL) JS_FreeCString(ctx, s);
	return JS_UNDEFINED;
}

static JSValue node_get_attr_prop(JSContext *ctx, JSValueConst this_val,
				  const char *name)
{
	struct dom_node *node = this_node(ctx, this_val);
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
	struct dom_node *node = this_node(ctx, this_val);
	const char *s = JS_ToCString(ctx, val);
	dom_string *key = to_dom_string(name);
	dom_string *dv = to_dom_string(s != NULL ? s : "");

	if (node != NULL && key != NULL && dv != NULL) {
		dom_element_set_attribute(node, key, dv);
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
	struct dom_node *node = this_node(ctx, this_val);
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
	struct dom_node *node = this_node(ctx, this_val);
	const char *name, *value;
	dom_string *key, *val;

	if (node == NULL || argc < 2) return JS_UNDEFINED;
	name = JS_ToCString(ctx, argv[0]);
	value = JS_ToCString(ctx, argv[1]);
	key = to_dom_string(name);
	val = to_dom_string(value != NULL ? value : "");
	if (node != NULL && key != NULL && val != NULL) {
		dom_element_set_attribute(node, key, val);
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
	struct dom_node *node = this_node(ctx, this_val);
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
	struct dom_node *node = this_node(ctx, this_val);
	const char *name;
	dom_string *key;

	if (node == NULL || argc < 1) return JS_UNDEFINED;
	name = JS_ToCString(ctx, argv[0]);
	key = to_dom_string(name);
	if (key != NULL) {
		dom_element_remove_attribute(node, key);
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
	key = to_dom_string(name);
	if (key != NULL) {
		dom_element_get_elements_by_tag_name(node, key, &list);
		dom_string_unref(key);
	}
	if (name) JS_FreeCString(ctx, name);
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
	if (htmlnode == NULL) goto out;
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
	JSValue global, event_obj, ret, args[1];

	if (thread == NULL || thread->closed) {
		return;
	}
	ctx = thread->ctx;
	begin_script(thread);
	/* this is the element the listener was added to */
	global = wrap_node(ctx, l->node);
	event_obj = wrap_event(ctx, evt);
	args[0] = event_obj;
	ret = JS_Call(ctx, l->func, global, 1, args);
	if (JS_IsException(ret)) {
		qjs_report_exception(ctx);
	}
	JS_FreeValue(ctx, ret);
	JS_FreeValue(ctx, event_obj);
	JS_FreeValue(ctx, global);
	end_script(thread);
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
 * Bindings that are simplest to express in JS. They run once per page
 * context; Node is the shared prototype of every wrapped DOM node.
 */
static const char prelude_js[] =
"(function(){\n"
"var P=Node.prototype;\n"
"function priv(o,k,make){if(!Object.prototype.hasOwnProperty.call(o,k))"
"Object.defineProperty(o,k,{value:make(),writable:true});return o[k];}\n"
"Object.defineProperty(P,'style',{get:function(){return priv(this,'__style',function(){"
"return {getPropertyValue:function(){return '';},setProperty:function(){},removeProperty:function(){},cssText:''};});}});\n"
"Object.defineProperty(P,'dataset',{get:function(){return priv(this,'__dataset',function(){return {};});}});\n"
"Object.defineProperty(P,'classList',{get:function(){var el=this;return {"
"contains:function(c){return (' '+el.className+' ').indexOf(' '+c+' ')>=0;},"
"add:function(){for(var i=0;i<arguments.length;i++){if(!this.contains(arguments[i]))el.className=(el.className?el.className+' ':'')+arguments[i];}},"
"remove:function(){for(var i=0;i<arguments.length;i++){el.className=(' '+el.className+' ').split(' '+arguments[i]+' ').join(' ').trim();}},"
"toggle:function(c,f){var h=this.contains(c);if(f===undefined)f=!h;if(f&&!h)this.add(c);else if(!f&&h)this.remove(c);return f;},"
"get length(){return el.className?el.className.split(/\\s+/).length:0;}};}});\n"
"Object.defineProperty(P,'children',{get:function(){return this.childNodes.filter(function(n){return n.nodeType===1;});}});\n"
"Object.defineProperty(P,'firstElementChild',{get:function(){var c=this.children;return c.length?c[0]:null;}});\n"
"Object.defineProperty(P,'lastElementChild',{get:function(){var c=this.children;return c.length?c[c.length-1]:null;}});\n"
"Object.defineProperty(P,'parentElement',{get:function(){var p=this.parentNode;return p&&p.nodeType===1?p:null;}});\n"
"Object.defineProperty(P,'innerText',{get:function(){return this.textContent;},set:function(v){this.textContent=v;}});\n"
"Object.defineProperty(P,'outerHTML',{get:function(){return '';}});\n"
"Object.defineProperty(P,'ownerDocument',{get:function(){return document;}});\n"
"['href','src','value','type','name','title','alt','rel','target','action','method','placeholder','lang','dir','htmlFor','content','charset','width','height'].forEach(function(a){"
"var attr=a==='htmlFor'?'for':a;Object.defineProperty(P,a,{get:function(){var v=this.getAttribute(attr);return v===null?'':v;},set:function(v){this.setAttribute(attr,String(v));}});});\n"
"['disabled','checked','hidden','readOnly','selected','multiple','required'].forEach(function(a){var attr=a.toLowerCase();"
"Object.defineProperty(P,a,{get:function(){return this.hasAttribute(attr);},set:function(v){if(v)this.setAttribute(attr,'');else this.removeAttribute(attr);}});});\n"
"['offsetWidth','offsetHeight','offsetTop','offsetLeft','clientWidth','clientHeight','clientTop','clientLeft','scrollWidth','scrollHeight'].forEach(function(a){"
"Object.defineProperty(P,a,{get:function(){return 0;}});});\n"
"P.scrollTop=0;P.scrollLeft=0;P.tabIndex=0;\n"
"['onclick','onchange','onsubmit','oninput','onkeydown','onkeyup','onkeypress','onmousedown','onmouseup','onmouseover','onmouseout','onfocus','onblur','onload','onerror','ontouchstart','ontouchend'].forEach(function(h){"
"Object.defineProperty(P,h,{get:function(){return this['__'+h]||null;},set:function(f){this['__'+h]=f;if(typeof f==='function')this.addEventListener(h.slice(2),function(e){return f.call(this,e);});}});});\n"
"P.getBoundingClientRect=function(){return {top:0,left:0,right:0,bottom:0,width:0,height:0,x:0,y:0};};\n"
"P.getClientRects=function(){return [];};\n"
"P.focus=P.blur=P.scrollIntoView=P.click=P.select=function(){};\n"
"P.contains=function(n){while(n){if(n===this)return true;n=n.parentNode;}return false;};\n"
"P.hasChildNodes=function(){return this.firstChild!==null;};\n"
"P.remove=function(){var p=this.parentNode;if(p)p.removeChild(this);};\n"
"P.getElementsByClassName=function(c){return this.querySelectorAll('.'+c);};\n"
"function parseSimple(sel){var m=sel.match(/^([a-zA-Z][\\w-]*|\\*)?(#[\\w-]+)?((?:\\.[\\w-]+)*)(\\[[^\\]]*\\])?$/);if(!m)return null;"
"return {tag:m[1]&&m[1]!=='*'?m[1].toUpperCase():null,id:m[2]?m[2].slice(1):null,classes:m[3]?m[3].split('.').slice(1):[],attr:m[4]?m[4].slice(1,-1).split('=')[0].replace(/\"/g,''):null};}\n"
"function matchSimple(el,q){if(el.nodeType!==1)return false;if(q.tag&&el.tagName.toUpperCase()!==q.tag)return false;if(q.id&&el.id!==q.id)return false;"
"for(var i=0;i<q.classes.length;i++)if(!el.classList.contains(q.classes[i]))return false;if(q.attr&&!el.hasAttribute(q.attr))return false;return true;}\n"
"function matchesCompound(el,parts){var i=parts.length-1;if(!matchSimple(el,parts[i]))return false;var n=el.parentNode;i--;"
"while(i>=0&&n&&n.nodeType===1){if(matchSimple(n,parts[i]))i--;n=n.parentNode;}return i<0;}\n"
"function compile(selector){return selector.split(',').map(function(s){return s.trim().split(/\\s*>\\s*|\\s+/).map(parseSimple);}).filter(function(p){return p.every(function(x){return x;});});}\n"
"function collect(root,groups,all,out){var c=root.firstChild;while(c){if(c.nodeType===1){for(var g=0;g<groups.length;g++){if(matchesCompound(c,groups[g])){out.push(c);break;}}"
"if(!all&&out.length)return out;collect(c,groups,all,out);if(!all&&out.length)return out;}c=c.nextSibling;}return out;}\n"
"P.querySelectorAll=function(sel){return collect(this,compile(String(sel)),true,[]);};\n"
"P.querySelector=function(sel){var r=collect(this,compile(String(sel)),false,[]);return r.length?r[0]:null;};\n"
"P.matches=P.webkitMatchesSelector=P.msMatchesSelector=function(sel){var el=this;return compile(String(sel)).some(function(g){return matchesCompound(el,g);});};\n"
"P.closest=function(sel){var n=this;while(n&&n.nodeType===1){if(n.matches(sel))return n;n=n.parentNode;}return null;};\n"
"P.dispatchEvent=function(){return true;};\n"
"var D=document;\n"
"D.querySelectorAll=function(s){var r=D.documentElement;return r?r.querySelectorAll(s):[];};\n"
"D.querySelector=function(s){var r=D.documentElement;return r?r.querySelector(s):null;};\n"
"D.getElementsByClassName=function(c){return D.querySelectorAll('.'+c);};\n"
"Object.defineProperty(D,'head',{get:function(){var h=D.getElementsByTagName('head');return h.length?h[0]:null;}});\n"
"Object.defineProperty(D,'forms',{get:function(){return D.getElementsByTagName('form');}});\n"
"Object.defineProperty(D,'images',{get:function(){return D.getElementsByTagName('img');}});\n"
"Object.defineProperty(D,'links',{get:function(){return D.getElementsByTagName('a');}});\n"
"Object.defineProperty(D,'scripts',{get:function(){return D.getElementsByTagName('script');}});\n"
"D.defaultView=window;D.nodeType=9;D.nodeName='#document';D.documentMode=undefined;D.compatMode='CSS1Compat';D.hidden=false;D.visibilityState='visible';\n"
"D.createEvent=function(t){return /custom/i.test(t)?new CustomEvent(''):new Event('');};D.dispatchEvent=function(){return true;};D.hasFocus=function(){return true;};\n"
"D.createElementNS=function(ns,t){return D.createElement(t);};D.createAttribute=function(n){return {name:n,value:''};};\n"
"D.implementation={createHTMLDocument:function(){return D;},createDocument:function(){return D;},hasFeature:function(){return true;}};\n"
"D.currentScript=null;D.characterSet=D.charset='UTF-8';D.referrer='';D.domain='';\n"
"Object.defineProperty(D,'URL',{get:function(){return location.href;}});Object.defineProperty(D,'documentURI',{get:function(){return location.href;}});\n"
"Object.defineProperty(D,'activeElement',{get:function(){return D.body;}});\n"
"D.createComment=function(t){return D.createTextNode('');};D.write=D.writeln=function(){};\n"
"D.getElementsByName=function(n){return D.querySelectorAll('[name='+n+']').filter(function(e){return e.getAttribute('name')===n;});};\n"
"D.contains=function(n){var r=D.documentElement;return r?r.contains(n):false;};\n"
"['onload','onreadystatechange','onclick','onkeydown','onkeyup','onmousemove','ontouchstart'].forEach(function(h){"
"Object.defineProperty(D,h,{get:function(){return D['__'+h]||null;},set:function(f){D['__'+h]=f;if(typeof f==='function')D.addEventListener(h.slice(2),f);}});});\n"
"var W=window;\n"
"['onload','onerror','onresize','onscroll','onhashchange','onpopstate','onunload','onbeforeunload','onmessage','onpageshow','onclick','onkeydown','onkeyup','ontouchstart'].forEach(function(h){"
"Object.defineProperty(W,h,{get:function(){return W['__'+h]||null;},set:function(f){W['__'+h]=f;if(typeof f==='function'&&h!=='onerror')W.addEventListener(h.slice(2),f);}});});\n"
"W.dispatchEvent=function(){return true;};\n"
"W.innerWidth=W.outerWidth=960;W.innerHeight=W.outerHeight=544;W.devicePixelRatio=1;W.scrollX=W.pageXOffset=0;W.scrollY=W.pageYOffset=0;\n"
"W.screen={width:960,height:544,availWidth:960,availHeight:544,colorDepth:32,pixelDepth:32,orientation:{type:'landscape-primary'}};\n"
"W.scrollTo=W.scrollBy=W.scroll=W.focus=W.blur=W.stop=W.print=W.close=function(){};W.open=function(){return null;};\n"
"W.confirm=function(){return false;};W.prompt=function(){return null;};\n"
"W.requestAnimationFrame=function(f){return setTimeout(function(){f(Date.now());},16);};W.cancelAnimationFrame=function(h){clearTimeout(h);};\n"
"W.requestIdleCallback=function(f){return setTimeout(function(){f({didTimeout:false,timeRemaining:function(){return 10;}});},50);};W.cancelIdleCallback=function(h){clearTimeout(h);};\n"
"W.getComputedStyle=function(el){return el&&el.style?el.style:{getPropertyValue:function(){return '';}};};\n"
"W.matchMedia=function(q){return {matches:false,media:q,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){}};};\n"
"function Storage(){var d={};this.getItem=function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null;};this.setItem=function(k,v){d[k]=String(v);};"
"this.removeItem=function(k){delete d[k];};this.clear=function(){d={};};this.key=function(i){return Object.keys(d)[i]||null;};Object.defineProperty(this,'length',{get:function(){return Object.keys(d).length;}});}\n"
"W.localStorage=new Storage();W.sessionStorage=new Storage();\n"
"W.history={length:1,state:null,pushState:function(){},replaceState:function(){},back:function(){},forward:function(){},go:function(){}};\n"
"var t0=Date.now();var perf=W.performance||{};W.performance=perf;if(!perf.now)perf.now=function(){return Date.now()-t0;};"
"perf.timing={navigationStart:t0,fetchStart:t0,domainLookupStart:t0,domainLookupEnd:t0,connectStart:t0,connectEnd:t0,requestStart:t0,responseStart:t0,responseEnd:t0,domLoading:t0,domInteractive:t0,domContentLoadedEventStart:t0,domContentLoadedEventEnd:t0,domComplete:t0,loadEventStart:t0,loadEventEnd:t0};"
"perf.navigation={type:0,redirectCount:0};perf.mark=perf.measure=perf.clearMarks=perf.clearMeasures=function(){};perf.getEntries=perf.getEntriesByType=perf.getEntriesByName=function(){return [];};\n"
"navigator.language='en-US';navigator.languages=['en-US','en'];navigator.cookieEnabled=true;navigator.onLine=true;navigator.doNotTrack=null;navigator.maxTouchPoints=1;navigator.vendor='';navigator.hardwareConcurrency=1;navigator.sendBeacon=function(){return false;};navigator.javaEnabled=function(){return false;};\n"
"location.reload=function(){location.href=location.href;};\n"
"['protocol','host','hostname','port','pathname','search','hash','origin'].forEach(function(k){Object.defineProperty(location,k,{get:function(){"
"var m=location.href.match(/^([a-z][a-z0-9+.-]*:)\\/\\/(([^\\/:?#]*)(?::(\\d+))?)([^?#]*)(\\?[^#]*)?(#.*)?/i)||[];"
"return {protocol:m[1]||'',host:m[2]||'',hostname:m[3]||'',port:m[4]||'',pathname:m[5]||'/',search:m[6]||'',hash:m[7]||'',origin:(m[1]||'')+'//'+(m[2]||'')}[k];}});});\n"
"location.toString=function(){return location.href;};\n"
"function Event(type,init){this.type=String(type);this.bubbles=!!(init&&init.bubbles);this.cancelable=!!(init&&init.cancelable);this.defaultPrevented=false;this.target=null;this.currentTarget=null;this.timeStamp=Date.now();}\n"
"Event.prototype.preventDefault=function(){this.defaultPrevented=true;};Event.prototype.stopPropagation=Event.prototype.stopImmediatePropagation=function(){};"
"Event.prototype.initEvent=function(t,b,c){this.type=t;this.bubbles=!!b;this.cancelable=!!c;};\n"
"function CustomEvent(type,init){Event.call(this,type,init);this.detail=init?init.detail:null;}CustomEvent.prototype=Object.create(Event.prototype);\n"
"CustomEvent.prototype.initCustomEvent=function(t,b,c,d){this.initEvent(t,b,c);this.detail=d;};\n"
"W.Event=Event;W.CustomEvent=CustomEvent;W.UIEvent=W.MouseEvent=W.KeyboardEvent=W.FocusEvent=Event;\n"
"W.HTMLDocument=W.Document=function(){};W.Document.prototype=Object.getPrototypeOf(D);\n"
"W.NodeList=W.HTMLCollection=Array;\n"
"['CharacterData','Text','Comment','Attr','DocumentFragment','DocumentType','ShadowRoot','SVGElement','SVGSVGElement','HTMLUnknownElement','HTMLAnchorElement','HTMLAreaElement','HTMLAudioElement','HTMLBaseElement','HTMLBodyElement','HTMLBRElement','HTMLButtonElement','HTMLCanvasElement','HTMLDataElement','HTMLDataListElement','HTMLDetailsElement','HTMLDialogElement','HTMLDivElement','HTMLDListElement','HTMLEmbedElement','HTMLFieldSetElement','HTMLFontElement','HTMLFormElement','HTMLFrameElement','HTMLFrameSetElement','HTMLHeadElement','HTMLHeadingElement','HTMLHRElement','HTMLHtmlElement','HTMLIFrameElement','HTMLImageElement','HTMLInputElement','HTMLLabelElement','HTMLLegendElement','HTMLLIElement','HTMLLinkElement','HTMLMapElement','HTMLMarqueeElement','HTMLMediaElement','HTMLMenuElement','HTMLMetaElement','HTMLMeterElement','HTMLModElement','HTMLObjectElement','HTMLOListElement','HTMLOptGroupElement','HTMLOptionElement','HTMLOutputElement','HTMLParagraphElement','HTMLParamElement','HTMLPictureElement','HTMLPreElement','HTMLProgressElement','HTMLQuoteElement','HTMLScriptElement','HTMLSelectElement','HTMLSlotElement','HTMLSourceElement','HTMLSpanElement','HTMLStyleElement','HTMLTableCaptionElement','HTMLTableCellElement','HTMLTableColElement','HTMLTableElement','HTMLTableRowElement','HTMLTableSectionElement','HTMLTemplateElement','HTMLTextAreaElement','HTMLTimeElement','HTMLTitleElement','HTMLTrackElement','HTMLUListElement','HTMLVideoElement'].forEach(function(n){W[n]=Element;});\n"
"W.Window=function(){};W.Window.prototype=Object.getPrototypeOf(W);W.Navigator=W.Location=W.History=W.Screen=W.Storage=Storage;\n"
"W.MutationObserver=function(){};W.MutationObserver.prototype.observe=W.MutationObserver.prototype.disconnect=function(){};W.MutationObserver.prototype.takeRecords=function(){return [];};\n"
"W.IntersectionObserver=W.ResizeObserver=W.PerformanceObserver=function(){};W.IntersectionObserver.prototype.observe=W.IntersectionObserver.prototype.unobserve=W.IntersectionObserver.prototype.disconnect=function(){};"
"W.ResizeObserver.prototype=W.PerformanceObserver.prototype=W.IntersectionObserver.prototype;\n"
"W.atob=function(s){s=String(s).replace(/[^A-Za-z0-9+\\/=]/g,'');var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',o='',i=0;while(i<s.length){var a=A.indexOf(s.charAt(i++)),b=A.indexOf(s.charAt(i++)),c=A.indexOf(s.charAt(i++)),d=A.indexOf(s.charAt(i++));var n=(a<<18)|(b<<12)|((c&63)<<6)|(d&63);o+=String.fromCharCode((n>>16)&255);if(c!==64&&c>=0)o+=String.fromCharCode((n>>8)&255);if(d!==64&&d>=0)o+=String.fromCharCode(n&255);}return o;};\n"
"W.btoa=function(s){s=String(s);var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',o='',i=0;while(i<s.length){var a=s.charCodeAt(i++),b=s.charCodeAt(i++),c=s.charCodeAt(i++);var n=(a<<16)|((b||0)<<8)|(c||0);o+=A.charAt((n>>18)&63)+A.charAt((n>>12)&63)+(isNaN(b)?'=':A.charAt((n>>6)&63))+(isNaN(c)?'=':A.charAt(n&63));}return o;};\n"
"function Image(){return document.createElement('img');}W.Image=Image;\n"
"function Option(t,v){var o=document.createElement('option');if(t!==undefined)o.textContent=t;if(v!==undefined)o.setAttribute('value',v);return o;}W.Option=Option;\n"
"})();\n";

static void install_object(JSContext *ctx, JSValue parent, const char *name,
			   const JSCFunctionListEntry *tab, size_t n)
{
	JSValue obj = JS_NewObject(ctx);

	JS_SetPropertyFunctionList(ctx, obj, tab, (int)n);
	JS_SetPropertyStr(ctx, parent, name, obj);
}

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
		JSValue r = JS_Eval(ctx, prelude_js, sizeof(prelude_js) - 1,
				    "<prelude>", JS_EVAL_TYPE_GLOBAL);
		if (JS_IsException(r)) {
			qjs_report_exception_src(ctx, "<prelude>", prelude_js,
						 sizeof(prelude_js) - 1);
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
	free_wrappers(thread);
	JS_FreeContext(thread->ctx);
	thread->ctx = NULL;
	JS_RunGC(thread->heap->rt);
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

bool js_exec(jsthread *thread, const uint8_t *txt, size_t txtlen, const char *name)
{
	JSValue ret;
	bool ok;
	char *src;

	if (thread == NULL || thread->closed || txt == NULL || txtlen == 0) {
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
	ret = JS_Eval(thread->ctx, src, txtlen, name, JS_EVAL_TYPE_GLOBAL);
	ok = !JS_IsException(ret);
	if (!ok) {
		qjs_report_exception_src(thread->ctx, name, src, txtlen);
	}
	JS_FreeValue(thread->ctx, ret);
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
