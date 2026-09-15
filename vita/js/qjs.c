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
#include "utils/utils.h"
#include "utils/nsurl.h"
#include "utils/corestrings.h"
#include "netsurf/browser_window.h"
#include "netsurf/misc.h"
#include "netsurf/mouse.h"
#include "netsurf/window.h"
#include "content/urldb.h"
#include "content/fetch.h"
#include "content/hlcache.h"
#include "content/handlers/javascript/js.h"
#include "content/handlers/javascript/content.h"

#include <dom/dom.h>
#include <dom/bindings/hubbub/parser.h>
#include <nsutils/time.h>

#include "utils/useragent.h"

#include "vita_platform.h"

/* JavaScript's share of the C stack: see js_newheap. */
#define JS_STACK_DEFAULT (1024 * 1024)
#define JS_STACK_MAX     (2 * 1024 * 1024)
#define JS_STACK_MIN     (96 * 1024)

/* guit->misc->schedule lives behind the core's gui table. */
#include "desktop/gui_internal.h"
#include "netsurf/misc.h"

/* html_content, for the document node and browser window. */
#include "content/handlers/html/private.h"
/* struct html_script, to find a module the page already fetched. */
#include "content/handlers/html/html.h"
#include "netsurf/content.h"
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
	/*
	 * The thread the runtime's interrupt handler was last pointed at.
	 * The runtime outlives any one page, and the handler reads the
	 * thread's deadline on every call, so a thread that is freed
	 * without clearing this leaves the handler reading freed memory
	 * until the next page installs its own.
	 */
	struct jsthread *interrupt_thread;
};

struct js_listener;
struct js_xhr;

/*
 * A module script that named an import nothing had yet. The import
 * starts a fetch; the script waits here and is compiled again once it
 * arrives, which is what a browser does with a module graph. Without
 * this the first miss was fatal and the page never started: a bundler
 * that splits its code imports a chunk the document never declared.
 */
struct js_deferred {
	struct js_deferred *next;
	char *src;
	size_t len;
	char *name;
	int tries;
	unsigned progress;  /**< the progress count when it last failed */
};

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
	/*
	 * How the running script's overrun has been reported. QuickJS
	 * raises an ordinary exception when the interrupt handler says
	 * stop, and a page wrapped in try/catch swallows it and carries
	 * on, so the handler fires again a moment later and keeps firing.
	 * YouTube did that for eighteen minutes and wrote eighteen
	 * thousand identical lines, each one flushed to the memory card.
	 */
	unsigned script_depth;    /**< nested entries from C into script */
	bool aborting;            /**< the budget is unwinding a script */
	unsigned scripts_killed;  /**< scripts the budget stopped, this page */
	unsigned overrun_count;   /**< interrupts past the deadline */
	uint64_t overrun_said_ms; /**< when that was last logged */
	const char *current_script; /**< URL of the script js_exec is running */
	struct js_listener *listeners; /**< event listeners, freed on close */
	/**
	 * document.readyState. It was the fixed string "interactive", and
	 * the usual guard is
	 *   if (document.readyState === 'loading') wait for DOMContentLoaded
	 *   else run now
	 * so a page's setup ran against a document still being parsed.
	 */
	const char *ready_state;
	/**
	 * Whether a MutationObserver is watching. Reporting every mutation
	 * to JavaScript costs a call per change, so nothing is reported
	 * until a page asks for it, and a page that never uses one pays
	 * nothing at all.
	 */
	bool watch_mutations;
	struct js_timer *timers;       /**< live timers, cancelled on close */
	struct js_wrapper *wrappers[WRAPPER_BUCKETS];
	struct js_xhr *xhrs;           /**< requests in flight */
	int next_xhr_id;
	bool closed;
	bool dom_dirty;           /**< scripts changed the DOM since the last layout */
	bool relayout_pending;    /**< relayout_callback is scheduled */
	bool relayout_off;        /**< document too large to rebuild */
	unsigned dom_elements;    /**< elements in the document, 0 if not counted */
	unsigned relayout_ms;     /**< how long the last rebuild took */
	unsigned js_scripts;      /**< scripts executed for this page */
	unsigned js_bytes;        /**< their total size */
	unsigned js_compile_ms;   /**< time spent compiling them */
	unsigned js_run_ms;       /**< time spent running them */
	unsigned js_modules;      /**< of those, compiled as ES modules */
	unsigned js_imports_missed; /**< imports that resolved to nothing */
	unsigned js_import_fetches; /**< chunks the loader went and fetched */
	unsigned retry_delay_ms;  /**< how long before the next retry round */
	struct js_deferred *deferred; /**< module scripts waiting on imports */
	bool deferred_scheduled;
	JSValue import_map;       /**< parsed <script type="importmap">, or
				   *   JS_UNINITIALIZED before it is looked
				   *   up and JS_UNDEFINED if there is none */
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
	dom_string *type;	/**< kept, to match a remove against */
	bool capture;
	bool once;
	bool passive;		/**< preventDefault from it is ignored */
	bool dead;		/**< removed while its own call was running */
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
#define RELAYOUT_MAX_DELAY_MS 8000 /**< longest wait a slow page earns */
/*
 * A rebuild costs a full box construction and style selection for the
 * whole document, and it runs in one go. On a Wikipedia article, which
 * is about five and a half thousand elements, that is tens of seconds on
 * the Vita and the browser is frozen for all of it, which is a far worse
 * page than the one the rebuild would have improved. Documents above
 * this size therefore keep the layout they were parsed with.
 */
#define RELAYOUT_MAX_ELEMENTS 6000

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
		uint64_t now = now_ms();

		thread->overrun_count++;
		/* The first one, then at most one line every 30 seconds.
		 * The abort is uncatchable, so a second interrupt means
		 * the script resumed some other way -- a fresh call in
		 * from C, or a callback whose exception was dropped --
		 * and that is worth saying out loud, but only as often
		 * as it takes to see it. */
		if (thread->overrun_count == 1) {
			vita_log("qjs: script exceeded its time budget: %s",
				 thread->current_script != NULL ?
				 thread->current_script : "?");
			thread->overrun_said_ms = now;
		} else if (now - thread->overrun_said_ms >= 30000) {
			vita_log("qjs: script still over budget, aborted %u "
				 "times and resumed every time",
				 thread->overrun_count);
			thread->overrun_said_ms = now;
		}
		thread->aborting = true;
		return 1; /* abort */
	}
	return 0;
}

/*
 * True while the time budget is unwinding a script on this context.
 *
 * The value QuickJS throws for an interrupt is null, not an Error, so
 * there is nothing in the exception itself to recognise it by -- and
 * merely fetching it with JS_GetException clears the flag that makes it
 * uncatchable. C code asks here instead, and leaves the exception alone.
 */
static bool qjs_budget_abort(JSContext *ctx)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	return thread != NULL && thread->aborting;
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
static void js_free_deferred(jsthread *thread);
/* Persistent storage, defined with the rest of the on-disk code below. */
static JSValue win_vita_store_load(JSContext *ctx, JSValueConst this_val,
				   int argc, JSValueConst *argv);
static JSValue win_vita_store_save(JSContext *ctx, JSValueConst this_val,
				   int argc, JSValueConst *argv);
static void qjs_report_exception_src(JSContext *ctx, const char *name,
				     const char *src, size_t len)
{
	JSValue exc;
	const char *msg;

	/*
	 * The time-budget abort is not the page's error to hear about. It
	 * is already logged where it was raised, and fetching it here to
	 * report it would clear it -- which is how a script that overran
	 * inside a callback used to carry on. Leave it pending and let it
	 * keep unwinding; end_script drops it once the outermost call into
	 * script is over.
	 */
	if (qjs_budget_abort(ctx)) {
		return;
	}
	exc = JS_GetException(ctx);
	msg = JS_ToCString(ctx, exc);

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
	/*
	 * Tell the page. window.onerror and the error event never fired
	 * here, so a script that installs a handler to fall back when
	 * something throws -- which is what onerror is for -- never heard
	 * about it, and neither did anything reporting errors.
	 */
	{
		JSValue global = JS_GetGlobalObject(ctx);
		JSValue fn = JS_GetPropertyStr(ctx, global, "__vitaReportError");

		if (JS_IsFunction(ctx, fn)) {
			JSValue args[2], r;

			args[0] = JS_DupValue(ctx, exc);
			args[1] = name != NULL ? JS_NewString(ctx, name)
					       : JS_NULL;
			r = JS_Call(ctx, fn, global, 2, args);
			/* A throwing handler must not re-enter this. */
			if (JS_IsException(r)) {
				JS_FreeValue(ctx, JS_GetException(ctx));
			}
			JS_FreeValue(ctx, r);
			JS_FreeValue(ctx, args[0]);
			JS_FreeValue(ctx, args[1]);
		}
		JS_FreeValue(ctx, fn);
		JS_FreeValue(ctx, global);
	}
	JS_FreeValue(ctx, exc);
}

static void qjs_report_exception(JSContext *ctx)
{
	qjs_report_exception_src(ctx, NULL, NULL, 0);
}

/** True if err stringifies to something containing needle. */
static bool qjs_error_mentions(JSContext *ctx, JSValueConst err,
			       const char *needle)
{
	const char *msg = JS_ToCString(ctx, err);
	bool found;

	if (msg == NULL) {
		return false;
	}
	found = strstr(msg, needle) != NULL;
	JS_FreeCString(ctx, msg);
	return found;
}

/**
 * Deal with an exception from a JS call made under a running script.
 *
 * QuickJS marks the time-budget abort uncatchable on purpose, so that
 * nothing can swallow it and let a runaway script carry on. C code that
 * clears the pending exception defeats exactly that. A mutation
 * notification is called from inside whatever script did the mutating,
 * so clearing there meant the budget could never stop a script that
 * touches the DOM: YouTube's bootstrap ran four minutes past its
 * twenty seconds, aborted thirty-three times a second and resumed every
 * time, because each abort landed on a mutation callback and stopped
 * here.
 *
 * An ordinary error in a callback is still contained. Only the abort
 * goes back up, to reach the script it was meant for.
 */
static void qjs_absorb_or_rethrow(JSContext *ctx)
{
	if (qjs_budget_abort(ctx)) {
		return;		/* leave it pending, and uncatchable */
	}
	JS_FreeValue(ctx, JS_GetException(ctx));
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

/* The same, for text whose length is known: a page may put a NUL in the
 * middle of a string and strlen would cut it there. */
static dom_string *to_dom_string_len(const char *s, size_t len)
{
	dom_string *out = NULL;

	if (s == NULL) {
		return NULL;
	}
	if (dom_string_create((const uint8_t *)s, len, &out) != DOM_NO_ERR) {
		return NULL;
	}
	return out;
}

/* ------------------------------------------------------------------------ */
/* Node wrapper                                                             */

/*
 * Each wrapper owns a reference on its dom_node, dropped in the finalizer,
 * and the thread's cache keeps one wrapper per node so a node fetched
 * twice compares equal. Custom elements depend on that: upgrading swaps an
 * element's prototype, and the swap has to be visible to every later
 * reference to the same node.
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

/*
 * Tell the page's MutationObservers what just changed. kind is
 * "childList", "attributes" or "characterData"; the two extra values
 * mean different things per kind and the prelude sorts them out.
 */
static void notify_mutation_ns(JSContext *ctx, const char *kind,
			       struct dom_node *target,
			       JSValue a, JSValue b, JSValue extra)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	JSValue global, fn;

	if (thread == NULL || thread->watch_mutations == false ||
	    thread->closed) {
		JS_FreeValue(ctx, a);
		JS_FreeValue(ctx, b);
		JS_FreeValue(ctx, extra);
		return;
	}
	global = JS_GetGlobalObject(ctx);
	fn = JS_GetPropertyStr(ctx, global, "__vitaMutation");
	if (JS_IsFunction(ctx, fn)) {
		JSValue args[5], r;

		args[0] = JS_NewString(ctx, kind);
		args[1] = wrap_node(ctx, target);
		args[2] = a;
		args[3] = b;
		args[4] = extra;
		r = JS_Call(ctx, fn, global, 5, args);
		if (JS_IsException(r)) {
			qjs_absorb_or_rethrow(ctx);
		}
		JS_FreeValue(ctx, r);
		JS_FreeValue(ctx, args[0]);
		JS_FreeValue(ctx, args[1]);
	} else {
		JS_FreeValue(ctx, a);
		JS_FreeValue(ctx, b);
		JS_FreeValue(ctx, extra);
	}
	JS_FreeValue(ctx, fn);
	JS_FreeValue(ctx, global);
}

static void notify_mutation(JSContext *ctx, const char *kind,
			    struct dom_node *target, JSValue a, JSValue b)
{
	notify_mutation_ns(ctx, kind, target, a, b, JS_NULL);
}

/*
 * A node that moves leaves its old parent, and an observer watching
 * that parent has to see it go. Only the arrival was reported, so a
 * move looked like an addition out of nowhere.
 */
static void notify_left_parent(JSContext *ctx, struct dom_node *node,
			       struct dom_node *newparent)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_node *old = NULL;
	JSValue gone;

	if (thread == NULL || thread->watch_mutations == false || node == NULL) {
		return;
	}
	if (dom_node_get_parent_node(node, &old) != DOM_NO_ERR || old == NULL) {
		return;
	}
	if (old != newparent) {
		gone = JS_NewArray(ctx);
		JS_SetPropertyUint32(ctx, gone, 0, wrap_node(ctx, node));
		notify_mutation(ctx, "childList", old, JS_NULL, gone);
	}
	dom_node_unref(old);
}

/** The node's children as a JS array, for a before-and-after record. */
static JSValue children_snapshot(JSContext *ctx, struct dom_node *node)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	JSValue arr;
	struct dom_node *child = NULL;
	uint32_t i = 0;

	if (thread == NULL || thread->watch_mutations == false) {
		return JS_UNDEFINED;
	}
	arr = JS_NewArray(ctx);
	if (dom_node_get_first_child(node, &child) != DOM_NO_ERR) {
		return arr;
	}
	while (child != NULL) {
		struct dom_node *next = NULL;

		JS_SetPropertyUint32(ctx, arr, i++, wrap_node(ctx, child));
		dom_node_get_next_sibling(child, &next);
		dom_node_unref(child);
		child = next;
	}
	return arr;
}

/** Turn on mutation reporting; the prelude calls this from observe(). */
static JSValue win_vita_watch_mutations(JSContext *ctx, JSValueConst this_val,
					int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	(void)this_val;
	if (thread != NULL && argc > 0) {
		thread->watch_mutations = JS_ToBool(ctx, argv[0]) == 1;
	}
	return JS_UNDEFINED;
}

static JSValue node_set_text_content(JSContext *ctx, JSValueConst this_val,
				     JSValueConst val)
{
	struct dom_node *node = this_node(ctx, this_val);
	/* textContent is a nullable string, so null and undefined both mean
	 * "no text", which empties the node rather than writing "null". */
	bool empty = JS_IsNull(val) || JS_IsUndefined(val);
	size_t len = 0;
	const char *s = empty ? NULL : JS_ToCStringLen(ctx, &len, val);
	dom_string *d;

	if (node == NULL) return JS_EXCEPTION;
	if (s != NULL && len == 0) empty = true;
	d = empty ? to_dom_string("") : to_dom_string_len(s, len);
	if (d != NULL) {
		dom_node_type type = DOM_ELEMENT_NODE;
		JSValue olddata = JS_NULL;

		JSValue before = children_snapshot(ctx, node);

		dom_node_get_node_type(node, &type);
		/* what the text said before, which a characterData record
		 * carries when the observer asked for it */
		if (type == DOM_TEXT_NODE || type == DOM_COMMENT_NODE ||
		    type == DOM_CDATA_SECTION_NODE) {
			jsthread *th = JS_GetContextOpaque(ctx);
			dom_string *was = NULL;

			if (th != NULL && th->watch_mutations &&
			    dom_characterdata_get_data((dom_characterdata *)node,
						       &was) == DOM_NO_ERR &&
			    was != NULL) {
				olddata = JS_NewStringLen(ctx,
					dom_string_data(was),
					dom_string_byte_length(was));
				dom_string_unref(was);
			}
		}
		/*
		 * libdom's generic setter empties the node and appends a
		 * text node as a child, and a text node cannot have one:
		 * textContent = x on one aborted the browser outright.
		 * Character data takes its value directly.
		 */
		if (type == DOM_TEXT_NODE || type == DOM_COMMENT_NODE ||
		    type == DOM_CDATA_SECTION_NODE) {
			dom_characterdata_set_data((dom_characterdata *)node, d);
		} else if (empty) {
			/* An empty string leaves the node with no children at
			 * all; libdom's setter would leave an empty text node
			 * behind, which childNodes and firstChild then see. */
			struct dom_node *child = NULL, *gone = NULL;

			while (dom_node_get_first_child(node, &child) ==
			       DOM_NO_ERR && child != NULL) {
				if (dom_node_remove_child(node, child,
							  &gone) != DOM_NO_ERR) {
					dom_node_unref(child);
					break;
				}
				if (gone != NULL) dom_node_unref(gone);
				dom_node_unref(child);
				child = NULL;
				gone = NULL;
			}
		} else {
			dom_node_set_text_content(node, d);
		}
		dom_string_unref(d);
		mark_dirty(ctx);
		if (type == DOM_TEXT_NODE || type == DOM_COMMENT_NODE ||
		    type == DOM_CDATA_SECTION_NODE) {
			JS_FreeValue(ctx, before);
			notify_mutation(ctx, "characterData", node,
					JS_NULL, olddata);
			olddata = JS_NULL;
		} else {
			notify_mutation(ctx, "childList", node,
					children_snapshot(ctx, node), before);
		}
		if (!JS_IsNull(olddata)) JS_FreeValue(ctx, olddata);
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
		dom_string *old = NULL;
		jsthread *th = JS_GetContextOpaque(ctx);

		if (th != NULL && th->watch_mutations) {
			dom_element_get_attribute(node, key, &old);
		}
		dom_element_set_attribute(node, key, dv);
		mark_dirty(ctx);
		/* className and id are the same attribute write as
		 * setAttribute, and an observer watching class has to see
		 * one: this path reported nothing at all, so a component
		 * that sets className missed every change. */
		notify_mutation(ctx, "attributes", node,
				JS_NewString(ctx, name),
				old != NULL ?
				JS_NewStringLen(ctx, dom_string_data(old),
						dom_string_byte_length(old)) :
				JS_NULL);
		if (old != NULL) dom_string_unref(old);
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

/*
 * element.attributes, as an array of {name, value} with the item() and
 * getNamedItem() a NamedNodeMap answers to. Pages read it to copy an
 * element's attributes, and polyfills walk the name looking for a
 * descriptor, so its absence threw where they patch.
 */
static JSValue node_get_attributes(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_element(ctx, this_val);
	struct dom_namednodemap *map = NULL;
	JSValue arr = JS_NewArray(ctx);
	uint32_t len = 0, i, out = 0;

	if (node == NULL) {
		return arr;
	}
	if (dom_node_get_attributes(node, &map) != DOM_NO_ERR || map == NULL) {
		return arr;
	}
	dom_namednodemap_get_length(map, &len);
	for (i = 0; i < len; i++) {
		struct dom_node *attr = NULL;
		dom_string *name = NULL, *val = NULL;
		JSValue entry;

		if (dom_namednodemap_item(map, i, &attr) != DOM_NO_ERR ||
		    attr == NULL) {
			continue;
		}
		dom_node_get_node_name(attr, &name);
		dom_node_get_node_value(attr, &val);
		entry = JS_NewObject(ctx);
		JS_SetPropertyStr(ctx, entry, "name",
				  name != NULL ?
				  JS_NewStringLen(ctx, dom_string_data(name),
						  dom_string_byte_length(name)) :
				  JS_NewString(ctx, ""));
		JS_SetPropertyStr(ctx, entry, "value",
				  val != NULL ?
				  JS_NewStringLen(ctx, dom_string_data(val),
						  dom_string_byte_length(val)) :
				  JS_NewString(ctx, ""));
		JS_SetPropertyStr(ctx, entry, "specified", JS_TRUE);
		{
			dom_string *ns = NULL, *local = NULL, *prefix = NULL;

			dom_node_get_namespace(attr, &ns);
			dom_node_get_local_name(attr, &local);
			dom_node_get_prefix(attr, &prefix);
			JS_SetPropertyStr(ctx, entry, "namespace",
					  ns != NULL ?
					  JS_NewStringLen(ctx, dom_string_data(ns),
							  dom_string_byte_length(ns)) :
					  JS_NULL);
			JS_SetPropertyStr(ctx, entry, "localName",
					  local != NULL ?
					  JS_NewStringLen(ctx, dom_string_data(local),
							  dom_string_byte_length(local)) :
					  JS_NULL);
			JS_SetPropertyStr(ctx, entry, "prefix",
					  prefix != NULL ?
					  JS_NewStringLen(ctx, dom_string_data(prefix),
							  dom_string_byte_length(prefix)) :
					  JS_NULL);
			if (ns != NULL) dom_string_unref(ns);
			if (local != NULL) dom_string_unref(local);
			if (prefix != NULL) dom_string_unref(prefix);
		}
		if (name != NULL) dom_string_unref(name);
		if (val != NULL) dom_string_unref(val);
		dom_node_unref(attr);
		JS_SetPropertyUint32(ctx, arr, out++, entry);
	}
	dom_namednodemap_unref(map);
	return arr;
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
		dom_string *old = NULL;
		jsthread *th = JS_GetContextOpaque(ctx);

		if (th != NULL && th->watch_mutations) {
			dom_element_get_attribute(node, key, &old);
		}
		dom_element_set_attribute(node, key, val);
		mark_dirty(ctx);
		notify_mutation(ctx, "attributes", node,
				JS_NewString(ctx, name != NULL ? name : ""),
				old != NULL ?
				JS_NewStringLen(ctx, dom_string_data(old),
						dom_string_byte_length(old)) :
				JS_NULL);
		if (old != NULL) dom_string_unref(old);
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
		dom_string *old = NULL;
		jsthread *th = JS_GetContextOpaque(ctx);

		bool had = false;

		dom_element_has_attribute(node, key, &had);
		if (th != NULL && th->watch_mutations) {
			dom_element_get_attribute(node, key, &old);
		}
		dom_element_remove_attribute(node, key);
		mark_dirty(ctx);
		/* removing an attribute that was not there changes nothing,
		 * and nothing is what an observer should see */
		if (had) {
			notify_mutation(ctx, "attributes", node,
					JS_NewString(ctx, name != NULL ? name : ""),
					old != NULL ?
					JS_NewStringLen(ctx, dom_string_data(old),
							dom_string_byte_length(old)) :
					JS_NULL);
		}
		if (old != NULL) dom_string_unref(old);
		dom_string_unref(key);
	}
	if (name) JS_FreeCString(ctx, name);
	return JS_UNDEFINED;
}

/*
 * The namespaced half of the attribute interface. Without it every
 * setAttributeNS landed in the null namespace, so an SVG use element's
 * xlink:href and a document's xmlns were indistinguishable from any
 * other attribute, and removing one removed the wrong one.
 *
 * An empty namespace argument means the null namespace, which is what
 * the specification says and not what an empty dom_string would mean.
 */
static dom_string *ns_arg(JSContext *ctx, JSValueConst v, const char **held)
{
	const char *s;

	*held = NULL;
	if (JS_IsNull(v) || JS_IsUndefined(v)) {
		return NULL;
	}
	s = JS_ToCString(ctx, v);
	if (s == NULL) {
		return NULL;
	}
	if (s[0] == '\0') {
		JS_FreeCString(ctx, s);
		return NULL;
	}
	*held = s;
	return to_dom_string(s);
}

static JSValue node_get_attribute_ns(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *nsheld = NULL, *local;
	dom_string *ns, *key, *val = NULL;
	JSValue r;

	if (node == NULL || argc < 2) return JS_NULL;
	ns = ns_arg(ctx, argv[0], &nsheld);
	local = JS_ToCString(ctx, argv[1]);
	key = to_dom_string(local);
	if (key != NULL) {
		dom_element_get_attribute_ns(node, ns, key, &val);
		dom_string_unref(key);
	}
	if (ns != NULL) dom_string_unref(ns);
	if (nsheld) JS_FreeCString(ctx, nsheld);
	if (local) JS_FreeCString(ctx, local);
	if (val == NULL) return JS_NULL;
	r = JS_NewStringLen(ctx, dom_string_data(val), dom_string_byte_length(val));
	dom_string_unref(val);
	return r;
}

static JSValue node_set_attribute_ns(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *nsheld = NULL, *qname, *value;
	dom_string *ns, *key, *val;

	if (node == NULL || argc < 3) return JS_UNDEFINED;
	ns = ns_arg(ctx, argv[0], &nsheld);
	qname = JS_ToCString(ctx, argv[1]);
	value = JS_ToCString(ctx, argv[2]);
	key = to_dom_string(qname);
	val = to_dom_string(value != NULL ? value : "");
	if (key != NULL && val != NULL) {
		dom_string *old = NULL;
		jsthread *th = JS_GetContextOpaque(ctx);
		const char *local = qname != NULL ? strchr(qname, ':') : NULL;

		local = local != NULL ? local + 1 : qname;
		if (th != NULL && th->watch_mutations) {
			dom_string *lk = to_dom_string(local);

			if (lk != NULL) {
				dom_element_get_attribute_ns(node, ns, lk, &old);
				dom_string_unref(lk);
			}
		}
		dom_element_set_attribute_ns(node, ns, key, val);
		mark_dirty(ctx);
		notify_mutation_ns(ctx, "attributes", node,
				   JS_NewString(ctx, local != NULL ? local : ""),
				   old != NULL ?
				   JS_NewStringLen(ctx, dom_string_data(old),
						   dom_string_byte_length(old)) :
				   JS_NULL,
				   nsheld != NULL ? JS_NewString(ctx, nsheld)
						  : JS_NULL);
		if (old != NULL) dom_string_unref(old);
	}
	if (key) dom_string_unref(key);
	if (val) dom_string_unref(val);
	if (ns != NULL) dom_string_unref(ns);
	if (nsheld) JS_FreeCString(ctx, nsheld);
	if (qname) JS_FreeCString(ctx, qname);
	if (value) JS_FreeCString(ctx, value);
	return JS_UNDEFINED;
}

static JSValue node_has_attribute_ns(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *nsheld = NULL, *local;
	dom_string *ns, *key;
	bool has = false;

	if (node == NULL || argc < 2) return JS_NewBool(ctx, false);
	ns = ns_arg(ctx, argv[0], &nsheld);
	local = JS_ToCString(ctx, argv[1]);
	key = to_dom_string(local);
	if (key != NULL) {
		dom_element_has_attribute_ns(node, ns, key, &has);
		dom_string_unref(key);
	}
	if (ns != NULL) dom_string_unref(ns);
	if (nsheld) JS_FreeCString(ctx, nsheld);
	if (local) JS_FreeCString(ctx, local);
	return JS_NewBool(ctx, has);
}

static JSValue node_remove_attribute_ns(JSContext *ctx, JSValueConst this_val,
					int argc, JSValueConst *argv)
{
	struct dom_node *node = this_element(ctx, this_val);
	const char *nsheld = NULL, *local;
	dom_string *ns, *key;

	if (node == NULL || argc < 2) return JS_UNDEFINED;
	ns = ns_arg(ctx, argv[0], &nsheld);
	local = JS_ToCString(ctx, argv[1]);
	key = to_dom_string(local);
	if (key != NULL) {
		dom_string *old = NULL;
		bool had = false;

		dom_element_has_attribute_ns(node, ns, key, &had);
		dom_element_get_attribute_ns(node, ns, key, &old);
		dom_element_remove_attribute_ns(node, ns, key);
		mark_dirty(ctx);
		if (had) {
			notify_mutation_ns(ctx, "attributes", node,
					   JS_NewString(ctx, local != NULL ? local : ""),
					   old != NULL ?
					   JS_NewStringLen(ctx, dom_string_data(old),
							   dom_string_byte_length(old)) :
					   JS_NULL,
					   nsheld != NULL ? JS_NewString(ctx, nsheld)
							  : JS_NULL);
		}
		if (old != NULL) dom_string_unref(old);
		dom_string_unref(key);
	}
	if (ns != NULL) dom_string_unref(ns);
	if (nsheld) JS_FreeCString(ctx, nsheld);
	if (local) JS_FreeCString(ctx, local);
	return JS_UNDEFINED;
}

/*
 * A whole document of its own, parsed from markup.
 *
 * DOMParser used to hand back a div with the markup inside it, so
 * documentElement, head, body and every document method were missing on
 * something a page had every reason to treat as a document -- and
 * createHTMLDocument had the same stub behind it. This parses into a
 * real libdom document with the same parser the browser uses for a
 * page, scripting off, and wraps the document node.
 */
/*
 * Make a node inside another document. libdom ties every node to the
 * document it was created in and refuses to insert one that belongs
 * somewhere else, so a document parsed by DOMParser needs its own
 * createElement rather than the page's.
 *
 * __vitaCreateIn(doc, kind, name): kind is the node type wanted.
 */
/* A doctype's publicId and systemId, which libdom holds on the node. */
static JSValue node_get_public_id(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;
	dom_node_type t = DOM_ELEMENT_NODE;

	if (node == NULL) return JS_UNDEFINED;
	if (dom_node_get_node_type(node, &t) != DOM_NO_ERR ||
	    t != DOM_DOCUMENT_TYPE_NODE) {
		return JS_UNDEFINED;
	}
	if (dom_document_type_get_public_id((dom_document_type *)node, &s) !=
	    DOM_NO_ERR || s == NULL) {
		return JS_NewString(ctx, "");
	}
	return str_result(ctx, s);
}

static JSValue node_get_system_id(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;
	dom_node_type t = DOM_ELEMENT_NODE;

	if (node == NULL) return JS_UNDEFINED;
	if (dom_node_get_node_type(node, &t) != DOM_NO_ERR ||
	    t != DOM_DOCUMENT_TYPE_NODE) {
		return JS_UNDEFINED;
	}
	if (dom_document_type_get_system_id((dom_document_type *)node, &s) !=
	    DOM_NO_ERR || s == NULL) {
		return JS_NewString(ctx, "");
	}
	return str_result(ctx, s);
}

/* A node's local name and prefix as libdom holds them, rather than
 * guessed from the tag name: an SVG clipPath keeps its capital P, and
 * an element made with a prefix keeps it. */
static JSValue node_get_local_name(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_UNDEFINED;
	if (dom_node_get_local_name(node, &s) != DOM_NO_ERR || s == NULL) {
		return JS_NULL;
	}
	return str_result(ctx, s);
}

static JSValue node_get_prefix(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_NULL;
	if (dom_node_get_prefix(node, &s) != DOM_NO_ERR || s == NULL) {
		return JS_NULL;
	}
	return str_result(ctx, s);
}

static JSValue node_get_namespace_uri(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_NULL;
	if (dom_node_get_namespace(node, &s) != DOM_NO_ERR || s == NULL) {
		return JS_NULL;
	}
	return str_result(ctx, s);
}

static JSValue win_vita_create_in(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	struct dom_node *host, *made = NULL;
	struct dom_document *doc;
	const char *name = NULL;
	dom_string *d = NULL;
	int kind = 1;
	JSValue r;

	if (argc < 2) return JS_NULL;
	host = JS_GetOpaque(argv[0], node_class_id);
	if (host == NULL) return JS_NULL;
	if (JS_ToInt32(ctx, &kind, argv[1]) != 0) return JS_NULL;
	if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
		name = JS_ToCString(ctx, argv[2]);
	}
	d = to_dom_string(name != NULL ? name : "");
	/* the document a node belongs to, which for a document is itself */
	{
		dom_node_type t = DOM_ELEMENT_NODE;

		dom_node_get_node_type(host, &t);
		if (t == DOM_DOCUMENT_NODE) {
			doc = (struct dom_document *)host;
		} else if (dom_node_get_owner_document(host, &doc) !=
			   DOM_NO_ERR || doc == NULL) {
			if (d != NULL) dom_string_unref(d);
			if (name != NULL) JS_FreeCString(ctx, name);
			return JS_NULL;
		}
	}
	switch (kind) {
	case 1:
		if (d != NULL)
			dom_document_create_element(doc, d,
						    (struct dom_element **)&made);
		break;
	case 3:
		if (d != NULL)
			dom_document_create_text_node(doc, d,
						      (struct dom_text **)&made);
		break;
	case 8:
		if (d != NULL)
			dom_document_create_comment(doc, d,
						    (struct dom_comment **)&made);
		break;
	case 11:
		dom_document_create_document_fragment(doc,
			(struct dom_document_fragment **)&made);
		break;
	default:
		break;
	}
	if (d != NULL) dom_string_unref(d);
	if (name != NULL) JS_FreeCString(ctx, name);
	if (made == NULL) return JS_NULL;
	r = wrap_node(ctx, made);
	dom_node_unref(made);
	return r;
}

static JSValue win_vita_parse_document(JSContext *ctx, JSValueConst this_val,
				       int argc, JSValueConst *argv)
{
	dom_hubbub_parser_params params;
	dom_hubbub_parser *parser = NULL;
	struct dom_document *doc = NULL;
	const char *html;
	size_t len = 0;
	dom_hubbub_error err;
	JSValue r;

	if (argc < 1) return JS_NULL;
	html = JS_ToCStringLen(ctx, &len, argv[0]);
	if (html == NULL) return JS_NULL;

	memset(&params, 0, sizeof(params));
	params.enc = "UTF-8";
	params.fix_enc = true;
	params.enable_script = false;
	params.msg = NULL;
	params.script = NULL;
	params.ctx = NULL;
	params.daf = NULL;

	err = dom_hubbub_parser_create(&params, &parser, &doc);
	if (err != DOM_HUBBUB_OK) {
		JS_FreeCString(ctx, html);
		return JS_NULL;
	}
	if (len > 0) {
		err = dom_hubbub_parser_parse_chunk(parser,
						    (const uint8_t *)html, len);
	}
	JS_FreeCString(ctx, html);
	if (err == DOM_HUBBUB_OK) {
		err = dom_hubbub_parser_completed(parser);
	}
	dom_hubbub_parser_destroy(parser);
	if (err != DOM_HUBBUB_OK && err != DOM_HUBBUB_HUBBUB_ERR) {
		if (doc != NULL) dom_node_unref(doc);
		return JS_NULL;
	}
	if (doc == NULL) return JS_NULL;
	r = wrap_node(ctx, (struct dom_node *)doc);
	/* wrap_node takes its own reference */
	dom_node_unref(doc);
	return r;
}

/*
 * What an insertion actually adds. Inserting a DocumentFragment inserts
 * its children and leaves the fragment empty, so a record naming the
 * fragment tells an observer nothing: take the children first.
 */
static JSValue inserted_nodes(JSContext *ctx, struct dom_node *child,
			      JSValueConst asgiven)
{
	dom_node_type t = DOM_ELEMENT_NODE;

	if (child != NULL &&
	    dom_node_get_node_type(child, &t) == DOM_NO_ERR &&
	    t == DOM_DOCUMENT_FRAGMENT_NODE) {
		return children_snapshot(ctx, child);
	}
	return JS_DupValue(ctx, asgiven);
}

static JSValue node_insert_before(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *child, *before = NULL, *ref = NULL;
	JSValue added;

	if (node == NULL || argc < 1) return JS_UNDEFINED;
	child = JS_GetOpaque(argv[0], node_class_id);
	if (child == NULL) return JS_UNDEFINED;
	mark_dirty(ctx);
	notify_left_parent(ctx, child, node);
	added = inserted_nodes(ctx, child, argv[0]);
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
	notify_mutation(ctx, "childList", node, added, JS_NULL);
	return JS_DupValue(ctx, argv[0]);
}

static JSValue node_replace_child(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *child, *old, *ref = NULL;
	JSValue added;

	if (node == NULL || argc < 2) return JS_UNDEFINED;
	child = JS_GetOpaque(argv[0], node_class_id);
	old = JS_GetOpaque(argv[1], node_class_id);
	if (child == NULL || old == NULL) return JS_UNDEFINED;
	mark_dirty(ctx);
	notify_left_parent(ctx, child, node);
	added = inserted_nodes(ctx, child, argv[0]);
	if (dom_node_replace_child(node, child, old, &ref) == DOM_NO_ERR &&
	    ref != NULL) {
		dom_node_unref(ref);
	}
	notify_mutation(ctx, "childList", node, added,
			JS_DupValue(ctx, argv[1]));
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

/*
 * node.ownerDocument. It used to answer "the page" for every node, so a
 * node that came from DOMParser or createHTMLDocument claimed to belong
 * to a document it was not in. Anything that then built a fragment or an
 * element for it built one in the wrong document, and libdom refuses to
 * insert across documents, so the work vanished without an error: a
 * template parsed that way handed back empty content.
 *
 * The page's document is the plain object bound as the `document`
 * global, not a wrapped node, so that one is fetched by name to keep
 * node.ownerDocument === document true.
 */
static struct dom_document *thread_document(jsthread *thread);

static JSValue node_get_owner_document(JSContext *ctx, JSValueConst this_val)
{
	struct dom_node *node = this_node(ctx, this_val);
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = NULL;
	JSValue r;

	if (node == NULL) return JS_NULL;
	if (dom_node_get_owner_document(node, &doc) != DOM_NO_ERR) {
		return JS_NULL;
	}
	if (doc == NULL) {
		/* a document node's own ownerDocument is null */
		return JS_NULL;
	}
	if (thread != NULL && doc == thread_document(thread)) {
		JSValue global = JS_GetGlobalObject(ctx);

		r = JS_GetPropertyStr(ctx, global, "document");
		JS_FreeValue(ctx, global);
	} else {
		r = wrap_node(ctx, (struct dom_node *)doc);
	}
	dom_node_unref(doc);
	return r;
}

static JSValue node_append_child(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *child, *ref = NULL;
	JSValue added;

	if (node == NULL || argc < 1) return JS_UNDEFINED;
	child = JS_GetOpaque(argv[0], node_class_id);
	if (child == NULL) return JS_UNDEFINED;
	mark_dirty(ctx);
	notify_left_parent(ctx, child, node);
	added = inserted_nodes(ctx, child, argv[0]);
	if (dom_node_append_child(node, child, &ref) == DOM_NO_ERR && ref != NULL) {
		dom_node_unref(ref);
	}
	notify_mutation(ctx, "childList", node, added, JS_NULL);
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
	notify_mutation(ctx, "childList", node,
			JS_NULL, JS_DupValue(ctx, argv[0]));
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
	if (doc == NULL) {
		/*
		 * libdom reports no owner document for a document node,
		 * which is what document.innerHTML would hand us. Parsing
		 * the fragment against a NULL document builds nodes with no
		 * owner, and libdom's mutation dispatch reads the owner
		 * without checking it.
		 */
		dom_node_type type = DOM_NODE_TYPE_COUNT;

		if (dom_node_get_node_type(node, &type) != DOM_NO_ERR ||
		    type != DOM_DOCUMENT_NODE) {
			return;
		}
		doc = (struct dom_document *)node;
		dom_node_ref(node);
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
	/*
	 * Move what was parsed into the target, from the head as well as
	 * the body. The fragment parser has no context element, so it
	 * parses as a whole page: a leading script, and any style, link,
	 * meta or title, land in the head. Taking only the body's children
	 * dropped them, so el.innerHTML = "<style>..</style><p>" lost the
	 * style and insertAdjacentHTML lost a leading script entirely.
	 */
	/*
	 * A comment before the markup is a sibling of the <html> element,
	 * not inside it, so the fragment's first child is the comment. The
	 * code here used to require an element there and give up when it
	 * found anything else -- after emptying the target -- so assigning
	 * markup that opened with a comment wiped the element and put
	 * nothing back. Build stamps are written exactly that way, and it
	 * is how every one of YouTube's components lost its markup: the
	 * template was empty, so the named nodes a component reads out of
	 * it were all undefined.
	 *
	 * So walk the fragment's children: take an <html> element apart
	 * section by section, and move anything else across as it stands.
	 */
	dom_node_get_first_child(fragment, &htmlnode);
	while (htmlnode != NULL) {
		struct dom_node *after = NULL, *cref = NULL;

		dom_node_get_next_sibling(htmlnode, &after);
		if (node_is_element(htmlnode)) {
			struct dom_node *section = NULL;

			dom_node_get_first_child(htmlnode, &section);
			while (section != NULL) {
				struct dom_node *next = NULL;

				dom_node_get_first_child(section, &child);
				while (child != NULL) {
					cref = NULL;
					dom_node_remove_child(section, child,
							      &cref);
					if (cref) dom_node_unref(cref);
					cref = NULL;
					dom_node_append_child(node, child,
							      &cref);
					if (cref) dom_node_unref(cref);
					dom_node_unref(child);
					child = NULL;
					dom_node_get_first_child(section,
								 &child);
				}
				dom_node_get_next_sibling(section, &next);
				dom_node_unref(section);
				section = next;
			}
		} else {
			dom_node_type t = DOM_NODE_TYPE_COUNT;

			/* A doctype is not a node an element can hold, and
			 * fragment parsing ignores one anyway. */
			dom_node_get_node_type(htmlnode, &t);
			if (t != DOM_DOCUMENT_TYPE_NODE) {
				cref = NULL;
				dom_node_remove_child(fragment, htmlnode,
						      &cref);
				if (cref) dom_node_unref(cref);
				cref = NULL;
				dom_node_append_child(node, htmlnode, &cref);
				if (cref) dom_node_unref(cref);
			}
		}
		dom_node_unref(htmlnode);
		htmlnode = after;
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

	JSValue before;

	if (node == NULL) return JS_EXCEPTION;
	before = children_snapshot(ctx, node);
	/* innerHTML is [LegacyNullToEmptyString]: null empties the element
	 * rather than writing the four letters of "null" into it. */
	if (JS_IsNull(val)) {
		s = JS_ToCStringLen(ctx, &len, JS_NewString(ctx, ""));
	} else {
		s = JS_ToCStringLen(ctx, &len, val);
	}
	if (s != NULL) {
		set_inner_html(node, s, len);
		JS_FreeCString(ctx, s);
		mark_dirty(ctx);
		notify_mutation(ctx, "childList", node,
				children_snapshot(ctx, node), before);
		before = JS_UNDEFINED;
	}
	JS_FreeValue(ctx, before);
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

/*
 * The third argument of addEventListener and removeEventListener: a
 * boolean is the capture flag, an object carries capture and once.
 */
/*
 * The scroll-blocking event types. A listener for one of these added to
 * the window, the document, the root element or the body is passive
 * unless the page says otherwise, so preventDefault from inside it does
 * nothing -- which is what lets the page keep scrolling while the
 * listener runs.
 */
static bool scroll_blocking(const char *type)
{
	return type != NULL &&
		(strcmp(type, "touchstart") == 0 ||
		 strcmp(type, "touchmove") == 0 ||
		 strcmp(type, "wheel") == 0 ||
		 strcmp(type, "mousewheel") == 0);
}

static bool passive_by_default(JSContext *ctx, struct dom_node *node,
			       const char *type)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc;
	dom_node_type t = DOM_ELEMENT_NODE;
	dom_string *name = NULL;
	bool root = false;

	if (!scroll_blocking(type)) return false;
	if (node == NULL) return true;	/* the window */
	doc = thread_document(thread);
	if ((struct dom_node *)doc == node) return true;
	if (dom_node_get_node_type(node, &t) != DOM_NO_ERR ||
	    t != DOM_ELEMENT_NODE) {
		return false;
	}
	if (dom_node_get_node_name(node, &name) == DOM_NO_ERR && name != NULL) {
		const char *n = dom_string_data(name);
		size_t len = dom_string_byte_length(name);

		root = (len == 4 && strncasecmp(n, "HTML", 4) == 0) ||
		       (len == 4 && strncasecmp(n, "BODY", 4) == 0);
		dom_string_unref(name);
	}
	return root;
}

static void listener_options(JSContext *ctx, JSValueConst opts,
			     bool *capture, bool *once, bool *passive,
			     bool dflt)
{
	*capture = false;
	if (once != NULL) {
		*once = false;
	}
	if (passive != NULL) {
		*passive = dflt;
	}
	if (JS_IsUndefined(opts) || JS_IsNull(opts)) {
		return;
	}
	if (JS_IsObject(opts)) {
		JSValue v = JS_GetPropertyStr(ctx, opts, "capture");
		*capture = JS_ToBool(ctx, v) == 1;
		JS_FreeValue(ctx, v);
		if (once != NULL) {
			v = JS_GetPropertyStr(ctx, opts, "once");
			*once = JS_ToBool(ctx, v) == 1;
			JS_FreeValue(ctx, v);
		}
		if (passive != NULL) {
			v = JS_GetPropertyStr(ctx, opts, "passive");
			/* absent leaves the default; present decides */
			if (!JS_IsUndefined(v)) {
				*passive = JS_ToBool(ctx, v) == 1;
			}
			JS_FreeValue(ctx, v);
		}
		return;
	}
	*capture = JS_ToBool(ctx, opts) == 1;
}

/** Whether l is the listener (type, func, capture) on node. */
static bool listener_matches(JSContext *ctx, struct js_listener *l,
			     struct dom_node *node, dom_string *type,
			     JSValueConst func, bool capture)
{
	return l->dead == false &&
		l->node == node &&
		l->capture == capture &&
		l->type != NULL &&
		dom_string_isequal(l->type, type) &&
		JS_IsStrictEqual(ctx, l->func, func);
}

/** Take l out of the thread's list, off the node, and free it. */
static void drop_listener(jsthread *thread, struct js_listener *l)
{
	struct js_listener **pp;

	if (l->node != NULL && l->type != NULL && l->dom_listener != NULL) {
		dom_event_target_remove_event_listener(l->node, l->type,
						       l->dom_listener,
						       l->capture);
	}
	for (pp = &thread->listeners; *pp != NULL; pp = &(*pp)->next) {
		if (*pp == l) {
			*pp = l->next;
			break;
		}
	}
	if (l->dom_listener != NULL) dom_event_listener_unref(l->dom_listener);
	if (l->type != NULL) dom_string_unref(l->type);
	if (l->node != NULL) dom_node_unref(l->node);
	JS_FreeValue(thread->ctx, l->func);
	free(l);
}

/*
 * Free the listeners marked inert during a dispatch. Only safe with no
 * dispatch running, which is why they were only marked.
 */
static void sweep_dead_listeners(jsthread *thread)
{
	struct js_listener *l, *next;

	if (thread->event_depth > 0 || thread->closed) {
		return;
	}
	for (l = thread->listeners; l != NULL; l = next) {
		next = l->next;
		if (l->dead) {
			drop_listener(thread, l);
		}
	}
}

/** Register func as a listener for event type on node. */
static JSValue add_listener(JSContext *ctx, struct dom_node *node,
			    JSValueConst type_v, JSValueConst func,
			    JSValueConst opts)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *type;
	dom_string *type_dom;
	struct js_listener *l;
	struct dom_event_listener *dl = NULL;
	bool capture = false, once = false, passive = false;

	if (node == NULL || thread == NULL || !JS_IsFunction(ctx, func)) {
		return JS_UNDEFINED;
	}
	sweep_dead_listeners(thread);
	type = JS_ToCString(ctx, type_v);
	listener_options(ctx, opts, &capture, &once, &passive,
			 passive_by_default(ctx, node, type));
	type_dom = to_dom_string(type);
	if (type_dom == NULL) {
		if (type) JS_FreeCString(ctx, type);
		return JS_UNDEFINED;
	}

	/*
	 * The same function added twice for the same type and phase is one
	 * listener, not two. Pages re-register on every render, and without
	 * this each one ran as many times as it had been added.
	 */
	for (l = thread->listeners; l != NULL; l = l->next) {
		if (listener_matches(ctx, l, node, type_dom, func, capture)) {
			dom_string_unref(type_dom);
			JS_FreeCString(ctx, type);
			return JS_UNDEFINED;
		}
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
	l->type = dom_string_ref(type_dom);
	l->capture = capture;
	l->once = once;
	l->passive = passive;
	l->next = thread->listeners;
	thread->listeners = l;

	dom_event_target_add_event_listener(node, type_dom, dl, capture);
	dom_string_unref(type_dom);
	JS_FreeCString(ctx, type);
	return JS_UNDEFINED;
}

/** removeEventListener: take off the one that matches, if it is there. */
static JSValue remove_listener(JSContext *ctx, struct dom_node *node,
			       JSValueConst type_v, JSValueConst func,
			       JSValueConst opts)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *type;
	dom_string *type_dom;
	struct js_listener *l;
	bool capture = false;

	if (node == NULL || thread == NULL || !JS_IsFunction(ctx, func)) {
		return JS_UNDEFINED;
	}
	sweep_dead_listeners(thread);
	listener_options(ctx, opts, &capture, NULL, NULL, false);
	type = JS_ToCString(ctx, type_v);
	type_dom = to_dom_string(type);
	if (type_dom == NULL) {
		if (type) JS_FreeCString(ctx, type);
		return JS_UNDEFINED;
	}
	for (l = thread->listeners; l != NULL; l = l->next) {
		if (listener_matches(ctx, l, node, type_dom, func, capture)) {
			/*
			 * A listener can remove itself from inside its own
			 * call, and libdom is walking the list it is in, so
			 * mark it and let the trampoline free it.
			 */
			if (thread->event_depth > 0) {
				l->dead = true;
			} else {
				drop_listener(thread, l);
			}
			break;
		}
	}
	dom_string_unref(type_dom);
	JS_FreeCString(ctx, type);
	return JS_UNDEFINED;
}

static JSValue node_add_event_listener(JSContext *ctx, JSValueConst this_val,
				       int argc, JSValueConst *argv)
{
	if (argc < 2) return JS_UNDEFINED;
	return add_listener(ctx, this_node(ctx, this_val), argv[0], argv[1],
			    argc > 2 ? argv[2] : JS_UNDEFINED);
}

static JSValue node_remove_event_listener(JSContext *ctx, JSValueConst this_val,
					  int argc, JSValueConst *argv)
{
	if (argc < 2) return JS_UNDEFINED;
	return remove_listener(ctx, this_node(ctx, this_val), argv[0], argv[1],
			       argc > 2 ? argv[2] : JS_UNDEFINED);
}

/*
 * window and document listeners live on the document node: DOMContentLoaded
 * is dispatched there by NetSurf and load bubbles up to it from the body.
 */
/* The same encoding, reachable from the prelude as a global. */
static JSValue win_vita_encoding(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *enc = NULL;

	(void)this_val; (void)argc; (void)argv;
	if (thread != NULL && thread->htmlc != NULL) {
		enc = thread->htmlc->encoding;
	}
	return enc != NULL ? JS_NewString(ctx, enc) : JS_NULL;
}

static JSValue doc_get_ready_state(JSContext *ctx, JSValueConst this_val)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	(void)this_val;
	return JS_NewString(ctx, (thread != NULL && thread->ready_state != NULL)
			    ? thread->ready_state : "loading");
}

static JSValue doc_add_event_listener(JSContext *ctx, JSValueConst this_val,
				      int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	(void)this_val;
	if (argc < 2) return JS_UNDEFINED;
	return add_listener(ctx, (struct dom_node *)thread_document(thread),
			    argv[0], argv[1],
			    argc > 2 ? argv[2] : JS_UNDEFINED);
}

/* The matching remove for the document's and window's listeners. */
static JSValue doc_remove_event_listener(JSContext *ctx, JSValueConst this_val,
					 int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	(void)this_val;
	if (argc < 2) return JS_UNDEFINED;
	return remove_listener(ctx, (struct dom_node *)thread_document(thread),
			       argv[0], argv[1],
			       argc > 2 ? argv[2] : JS_UNDEFINED);
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
	JS_CGETSET_DEF("ownerDocument", node_get_owner_document, NULL),
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
	JS_CGETSET_DEF("attributes", node_get_attributes, NULL),
	JS_CFUNC_DEF("getAttribute", 1, node_get_attribute),
	JS_CFUNC_DEF("setAttribute", 2, node_set_attribute),
	JS_CFUNC_DEF("hasAttribute", 1, node_has_attribute),
	JS_CFUNC_DEF("removeAttribute", 1, node_remove_attribute),
	JS_CFUNC_DEF("getAttributeNS", 2, node_get_attribute_ns),
	JS_CFUNC_DEF("setAttributeNS", 3, node_set_attribute_ns),
	JS_CFUNC_DEF("hasAttributeNS", 2, node_has_attribute_ns),
	JS_CFUNC_DEF("removeAttributeNS", 2, node_remove_attribute_ns),
	JS_CGETSET_DEF("localName", node_get_local_name, NULL),
	JS_CGETSET_DEF("prefix", node_get_prefix, NULL),
	JS_CGETSET_DEF("namespaceURI", node_get_namespace_uri, NULL),
	JS_CGETSET_DEF("publicId", node_get_public_id, NULL),
	JS_CGETSET_DEF("systemId", node_get_system_id, NULL),
	JS_CFUNC_DEF("appendChild", 1, node_append_child),
	JS_CFUNC_DEF("removeChild", 1, node_remove_child),
	JS_CFUNC_DEF("insertBefore", 2, node_insert_before),
	JS_CFUNC_DEF("replaceChild", 2, node_replace_child),
	JS_CFUNC_DEF("cloneNode", 1, node_clone_node),
	JS_CFUNC_DEF("getElementsByTagName", 1, node_get_elements_by_tag_name),
	JS_CFUNC_DEF("addEventListener", 2, node_add_event_listener),
	JS_CFUNC_DEF("removeEventListener", 2, node_remove_event_listener),
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
	size_t len = 0;
	dom_string *d;
	struct dom_text *node = NULL;
	JSValue r;

	(void)this_val;
	if (doc == NULL || argc < 1) return JS_NULL;
	/* by length: a page may put a NUL inside the text, and strlen
	 * would cut the node short there */
	text = JS_ToCStringLen(ctx, &len, argv[0]);
	d = to_dom_string_len(text != NULL ? text : "", text != NULL ? len : 0);
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

/*
 * An element in a namespace, keeping its prefix and the case of its
 * local name. createElementNS used to drop to createElement, which
 * lowercases and has no namespace, so createElementNS(svg, "clipPath")
 * became a clippath element in the HTML namespace.
 */
static JSValue doc_create_element_ns(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *nsheld = NULL, *qname;
	dom_string *ns, *q;
	struct dom_element *el = NULL;
	JSValue r;

	(void)this_val;
	if (doc == NULL || argc < 2) return JS_NULL;
	ns = ns_arg(ctx, argv[0], &nsheld);
	qname = JS_ToCString(ctx, argv[1]);
	q = to_dom_string(qname);
	if (q != NULL) {
		dom_document_create_element_ns(doc, ns, q, &el);
		dom_string_unref(q);
	}
	if (ns != NULL) dom_string_unref(ns);
	if (nsheld) JS_FreeCString(ctx, nsheld);
	if (qname) JS_FreeCString(ctx, qname);
	if (el == NULL) return JS_NULL;
	r = wrap_node(ctx, (struct dom_node *)el);
	dom_node_unref((struct dom_node *)el);
	return r;
}

/*
 * An empty document, the way createDocument means it: no html, head or
 * body, with only the doctype and root element the caller asked for.
 * Parsing an empty string and taking the children out again does not
 * work -- libdom will not remove a document's own element.
 */
static JSValue doc_create_document(JSContext *ctx, JSValueConst this_val,
				   int argc, JSValueConst *argv)
{
	const char *ns = NULL, *qname = NULL;
	struct dom_document_type *dt = NULL;
	struct dom_document *doc = NULL;
	JSValue r;

	(void)this_val;
	if (argc > 0 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
		ns = JS_ToCString(ctx, argv[0]);
		if (ns != NULL && ns[0] == '\0') {
			JS_FreeCString(ctx, ns);
			ns = NULL;
		}
	}
	if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
		qname = JS_ToCString(ctx, argv[1]);
		if (qname != NULL && qname[0] == '\0') {
			JS_FreeCString(ctx, qname);
			qname = NULL;
		}
	}
	if (argc > 2) {
		dt = JS_GetOpaque(argv[2], node_class_id);
	}
	if (dom_implementation_create_document(DOM_IMPLEMENTATION_CORE, ns,
					       qname, dt, NULL, NULL,
					       &doc) != DOM_NO_ERR) {
		doc = NULL;
	}
	if (ns) JS_FreeCString(ctx, ns);
	if (qname) JS_FreeCString(ctx, qname);
	if (doc == NULL) return JS_NULL;
	r = wrap_node(ctx, (struct dom_node *)doc);
	dom_node_unref((struct dom_node *)doc);
	return r;
}

/*
 * A real doctype node. createDocumentType used to hand back a plain
 * object with a nodeType on it, so it had no tree methods at all and a
 * document could not actually hold one: inserting it threw a TypeError
 * rather than doing the insertion or refusing it properly.
 */
static JSValue doc_create_doctype(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	const char *qname = NULL, *pub = NULL, *sys = NULL;
	struct dom_document_type *dt = NULL;
	JSValue r;

	(void)this_val;
	if (argc < 1) return JS_NULL;
	qname = JS_ToCString(ctx, argv[0]);
	if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
		pub = JS_ToCString(ctx, argv[1]);
	}
	if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
		sys = JS_ToCString(ctx, argv[2]);
	}
	if (dom_implementation_create_document_type(qname,
						    pub != NULL ? pub : "",
						    sys != NULL ? sys : "",
						    &dt) != DOM_NO_ERR) {
		dt = NULL;
	}
	if (qname) JS_FreeCString(ctx, qname);
	if (pub) JS_FreeCString(ctx, pub);
	if (sys) JS_FreeCString(ctx, sys);
	if (dt == NULL) return JS_NULL;
	r = wrap_node(ctx, (struct dom_node *)dt);
	dom_node_unref((struct dom_node *)dt);
	return r;
}

/*
 * A real comment node. The prelude used to hand back an empty text node,
 * and every framework that marks an insertion point with a comment --
 * React, Vue and lit all do -- was writing its markers into the text of
 * the page instead of into a node it could find again.
 */
static JSValue doc_create_comment(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *text;
	size_t len = 0;
	dom_string *d;
	struct dom_comment *node = NULL;
	JSValue r;

	(void)this_val;
	if (doc == NULL) return JS_NULL;
	text = argc > 0 ? JS_ToCStringLen(ctx, &len, argv[0]) : NULL;
	d = to_dom_string_len(text != NULL ? text : "", text != NULL ? len : 0);
	if (d == NULL) {
		if (text) JS_FreeCString(ctx, text);
		return JS_NULL;
	}
	dom_document_create_comment(doc, d, &node);
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
	JS_CFUNC_DEF("createElementNS", 2, doc_create_element_ns),
	JS_CFUNC_DEF("__vitaCreateDoctype", 3, doc_create_doctype),
	JS_CFUNC_DEF("__vitaCreateDocument", 3, doc_create_document),
	JS_CFUNC_DEF("createTextNode", 1, doc_create_text_node),
	JS_CFUNC_DEF("createComment", 1, doc_create_comment),
	JS_CFUNC_DEF("createDocumentFragment", 0, doc_create_document_fragment),
	JS_CFUNC_DEF("addEventListener", 2, doc_add_event_listener),
	JS_CFUNC_DEF("removeEventListener", 2, doc_remove_event_listener),
	JS_CGETSET_DEF("readyState", doc_get_ready_state, NULL),
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
	/* console.log() with nothing to say still reaches vita_log, which
	 * read whatever was on the stack. */
	line[0] = 0;
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

/* Lower bound on script_timeout, in seconds. See js_newheap(). */
#define SCRIPT_TIMEOUT_MIN 20

/*
 * Arm the deadline afresh without opening a nesting level. Compiling is
 * not interruptible -- QuickJS's parser never calls the interrupt
 * handler -- so a bundle that takes longer to compile than the whole
 * budget must not have that time charged against its run.
 */
static void rearm_deadline(jsthread *thread)
{
	thread->aborting = false;
	thread->overrun_count = 0;
	thread->overrun_said_ms = 0;
	if (thread->heap->timeout > 0) {
		/*
		 * Less each time this page has had a script stopped.
		 *
		 * Twenty seconds is a long time to let a script run, and
		 * it is meant to be generous enough that a page doing real
		 * work on a slow processor is never cut off. A page that
		 * has already had a script stopped is not that page: on
		 * YouTube two scripts each ran the full twenty seconds and
		 * were killed, forty seconds of a hundred-and-six second
		 * load that produced nothing, and the page rendered anyway.
		 * So halve it after each one, down to five seconds, which
		 * bounds what a runaway costs without touching a page that
		 * never overruns -- and almost none do.
		 */
		unsigned secs = (unsigned)thread->heap->timeout;
		unsigned halvings = thread->scripts_killed;

		if (halvings > 2) {
			halvings = 2;
		}
		secs >>= halvings;
		if (secs < 5) {
			secs = 5;
		}
		thread->deadline_ms = now_ms() + (uint64_t)secs * 1000;
	} else {
		thread->deadline_ms = 0;
	}
}

/*
 * These nest. Script reaches back into C and C calls into script again
 * all the time -- a listener run from dispatchEvent(), a module settled
 * inside the script that imported it -- and each of those is part of the
 * work the outer script is doing, not a new piece of work with a budget
 * of its own. Without the depth count an inner call re-armed the
 * deadline, handing the outer script another twenty seconds every time
 * it fired an event, and its end_script then cleared the deadline
 * outright, leaving the rest of that script with no budget at all.
 * Draining microtasks belongs to the outermost call for the same
 * reason: that is where a script actually finishes.
 */
/*
 * Wall time inside script, from the outermost entry only, so that a
 * listener called from a script is not counted twice. The page profile
 * reads it: without this the only script time recorded was what a
 * <script> element ran during the parse, and a page that does its work
 * from timers and events -- which is most of them now -- showed a load
 * of a minute and a half with five hundred milliseconds accounted for.
 */
static uint64_t script_entered_ms;

static void begin_script(jsthread *thread)
{
	if (thread->script_depth++ > 0) {
		return;
	}
	script_entered_ms = now_ms();
	rearm_deadline(thread);
}

static void schedule_relayout(jsthread *thread, int ms);

static void end_script(jsthread *thread)
{
	if (thread->script_depth > 0 && --thread->script_depth > 0) {
		return;
	}
	thread->script_depth = 0;
	if (script_entered_ms != 0) {
		vitasurf_ms_script += (unsigned)(now_ms() - script_entered_ms);
		script_entered_ms = 0;
	}
	if (thread->overrun_count > 0) {
		thread->scripts_killed++;
		vita_log("qjs: that script was stopped by the budget "
			 "(%u on this page; the next gets %u seconds)",
			 thread->scripts_killed,
			 thread->scripts_killed >= 2 ? 5u :
			 (unsigned)thread->heap->timeout / 2);
	}
	thread->overrun_count = 0;
	thread->deadline_ms = 0;
	thread->aborting = false;
	/* The outermost call is over, so nothing is still unwinding. An
	 * exception left pending here is one that was reported already, or
	 * the budget abort on its way out; either way the jobs below must
	 * not start with it hanging over them. */
	if (JS_HasException(thread->ctx)) {
		JS_FreeValue(thread->ctx, JS_GetException(thread->ctx));
	}
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
	 * Only the page on screen is worth rebuilding. NetSurf keeps a
	 * content and its scripts alive for a while after the user has
	 * moved on, and rebuilding one of those spends the freeze on a
	 * page nobody is looking at, while the page they are waiting for
	 * loads behind it.
	 */
	if (thread->win != NULL) {
		struct hlcache_handle *h = browser_window_get_content(thread->win);

		if (h == NULL ||
		    hlcache_handle_get_content(h) != (struct content *)htmlc) {
			thread->dom_dirty = false;
			return;
		}
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
	thread->relayout_ms = (unsigned)(now_ms() - t0);
	vita_log("qjs: layout rebuilt after script changes in %u ms "
		 "(%u elements)%s",
		 thread->relayout_ms, thread->dom_elements,
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
	/*
	 * Earn quiet in proportion to what the last rebuild cost. A page
	 * that keeps touching the DOM would otherwise spend most of its
	 * time frozen, and one measured at four and a half seconds should
	 * not be asked again a moment later.
	 */
	if (thread->relayout_ms > 0) {
		unsigned floor_ms = thread->relayout_ms * 4;

		if (floor_ms > RELAYOUT_MAX_DELAY_MS) {
			floor_ms = RELAYOUT_MAX_DELAY_MS;
		}
		if ((unsigned)ms < floor_ms) {
			ms = (int)floor_ms;
		}
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
		/*
		 * The body as bytes, not as a string. JS_NewStringLen takes
		 * UTF-8 and rewrites anything that is not, so a response that
		 * is not text -- a font, a wasm module, a glTF model -- came
		 * across shorter than it went in and with its bytes changed.
		 * The caller decodes it when it wants text.
		 */
		args[2] = err != NULL ?
			JS_NewArrayBufferCopy(ctx, (const uint8_t *)"", 0) :
			JS_NewArrayBufferCopy(ctx,
				(const uint8_t *)(x->body != NULL ? x->body : ""),
				x->body != NULL ? x->body_len : 0);
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
	/*
	 * Resolve against the document's own base, not the window's URL.
	 * While a page is loading the window still reports the previous
	 * one, so a relative request went to whatever was on screen
	 * before, which for the first page of a session is a file: URL.
	 */
	if (thread->htmlc != NULL && thread->htmlc->base_url != NULL) {
		page = nsurl_ref(thread->htmlc->base_url);
	} else if (browser_window_get_url(thread->win, false, &page) != NSERROR_OK) {
		page = NULL;
	}
	if (page == NULL) {
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
	/* spent, or removed while a dispatch was walking the list */
	if (l->dead) {
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
	/* which phase the listener is being called in, which an event out
	 * of dispatch does not have at all */
	{
		dom_event_flow_phase phase = DOM_AT_TARGET;

		if (dom_event_get_event_phase(evt, &phase) == DOM_NO_ERR) {
			JS_SetPropertyStr(ctx, event_obj, "eventPhase",
					  JS_NewInt32(ctx, (int)phase));
		}
	}
	args[0] = event_obj;
	/* while a passive listener runs, the event refuses to be cancelled */
	if (l->passive) {
		JS_SetPropertyStr(ctx, event_obj, "__vitaPassive", JS_TRUE);
	}
	ret = JS_Call(ctx, l->func, global, 1, args);
	if (l->passive) {
		JS_SetPropertyStr(ctx, event_obj, "__vitaPassive", JS_FALSE);
	}
	if (JS_IsException(ret)) {
		qjs_report_exception(ctx);
	}
	JS_FreeValue(ctx, ret);
	/* carry the listener's decisions back into the DOM dispatch */
	flag = JS_GetPropertyStr(ctx, event_obj, "defaultPrevented");
	if (JS_ToBool(ctx, flag) == 1) {
		if (l->passive) {
			/* a passive listener does not get to cancel: put
			 * the flag back so the page keeps scrolling */
			JS_SetPropertyStr(ctx, event_obj, "defaultPrevented",
					  JS_FALSE);
		} else {
			dom_event_prevent_default(evt);
		}
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
	/*
	 * A once listener is spent. It cannot be freed here: libdom is
	 * still inside the dispatch that is walking the list it is in, and
	 * taking it off underneath that walk corrupts it. Mark it inert
	 * and let the next add or remove, outside any dispatch, free it.
	 */
	if (l->once) {
		l->dead = true;
	}
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
/*
 * __vitaStyle(node): the computed values a page is most likely to read
 * back, as [fontSize px, display, visibility, colour, background
 * colour]. Everything else getComputedStyle reports comes from the
 * prelude's defaults; these are the ones that actually vary and that
 * code branches on. A page doing its own rem arithmetic reads the root
 * font size, which is what sent YouTube into "cannot read property
 * 'replace' of undefined".
 *
 * The two colours are libcss's RGB with the alpha byte carried
 * separately in slots 5 and 6, or -1 where the property is not a colour
 * (background-color's default, transparent). They are here because a
 * page that themes itself reads a colour back to decide what it is
 * showing, and answering with the stylesheet's default said every page
 * was black on transparent.
 */
static JSValue win_vita_style(JSContext *ctx, JSValueConst this_val,
			      int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_node *node;
	struct box *box;
	css_fixed len = 0;
	css_unit unit = CSS_UNIT_PX;
	css_color colour = 0;
	JSValue arr;
	int px;

	(void)this_val;
	if (argc < 1 || thread == NULL || thread->htmlc == NULL) {
		return JS_NULL;
	}
	node = JS_GetOpaque(argv[0], node_class_id);
	if (node == NULL || !layout_current(thread)) {
		return JS_NULL;
	}
	box = box_for_node(node);
	if (box == NULL || box->style == NULL) {
		/*
		 * Laid out, but this element got no box. That is what
		 * display:none looks like from here, and reporting it
		 * matters: code hides things by setting display and then
		 * asks whether they are hidden.
		 */
		arr = JS_NewArray(ctx);
		set_index(ctx, arr, 0, 16);
		set_index(ctx, arr, 1, (int)CSS_DISPLAY_NONE);
		set_index(ctx, arr, 2, (int)CSS_VISIBILITY_VISIBLE);
		set_index(ctx, arr, 3, -1);
		set_index(ctx, arr, 4, -1);
		set_index(ctx, arr, 5, -1);
		set_index(ctx, arr, 6, -1);
		return arr;
	}
	css_computed_font_size(box->style, &len, &unit);
	px = FIXTOINT(css_unit_len2device_px(box->style,
					     &thread->htmlc->unit_len_ctx,
					     len, unit));
	if (px <= 0) px = 16;

	arr = JS_NewArray(ctx);
	set_index(ctx, arr, 0, px);
	set_index(ctx, arr, 1, (int)css_computed_display_static(box->style));
	set_index(ctx, arr, 2, (int)css_computed_visibility(box->style));

	/*
	 * set_index takes an int, and a colour with the alpha byte set
	 * does not fit one on a 32-bit target, so the alpha is split off
	 * and the prelude puts the two back together.
	 */
	if (css_computed_color(box->style, &colour) == CSS_COLOR_COLOR) {
		set_index(ctx, arr, 3, (int)(colour & 0xffffff));
		set_index(ctx, arr, 5, (int)((colour >> 24) & 0xff));
	} else {
		set_index(ctx, arr, 3, -1);
		set_index(ctx, arr, 5, -1);
	}
	colour = 0;
	if (css_computed_background_color(box->style, &colour) ==
			CSS_BACKGROUND_COLOR_COLOR) {
		set_index(ctx, arr, 4, (int)(colour & 0xffffff));
		set_index(ctx, arr, 6, (int)((colour >> 24) & 0xff));
	} else {
		set_index(ctx, arr, 4, -1);
		set_index(ctx, arr, 6, -1);
	}
	return arr;
}

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

/*
 * The prelude compiled once, kept for the life of the process. Freed
 * nowhere on purpose: it is wanted until the browser exits, and the
 * runtime that produced it may be gone long before that.
 */
static uint8_t *prelude_bc;
static size_t prelude_bc_len;

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
	JS_SetPropertyStr(ctx, global, "__vitaStyle",
			  JS_NewCFunction(ctx, win_vita_style, "__vitaStyle", 1));
	JS_SetPropertyStr(ctx, global, "__vitaScroll",
			  JS_NewCFunction(ctx, win_vita_scroll, "__vitaScroll", 0));
	JS_SetPropertyStr(ctx, global, "__vitaEncoding",
			  JS_NewCFunction(ctx, win_vita_encoding, "__vitaEncoding", 0));
	JS_SetPropertyStr(ctx, global, "__vitaWatchMutations",
			  JS_NewCFunction(ctx, win_vita_watch_mutations,
					  "__vitaWatchMutations", 1));
	JS_SetPropertyStr(ctx, global, "__vitaParseDocument",
			  JS_NewCFunction(ctx, win_vita_parse_document,
					  "__vitaParseDocument", 1));
	JS_SetPropertyStr(ctx, global, "__vitaCreateIn",
			  JS_NewCFunction(ctx, win_vita_create_in,
					  "__vitaCreateIn", 3));
	JS_SetPropertyStr(ctx, global, "__vitaScrollTo",
			  JS_NewCFunction(ctx, win_vita_scroll_to, "__vitaScrollTo", 2));
	JS_SetPropertyStr(ctx, global, "__vitaStoreLoad",
			  JS_NewCFunction(ctx, win_vita_store_load,
					  "__vitaStoreLoad", 0));
	JS_SetPropertyStr(ctx, global, "__vitaStoreSave",
			  JS_NewCFunction(ctx, win_vita_store_save,
					  "__vitaStoreSave", 1));
	JS_SetPropertyStr(ctx, global, "__vitaDispatch",
			  JS_NewCFunction(ctx, win_vita_dispatch, "__vitaDispatch", 2));

	/* window listeners live on the document node (see add_listener) */
	JS_SetPropertyStr(ctx, global, "addEventListener",
			  JS_NewCFunction(ctx, doc_add_event_listener, "addEventListener", 2));
	JS_SetPropertyStr(ctx, global, "removeEventListener",
			  JS_NewCFunction(ctx, doc_remove_event_listener,
					  "removeEventListener", 2));

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
		uint64_t t0 = 0, t1 = 0;
		JSValue fn, r;
		bool cached = prelude_bc != NULL;

		/*
		 * The prelude runs once per page, so its own cost is part
		 * of every load, and on the device parsing it was 374 ms of
		 * every one. Parse it once for the life of the process and
		 * keep the bytecode: QuickJS bytecode is portable between
		 * runtimes, which is how qjsc precompiles a script, so each
		 * later page reads the same buffer back instead of parsing
		 * 172 KB of source again.
		 */
		nsu_getmonotonic_ms(&t0);
		if (prelude_bc == NULL) {
			fn = JS_Eval(ctx, src, len, "<prelude>",
				     JS_EVAL_TYPE_GLOBAL |
				     JS_EVAL_FLAG_COMPILE_ONLY);
			if (!JS_IsException(fn)) {
				uint8_t *out;
				size_t out_len = 0;

				out = JS_WriteObject(ctx, &out_len, fn,
						     JS_WRITE_OBJ_BYTECODE);
				if (out != NULL) {
					prelude_bc = out;
					prelude_bc_len = out_len;
				}
			}
		} else {
			fn = JS_ReadObject(ctx, prelude_bc, prelude_bc_len,
					   JS_READ_OBJ_BYTECODE);
		}
		if (JS_IsException(fn)) {
			qjs_report_exception_src(ctx, "<prelude>", src, len);
			JS_FreeValue(ctx, fn);
		} else {
			r = JS_EvalFunction(ctx, fn);
			if (JS_IsException(r)) {
				qjs_report_exception_src(ctx, "<prelude>",
							 src, len);
			}
			JS_FreeValue(ctx, r);
		}
		nsu_getmonotonic_ms(&t1);
		/*
		 * Once per page, before a line of the page's own script.
		 * A quarter of a second of every load on the device, and
		 * it was in none of the buckets.
		 */
		vitasurf_ms_prelude += (unsigned int)(t1 - t0);
		vita_log("qjs: prelude %u KB ran in %u ms (%s)",
			 (unsigned int)(len / 1024),
			 (unsigned int)(t1 - t0),
			 cached ? "bytecode" : "source");
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

static JSModuleDef *qjs_module_loader(JSContext *ctx, const char *name,
				      void *opaque);
static char *qjs_module_normalize(JSContext *ctx, const char *base,
				  const char *name, void *opaque);

/*
 * A promise rejected with nobody to catch it. QuickJS calls this when the
 * rejection happens and again if a handler turns up late; only the first
 * is worth telling the page about.
 */
static void qjs_rejection_tracker(JSContext *ctx, JSValueConst promise,
				  JSValueConst reason, bool is_handled,
				  void *opaque)
{
	JSValue global, fn;

	(void)opaque;
	if (ctx == NULL) {
		return;
	}
	/*
	 * A handler attached after the rejection cancels the report: the
	 * prelude holds it for a turn so a .catch() added later in the
	 * same tick -- which is how frameworks write it -- takes it off
	 * the list rather than being called an error.
	 */
	global = JS_GetGlobalObject(ctx);
	fn = JS_GetPropertyStr(ctx, global,
			       is_handled ? "__vitaRejectionHandled"
					  : "__vitaReportRejection");
	if (JS_IsFunction(ctx, fn)) {
		JSValue args[2], r;

		args[0] = is_handled ? JS_DupValue(ctx, promise)
				     : JS_DupValue(ctx, reason);
		args[1] = JS_DupValue(ctx, promise);
		r = JS_Call(ctx, fn, global, 2, args);
		if (JS_IsException(r)) {
			qjs_absorb_or_rethrow(ctx);
		}
		JS_FreeValue(ctx, r);
		JS_FreeValue(ctx, args[0]);
		JS_FreeValue(ctx, args[1]);
	}
	JS_FreeValue(ctx, fn);
	JS_FreeValue(ctx, global);
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
	/*
	 * The timeout is NetSurf's script_timeout option, in seconds, and 0
	 * means no limit. The Vita runs script roughly 25 times slower than
	 * a desktop, so a budget short enough to be useful there stops work
	 * a page legitimately needs here; raise anything below the floor.
	 * A Choices file written by an earlier build is read after the
	 * bundled one, so the floor rather than the option default is what
	 * actually takes effect on a device that has been used.
	 */
	if (timeout > 0 && timeout < SCRIPT_TIMEOUT_MIN) {
		timeout = SCRIPT_TIMEOUT_MIN;
	}
	ret->timeout = timeout;
	/*
	 * Keep a page's scripts within a sensible slice of the heap. The
	 * newlib heap is 176 MB (VITASURF_HEAP_MB) and the rest of it holds
	 * the document, the box tree and the image cache, so scripts get a
	 * third of it. Large application bundles need most of this for
	 * their bytecode alone.
	 *
	 * The stack limit is QuickJS's own recursion guard, measured against
	 * the C stack. The main thread has 4 MB (VITASURF_STACK_KB) and
	 * script runs on it, so 1 MB still leaves room for the CSS selection
	 * and layout recursion underneath. Minified bundles nest deeply
	 * enough that 512 KB aborted them with a stack overflow.
	 */
	JS_SetModuleLoaderFunc(ret->rt, qjs_module_normalize,
			       qjs_module_loader, NULL);
	JS_SetHostPromiseRejectionTracker(ret->rt, qjs_rejection_tracker, NULL);
	JS_SetMemoryLimit(ret->rt, 96 * 1024 * 1024);
	{
		/*
		 * Measured against the stack the thread actually got, never
		 * against the one that was asked for: a guard larger than
		 * the stack it guards never fires, and the overflow then
		 * arrives as a data abort rather than a catchable error.
		 * That is what happened when --gc-sections dropped the
		 * stack size request and left the runtime's 256 KB default
		 * behind while this was set to a megabyte.
		 *
		 * Half the stack, so the CSS selection and layout recursion
		 * underneath still have room, and capped so a large stack
		 * does not let a runaway script recurse for seconds before
		 * the guard notices.
		 */
		size_t js_stack = JS_STACK_DEFAULT;

		if (vita_main_stack_bytes > 0) {
			js_stack = vita_main_stack_bytes / 2;
			if (js_stack > JS_STACK_MAX) js_stack = JS_STACK_MAX;
			if (js_stack < JS_STACK_MIN) js_stack = JS_STACK_MIN;
		}
		JS_SetMaxStackSize(ret->rt, js_stack);
		vita_log("qjs: recursion guard %u KB of a %u KB stack",
			 (unsigned int)(js_stack / 1024),
			 (unsigned int)(vita_main_stack_bytes / 1024));
	}
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
	/* calloc leaves this as a zeroed JSValue, which is not the
	 * "not looked up yet" marker import_map_of tests for. */
	ret->import_map = JS_UNINITIALIZED;
	JS_SetContextOpaque(ret->ctx, ret);
	JS_SetInterruptHandler(heap->rt, qjs_interrupt, ret);
	heap->interrupt_thread = ret;
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
	uint64_t t0 = 0, t1 = 0;

	if (thread == NULL || thread->closed) {
		return NSERROR_OK;
	}
	/*
	 * Freeing the last page's context and collecting what it left
	 * behind happens while the next page is loading, so the wait lands
	 * on that page. Count it against that page: one whose own work
	 * came to a third of a second still took nearly three, and this is
	 * one of the places the rest could be.
	 */
	t0 = now_ms();
	thread->closed = true;
	if (thread->relayout_pending) {
		guit->misc->schedule(-1, relayout_callback, thread);
		thread->relayout_pending = false;
	}
	/* drop module scripts still waiting on an import, and the
	 * scheduler entry that would have retried them */
	js_free_deferred(thread);
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
	if (!JS_IsUninitialized(thread->import_map)) {
		JS_FreeValue(thread->ctx, thread->import_map);
		thread->import_map = JS_UNINITIALIZED;
	}
	JS_FreeContext(thread->ctx);
	thread->ctx = NULL;
	JS_RunGC(thread->heap->rt);
	t1 = now_ms();
	vitasurf_ms_teardown += (unsigned)(t1 - t0);
	vita_log("qjs: page closed in %u ms, runtime memory now %u KB",
		 (unsigned)(t1 - t0), runtime_kb(thread->heap->rt));
	return NSERROR_OK;
}

void js_destroythread(jsthread *thread)
{
	struct js_listener *l;
	struct js_timer *t;
	uint64_t t0 = 0, t1 = 0;

	if (thread == NULL) {
		return;
	}
	t0 = now_ms();		/* the rest of the teardown; see above */
	js_free_deferred(thread);
	js_closethread(thread); /* releases the context if still open */
	l = thread->listeners;
	while (l != NULL) {
		struct js_listener *next = l->next;
		if (l->dom_listener != NULL) {
			dom_event_listener_unref(l->dom_listener);
		}
		if (l->type != NULL) {
			dom_string_unref(l->type);
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
	if (thread->heap->interrupt_thread == thread) {
		JS_SetInterruptHandler(thread->heap->rt, NULL, NULL);
		thread->heap->interrupt_thread = NULL;
	}
	thread->heap->live_threads--;
	if (thread->heap->pending_destroy && thread->heap->live_threads == 0) {
		jsheap *heap = thread->heap;
		JS_FreeRuntime(heap->rt);
		free(heap);
	}
	free(thread);
	t1 = now_ms();
	vitasurf_ms_teardown += (unsigned)(t1 - t0);
}

/*
 * Scripts above this size are skipped. Compiling costs roughly 2 ms per KB
 * on hardware, so the limit is what a page is allowed to spend before the
 * script is judged not worth waiting for. It is deliberately high enough
 * for the application bundles large sites ship: skipping one of those
 * leaves a blank page, which is worse than a slow one.
 *
 * Scripts at the top of this range take tens of seconds. SCRIPT_LOG_BYTES
 * is the size above which a script is logged whether or not verbose
 * logging is on, so a slow load says which script it waited for, and
 * above which the heap is logged either side of it, because a bundle
 * this size is the largest single allocation a page makes.
 *
 * YouTube's desktop application bundle measured 10509 KB, which is what
 * put the ceiling where it is.
 */
#define SCRIPT_MAX_BYTES (16 * 1024 * 1024)
#define SCRIPT_LOG_BYTES (256 * 1024)

/* ------------------------------------------------------------------------ */
/* Compiled script cache                                                    */

/*
 * Compiling is the single most expensive thing a page makes us do.
 * YouTube's bundle is 10.5 MB of JavaScript and took 17.6 seconds to
 * compile on the device, against 9.3 to run: most of a minute and a half
 * of page load, repeated in full every single visit.
 *
 * QuickJS can serialise a compiled function and read it back, which is
 * how qjsc precompiles a script and how the prelude avoids being parsed
 * once per page. The same thing works across runs if the bytecode is
 * kept on the memory card. Measured on a 2.5 MB bundle, reading it back
 * took 22 ms against 244 ms to compile, and evaluating the result
 * behaved identically -- same values, same errors, same peak memory.
 *
 * Only classic scripts are cached. A module's imports are resolved while
 * it is compiled, and a miss there sends the script down the deferred
 * retry path; keeping that behaviour identical matters more than the
 * saving, so modules are left alone.
 */

#define BC_MAGIC      0x43425356u        /* 'VSBC' */
#define BC_FORMAT     1u
/* Below this, compiling is quicker than finding the file on the card. */
#define BC_MIN_SRC    (128 * 1024)
/* One entry. Bytecode runs three to five times the size of its source. */
#define BC_MAX_ENTRY  (48u * 1024 * 1024)
/* The whole directory. An unbounded cache is a bug (see CLAUDE.md). */
#define BC_BUDGET     (96u * 1024 * 1024)
#define BC_MAX_ENTRIES 48

struct bc_header {
	uint32_t magic;
	uint32_t format;
	uint32_t src_len;
	uint32_t src_hash_lo;
	uint32_t src_hash_hi;
	uint32_t bc_len;
};

/** FNV-1a over a buffer. Used to name an entry and to check its source. */
static uint64_t bc_hash(const void *p, size_t len)
{
	const uint8_t *b = p;
	uint64_t h = 1469598103934665603ull;
	size_t i;

	for (i = 0; i < len; i++) {
		h ^= b[i];
		h *= 1099511628211ull;
	}
	return h;
}

/** Path of the entry for a URL, into buf. */
static void bc_path(char *buf, size_t n, const char *url)
{
	uint64_t h = bc_hash(url, strlen(url));

	snprintf(buf, n, "%s/%08x%08x.bc", VITASURF_JSCACHE_DIR,
		 (unsigned)(h >> 32), (unsigned)(h & 0xffffffffu));
}

/*
 * The index. Eviction needs to know what is in the directory and how big
 * each entry is, and reading a directory is the one file operation whose
 * behaviour on the device I have not verified. A list the cache writes
 * itself needs nothing but fopen, and doubles as the use order.
 *
 * Losing it costs the cache, not correctness: a stale name is a file that
 * gets overwritten, and a missing one is a miss.
 */
struct bc_entry {
	char name[24];
	uint32_t bytes;
	uint32_t stamp;		/* use order; a counter, not a clock */
};

static struct bc_entry bc_index[BC_MAX_ENTRIES];
static unsigned bc_index_n;
static uint32_t bc_stamp;
static bool bc_index_read;

static void bc_index_load(void)
{
	char path[256];
	FILE *f;

	if (bc_index_read) {
		return;
	}
	bc_index_read = true;
	snprintf(path, sizeof(path), "%s/index", VITASURF_JSCACHE_DIR);
	f = fopen(path, "rb");
	if (f == NULL) {
		return;
	}
	while (bc_index_n < BC_MAX_ENTRIES) {
		struct bc_entry *e = &bc_index[bc_index_n];
		unsigned bytes = 0, stamp = 0;

		if (fscanf(f, "%23s %u %u", e->name, &bytes, &stamp) != 3) {
			break;
		}
		e->bytes = bytes;
		e->stamp = stamp;
		if (stamp > bc_stamp) {
			bc_stamp = stamp;
		}
		bc_index_n++;
	}
	fclose(f);
}

static void bc_index_save(void)
{
	char path[256];
	FILE *f;
	unsigned i;

	snprintf(path, sizeof(path), "%s/index", VITASURF_JSCACHE_DIR);
	f = fopen(path, "wb");
	if (f == NULL) {
		return;
	}
	for (i = 0; i < bc_index_n; i++) {
		fprintf(f, "%s %u %u\n", bc_index[i].name,
			(unsigned)bc_index[i].bytes,
			(unsigned)bc_index[i].stamp);
	}
	fclose(f);
}

static struct bc_entry *bc_index_find(const char *name)
{
	unsigned i;

	for (i = 0; i < bc_index_n; i++) {
		if (strcmp(bc_index[i].name, name) == 0) {
			return &bc_index[i];
		}
	}
	return NULL;
}

static void bc_index_drop(unsigned i)
{
	char path[256];

	snprintf(path, sizeof(path), "%s/%s", VITASURF_JSCACHE_DIR,
		 bc_index[i].name);
	remove(path);
	memmove(&bc_index[i], &bc_index[i + 1],
		(bc_index_n - i - 1) * sizeof(bc_index[0]));
	bc_index_n--;
}

/** Make room for one more entry of this size, oldest use first. */
static void bc_index_make_room(uint32_t bytes)
{
	for (;;) {
		uint64_t total = bytes;
		unsigned i, oldest = 0;

		for (i = 0; i < bc_index_n; i++) {
			total += bc_index[i].bytes;
			if (bc_index[i].stamp < bc_index[oldest].stamp) {
				oldest = i;
			}
		}
		if (bc_index_n == 0) {
			return;
		}
		if (total <= BC_BUDGET && bc_index_n < BC_MAX_ENTRIES) {
			return;
		}
		vita_log("qjs: cache full, dropping %s (%u KB)",
			 bc_index[oldest].name,
			 (unsigned)(bc_index[oldest].bytes / 1024));
		bc_index_drop(oldest);
	}
}

/**
 * The compiled form of this source, or JS_UNDEFINED if it is not cached.
 *
 * The file is named after the URL and carries the length and hash of the
 * source it was built from, so a bundle that changed behind the same URL
 * is a miss rather than the wrong code.
 */
static JSValue bc_load(JSContext *ctx, const char *url,
		       const char *src, size_t srclen)
{
	char path[256];
	struct bc_header h;
	FILE *f;
	uint8_t *buf;
	JSValue fn;
	uint64_t hash;

	if (srclen < BC_MIN_SRC || url == NULL || url[0] == '<') {
		return JS_UNDEFINED;
	}
	bc_path(path, sizeof(path), url);
	f = fopen(path, "rb");
	if (f == NULL) {
		return JS_UNDEFINED;
	}
	if (fread(&h, 1, sizeof(h), f) != sizeof(h) ||
	    h.magic != BC_MAGIC || h.format != BC_FORMAT ||
	    h.src_len != (uint32_t)srclen ||
	    h.bc_len == 0 || h.bc_len > BC_MAX_ENTRY) {
		fclose(f);
		return JS_UNDEFINED;
	}
	hash = bc_hash(src, srclen);
	if (h.src_hash_lo != (uint32_t)(hash & 0xffffffffu) ||
	    h.src_hash_hi != (uint32_t)(hash >> 32)) {
		fclose(f);		/* same URL, different bundle */
		return JS_UNDEFINED;
	}
	buf = malloc(h.bc_len);
	if (buf == NULL) {
		fclose(f);
		return JS_UNDEFINED;
	}
	if (fread(buf, 1, h.bc_len, f) != h.bc_len) {
		free(buf);
		fclose(f);
		return JS_UNDEFINED;
	}
	fclose(f);
	/*
	 * QuickJS stamps its own bytecode version into the stream and
	 * refuses a stream it did not write, so an entry left behind by an
	 * older engine comes back as an exception here rather than as
	 * something that runs. Treat it as a miss and compile.
	 */
	fn = JS_ReadObject(ctx, buf, h.bc_len, JS_READ_OBJ_BYTECODE);
	free(buf);
	if (JS_IsException(fn)) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		remove(path);
		return JS_UNDEFINED;
	}
	{
		char nm[24];
		struct bc_entry *e;

		snprintf(nm, sizeof(nm), "%s", strrchr(path, '/') + 1);
		bc_index_load();
		e = bc_index_find(nm);
		if (e != NULL) {
			e->stamp = ++bc_stamp;
			bc_index_save();
		}
	}
	return fn;
}

/** Keep the compiled form of this source for the next visit. */
static void bc_store(JSContext *ctx, const char *url,
		     const char *src, size_t srclen, JSValueConst fn)
{
	char path[256], tmp[264], nm[24];
	struct bc_header h;
	uint8_t *out;
	size_t out_len = 0;
	FILE *f;
	uint64_t hash;
	struct bc_entry *e;

	if (srclen < BC_MIN_SRC || url == NULL || url[0] == '<') {
		return;
	}
	out = JS_WriteObject(ctx, &out_len, fn, JS_WRITE_OBJ_BYTECODE);
	if (out == NULL) {
		return;
	}
	if (out_len == 0 || out_len > BC_MAX_ENTRY) {
		js_free(ctx, out);
		return;
	}
	bc_path(path, sizeof(path), url);
	snprintf(nm, sizeof(nm), "%s", strrchr(path, '/') + 1);
	bc_index_load();
	e = bc_index_find(nm);
	if (e != NULL) {			/* replacing our own entry */
		unsigned i = (unsigned)(e - bc_index);
		bc_index_drop(i);
	}
	bc_index_make_room((uint32_t)out_len);
	if (bc_index_n >= BC_MAX_ENTRIES) {
		js_free(ctx, out);
		return;
	}
	hash = bc_hash(src, srclen);
	h.magic = BC_MAGIC;
	h.format = BC_FORMAT;
	h.src_len = (uint32_t)srclen;
	h.src_hash_lo = (uint32_t)(hash & 0xffffffffu);
	h.src_hash_hi = (uint32_t)(hash >> 32);
	h.bc_len = (uint32_t)out_len;
	/*
	 * Written beside the entry and renamed over it, so a battery that
	 * runs out mid-write leaves the old entry or no entry, never half
	 * of one under a name that claims to be whole.
	 */
	snprintf(tmp, sizeof(tmp), "%s.new", path);
	f = fopen(tmp, "wb");
	if (f == NULL) {
		js_free(ctx, out);
		return;
	}
	if (fwrite(&h, 1, sizeof(h), f) != sizeof(h) ||
	    fwrite(out, 1, out_len, f) != out_len) {
		fclose(f);
		remove(tmp);
		js_free(ctx, out);
		return;
	}
	fclose(f);
	js_free(ctx, out);
	remove(path);
	if (rename(tmp, path) != 0) {
		remove(tmp);
		return;
	}
	snprintf(bc_index[bc_index_n].name, sizeof(bc_index[0].name), "%s", nm);
	bc_index[bc_index_n].bytes = (uint32_t)out_len;
	bc_index[bc_index_n].stamp = ++bc_stamp;
	bc_index_n++;
	bc_index_save();
	vita_log("qjs: cached %u KB of bytecode for %u KB of source",
		 (unsigned)(out_len / 1024), (unsigned)(srclen / 1024));
}

/* ------------------------------------------------------------------------ */
/* Persistent storage                                                       */

/*
 * One file per origin under ux0:data/VitaSurf/storage, holding everything
 * that origin has stored: localStorage and IndexedDB both sit on this.
 *
 * Neither had anywhere to go before. localStorage was a plain object that
 * went with the page, shared by every site, and IndexedDB was missing, so
 * claude.ai reported no storage for its session and read its persisted
 * state back as a rejection on every load.
 *
 * The origin is worked out here from the document's own URL, not passed
 * in from script: these functions sit on the global object where a page
 * can reach them, and a page that could name its own origin could read
 * another site's storage.
 *
 * The whole origin is read and written at once. That is the wrong shape
 * for a database and the right one for a memory card, where the cost is
 * per file rather than per byte, and the writing is deferred so a burst
 * of puts is one write.
 */

#define STORE_MAX_ORIGIN (4u * 1024 * 1024)	/* one site */
#define STORE_BUDGET     (32u * 1024 * 1024)	/* all of them */
#define STORE_MAX_FILES  64

/** scheme://host:port for a URL, or NULL for one with no host. */
static char *origin_of(nsurl *url)
{
	lwc_string *scheme = NULL, *host = NULL;
	char *out = NULL;

	if (url == NULL) {
		return NULL;
	}
	scheme = nsurl_get_component(url, NSURL_SCHEME);
	host = nsurl_get_component(url, NSURL_HOST);
	if (scheme != NULL && host != NULL) {
		lwc_string *port = nsurl_get_component(url, NSURL_PORT);
		size_t n = lwc_string_length(scheme) + lwc_string_length(host) +
			(port != NULL ? lwc_string_length(port) : 0) + 8;

		out = malloc(n);
		if (out != NULL) {
			snprintf(out, n, "%.*s://%.*s%s%.*s",
				 (int)lwc_string_length(scheme),
				 lwc_string_data(scheme),
				 (int)lwc_string_length(host),
				 lwc_string_data(host),
				 port != NULL ? ":" : "",
				 port != NULL ? (int)lwc_string_length(port) : 0,
				 port != NULL ? lwc_string_data(port) : "");
		}
		if (port != NULL) lwc_string_unref(port);
	} else if (scheme != NULL) {
		/*
		 * file: has no host. Every local page shares one store,
		 * which is what a browser does with file: URLs too.
		 */
		out = strdup("file://");
	}
	if (scheme != NULL) lwc_string_unref(scheme);
	if (host != NULL) lwc_string_unref(host);
	return out;
}

static void store_path(char *buf, size_t n, const char *origin)
{
	uint64_t h = bc_hash(origin, strlen(origin));

	snprintf(buf, n, "%s/%08x%08x.kv", VITASURF_STORAGE_DIR,
		 (unsigned)(h >> 32), (unsigned)(h & 0xffffffffu));
}

/*
 * The index, as for compiled scripts: the names and sizes of the files
 * written, so the oldest can go when the budget is reached without
 * reading the directory.
 */
static struct bc_entry store_index[STORE_MAX_FILES];
static unsigned store_index_n;
static uint32_t store_stamp;
static bool store_index_read;

static void store_index_load(void)
{
	char path[256];
	FILE *f;

	if (store_index_read) {
		return;
	}
	store_index_read = true;
	snprintf(path, sizeof(path), "%s/index", VITASURF_STORAGE_DIR);
	f = fopen(path, "rb");
	if (f == NULL) {
		return;
	}
	while (store_index_n < STORE_MAX_FILES) {
		struct bc_entry *e = &store_index[store_index_n];
		unsigned bytes = 0, stamp = 0;

		if (fscanf(f, "%23s %u %u", e->name, &bytes, &stamp) != 3) {
			break;
		}
		e->bytes = bytes;
		e->stamp = stamp;
		if (stamp > store_stamp) {
			store_stamp = stamp;
		}
		store_index_n++;
	}
	fclose(f);
}

static void store_index_save(void)
{
	char path[256];
	FILE *f;
	unsigned i;

	snprintf(path, sizeof(path), "%s/index", VITASURF_STORAGE_DIR);
	f = fopen(path, "wb");
	if (f == NULL) {
		return;
	}
	for (i = 0; i < store_index_n; i++) {
		fprintf(f, "%s %u %u\n", store_index[i].name,
			(unsigned)store_index[i].bytes,
			(unsigned)store_index[i].stamp);
	}
	fclose(f);
}

/** Note this file at this size, dropping the least recently used first. */
static void store_index_note(const char *name, uint32_t bytes)
{
	unsigned i;

	store_index_load();
	for (i = 0; i < store_index_n; i++) {
		if (strcmp(store_index[i].name, name) == 0) {
			store_index[i].bytes = bytes;
			store_index[i].stamp = ++store_stamp;
			store_index_save();
			return;
		}
	}
	for (;;) {
		uint64_t total = bytes;
		unsigned oldest = 0;

		for (i = 0; i < store_index_n; i++) {
			total += store_index[i].bytes;
			if (store_index[i].stamp < store_index[oldest].stamp) {
				oldest = i;
			}
		}
		if (store_index_n == 0 ||
		    (total <= STORE_BUDGET && store_index_n < STORE_MAX_FILES)) {
			break;
		}
		{
			char path[256];

			snprintf(path, sizeof(path), "%s/%s",
				 VITASURF_STORAGE_DIR, store_index[oldest].name);
			remove(path);
			vita_log("storage: full, dropping %s (%u KB)",
				 store_index[oldest].name,
				 (unsigned)(store_index[oldest].bytes / 1024));
			memmove(&store_index[oldest], &store_index[oldest + 1],
				(store_index_n - oldest - 1) *
				sizeof(store_index[0]));
			store_index_n--;
		}
	}
	if (store_index_n < STORE_MAX_FILES) {
		snprintf(store_index[store_index_n].name,
			 sizeof(store_index[0].name), "%s", name);
		store_index[store_index_n].bytes = bytes;
		store_index[store_index_n].stamp = ++store_stamp;
		store_index_n++;
	}
	store_index_save();
}

/** __vitaStoreLoad(): everything this origin has stored, or null. */
static JSValue win_vita_store_load(JSContext *ctx, JSValueConst this_val,
				   int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	char path[256], *origin, *buf;
	long len;
	FILE *f;
	JSValue out;

	(void)this_val; (void)argc; (void)argv;
	if (thread == NULL || thread->htmlc == NULL) {
		return JS_NULL;
	}
	origin = origin_of(thread->htmlc->base_url);
	if (origin == NULL) {
		return JS_NULL;
	}
	store_path(path, sizeof(path), origin);
	free(origin);
	f = fopen(path, "rb");
	if (f == NULL) {
		return JS_NULL;
	}
	fseek(f, 0, SEEK_END);
	len = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (len <= 0 || (unsigned long)len > STORE_MAX_ORIGIN) {
		fclose(f);
		return JS_NULL;
	}
	buf = malloc((size_t)len + 1);
	if (buf == NULL) {
		fclose(f);
		return JS_NULL;
	}
	if (fread(buf, 1, (size_t)len, f) != (size_t)len) {
		free(buf);
		fclose(f);
		return JS_NULL;
	}
	fclose(f);
	buf[len] = 0;
	out = JS_NewStringLen(ctx, buf, (size_t)len);
	free(buf);
	return out;
}

/** __vitaStoreSave(text): replace everything this origin has stored. */
static JSValue win_vita_store_save(JSContext *ctx, JSValueConst this_val,
				   int argc, JSValueConst *argv)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	char path[256], tmp[264], *origin;
	const char *text;
	size_t len = 0;
	FILE *f;
	bool ok = false;

	(void)this_val;
	if (thread == NULL || thread->htmlc == NULL || argc < 1) {
		return JS_FALSE;
	}
	origin = origin_of(thread->htmlc->base_url);
	if (origin == NULL) {
		return JS_FALSE;
	}
	text = JS_ToCStringLen(ctx, &len, argv[0]);
	if (text == NULL) {
		free(origin);
		return JS_FALSE;
	}
	if (len > STORE_MAX_ORIGIN) {
		vita_log("storage: %s wanted %u KB, over the %u KB a site gets",
			 origin, (unsigned)(len / 1024),
			 (unsigned)(STORE_MAX_ORIGIN / 1024));
		JS_FreeCString(ctx, text);
		free(origin);
		return JS_FALSE;
	}
	store_path(path, sizeof(path), origin);
	free(origin);
	/* beside its own name and renamed over it, as for the script cache */
	snprintf(tmp, sizeof(tmp), "%s.new", path);
	f = fopen(tmp, "wb");
	if (f != NULL) {
		ok = fwrite(text, 1, len, f) == len;
		fclose(f);
		if (ok) {
			remove(path);
			ok = rename(tmp, path) == 0;
		}
		if (!ok) {
			remove(tmp);
		}
	}
	if (ok) {
		store_index_note(strrchr(path, '/') + 1, (uint32_t)len);
	}
	JS_FreeCString(ctx, text);
	return ok ? JS_TRUE : JS_FALSE;
}

/*
 * An import map: <script type="importmap">, whose JSON says what a bare
 * specifier such as "react" stands for. NetSurf never runs the element,
 * because importmap is not a script type it executes, so the text is
 * read from the DOM here and parsed once per page.
 */
static JSValue import_map_of(jsthread *thread)
{
	JSContext *ctx = thread->ctx;
	struct dom_document *doc = thread_document(thread);
	struct dom_nodelist *list = NULL;
	uint32_t len = 0, i;

	if (!JS_IsUninitialized(thread->import_map)) {
		return thread->import_map;
	}
	thread->import_map = JS_UNDEFINED;
	if (doc == NULL) {
		return thread->import_map;
	}
	dom_document_get_elements_by_tag_name(doc, corestring_dom_SCRIPT, &list);
	if (list == NULL) {
		return thread->import_map;
	}
	dom_nodelist_get_length(list, &len);
	for (i = 0; i < len; i++) {
		struct dom_node *n = NULL;
		dom_string *type = NULL, *text = NULL;

		dom_nodelist_item(list, i, &n);
		if (n == NULL) continue;
		dom_element_get_attribute(n, corestring_dom_type, &type);
		if (type != NULL &&
		    strcasecmp(dom_string_data(type), "importmap") == 0 &&
		    dom_node_get_text_content(n, &text) == DOM_NO_ERR &&
		    text != NULL) {
			JSValue v = JS_ParseJSON(ctx, dom_string_data(text),
						 dom_string_byte_length(text),
						 "<importmap>");
			if (JS_IsException(v)) {
				JS_FreeValue(ctx, JS_GetException(ctx));
				vita_log("qjs: import map did not parse");
			} else {
				thread->import_map = v;
				vita_log("qjs: import map loaded (%u bytes)",
					 (unsigned)dom_string_byte_length(text));
			}
		}
		if (text != NULL) dom_string_unref(text);
		if (type != NULL) dom_string_unref(type);
		dom_node_unref(n);
		if (!JS_IsUndefined(thread->import_map)) break;
	}
	dom_nodelist_unref(list);
	return thread->import_map;
}

/** A js_malloc'd copy of s, for returning from the normalizer. */
static char *js_dup_cstr(JSContext *ctx, const char *s)
{
	size_t n = strlen(s) + 1;
	char *out = js_malloc(ctx, n);

	if (out != NULL) memcpy(out, s, n);
	return out;
}

/** Resolve rel against base, or against the document if base is not a URL. */
static char *resolve_against(JSContext *ctx, jsthread *thread,
			     const char *base, const char *rel)
{
	nsurl *nsbase = NULL, *joined = NULL;
	char *out = NULL;

	if (base != NULL && strchr(base, ':') != NULL) {
		nsurl_create(base, &nsbase);
	}
	if (nsbase == NULL && thread->htmlc != NULL &&
	    thread->htmlc->base_url != NULL) {
		nsbase = nsurl_ref(thread->htmlc->base_url);
	}
	if (nsbase == NULL) {
		return js_dup_cstr(ctx, rel);
	}
	if (nsurl_join(nsbase, rel, &joined) == NSERROR_OK && joined != NULL) {
		out = js_dup_cstr(ctx, nsurl_access(joined));
		nsurl_unref(joined);
	} else {
		out = js_dup_cstr(ctx, rel);
	}
	nsurl_unref(nsbase);
	return out;
}

/**
 * Look name up in one "imports" object: an exact key first, then the
 * longest key ending in "/" that starts it, whose remainder is appended.
 */
static char *map_lookup(JSContext *ctx, jsthread *thread, JSValueConst imports,
			const char *name, const char *doc_base)
{
	JSPropertyEnum *props = NULL;
	uint32_t count = 0, i;
	size_t namelen = strlen(name), bestlen = 0;
	char *out = NULL;
	JSValue v;

	if (!JS_IsObject(imports)) {
		return NULL;
	}
	v = JS_GetPropertyStr(ctx, imports, name);
	if (JS_IsString(v)) {
		const char *target = JS_ToCString(ctx, v);
		if (target != NULL) {
			out = resolve_against(ctx, thread, doc_base, target);
			JS_FreeCString(ctx, target);
		}
		JS_FreeValue(ctx, v);
		return out;
	}
	JS_FreeValue(ctx, v);

	if (JS_GetOwnPropertyNames(ctx, &props, &count, imports,
				   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0) {
		return NULL;
	}
	for (i = 0; i < count; i++) {
		const char *key = JS_AtomToCString(ctx, props[i].atom);
		size_t klen;

		if (key == NULL) continue;
		klen = strlen(key);
		if (klen > bestlen && klen <= namelen && klen > 0 &&
		    key[klen - 1] == '/' && strncmp(key, name, klen) == 0) {
			JSValue tv = JS_GetPropertyStr(ctx, imports, key);
			const char *target = JS_ToCString(ctx, tv);

			if (target != NULL) {
				char *joined = malloc(strlen(target) +
						      (namelen - klen) + 1);
				if (joined != NULL) {
					strcpy(joined, target);
					strcat(joined, name + klen);
					if (out != NULL) js_free(ctx, out);
					out = resolve_against(ctx, thread,
							      doc_base, joined);
					free(joined);
					bestlen = klen;
				}
				JS_FreeCString(ctx, target);
			}
			JS_FreeValue(ctx, tv);
		}
		JS_FreeCString(ctx, key);
	}
	for (i = 0; i < count; i++) {
		JS_FreeAtom(ctx, props[i].atom);
	}
	js_free(ctx, props);
	return out;
}

/*
 * Resolve an import specifier. A relative or absolute URL joins onto the
 * importing module, which is what the default normalizer would do but
 * done with nsurl so that "..", queries and fragments come out right. A
 * bare specifier goes through the import map: the scopes whose prefix
 * matches the importer first, longest first, then the top level imports.
 * Anything still unmatched is passed through for the loader to report.
 */
static char *qjs_module_normalize(JSContext *ctx, const char *base,
				  const char *name, void *opaque)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	JSValue map, imports, scopes;
	const char *doc_base = NULL;
	char *out = NULL;

	(void)opaque;
	if (thread == NULL || name == NULL) {
		return js_dup_cstr(ctx, name != NULL ? name : "");
	}
	if (name[0] == '.' || name[0] == '/' || strstr(name, "://") != NULL) {
		return resolve_against(ctx, thread, base, name);
	}

	map = import_map_of(thread);
	if (!JS_IsObject(map)) {
		return js_dup_cstr(ctx, name);
	}
	if (thread->htmlc != NULL && thread->htmlc->base_url != NULL) {
		doc_base = nsurl_access(thread->htmlc->base_url);
	}

	scopes = JS_GetPropertyStr(ctx, map, "scopes");
	if (JS_IsObject(scopes) && base != NULL) {
		JSPropertyEnum *props = NULL;
		uint32_t count = 0, i;
		size_t bestlen = 0;

		if (JS_GetOwnPropertyNames(ctx, &props, &count, scopes,
					   JS_GPN_STRING_MASK |
					   JS_GPN_ENUM_ONLY) == 0) {
			for (i = 0; i < count; i++) {
				const char *key = JS_AtomToCString(ctx,
								props[i].atom);
				char *scoped;
				size_t klen;
				JSValue sv;

				char *abs;

				if (key == NULL) continue;
				/*
				 * A scope key is a URL written relative to
				 * the document, so it has to be resolved
				 * before it can be compared with the URL of
				 * the module doing the importing.
				 */
				abs = resolve_against(ctx, thread, doc_base,
						      key);
				if (abs == NULL) {
					JS_FreeCString(ctx, key);
					continue;
				}
				klen = strlen(abs);
				if (klen <= bestlen ||
				    strncmp(abs, base, klen) != 0) {
					js_free(ctx, abs);
					JS_FreeCString(ctx, key);
					continue;
				}
				js_free(ctx, abs);
				sv = JS_GetPropertyStr(ctx, scopes, key);
				scoped = map_lookup(ctx, thread, sv, name,
						    doc_base);
				JS_FreeValue(ctx, sv);
				if (scoped != NULL) {
					if (out != NULL) js_free(ctx, out);
					out = scoped;
					bestlen = klen;
				}
				JS_FreeCString(ctx, key);
			}
			for (i = 0; i < count; i++) {
				JS_FreeAtom(ctx, props[i].atom);
			}
			js_free(ctx, props);
		}
	}
	JS_FreeValue(ctx, scopes);

	if (out == NULL) {
		imports = JS_GetPropertyStr(ctx, map, "imports");
		out = map_lookup(ctx, thread, imports, name, doc_base);
		JS_FreeValue(ctx, imports);
	}
	if (out == NULL) {
		return js_dup_cstr(ctx, name);
	}
	vita_log("qjs: import map resolved '%s' to '%s'", name, out);
	return out;
}

/*
 * A module's import.meta, which QuickJS creates empty and leaves to the
 * host to fill. Code reads import.meta.url to work out where it was
 * loaded from: webpack's ES module output decides its public path that
 * way and throws "Automatic publicPath is not supported in this browser"
 * when it comes back undefined.
 */
static void set_import_meta(JSContext *ctx, JSValueConst func_val,
			    const char *url)
{
	JSModuleDef *m = JS_VALUE_GET_PTR(func_val);
	JSValue meta;

	if (m == NULL || url == NULL) {
		return;
	}
	meta = JS_GetImportMeta(ctx, m);
	if (JS_IsException(meta)) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		return;
	}
	JS_DefinePropertyValueStr(ctx, meta, "url",
				  JS_NewString(ctx, url), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, meta, "main", JS_FALSE, JS_PROP_C_W_E);
	JS_FreeValue(ctx, meta);
}

/*
 * Import resolution. A script compiled as a module is registered under its
 * own URL, and QuickJS satisfies an import of a URL it has already
 * compiled from its own module list without asking us, so a page whose
 * modules import each other by path links without any fetching here.
 *
 * Anything else -- a bare specifier resolved through an import map, or a
 * module the page never loaded through a script element -- would need a
 * fetch, and the fetcher is asynchronous while import resolution is not.
 * Those are named in the log and the import fails, which leaves the
 * importing module unevaluated rather than the whole page dead.
 */
/*
 * The same module, without the cache-busting parameter a bundler adds
 * when it retries a chunk that failed to load. webpack appends "?&r=1",
 * then "?&r=2", to the same file, and matching those literally against
 * what the page fetched would miss every time.
 */
static const char *without_retry_suffix(const char *url, char *buf, size_t len)
{
	const char *q = strstr(url, "?&r=");
	size_t n;

	if (q == NULL) {
		return url;
	}
	n = (size_t)(q - url);
	if (n >= len) {
		return url;
	}
	memcpy(buf, url, n);
	buf[n] = 0;
	return buf;
}

static JSModuleDef *qjs_module_loader(JSContext *ctx, const char *name,
				      void *opaque)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	unsigned int i, fetched = 0;
	bool unready = false;
	char stripped[1024];
	const char *want;

	(void)opaque;
	if (thread == NULL || name == NULL) {
		JS_ThrowReferenceError(ctx, "could not load module");
		return NULL;
	}
	want = without_retry_suffix(name, stripped, sizeof(stripped));

	/*
	 * The page may already have the module's source: a
	 * <link rel="modulepreload"> fetches one without running it, for
	 * exactly this moment. Compile it here, which is when a module's
	 * body is meant to run anyway, rather than at whatever point in
	 * the document the link happened to sit.
	 */
	if (thread->htmlc != NULL) {
		for (i = 0; i < thread->htmlc->scripts_count; i++) {
			struct html_script *sc = &thread->htmlc->scripts[i];
			const uint8_t *data;
			size_t size = 0;
			char *src;
			JSValue fn;
			JSModuleDef *m;

			if (sc->type == HTML_SCRIPT_INLINE ||
			    sc->data.handle == NULL) {
				continue;
			}
			fetched++;
			if (strcmp(nsurl_access(hlcache_handle_get_url(
					sc->data.handle)), want) != 0) {
				continue;
			}
			if (content_get_status(sc->data.handle) !=
					CONTENT_STATUS_DONE) {
				/* Named by the page but still arriving. */
				unready = true;
				continue;
			}
			data = content_get_source_data(sc->data.handle, &size);
			if (data == NULL || size == 0 ||
			    size > SCRIPT_MAX_BYTES) {
				break;
			}
			src = malloc(size + 1);
			if (src == NULL) {
				break;
			}
			memcpy(src, data, size);
			src[size] = 0;
			fn = JS_Eval(ctx, src, size, name,
				     JS_EVAL_TYPE_MODULE |
				     JS_EVAL_FLAG_COMPILE_ONLY);
			free(src);
			if (JS_IsException(fn)) {
				vita_log("qjs: module '%s' did not compile",
					 name);
				return NULL;
			}
			set_import_meta(ctx, fn, name);
			m = JS_VALUE_GET_PTR(fn);
			JS_FreeValue(ctx, fn);
			thread->js_modules++;
			vita_log("qjs: compiled module for import '%s' "
				 "(%u KB)", name, (unsigned)(size / 1024));
			return m;
		}
	}

	/*
	 * Nothing has it. Start a fetch anyway: a bundler that splits its
	 * code imports a chunk it never named in the document, and then
	 * retries the same chunk a few times a second apart when the
	 * import fails. This one fails too, but the retry can find it.
	 */
	if (!unready && thread->htmlc != NULL &&
	    strstr(want, "://") != NULL) {
		dom_string *href = to_dom_string(want);

		if (href != NULL) {
			if (html_process_module_preload(thread->htmlc, href)) {
				thread->js_import_fetches++;
				vita_log("qjs: fetching '%s' for a retry",
					 want);
			}
			dom_string_unref(href);
		}
	}

	thread->js_imports_missed++;
	vita_log("qjs: no module for import '%s' (%u fetched scripts%s)",
		 name, fetched, unready ? ", one still arriving" : "");
	JS_ThrowReferenceError(ctx, "could not load module '%s'", name);
	return NULL;
}


/*
 * Evaluating a module yields a promise. It settles synchronously unless
 * the module awaits at its top level, so drain the job queue and then
 * read it: otherwise a module that threw would be recorded as having run
 * cleanly, and a page whose entry module failed would look like a page
 * whose scripts all succeeded and simply drew nothing.
 */
static JSValue settle_module(jsthread *thread, JSValue ret, const char *name)
{
	JSPromiseStateEnum st;

	if (!JS_IsPromise(ret)) {
		return ret;
	}
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
	st = JS_PromiseState(thread->ctx, ret);
	if (st == JS_PROMISE_REJECTED) {
		JSValue err = JS_PromiseResult(thread->ctx, ret);

		JS_FreeValue(thread->ctx, ret);
		return JS_Throw(thread->ctx, err);
	}
	if (st == JS_PROMISE_PENDING) {
		vita_log("qjs: module still pending: %s", name);
	}
	return ret;
}

#define MODULE_RETRY_MS    300
/* A round that gets nowhere waits longer before the next one. */
#define MODULE_RETRY_MAX_MS 4800
#define MODULE_RETRY_TRIES 20

static void module_retry_callback(void *p);

static void free_deferred(struct js_deferred *d)
{
	free(d->src);
	free(d->name);
	free(d);
}

static void js_free_deferred(jsthread *thread)
{
	struct js_deferred *d = thread->deferred, *next;

	while (d != NULL) {
		next = d->next;
		free_deferred(d);
		d = next;
	}
	thread->deferred = NULL;
	if (thread->deferred_scheduled) {
		guit->misc->schedule(-1, module_retry_callback, thread);
		thread->deferred_scheduled = false;
	}
}

/* Keep a module script that is short of an import, to try again. */
static void defer_module(jsthread *thread, const char *src, size_t len,
			 const char *name)
{
	struct js_deferred *d = calloc(1, sizeof(*d));

	if (d == NULL) return;
	d->src = malloc(len + 1);
	if (d->src == NULL) { free(d); return; }
	memcpy(d->src, src, len);
	d->src[len] = 0;
	d->len = len;
	d->name = strdup(name != NULL ? name : "<script>");
	d->next = thread->deferred;
	thread->deferred = d;
	if (!thread->deferred_scheduled) {
		thread->deferred_scheduled = true;
		guit->misc->schedule(MODULE_RETRY_MS, module_retry_callback,
				     thread);
	}
	vita_log("qjs: module '%s' waits for an import", d->name);
}

/*
 * Try the waiting module scripts again. Each attempt re-runs the loader,
 * which finds anything that has arrived since; a graph several chunks
 * deep needs one pass per chunk, so this keeps going for a while before
 * giving up on one.
 */
static void module_retry_callback(void *p)
{
	jsthread *thread = p;
	struct js_deferred *d, **link;
	unsigned progress;
	bool again = false, moved = false;

	if (thread == NULL || thread->closed) return;
	thread->deferred_scheduled = false;
	link = &thread->deferred;
	while ((d = *link) != NULL) {
		unsigned missed = thread->js_imports_missed;
		JSValue fn;

		begin_script(thread);
		thread->current_script = d->name;
		fn = JS_Eval(thread->ctx, d->src, d->len, d->name,
			     JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
		if (!JS_IsException(fn)) {
			JSValue ret;

			set_import_meta(thread->ctx, fn, d->name);
			vita_log("qjs: module '%s' ready after %d tries",
				 d->name, d->tries + 1);
			rearm_deadline(thread);
			ret = settle_module(thread,
					    JS_EvalFunction(thread->ctx, fn),
					    d->name);
			if (JS_IsException(ret)) {
				qjs_report_exception_src(thread->ctx, d->name,
							 NULL, 0);
			}
			JS_FreeValue(thread->ctx, ret);
			thread->current_script = NULL;
			end_script(thread);
			*link = d->next;
			free_deferred(d);
			continue;
		}
		JS_FreeValue(thread->ctx, JS_GetException(thread->ctx));
		JS_FreeValue(thread->ctx, fn);
		thread->current_script = NULL;
		end_script(thread);
		/*
		 * A graph several chunks deep needs one round per chunk, so
		 * a round that got anywhere is progress however long the
		 * graph turns out to be: only stalled rounds count against
		 * the limit. GitHub reaches ninety modules. Compiling a
		 * module is not the only kind of progress -- a chain
		 * resolves one link at a time and the deepest link fails to
		 * compile every round until the last -- so reaching for a
		 * chunk that was not asked for before counts too.
		 */
		progress = thread->js_modules + thread->js_import_fetches;
		if (progress != d->progress) {
			d->progress = progress;
			d->tries = 0;
			moved = true;
		}
		d->tries++;
		if (d->tries >= MODULE_RETRY_TRIES ||
		    thread->js_imports_missed == missed) {
			/* out of patience, or it failed for some other
			 * reason than a missing import */
			vita_log("qjs: module '%s' gave up after %d tries",
				 d->name, d->tries);
			*link = d->next;
			free_deferred(d);
			continue;
		}
		again = true;
		link = &d->next;
	}
	if (again && !thread->closed) {
		/*
		 * Back off while nothing is arriving.
		 *
		 * A round recompiles every deferred module, and one of
		 * claude.ai's chunks is four hundred kilobytes, which is
		 * about a second of compiling on the device. Retrying
		 * every three hundred milliseconds started the next round
		 * long before the last had finished and recompiled the
		 * same two modules eight times over seventeen seconds, all
		 * of it failing at the same import that had not arrived
		 * yet. A round that resolves something keeps the short
		 * interval, because a chain wants one round per link.
		 */
		if (moved) {
			thread->retry_delay_ms = MODULE_RETRY_MS;
		} else if (thread->retry_delay_ms < MODULE_RETRY_MS) {
			thread->retry_delay_ms = MODULE_RETRY_MS;
		} else if (thread->retry_delay_ms < MODULE_RETRY_MAX_MS) {
			thread->retry_delay_ms *= 2;
		}
		thread->deferred_scheduled = true;
		guit->misc->schedule((int)thread->retry_delay_ms,
				     module_retry_callback, thread);
	}
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
	 * Give the prelude a moment before each script. It uses this to
	 * empty any <template> the parser has read since the last one:
	 * libdom parses a template's children into the element, and until
	 * they are moved into its content fragment they are still in the
	 * document, where a script's own querySelectorAll finds them.
	 */
	{
		JSValue global = JS_GetGlobalObject(thread->ctx);
		JSValue fn = JS_GetPropertyStr(thread->ctx, global,
					       "__vitaBeforeScript");
		if (JS_IsFunction(thread->ctx, fn)) {
			JSValue r = JS_Call(thread->ctx, fn, global, 0, NULL);
			if (JS_IsException(r)) {
				qjs_report_exception(thread->ctx);
			}
			JS_FreeValue(thread->ctx, r);
		}
		JS_FreeValue(thread->ctx, fn);
		JS_FreeValue(thread->ctx, global);
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
	{
		/*
		 * Compiling and running are separated so a log says which
		 * of the two a slow page spends its time in; JS_Eval does
		 * the same two steps internally, so this costs nothing.
		 */
		uint64_t t_start = now_ms(), t_compiled, t_done;
		bool module = false, cached = false;
		JSValue fn;

		/*
		 * Sites serve their own code as ES modules, which are not
		 * valid global scripts: export and import are syntax errors
		 * there, and a module's top level declarations share no
		 * scope with any other script, so a page whose modules each
		 * declare the same name also collides when they are
		 * compiled globally.
		 *
		 * NetSurf does not pass the script element's type down, and
		 * QuickJS's JS_DetectModule answers yes for ordinary
		 * scripts too, since nearly all of them also parse as
		 * modules. Compiling a classic script as a module would be
		 * the worse mistake: module code is strict, and its top
		 * level declarations never reach the global object, so
		 * anything a later script or an inline handler looks up by
		 * name would be gone.
		 *
		 * So compile as a script first and only reach for a module
		 * when that fails. A script that compiles keeps script
		 * semantics, and the retry costs a parse only on source
		 * that was not going to run at all.
		 */
		fn = bc_load(thread->ctx, name, src, txtlen);
		if (!JS_IsUndefined(fn)) {
			cached = true;
			goto compiled;
		}
		fn = JS_Eval(thread->ctx, src, txtlen, name,
			     JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
		if (!JS_IsException(fn)) {
			bc_store(thread->ctx, name, src, txtlen, fn);
		}
		if (JS_IsException(fn)) {
			JSValue script_err = JS_GetException(thread->ctx);
			unsigned missed = thread->js_imports_missed;
			JSValue as_module =
				JS_Eval(thread->ctx, src, txtlen, name,
					JS_EVAL_TYPE_MODULE |
					JS_EVAL_FLAG_COMPILE_ONLY);

			if (!JS_IsException(as_module)) {
				JS_FreeValue(thread->ctx, script_err);
				fn = as_module;
				module = true;
				set_import_meta(thread->ctx, fn, name);
			} else if (thread->js_imports_missed != missed) {
				/*
				 * It asked for an import and nothing had it
				 * yet. The loader has started a fetch, so
				 * put the script aside and compile it again
				 * when that lands rather than failing here:
				 * a bundler that splits its code imports a
				 * chunk the document never declared, and one
				 * miss used to end the page.
				 */
				JS_FreeValue(thread->ctx, script_err);
				JS_FreeValue(thread->ctx,
					     JS_GetException(thread->ctx));
				JS_FreeValue(thread->ctx, as_module);
				free(src);
				defer_module(thread, (const char *)txt, txtlen,
					     name);
				thread->current_script = NULL;
				end_script(thread);
				return true;
			} else {
				/* Not a module either: the first error is
				 * the one that describes the source. */
				JS_FreeValue(thread->ctx,
					     JS_GetException(thread->ctx));
				JS_FreeValue(thread->ctx, as_module);
				fn = JS_Throw(thread->ctx, script_err);
			}
		}

	compiled:
		t_compiled = now_ms();
		if (JS_IsException(fn)) {
			ret = fn;
		} else {
			/*
			 * Re-arm the deadline so the compile does not eat the
			 * run budget. QuickJS's parser never calls the
			 * interrupt handler, so the deadline could not have
			 * stopped the compile anyway; without this a bundle
			 * that took longer to compile than script_timeout was
			 * aborted at its first statement.
			 */
			rearm_deadline(thread);
			ret = JS_EvalFunction(thread->ctx, fn);
			/*
			 * QuickJS checks a global let or const against the
			 * bindings other scripts already made when the
			 * script runs, not when it compiles, so a bundle
			 * that is really a module but happens to contain no
			 * import or export reaches this far and then dies on
			 * "redeclaration of e" against the last module that
			 * declared the same minified name. Nothing has run
			 * at that point -- the declarations are instantiated
			 * before the body -- so compiling it again as a
			 * module, where its declarations are its own, costs
			 * only the parse.
			 */
			if (!module && JS_IsException(ret)) {
				JSValue err = JS_GetException(thread->ctx);

				if (qjs_error_mentions(thread->ctx, err,
						       "redeclaration")) {
					JSValue m = JS_Eval(thread->ctx, src,
							    txtlen, name,
							    JS_EVAL_TYPE_MODULE |
							    JS_EVAL_FLAG_COMPILE_ONLY);

					if (!JS_IsException(m)) {
						JS_FreeValue(thread->ctx, err);
						module = true;
						set_import_meta(thread->ctx, m, name);
						rearm_deadline(thread);
						ret = JS_EvalFunction(thread->ctx, m);
					} else {
						JS_FreeValue(thread->ctx,
							     JS_GetException(thread->ctx));
						JS_FreeValue(thread->ctx, m);
						ret = JS_Throw(thread->ctx, err);
					}
				} else {
					ret = JS_Throw(thread->ctx, err);
				}
			}
			ret = settle_module(thread, ret, name);
		}
		t_done = now_ms();

		if (module) {
			thread->js_modules++;
		}
		thread->js_scripts++;
		thread->js_bytes += (unsigned)txtlen;
		thread->js_compile_ms += (unsigned)(t_compiled - t_start);
		thread->js_run_ms += (unsigned)(t_done - t_compiled);

		if (txtlen > SCRIPT_LOG_BYTES || vita_verbose_requested()) {
			vita_log("qjs: script %u KB %s in %u ms, "
				 "ran in %u ms, runtime memory now %u KB: %s",
				 (unsigned)(txtlen / 1024),
				 cached ? "read from cache" : "compiled",
				 (unsigned)(t_compiled - t_start),
				 (unsigned)(t_done - t_compiled),
				 runtime_kb(thread->heap->rt),
				 name);
		}
		if (txtlen > SCRIPT_LOG_BYTES) {
			vita_log_memory("after a large script");
		}
	}
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
	if (strcmp(type, "DOMContentLoaded") == 0) {
		thread->ready_state = "interactive";
	} else if (strcmp(type, "load") == 0) {
		thread->ready_state = "complete";
	}
	if (strcmp(type, "load") == 0) {
		vita_log("qjs: load event, runtime memory %u KB; "
			 "%u scripts of %u KB compiled in %u ms, ran in %u ms"
			 "; %u modules, %u import misses",
			 runtime_kb(thread->heap->rt),
			 thread->js_scripts, thread->js_bytes / 1024,
			 thread->js_compile_ms, thread->js_run_ms,
			 thread->js_modules, thread->js_imports_missed);
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
				size_t blen = vlen + 208;
				char *body = malloc(blen);
				if (body != NULL) {
					JSValue fn;
					/* an inline handler that returns
					 * false cancels the event: a form
					 * with onsubmit="...; return false"
					 * submitted anyway without this */
					int len = snprintf(body, blen,
						"(function(event){var __r="
						"(function(event){%.*s\n})"
						".call(this,event);"
						"if(__r===false&&event&&"
						"event.preventDefault)"
						"event.preventDefault();"
						"return __r;})",
						(int)vlen, dom_string_data(value));
					fn = JS_Eval(ctx, body, (size_t)len,
						     "<inline handler>",
						     JS_EVAL_TYPE_GLOBAL);
					if (JS_IsException(fn)) {
						qjs_report_exception(ctx);
					} else {
						/*
						 * Set the handler property
						 * rather than adding a
						 * listener of our own. The
						 * prelude owns these: it
						 * installs one listener per
						 * property and replaces it
						 * when the attribute is set
						 * again. Adding one here as
						 * well meant an element whose
						 * attribute was set from
						 * script ran its handler
						 * twice.
						 */
						JSValue obj = wrap_node(ctx,
							(struct dom_node *)node);

						if (!JS_IsNull(obj)) {
							JS_SetPropertyStr(ctx, obj,
								aname,
								JS_DupValue(ctx, fn));
						}
						JS_FreeValue(ctx, obj);
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
