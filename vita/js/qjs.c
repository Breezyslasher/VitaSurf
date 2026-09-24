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
#include "utils/nsoption.h"
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
#include "vita_input.h"
#include "canvas.h"

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
/*
 * One chain per 128 nodes was one chain per hundred (VitaSurf). Every
 * crossing that hands JavaScript a node looks it up here, and a page of
 * six thousand elements and seven thousand text nodes left about a
 * hundred entries in each chain: a synthetic document of 13000 nodes
 * walked 31,569,372 chain steps over 523,562 look-ups, sixty a look-up,
 * and that was 294 ms on a host that is a dozen times quicker than the
 * device. 4096 chains is 16 KB a thread and takes the same document to
 * about three.
 */
#define WRAPPER_BUCKETS 4096
struct js_wrapper {
	struct dom_node *node;
	JSValue obj;
	struct js_wrapper *next;
};

/*
 * The binding running now, for the profile (VitaSurf): every binding
 * notes its own name on entry, one store, and the interrupt check clears
 * it whenever script runs. Time the profile finds spent outside the
 * interpreter is put down to the binding named here, or to a QuickJS
 * built-in or a compile when none is.
 */
#define c_where vita_c_where
#define C_WHERE const char *c_where_mark_ __attribute__((unused)) = \
	(c_where = __func__)

/* selector strings remembered by address; a power of two */
#define SEL_RECENT 256

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
	bool draining;            /**< end_script is running promise jobs */
	struct jsthread *all_next; /**< every live thread, for window events */
	bool aborting;            /**< the budget is unwinding a script */
	unsigned scripts_killed;  /**< scripts the budget stopped, this page */
	unsigned overrun_count;   /**< interrupts past the deadline */
	uint64_t overrun_said_ms; /**< when that was last logged */
	const char *current_script; /**< URL of the script js_exec is running */
	struct js_listener *listeners; /**< event listeners, freed on close */
	/*
	 * The listeners of one node, found without walking all of them
	 * (VitaSurf). Adding a listener has to know whether the same one
	 * is already there, and a page of any size registers thousands:
	 * Audiobookshelf's library view hung the browser scanning the
	 * whole list once per registration.
	 */
	struct js_listener **node_hash;
	size_t node_hash_size;	/**< a power of two, or zero for none */
	size_t listener_count;
	size_t dead_listeners;	/**< marked inert, waiting for a sweep */
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
	/*
	 * What each MutationObserver watches, mirrored from the prelude
	 * (VitaSurf): the node, what kinds of change, whether below it
	 * too, and the attribute names it filters on. With it the C side
	 * can tell whether any observer wants a change before calling
	 * into JavaScript at all; see mo_wanted.
	 */
	struct mo_watch *mo;
	unsigned mo_n, mo_alloc;
	struct js_timer *timers;       /**< live timers, cancelled on close */
	struct js_wrapper *wrappers[WRAPPER_BUCKETS];
	struct js_xhr *xhrs;           /**< requests in flight */
	int next_xhr_id;
	bool closed;
	bool dom_dirty;           /**< scripts changed the DOM since the last layout */
	bool relayout_pending;    /**< relayout_callback is scheduled */
	bool relayout_off;        /**< document too large to rebuild */
	unsigned relayout_waits;  /**< retries spent waiting on fetches */
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
	struct mod_deps *mod_deps[64]; /**< each module's imports, by URL */
	struct sel_compiled *sel_cache[128]; /**< selectors answered in C */
	unsigned int sel_cache_n;
	/*
	 * The selectors last asked for, by the script's string itself
	 * (VitaSurf). A lazy loader asks the same few hundred strings
	 * over and over, and each call copied the string out of the
	 * engine and hashed it before it could look it up. Each entry
	 * holds a reference to its string, so its address cannot be
	 * reused for another while it is here.
	 */
	struct sel_recent {
		const void *key;
		JSValue str;
		struct sel_compiled *s;
	} sel_recent[SEL_RECENT];
	/*
	 * The tag names under one element, for a bare tag query to be
	 * refused at once when no element of that name is there
	 * (VitaSurf). GitHub's lazy loader asks each element it scans
	 * for each of the tags it may load, and nearly all are not on
	 * the page, so each walked the whole subtree to find nothing.
	 * Built on the second such query of the same element while the
	 * tree keeps its shape, so a query asked once still stops at
	 * the first match; the names are ASCII-lowercased hashes, and
	 * a hash that is there only means the walk goes ahead.
	 */
	struct dom_node *tags_root;
	uint32_t tags_gen;
	uint32_t tags_asks;
	uint32_t *tags_set;       /**< open addressing, 0 is empty */
	uint32_t tags_cap, tags_n;
	bool tags_built;
	struct id_entry **id_idx;  /**< getElementById answers, by id */
	uint32_t id_idx_nb, id_idx_n; /**< buckets (a power of two), entries */
	uint32_t id_idx_gen;      /**< vita_id_gen the index is exact for */
	bool id_idx_built;
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
	struct js_listener *node_next;	/**< next listener on the same node */
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
	JSValue func;         /**< a function, or a string of code */
	JSValue args;         /**< array of extra arguments, or undefined */
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

/*
 * And what it is expected to cost (VitaSurf).
 *
 * The element count is a proxy for the work, and it does not hold. A
 * GitHub profile came in at 6270 elements -- under the limit above --
 * and rebuilt in 55621 ms, because the cost of an element is not the
 * element, it is the element against every rule that might style it.
 * That page loads 398 stylesheets whose universal chain alone offers
 * 2738 candidates to each element, and one element costs 11.7 ms
 * against a Wikipedia element's 1.1 ms.
 *
 * So estimate instead. Laying the page out the first time measured
 * exactly this, per element, on this page with this CSS; multiply it
 * by what the document now holds. Over this budget the page keeps the
 * layout it was parsed with, as it does over the element limit.
 */
#define RELAYOUT_MAX_MS 8000

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */

static uint64_t now_ms(void)
{
	uint64_t ms = 0;
	nsu_getmonotonic_ms(&ms);
	return ms;
}

/** Interrupt handler: stop a script that has run past its deadline. */
/**
 * The live JavaScript stack, as the text Error.stack would hold, or
 * NULL. A malloc'd copy for the caller to free.
 */
static char *capture_stack(JSContext *c)
{
	JSValue global = JS_GetGlobalObject(c);
	JSValue ector = JS_GetPropertyStr(c, global, "Error");
	JSValue capture = JS_GetPropertyStr(c, ector, "captureStackTrace");
	JSValue err = JS_NewError(c);
	JSValue stack;
	char *out = NULL;

	if (JS_IsFunction(c, capture)) {
		JSValue r = JS_Call(c, capture, ector, 1, &err);

		if (JS_IsException(r)) {
			JS_FreeValue(c, JS_GetException(c));
		}
		JS_FreeValue(c, r);
	}
	stack = JS_GetPropertyStr(c, err, "stack");
	if (JS_IsString(stack)) {
		const char *st = JS_ToCString(c, stack);

		if (st != NULL) {
			out = strdup(st);
			JS_FreeCString(c, st);
		}
	}
	JS_FreeValue(c, stack);
	JS_FreeValue(c, err);
	JS_FreeValue(c, capture);
	JS_FreeValue(c, ector);
	JS_FreeValue(c, global);
	return out;
}

/*
 * A sampling profile of the page's JavaScript (VitaSurf). The counters
 * say how often the page called into us and what that cost, but a
 * GitHub promise job of 11.6 s had 9 s that none of them covered: plain
 * script, somewhere. Every PROF_INTERVAL_MS while script runs, the
 * interrupt check notes the two innermost frames, and the page report
 * names the places most often found running. Only script is sampled;
 * time inside our bindings is not interruptible and is counted there.
 */
#define PROF_INTERVAL_MS 100
#define PROF_SLOTS 128

static struct {
	char where[300];
	unsigned int hits;
} prof[PROF_SLOTS];
static unsigned int prof_n, prof_samples, prof_other;
static uint64_t prof_last_ms;
static uint64_t prof_last_call_ms;	/* the interrupt check's last visit */
static bool prof_busy;

/* One frame of a stack text: "name (file:line:col)", the file's path cut
 * to its last part. */
static size_t prof_frame(const char *line, char *out, size_t outsz)
{
	const char *end = strchr(line, '\n'), *open, *slash;
	size_t n, used = 0;

	if (end == NULL) end = line + strlen(line);
	while (line < end && (*line == ' ' || *line == '\t')) line++;
	if (end - line >= 3 && memcmp(line, "at ", 3) == 0) line += 3;
	open = memchr(line, '(', (size_t)(end - line));
	if (open != NULL) {
		/* the name, then the location's last path component */
		n = (size_t)(open - line) + 1;
		if (n >= outsz) n = outsz - 1;
		memcpy(out, line, n);
		used = n;
		slash = open + 1;
		{
			const char *p;

			for (p = open + 1; p < end; p++) {
				if (*p == '/') slash = p + 1;
			}
		}
		n = (size_t)(end - slash);
		if (used + n >= outsz) n = outsz - 1 - used;
		memcpy(out + used, slash, n);
		used += n;
	} else {
		n = (size_t)(end - line);
		if (n >= outsz) n = outsz - 1;
		memcpy(out, line, n);
		used = n;
	}
	out[used] = '\0';
	return used;
}

/* Whether s[0..n) contains needle (newlib has no memmem). */
static bool prof_has(const char *s, size_t n, const char *needle)
{
	size_t k = strlen(needle), i;

	for (i = 0; i + k <= n; i++) {
		if (memcmp(s + i, needle, k) == 0) return true;
	}
	return false;
}

/*
 * weight is how many PROF_INTERVAL_MS slices have passed since the last
 * sample. The interrupt check comes round every few microseconds while
 * the interpreter runs, and not at all inside a binding or while code
 * made by new Function() compiles: a long silence before this visit was
 * time in C, and the frame on top now is the script that called there.
 * Those are marked [after time in C] and weighted by the time they took:
 * the frame named is the script that was running when the check came
 * round again, just after the call into C.
 */
static void prof_add(const char *key, unsigned int weight)
{
	unsigned int i;

	for (i = 0; i < prof_n; i++) {
		if (strcmp(prof[i].where, key) == 0) {
			prof[i].hits += weight;
			return;
		}
	}
	if (prof_n < PROF_SLOTS) {
		snprintf(prof[prof_n].where, sizeof(prof[0].where), "%s", key);
		prof[prof_n].hits = weight;
		prof_n++;
	} else {
		prof_other += weight;
	}
}

static void prof_sample(JSContext *ctx, unsigned int weight, bool in_c)
{
	char *st, key[300], f2[100];
	const char *l2;

	if (prof_busy) return;
	prof_busy = true;
	st = capture_stack(ctx);
	prof_busy = false;
	if (st == NULL) return;
	prof_samples += weight;
	prof_frame(st, key, 100);
	l2 = strchr(st, '\n');
	if (l2 != NULL && l2[1] != '\0') {
		prof_frame(l2 + 1, f2, sizeof(f2));
		snprintf(key + strlen(key), sizeof(key) - strlen(key),
			 " < %s", f2);
		/* two frames of our own code: which page call led there */
		if (strstr(key, "<prelude>") != NULL &&
		    strstr(f2, "<prelude>") != NULL) {
			const char *l = strchr(l2 + 1, '\n');

			while (l != NULL && l[1] != '\0') {
				const char *e = strchr(l + 1, '\n');
				size_t n = e != NULL ? (size_t)(e - l) :
					strlen(l);

				if (!prof_has(l, n, "<prelude>") &&
				    !prof_has(l, n, "(native)")) {
					prof_frame(l + 1, f2, sizeof(f2));
					snprintf(key + strlen(key),
						 sizeof(key) - strlen(key),
						 " from %s", f2);
					break;
				}
				l = e;
			}
		}
	}
	free(st);
	if (in_c) {
		const char *w = c_where;

		snprintf(key + strlen(key), sizeof(key) - strlen(key),
			 " [after %s]", w != NULL ? w :
			 "a built-in or a compile");
	}
	prof_add(key, weight);
}

/*
 * The end of a script or a promise job: a silence since the interrupt
 * check last came round was time in C with no script after it to be
 * found in -- one long binding call, or a compile, at the very end.
 */
static void prof_tail(const char *what)
{
	uint64_t t = now_ms();

	if (t - prof_last_call_ms >= PROF_INTERVAL_MS &&
	    t - prof_last_ms >= PROF_INTERVAL_MS) {
		char key[160];
		uint64_t slices = (t - prof_last_ms) / PROF_INTERVAL_MS;

		snprintf(key, sizeof(key), "%s [ended in %s]", what,
			 c_where != NULL ? c_where : "a built-in or a compile");
		prof_samples += slices > 600 ? 600u : (unsigned int)slices;
		prof_add(key, slices > 600 ? 600u : (unsigned int)slices);
	}
	prof_last_ms = prof_last_call_ms = t;
	c_where = NULL;
}

/* exported for the page report in vita/input/vita_input.c */
/* getElementById, for the page report */
static unsigned int id_calls, id_hits, id_exact, id_builds, id_build_ms;
/* every live thread, newest first; see vita_js_scrolled */
static struct jsthread *all_threads;
/* image sources scripts set, for the scroll log line */
static unsigned int img_src_sets;
/* entries into script from C made while promise jobs were running */
static unsigned int jobs_reentered;

void vita_js_report_profile(void);
void vita_js_report_profile(void)
{
	unsigned int shown;

	if (id_calls > 0) {
		vita_log("getElementById: %u calls, %u answered from the index, "
			 "%u by it being current, %u walks of the document in "
			 "%u ms", id_calls, id_hits, id_exact, id_builds,
			 id_build_ms);
		id_calls = id_hits = id_exact = id_builds = id_build_ms = 0;
	}
	if (jobs_reentered > 0) {
		vita_log("qjs: promise jobs called back into script from C %u "
			 "times (an event dispatched, a listener run), all "
			 "under the drain's one budget", jobs_reentered);
		jobs_reentered = 0;
	}
	if (prof_samples == 0) {
		return;
	}
	vita_log("profile: %u slices of %u ms of script; where it was most "
		 "often ([after X]: binding X, or a built-in or a compile, ran "
		 "long just before this point):", prof_samples,
		 (unsigned int)PROF_INTERVAL_MS);
	for (shown = 0; shown < 12; shown++) {
		unsigned int i, best = 0;
		bool any = false;

		for (i = 0; i < prof_n; i++) {
			if (prof[i].hits > 0 &&
			    (!any || prof[i].hits > prof[best].hits)) {
				best = i;
				any = true;
			}
		}
		if (!any) break;
		vita_log("profile: %3u%% %s",
			 prof[best].hits * 100u / prof_samples,
			 prof[best].where);
		prof[best].hits = 0;
	}
	if (prof_other > 0) {
		vita_log("profile: %u samples fell outside the %u places kept",
			 prof_other, (unsigned int)PROF_SLOTS);
	}
	prof_n = 0;
	prof_samples = 0;
	prof_other = 0;
}

static int qjs_interrupt_body(jsthread *thread);

static int qjs_interrupt(JSRuntime *rt, void *opaque)
{
	jsthread *thread = opaque;
	static bool inside;
	int r;

	(void)rt;
	if (thread == NULL || thread->deadline_ms == 0) {
		return 0;
	}
	/*
	 * Not re-entered (VitaSurf). Taking a stack, for the profile or
	 * for the overrun line, runs script, and that script reaches the
	 * interrupt check too: the abort then fell inside our own stack
	 * capture, which swallowed it, and what reached the page was a
	 * plain null its catch could take. tests/budget/mutate.html left
	 * its loop that way.
	 */
	if (inside) {
		return 0;
	}
	inside = true;
	r = qjs_interrupt_body(thread);
	inside = false;
	return r;
}

static int qjs_interrupt_body(jsthread *thread)
{
	/*
	 * Circle, pressed over the busy overlay, stops the script the same
	 * way the budget does (VitaSurf): the screen had stayed as it was
	 * for as long as the page's script cared to run.
	 */
	{
		uint64_t t = now_ms();
		bool in_c = t - prof_last_call_ms >= PROF_INTERVAL_MS;

		prof_last_call_ms = t;
		if (t - prof_last_ms >= PROF_INTERVAL_MS && thread->ctx != NULL &&
		    !thread->aborting) {
			uint64_t slices = (t - prof_last_ms) / PROF_INTERVAL_MS;

			prof_last_ms = t;
			prof_sample(thread->ctx, slices > 600 ? 600u :
				    (unsigned int)slices, in_c);
		}
		/* script is running again: no binding is */
		c_where = NULL;
	}
	if (vita_busy_take_cancel()) {
		vita_log("qjs: Circle stopped the running script: %s",
			 thread->current_script != NULL ?
			 thread->current_script : "?");
		thread->deadline_ms = 1;
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
			int level;

			vita_log("qjs: script exceeded its time budget: %s",
				 thread->current_script != NULL ?
				 thread->current_script : "?");
			/*
			 * And where it was when the axe fell (VitaSurf). The
			 * abort itself throws null, which carries no stack,
			 * and build 410 could name only the script: both
			 * levels said <prelude>, which is our own code and
			 * eleven thousand lines of it.
			 *
			 * Throwing an Error from C does not help: when the
			 * current frame is bytecode the engine leaves the
			 * backtrace to be added as the exception unwinds,
			 * and taking it straight back means it never is.
			 * Error.captureStackTrace builds the trace on the
			 * spot from the live frames, so call that.
			 */
			{
				char *st = capture_stack(thread->ctx);

				if (st != NULL) {
					vita_log("qjs:   %s", st);
					free(st);
				}
			}
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

/*
 * What a binding that called back into script returns (VitaSurf). When
 * the budget abort landed inside that call -- the page's mutation hook
 * behind setAttribute, say -- qjs_absorb_or_rethrow leaves it pending,
 * but a binding that then returns a value lets the script carry on with
 * the exception still set, and it later surfaced as a plain null the
 * page's own catch took: the runaway in tests/budget/mutate.html left
 * its loop and kept going.
 */
static JSValue ret_or_abort(JSContext *ctx, JSValue r)
{
	if (qjs_budget_abort(ctx) && JS_HasException(ctx)) {
		JS_FreeValue(ctx, r);
		return JS_EXCEPTION;
	}
	return r;
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

static struct dom_document *thread_document(jsthread *thread);

static JSValue wrap_node(JSContext *ctx, struct dom_node *node)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct js_wrapper *w;
	unsigned h;
	JSValue obj;

	if (node == NULL) {
		return JS_NULL;
	}
	/*
	 * The document node is the document object (VitaSurf). It had a
	 * wrapper of its own, so documentElement.parentNode was not
	 * document, and a loop walking up until it reached document never
	 * did; ownerDocument already answered with the real one.
	 */
	if (thread != NULL &&
	    node == (struct dom_node *) thread_document(thread)) {
		JSValue global = JS_GetGlobalObject(ctx);
		JSValue d = JS_GetPropertyStr(ctx, global, "document");

		JS_FreeValue(ctx, global);
		if (JS_IsObject(d)) {
			return d;
		}
		JS_FreeValue(ctx, d);
	}
	/*
	 * How long the chain is, and what the lookup costs (VitaSurf).
	 * Every crossing that hands JavaScript a node comes through here.
	 */
	vitasurf_js_node_wraps++;
	{
		uint64_t w0 = now_ms();

		h = (unsigned)(((uintptr_t)node) >> 4) % WRAPPER_BUCKETS;
		if (thread != NULL) {
			for (w = thread->wrappers[h]; w != NULL; w = w->next) {
				vitasurf_js_wrap_steps++;
				if (w->node == node) {
					vitasurf_js_wrap_hits++;
					vitasurf_ms_js_wrap +=
						(unsigned)(now_ms() - w0);
					return JS_DupValue(ctx, w->obj);
				}
			}
		}
		vitasurf_ms_js_wrap += (unsigned)(now_ms() - w0);
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

	vitasurf_js_binding_calls++;
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

	vitasurf_js_binding_calls++;
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
	/*
	 * Attribute names that must be present (VitaSurf). A selector of
	 * nothing but [data-action] used to hand JavaScript every element
	 * under the root to test one by one, and GitHub's component
	 * framework asks exactly that of every element it binds. Only a
	 * necessary condition: the prelude still checks the value.
	 */
	dom_string **attrs;
	dom_string **attrs_lc;	/* the same, lower cased, or NULL */
	int nattrs;
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
/*
 * A count of the times the tree has changed, for the live collections
 * in prelude.js. getElementsByTagName and its relatives are live, and
 * the prelude made them so by running the query again on every read --
 * each .length, each [i] -- so a loop over one was a whole-document walk
 * per step, and one getElementsByClassName over Wikipedia's seven
 * thousand elements was fourteen thousand walks. A collection now keeps
 * its answer until this changes. Every C entry point that alters the
 * tree or an attribute bumps it, and so does the start of each script,
 * since the parser adds nodes between scripts.
 */
static uint32_t vita_gens[2];
#define vita_dom_gen (vita_gens[0])
/*
 * The same for the tree's shape alone (VitaSurf): nodes in, out or
 * moved, and the parser between scripts, but no attribute writes. A
 * collection that only a node moving can change, el.children or
 * getElementsByTagName, keeps its answer across attribute writes: a
 * loop that read el.children[i] and set an attribute each step had
 * the whole list built again every step.
 */
#define vita_tree_gen (vita_gens[1])
/*
 * Bumped by whatever can change which element an id names: a node going
 * in or out, an id attribute set or removed, the parser adding nodes
 * between scripts. Other attribute writes leave it, so a page setting
 * classes between lookups keeps its id index.
 */
static uint32_t vita_id_gen;

/*
 * When each element's attributes last changed (VitaSurf). The prelude
 * keeps an element's attributes map and used to throw it away whenever
 * anything anywhere in the document changed: Alpine writes attributes
 * as it walks the page, so every map went stale at once and every read
 * of el.attributes built it again from here, 101 of the 152 frames of
 * Yamtrack's seven-second start. A map now stays until its own
 * element's attributes change.
 *
 * A small table by node; an entry pushed out raises the floor, so an
 * element without an entry reads as changed at the floor, which is
 * never earlier than its last real change.
 */
#define ATTR_STAMP_SLOTS 4096
#define ATTR_STAMP_PROBE 8
static struct attr_stamp {
	struct dom_node *node;
	uint32_t stamp;
} attr_stamps[ATTR_STAMP_SLOTS];
static uint32_t attr_stamp_clock = 1;
static uint32_t attr_stamp_floor = 1;

static unsigned int attr_stamp_slot(const struct dom_node *node)
{
	return (unsigned int)(((uintptr_t)node >> 3) * 2654435761u) >> 20;
}

/* An element's attributes have just changed. */
static void attr_stamp_touch(struct dom_node *node)
{
	unsigned int h, i, free_i = ATTR_STAMP_SLOTS;

	if (node == NULL) {
		return;
	}
	attr_stamp_clock++;
	h = attr_stamp_slot(node);
	for (i = 0; i < ATTR_STAMP_PROBE; i++) {
		struct attr_stamp *e = &attr_stamps[(h + i) % ATTR_STAMP_SLOTS];

		if (e->node == node) {
			e->stamp = attr_stamp_clock;
			return;
		}
		if (e->node == NULL && free_i == ATTR_STAMP_SLOTS) {
			free_i = (h + i) % ATTR_STAMP_SLOTS;
		}
	}
	if (free_i == ATTR_STAMP_SLOTS) {
		/* full here: the one pushed out moves the floor up */
		free_i = h % ATTR_STAMP_SLOTS;
		if (attr_stamps[free_i].stamp > attr_stamp_floor) {
			attr_stamp_floor = attr_stamps[free_i].stamp;
		}
	}
	attr_stamps[free_i].node = node;
	attr_stamps[free_i].stamp = attr_stamp_clock;
}

/* When an element's attributes last changed, as far as can be told. */
static uint32_t attr_stamp_of(const struct dom_node *node)
{
	unsigned int h = attr_stamp_slot(node), i;

	for (i = 0; i < ATTR_STAMP_PROBE; i++) {
		const struct attr_stamp *e =
			&attr_stamps[(h + i) % ATTR_STAMP_SLOTS];

		if (e->node == node) {
			return e->stamp > attr_stamp_floor ?
				e->stamp : attr_stamp_floor;
		}
	}
	return attr_stamp_floor;
}

static JSValue node_attr_stamp(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	struct dom_node *node = JS_GetOpaque2(ctx, this_val, node_class_id);

	(void)argc;
	(void)argv;
	if (node == NULL || !node_is_element(node)) {
		return JS_NewInt32(ctx, -1);
	}
	return JS_NewUint32(ctx, attr_stamp_of(node) & 0x3fffffffu);
}

static void mark_dirty(JSContext *ctx)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	vita_dom_gen++;
	vita_tree_gen++;
	vita_id_gen++;
	if (thread != NULL) {
		thread->dom_dirty = true;
	}
}

/* mark_dirty for an attribute write, which moves an id only when it is
   the id attribute that changed. */
static void mark_attr_dirty(JSContext *ctx, const char *name)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	vita_dom_gen++;
	if (name == NULL || strcasecmp(name, "id") == 0) {
		vita_id_gen++;
	}
	if (thread != NULL) {
		thread->dom_dirty = true;
	}
}

static JSValue win_vita_module_state(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv);

static JSValue win_vita_dom_gen(JSContext *ctx, JSValueConst this_val,
				int argc, JSValueConst *argv)
{
	C_WHERE;
	(void)this_val; (void)argc; (void)argv;
	return JS_NewUint32(ctx, vita_dom_gen);
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
	C_WHERE;
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_node_name(node, &s);
	return str_result(ctx, s);
}

static JSValue node_get_tag_name(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
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
	C_WHERE;
	struct dom_node *node = this_node(ctx, this_val);
	dom_node_type type = 0;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_node_type(node, &type);
	return JS_NewInt32(ctx, (int)type);
}

static JSValue node_get_text_content(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	vitasurf_js_text_reads++;
	{ uint64_t y0 = now_ms();
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_text_content(node, &s);
	vitasurf_ms_js_text_reads += (unsigned)(now_ms() - y0);
	return str_result(ctx, s);
	}

}

/*
 * Tell the page's MutationObservers what just changed. kind is
 * "childList", "attributes" or "characterData"; the two extra values
 * mean different things per kind and the prelude sorts them out.
 */

/*
 * The MutationObserver watch list, kept in C (VitaSurf).
 *
 * Every mutation used to call __vitaMutation, which walked from the
 * target to the root through parentNode -- a crossing into C and a
 * wrapper for each of some thirty ancestors on GitHub -- only to find,
 * mostly, that no observer wanted it: GitHub's observers filter on a
 * few attribute names, and hydration sets class and aria-* thousands of
 * times. 5000 attribute sets on a node thirty deep cost 3.7 s in the
 * native harness, 87% of it in that call. The prelude now registers
 * each watch here as well, and a change nobody wants never reaches
 * JavaScript. One that does is handed the watched nodes found above it
 * and their depths, instead of the whole chain.
 */
#define MO_SUBTREE	(1u << 0)
#define MO_ATTRIBUTES	(1u << 1)
#define MO_CHILDLIST	(1u << 2)
#define MO_CHARDATA	(1u << 3)

struct mo_watch {
	uint32_t id;
	struct dom_node *node;		/* a reference */
	uint32_t flags;
	char **filter;			/* lower case names, or NULL */
	uint32_t n_filter;
};

static void mo_watch_free(struct mo_watch *w)
{
	uint32_t i;

	if (w->node != NULL) {
		dom_node_unref(w->node);
	}
	for (i = 0; i < w->n_filter; i++) {
		free(w->filter[i]);
	}
	free(w->filter);
}

static uint32_t mo_kind_flag(const char *kind)
{
	if (strcmp(kind, "attributes") == 0) return MO_ATTRIBUTES;
	if (strcmp(kind, "childList") == 0) return MO_CHILDLIST;
	if (strcmp(kind, "characterData") == 0) return MO_CHARDATA;
	return 0;
}

/** Whether watch w wants this kind of change at this depth. */
static bool mo_watch_wants(const struct mo_watch *w, uint32_t kind,
			   unsigned depth, const char *attr)
{
	uint32_t i;

	if (depth > 0 && (w->flags & MO_SUBTREE) == 0) return false;
	if ((w->flags & kind) == 0) return false;
	if (kind == MO_ATTRIBUTES && w->filter != NULL) {
		if (attr == NULL) return false;
		for (i = 0; i < w->n_filter; i++) {
			if (strcasecmp(w->filter[i], attr) == 0) return true;
		}
		return false;
	}
	return true;
}

/**
 * Whether any observer wants a change of this kind to target.
 *
 * \param matches  if not NULL, receives an array of the watched nodes
 *                 found at or above target and their depths, as the
 *                 prelude's _wants reads them
 */
static bool mo_wanted(JSContext *ctx, jsthread *thread, uint32_t kind,
		      struct dom_node *target, const char *attr,
		      JSValue *matches)
{
	struct dom_node *n = target;
	unsigned depth = 0;
	bool any = false;
	uint32_t out = 0;

	if (thread == NULL || thread->mo_n == 0 || target == NULL) {
		return false;
	}
	if (matches != NULL) {
		*matches = JS_UNDEFINED;
	}
	dom_node_ref(n);
	while (n != NULL) {
		struct dom_node *up = NULL;
		unsigned i;
		bool listed = false;

		for (i = 0; i < thread->mo_n; i++) {
			const struct mo_watch *w = &thread->mo[i];

			if (w->node != n) continue;
			if (mo_watch_wants(w, kind, depth, attr)) any = true;
			listed = true;
		}
		if (listed && matches != NULL) {
			if (JS_IsUndefined(*matches)) {
				*matches = JS_NewArray(ctx);
			}
			JS_SetPropertyUint32(ctx, *matches, out++,
					     wrap_node(ctx, n));
			JS_SetPropertyUint32(ctx, *matches, out++,
					     JS_NewInt32(ctx, (int32_t) depth));
		}
		if (dom_node_get_parent_node(n, &up) != DOM_NO_ERR) {
			up = NULL;
		}
		dom_node_unref(n);
		n = up;
		depth++;
	}
	if (!any && matches != NULL && !JS_IsUndefined(*matches)) {
		JS_FreeValue(ctx, *matches);
		*matches = JS_UNDEFINED;
	}
	return any;
}

/** A snapshot of target's children, only if an observer could want it. */
static JSValue children_snapshot(JSContext *ctx, struct dom_node *node);
static JSValue target_snapshot(JSContext *ctx, struct dom_node *node)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	if (!mo_wanted(ctx, thread, MO_CHILDLIST, node, NULL, NULL)) {
		return JS_UNDEFINED;
	}
	return children_snapshot(ctx, node);
}


/*
 * __vitaConnected(node): whether a node is in this page's document
 * (VitaSurf). The prelude's inDocument climbed parentNode in JavaScript,
 * a crossing into C and a wrapper per ancestor, on every querySelector
 * call; GitHub's component framework makes 160,000 of those binding what
 * it finds, and a build 419 log has one timer spend 20 s there.
 */
static JSValue win_vita_connected(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_node *n, *doc;

	(void)this_val;
	if (thread == NULL || argc < 1 || !JS_IsObject(argv[0])) {
		return JS_FALSE;
	}
	doc = (struct dom_node *) thread_document(thread);
	n = JS_GetOpaque(argv[0], node_class_id);
	if (n == NULL) {
		/* the document object is not a node wrapper */
		JSValue global = JS_GetGlobalObject(ctx);
		JSValue d = JS_GetPropertyStr(ctx, global, "document");
		bool same = JS_IsObject(d) &&
			JS_VALUE_GET_PTR(d) == JS_VALUE_GET_PTR(argv[0]);

		JS_FreeValue(ctx, d);
		JS_FreeValue(ctx, global);
		return JS_NewBool(ctx, same && doc != NULL);
	}
	if (doc == NULL) {
		return JS_FALSE;
	}
	dom_node_ref(n);
	while (n != NULL) {
		struct dom_node *up = NULL;

		if (n == doc) {
			dom_node_unref(n);
			return JS_TRUE;
		}
		if (dom_node_get_parent_node(n, &up) != DOM_NO_ERR) {
			up = NULL;
		}
		dom_node_unref(n);
		n = up;
	}
	return JS_FALSE;
}

/* __vitaMOWatch(id, node, flags, filter): register one watch entry */
static JSValue win_vita_mo_watch(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_node *node;
	struct mo_watch *w;
	uint32_t id = 0, flags = 0, len = 0, i;

	(void)this_val;
	if (thread == NULL || argc < 3) return JS_UNDEFINED;
	node = JS_GetOpaque(argv[1], node_class_id);
	if (node == NULL) {
		/* the document object is not a node wrapper */
		JSValue global = JS_GetGlobalObject(ctx);
		JSValue d = JS_GetPropertyStr(ctx, global, "document");

		if (JS_IsObject(d) &&
		    JS_VALUE_GET_PTR(d) == JS_VALUE_GET_PTR(argv[1])) {
			node = (struct dom_node *) thread_document(thread);
		}
		JS_FreeValue(ctx, d);
		JS_FreeValue(ctx, global);
		if (node == NULL) {
			return JS_UNDEFINED;
		}
	}
	JS_ToUint32(ctx, &id, argv[0]);
	JS_ToUint32(ctx, &flags, argv[2]);
	if (thread->mo_n == thread->mo_alloc) {
		unsigned want = thread->mo_alloc ? thread->mo_alloc * 2 : 8;
		struct mo_watch *grown = realloc(thread->mo,
						 want * sizeof(*grown));
		if (grown == NULL) return JS_UNDEFINED;
		thread->mo = grown;
		thread->mo_alloc = want;
	}
	w = &thread->mo[thread->mo_n];
	memset(w, 0, sizeof(*w));
	w->id = id;
	w->flags = flags;
	w->node = node;
	dom_node_ref(node);
	if (argc > 3 && JS_IsArray(argv[3])) {
		JSValue l = JS_GetPropertyStr(ctx, argv[3], "length");

		JS_ToUint32(ctx, &len, l);
		JS_FreeValue(ctx, l);
		w->filter = calloc(len > 0 ? len : 1, sizeof(char *));
		if (w->filter == NULL) {
			/* no filter list: be told of every attribute */
			len = 0;
		}
		for (i = 0; i < len; i++) {
			JSValue v = JS_GetPropertyUint32(ctx, argv[3], i);
			const char *c = JS_ToCString(ctx, v);

			w->filter[w->n_filter++] = strdup(c != NULL ? c : "");
			if (c != NULL) JS_FreeCString(ctx, c);
			JS_FreeValue(ctx, v);
		}
	}
	thread->mo_n++;
	return JS_UNDEFINED;
}

/* __vitaMOUnwatch(id): drop one watch entry */
static JSValue win_vita_mo_unwatch(JSContext *ctx, JSValueConst this_val,
				   int argc, JSValueConst *argv)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	uint32_t id = 0;
	unsigned i;

	(void)this_val;
	if (thread == NULL || argc < 1) return JS_UNDEFINED;
	JS_ToUint32(ctx, &id, argv[0]);
	for (i = 0; i < thread->mo_n; i++) {
		if (thread->mo[i].id != id) continue;
		mo_watch_free(&thread->mo[i]);
		thread->mo[i] = thread->mo[--thread->mo_n];
		break;
	}
	return JS_UNDEFINED;
}

static void notify_mutation_ns(JSContext *ctx, const char *kind,
			       struct dom_node *target,
			       JSValue a, JSValue b, JSValue extra)
{
	jsthread *thread = JS_GetContextOpaque(ctx);
	JSValue global, fn, matches = JS_UNDEFINED;

	if (thread == NULL || thread->watch_mutations == false ||
	    thread->closed) {
		JS_FreeValue(ctx, a);
		JS_FreeValue(ctx, b);
		JS_FreeValue(ctx, extra);
		return;
	}
	/* nobody wants it: nothing to tell JavaScript (VitaSurf) */
	{
		uint32_t k = mo_kind_flag(kind);
		const char *attr = NULL;
		bool wanted;

		if (k == MO_ATTRIBUTES && JS_IsString(a)) {
			attr = JS_ToCString(ctx, a);
		}
		wanted = mo_wanted(ctx, thread, k, target, attr, &matches);
		if (attr != NULL) JS_FreeCString(ctx, attr);
		if (!wanted) {
			vitasurf_js_mutations_skipped++;
			JS_FreeValue(ctx, a);
			JS_FreeValue(ctx, b);
			JS_FreeValue(ctx, extra);
			return;
		}
	}
	vitasurf_js_mutations_told++;
	global = JS_GetGlobalObject(ctx);
	fn = JS_GetPropertyStr(ctx, global, "__vitaMutation");
	if (JS_IsFunction(ctx, fn)) {
		JSValue args[6], r;

		args[0] = JS_NewString(ctx, kind);
		args[1] = wrap_node(ctx, target);
		args[2] = a;
		args[3] = b;
		args[4] = extra;
		args[5] = matches;
		r = JS_Call(ctx, fn, global, 6, args);
		if (JS_IsException(r)) {
			qjs_absorb_or_rethrow(ctx);
		}
		JS_FreeValue(ctx, r);
		JS_FreeValue(ctx, args[0]);
		JS_FreeValue(ctx, args[1]);
		JS_FreeValue(ctx, matches);
	} else {
		JS_FreeValue(ctx, matches);
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
	C_WHERE;
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
	C_WHERE;
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

		JSValue before = target_snapshot(ctx, node);

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
					target_snapshot(ctx, node), before);
		}
		if (!JS_IsNull(olddata)) JS_FreeValue(ctx, olddata);
	}
	if (s != NULL) JS_FreeCString(ctx, s);
	return ret_or_abort(ctx, JS_UNDEFINED);
}

static JSValue node_get_attr_prop(JSContext *ctx, JSValueConst this_val,
				  const char *name)
{
	C_WHERE;
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
	C_WHERE;
	return node_get_attr_prop(ctx, this_val, "id");
}

static JSValue node_get_class_name(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	return node_get_attr_prop(ctx, this_val, "class");
}

static JSValue node_set_attr_prop(JSContext *ctx, JSValueConst this_val,
				  const char *name, JSValueConst val)
{
	C_WHERE;
	vita_dom_gen++;
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
		attr_stamp_touch(node);
		mark_attr_dirty(ctx, name);
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
	return ret_or_abort(ctx, JS_UNDEFINED);
}

static JSValue node_set_id(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
	C_WHERE;
	return node_set_attr_prop(ctx, this_val, "id", v);
}

static JSValue node_set_class_name(JSContext *ctx, JSValueConst this_val,
				   JSValueConst v)
{
	C_WHERE;
	return node_set_attr_prop(ctx, this_val, "class", v);
}

static JSValue node_get_parent(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	vitasurf_js_tree_reads++;
	{ uint64_t w0 = now_ms();
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *p = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_parent_node(node, &p);
	r = wrap_node(ctx, p);
	if (p != NULL) dom_node_unref(p);
	vitasurf_ms_js_tree_reads += (unsigned)(now_ms() - w0);
	return r;
	}

}

static JSValue node_get_first_child(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	vitasurf_js_tree_reads++;
	{ uint64_t w0 = now_ms();
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_first_child(node, &c);
	r = wrap_node(ctx, c);
	if (c != NULL) dom_node_unref(c);
	vitasurf_ms_js_tree_reads += (unsigned)(now_ms() - w0);
	return r;
	}

}

static JSValue node_get_next_sibling(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	vitasurf_js_tree_reads++;
	{ uint64_t w0 = now_ms();
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_next_sibling(node, &c);
	r = wrap_node(ctx, c);
	if (c != NULL) dom_node_unref(c);
	vitasurf_ms_js_tree_reads += (unsigned)(now_ms() - w0);
	return r;
	}

}

static JSValue node_get_last_child(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	vitasurf_js_tree_reads++;
	{ uint64_t w0 = now_ms();
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_last_child(node, &c);
	r = wrap_node(ctx, c);
	if (c != NULL) dom_node_unref(c);
	vitasurf_ms_js_tree_reads += (unsigned)(now_ms() - w0);
	return r;
	}

}

static JSValue node_get_previous_sibling(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	vitasurf_js_tree_reads++;
	{ uint64_t w0 = now_ms();
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue r;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_previous_sibling(node, &c);
	r = wrap_node(ctx, c);
	if (c != NULL) dom_node_unref(c);
	vitasurf_ms_js_tree_reads += (unsigned)(now_ms() - w0);
	return r;
	}

}

/*
 * libdom's NodeList is a query, not an array: item(i) walks from the
 * root counting matches until it reaches i, and length() walks the whole
 * thing, so reading a list of n nodes one item at a time costs n*n node
 * visits. Wikipedia's mobile page has seven thousand elements and jQuery
 * reaches for getElementsByTagName on every selector, and one such read
 * was minutes on the Vita. The lists are walked once here instead.
 */
static JSValue node_get_child_nodes(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	struct dom_node *node = this_node(ctx, this_val);
	struct dom_node *c = NULL;
	JSValue arr;
	uint32_t i = 0;

	uint64_t t0;

	if (node == NULL) return JS_EXCEPTION;
	/* rebuilt on every read, so count what that costs (VitaSurf) */
	vitasurf_js_childnodes++;
	t0 = now_ms();
	arr = JS_NewArray(ctx);
	if (dom_node_get_first_child(node, &c) != DOM_NO_ERR) {
		c = NULL;
	}
	while (c != NULL) {
		struct dom_node *next = NULL;

		JS_SetPropertyUint32(ctx, arr, i++, wrap_node(ctx, c));
		if (dom_node_get_next_sibling(c, &next) != DOM_NO_ERR) {
			next = NULL;
		}
		dom_node_unref(c);
		c = next;
	}
	vitasurf_js_childnodes_items += i;
	vitasurf_ms_js_childnodes += (unsigned)(now_ms() - t0);
	return arr;
}

static JSValue node_get_node_value(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	struct dom_node *node = this_node(ctx, this_val);
	dom_string *s = NULL;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_node_value(node, &s);
	if (s == NULL) return JS_NULL;
	return str_result(ctx, s);
}

/*
 * nodeValue = x on a text or comment node is the same as data = x; on
 * anything else it does nothing. There was no setter at all, so the
 * value went into a plain property that shadowed the getter and the
 * node kept its old text: Svelte 5 writes every text node this way,
 * and Immich's login page came up with no words on it.
 */
static JSValue node_set_node_value(JSContext *ctx, JSValueConst this_val,
				   JSValueConst val)
{
	C_WHERE;
	struct dom_node *node = this_node(ctx, this_val);
	dom_node_type type = DOM_ELEMENT_NODE;

	if (node == NULL) return JS_EXCEPTION;
	dom_node_get_node_type(node, &type);
	if (type == DOM_TEXT_NODE || type == DOM_COMMENT_NODE ||
	    type == DOM_CDATA_SECTION_NODE ||
	    type == DOM_PROCESSING_INSTRUCTION_NODE) {
		return node_set_text_content(ctx, this_val, val);
	}
	return JS_UNDEFINED;
}

/* --- node methods --- */

static JSValue node_get_attribute(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	C_WHERE;
	vitasurf_js_attr_gets++;
	{ uint64_t g0 = now_ms();
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
	vitasurf_ms_js_attr_get_time += (unsigned)(now_ms() - g0);
	return r;
	}

}

/*
 * element.attributes, as an array of {name, value} with the item() and
 * getNamedItem() a NamedNodeMap answers to. Pages read it to copy an
 * element's attributes, and polyfills walk the name looking for a
 * descriptor, so its absence threw where they patch.
 */
static JSValue node_get_attributes(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
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
	vitasurf_js_attr_maps++;
	vitasurf_js_attr_map_items += len;
	for (i = 0; i < len; i++) {
		struct dom_node *attr = NULL;
		dom_string *name = NULL, *val = NULL, *ns = NULL;
		JSValue entry, jname;

		if (dom_namednodemap_item(map, i, &attr) != DOM_NO_ERR ||
		    attr == NULL) {
			continue;
		}
		dom_node_get_node_name(attr, &name);
		dom_node_get_node_value(attr, &val);
		dom_node_get_namespace(attr, &ns);
		entry = JS_NewObject(ctx);
		jname = name != NULL ?
			JS_NewStringLen(ctx, dom_string_data(name),
					dom_string_byte_length(name)) :
			JS_NewString(ctx, "");
		/* defined, not set: a fresh object has no setters to find,
		 * and Alpine asks for every element's attributes */
		JS_DefinePropertyValueStr(ctx, entry, "name",
					  JS_DupValue(ctx, jname), JS_PROP_C_W_E);
		JS_DefinePropertyValueStr(ctx, entry, "value",
				  val != NULL ?
				  JS_NewStringLen(ctx, dom_string_data(val),
						  dom_string_byte_length(val)) :
				  JS_NewString(ctx, ""), JS_PROP_C_W_E);
		JS_DefinePropertyValueStr(ctx, entry, "specified", JS_TRUE,
					  JS_PROP_C_W_E);
		if (ns == NULL) {
			/* An attribute in no namespace has no prefix and is
			 * its own local name: two libdom calls and a string
			 * spared on nearly every attribute of a page. */
			JS_DefinePropertyValueStr(ctx, entry, "namespace",
						  JS_NULL, JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, entry, "localName",
						  jname, JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, entry, "prefix",
						  JS_NULL, JS_PROP_C_W_E);
		} else {
			dom_string *local = NULL, *prefix = NULL;

			JS_FreeValue(ctx, jname);
			dom_node_get_local_name(attr, &local);
			dom_node_get_prefix(attr, &prefix);
			JS_DefinePropertyValueStr(ctx, entry, "namespace",
					  JS_NewStringLen(ctx, dom_string_data(ns),
							  dom_string_byte_length(ns)),
					  JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, entry, "localName",
					  local != NULL ?
					  JS_NewStringLen(ctx, dom_string_data(local),
							  dom_string_byte_length(local)) :
					  JS_NULL, JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, entry, "prefix",
					  prefix != NULL ?
					  JS_NewStringLen(ctx, dom_string_data(prefix),
							  dom_string_byte_length(prefix)) :
					  JS_NULL, JS_PROP_C_W_E);
			dom_string_unref(ns);
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
	C_WHERE;
	vitasurf_js_attr_sets++;
	{ uint64_t t0 = now_ms();
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
		attr_stamp_touch(node);
		mark_attr_dirty(ctx, name);
		if (name != NULL && (strcasecmp(name, "src") == 0 ||
				     strcasecmp(name, "srcset") == 0)) {
			img_src_sets++;
		}
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
	vitasurf_ms_js_attr_time += (unsigned)(now_ms() - t0);
	return ret_or_abort(ctx, JS_UNDEFINED);
	}

}

static JSValue node_has_attribute(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	C_WHERE;
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
	C_WHERE;
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
		attr_stamp_touch(node);
		mark_attr_dirty(ctx, name);
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
	return ret_or_abort(ctx, JS_UNDEFINED);
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
	C_WHERE;
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
	C_WHERE;
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
		attr_stamp_touch(node);
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
	return ret_or_abort(ctx, JS_UNDEFINED);
}

static JSValue node_has_attribute_ns(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	C_WHERE;
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
	C_WHERE;
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
		attr_stamp_touch(node);
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
	return ret_or_abort(ctx, JS_UNDEFINED);
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
	vitasurf_js_dom_edits++;
	{ uint64_t t0 = now_ms();
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
	vitasurf_ms_js_edit_time += (unsigned)(now_ms() - t0);
	return ret_or_abort(ctx, JS_DupValue(ctx, argv[0]));
	}

}

static JSValue node_replace_child(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	C_WHERE;
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
	return ret_or_abort(ctx, JS_DupValue(ctx, argv[1]));
}

static unsigned count_elements(struct dom_node *root);

/*
 * A clone that is worth a line of its own (VitaSurf). One cloneNode on
 * a GitHub load took 879 ms and nothing said what it copied, so a slow
 * one names the node and counts what came out of it: a single enormous
 * subtree and a clone that is slow per node look the same in a total.
 */
#define CLONE_SLOW_MS 50

static void clone_was_slow(struct dom_node *node, struct dom_node *copy,
			   bool deep, unsigned took)
{
	dom_string *name = NULL;

	if (dom_node_get_node_name(node, &name) != DOM_NO_ERR ||
	    name == NULL) {
		vita_log("qjs: a %s clone took %u ms for %u elements",
			 deep ? "deep" : "shallow", took,
			 count_elements(copy));
		return;
	}
	vita_log("qjs: a %s clone of <%s> took %u ms for %u elements",
		 deep ? "deep" : "shallow", dom_string_data(name), took,
		 count_elements(copy));
	dom_string_unref(name);
}

/*
 * The prelude says whether a selector it was asked to use came out of
 * its cache (VitaSurf), so the page report can put a number on the
 * parser a GitHub hydration job spent 7.8 seconds in.
 */
static JSValue win_vita_selector(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	C_WHERE;
	int kind = 0, steps = 0;

	(void)this_val;
	if (argc >= 1) {
		JS_ToInt32(ctx, &kind, argv[0]);
	}
	if (argc >= 2) {
		JS_ToInt32(ctx, &steps, argv[1]);
	}
	/* 0 parsed, 1 from the cache, then one per API: the page
	 * report says which call a page leans on */
	switch (kind) {
	case 0: vitasurf_js_selector_compiles++; break;
	case 1:
		/* the prelude batches its cache hits: steps is how many */
		vitasurf_js_selector_hits += steps > 0 ? (unsigned int)steps : 1;
		break;
	case 2: vitasurf_js_sel_all++; break;
	case 3: vitasurf_js_sel_one++; break;
	case 4: vitasurf_js_sel_matches++; break;
	case 5:
		vitasurf_js_sel_closest++;
		if (steps > 0) {
			vitasurf_js_sel_closest_steps += (unsigned int)steps;
		}
		break;
	case 6:
		/* a selector the general path has now matched this often */
		if (argc >= 3) {
			const char *t = JS_ToCString(ctx, argv[2]);

			if (t != NULL) {
				vita_log("qjs: selector '%.120s' has taken "
					 "the general path %d times", t,
					 steps);
				JS_FreeCString(ctx, t);
			}
		}
		break;
	default: break;
	}
	return JS_UNDEFINED;
}

/** Whether a dom_string holds exactly len bytes of s. */
static bool dom_string_is(dom_string *d, const char *s, size_t len)
{
	return d != NULL && dom_string_byte_length(d) == len &&
		memcmp(dom_string_data(d), s, len) == 0;
}

/*
 * Whether element n is what a selector of one bare tag names: the name
 * in any ASCII case for an element in the HTML namespace or none, the
 * name exactly as written for any other -- the prelude's matchSimple.
 * local is n's local name, already fetched by the caller.
 */
static bool tag_is(struct dom_node *n, dom_string *local,
		   const char *tag, size_t tag_len)
{
	static const char html_ns[] = "http://www.w3.org/1999/xhtml";
	dom_string *ns = NULL, *name = NULL;
	bool html, hit;

	if (local == NULL || dom_string_byte_length(local) != tag_len ||
	    strncasecmp(dom_string_data(local), tag, tag_len) != 0) {
		return false;	/* the common case: a different name */
	}
	dom_node_get_namespace(n, &ns);
	html = ns == NULL || dom_string_is(ns, html_ns, sizeof(html_ns) - 1);
	if (ns != NULL) dom_string_unref(ns);
	if (html) {
		return true;
	}
	if (dom_element_get_tag_name(n, &name) != DOM_NO_ERR) {
		return false;
	}
	hit = dom_string_is(name, tag, tag_len);
	if (name != NULL) dom_string_unref(name);
	return hit;
}

/* A tag name's hash with ASCII folded to lower case; 0 is never one. */
static uint32_t tag_hash_lower(const char *p, size_t n)
{
	uint32_t h = 2166136261u;
	size_t i;

	for (i = 0; i < n; i++) {
		unsigned char c = (unsigned char) p[i];

		if (c >= 'A' && c <= 'Z') c = (unsigned char) (c + 32);
		h = (h ^ c) * 16777619u;
	}
	return h | 1u;
}

static void tags_free(jsthread *thread)
{
	if (thread->tags_root != NULL) dom_node_unref(thread->tags_root);
	thread->tags_root = NULL;
	free(thread->tags_set);
	thread->tags_set = NULL;
	thread->tags_cap = thread->tags_n = 0;
	thread->tags_built = false;
}

static bool tags_has(const jsthread *thread, uint32_t h)
{
	uint32_t mask = thread->tags_cap - 1, i;

	if (thread->tags_cap == 0) return false;
	for (i = h & mask; thread->tags_set[i] != 0; i = (i + 1) & mask) {
		if (thread->tags_set[i] == h) return true;
	}
	return false;
}

static bool tags_add(jsthread *thread, uint32_t h)
{
	uint32_t mask, i;

	if ((thread->tags_n + 1) * 2 > thread->tags_cap) {
		uint32_t cap = thread->tags_cap ? thread->tags_cap * 2 : 128;
		uint32_t *set = calloc(cap, sizeof(*set)), j;

		if (set == NULL) return false;
		for (j = 0; j < thread->tags_cap; j++) {
			uint32_t v = thread->tags_set[j];

			if (v == 0) continue;
			for (i = v & (cap - 1); set[i] != 0;
			     i = (i + 1) & (cap - 1)) {
			}
			set[i] = v;
		}
		free(thread->tags_set);
		thread->tags_set = set;
		thread->tags_cap = cap;
	}
	mask = thread->tags_cap - 1;
	for (i = h & mask; thread->tags_set[i] != 0; i = (i + 1) & mask) {
		if (thread->tags_set[i] == h) return true;
	}
	thread->tags_set[i] = h;
	thread->tags_n++;
	return true;
}

/* Every element name under root, root itself left out as a query
 * leaves it out. False if there was no memory for them. */
static bool tags_build(jsthread *thread, struct dom_node *root)
{
	struct dom_node *n = NULL;

	vitasurf_js_sel_tag_sets++;
	if (dom_node_get_first_child(root, &n) != DOM_NO_ERR) n = NULL;
	while (n != NULL) {
		struct dom_node *next = NULL;

		dom_node_type type = 0;

		if (dom_node_get_node_type(n, &type) == DOM_NO_ERR &&
		    type == DOM_ELEMENT_NODE) {
			dom_string *local = NULL;
			bool ok = true;

			vitasurf_js_sel_tag_set_visits++;
			dom_node_get_local_name(n, &local);
			if (local != NULL) {
				ok = tags_add(thread, tag_hash_lower(
					dom_string_data(local),
					dom_string_byte_length(local)));
				dom_string_unref(local);
			}
			if (!ok) {
				dom_node_unref(n);
				return false;
			}
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
				if (dom_node_get_next_sibling(cur, &sib) ==
				    DOM_NO_ERR && sib != NULL) {
					next = sib;
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_parent_node(cur, &parent) !=
				    DOM_NO_ERR) {
					parent = NULL;
				}
				dom_node_unref(cur);
				cur = parent;
			}
		}
		dom_node_unref(n);
		n = next;
	}
	return true;
}

/*
 * Whether no element under root can have the name tag_hash_lower gave
 * tag_hash, so that a bare tag query of root finds nothing without
 * walking it (VitaSurf); see jsthread's tags_root. False means only
 * that the walk must decide.
 */
static bool tags_absent(jsthread *thread, struct dom_node *root,
			uint32_t tag_hash)
{
	if (thread->tags_root != root || thread->tags_gen != vita_tree_gen) {
		if (thread->tags_root != NULL) {
			dom_node_unref(thread->tags_root);
		}
		thread->tags_root = dom_node_ref(root);
		thread->tags_gen = vita_tree_gen;
		thread->tags_asks = 0;
		thread->tags_built = false;
		thread->tags_n = 0;
		if (thread->tags_set != NULL) {
			memset(thread->tags_set, 0,
			       thread->tags_cap * sizeof(*thread->tags_set));
		}
	}
	if (!thread->tags_built) {
		if (++thread->tags_asks < 2) return false;
		if (!tags_build(thread, root)) {
			thread->tags_n = 0;
			if (thread->tags_set != NULL) {
				memset(thread->tags_set, 0, thread->tags_cap *
				       sizeof(*thread->tags_set));
			}
			return false;
		}
		thread->tags_built = true;
	}
	if (tags_has(thread, tag_hash)) return false;
	vitasurf_js_sel_tag_absent++;
	return true;
}

/*
 * __vitaTagQuery(node, tag, mode): a selector of one bare, ASCII tag
 * name, answered in C (VitaSurf). mode 0 is matches(), 1 querySelector,
 * 2 querySelectorAll. GitHub's lazy component loader asks each element
 * added to the page for every tag it may load -- element.matches(tag),
 * then element.querySelector(tag) -- 280,000 calls on one profile page,
 * and through the general selector path that was 20 s of a timer the
 * budget stopped. Returns undefined for anything that is not a node
 * wrapper (a document object), and the prelude takes its own path.
 */
static JSValue win_vita_tag_query(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	C_WHERE;
	struct dom_node *root, *n = NULL;
	const char *tag;
	size_t tag_len;
	int32_t mode = 0;
	JSValue out = JS_NULL;
	uint32_t out_n = 0;

	(void)this_val;
	if (argc < 3 || !JS_IsObject(argv[0])) {
		return JS_UNDEFINED;
	}
	root = JS_GetOpaque(argv[0], node_class_id);
	if (root == NULL) {
		return JS_UNDEFINED;
	}
	JS_ToInt32(ctx, &mode, argv[2]);
	tag = JS_ToCStringLen(ctx, &tag_len, argv[1]);
	if (tag == NULL) {
		return JS_EXCEPTION;
	}
	vitasurf_js_sel_tag_fast++;
	if (mode == 0) {
		dom_node_type type = 0;
		dom_string *local = NULL;
		bool hit = false;

		vitasurf_js_sel_matches++;
		if (dom_node_get_node_type(root, &type) == DOM_NO_ERR &&
		    type == DOM_ELEMENT_NODE) {
			dom_node_get_local_name(root, &local);
			hit = tag_is(root, local, tag, tag_len);
			if (local != NULL) dom_string_unref(local);
		}
		JS_FreeCString(ctx, tag);
		return JS_NewBool(ctx, hit);
	}
	if (mode == 2) {
		vitasurf_js_sel_all++;
		out = JS_NewArray(ctx);
	} else {
		vitasurf_js_sel_one++;
	}
	{
		jsthread *thread = JS_GetContextOpaque(ctx);

		if (thread != NULL && tags_absent(thread, root,
				tag_hash_lower(tag, tag_len))) {
			JS_FreeCString(ctx, tag);
			return out;
		}
	}
	/* iterative pre-order walk; root itself is not a candidate */
	if (dom_node_get_first_child(root, &n) != DOM_NO_ERR) {
		n = NULL;
	}
	while (n != NULL) {
		struct dom_node *next = NULL;
		dom_node_type type = 0;

		if (dom_node_get_node_type(n, &type) == DOM_NO_ERR &&
		    type == DOM_ELEMENT_NODE) {
			dom_string *local = NULL;
			bool hit;

			vitasurf_js_sel_tag_visits++;
			dom_node_get_local_name(n, &local);
			hit = tag_is(n, local, tag, tag_len);
			if (local != NULL) dom_string_unref(local);
			if (hit) {
				if (mode != 2) {
					out = wrap_node(ctx, n);
					dom_node_unref(n);
					break;
				}
				JS_SetPropertyUint32(ctx, out, out_n++,
						     wrap_node(ctx, n));
			}
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
				if (dom_node_get_next_sibling(cur, &sib) ==
				    DOM_NO_ERR && sib != NULL) {
					next = sib;
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_parent_node(cur, &parent) !=
				    DOM_NO_ERR) {
					parent = NULL;
				}
				dom_node_unref(cur);
				cur = parent;
			}
		}
		dom_node_unref(n);
		n = next;
	}
	JS_FreeCString(ctx, tag);
	return out;
}

/*
 * __vitaClosestTag(node, tag, tagUpper): closest() for a selector that
 * is one bare tag name (VitaSurf). GitHub's component framework asks
 * closest(tagName) of every element it binds; in JavaScript that was a
 * wrapper and a matches() call per ancestor. The test is the prelude's
 * matchSimple: tagUpper for an element in the HTML namespace or none,
 * tag as written for any other.
 */
static JSValue win_vita_closest_tag(JSContext *ctx, JSValueConst this_val,
				    int argc, JSValueConst *argv)
{
	C_WHERE;
	static const char html_ns[] = "http://www.w3.org/1999/xhtml";
	struct dom_node *n;
	const char *tag, *upper;
	size_t tag_len, upper_len;
	JSValue result = JS_NULL;
	unsigned int steps = 0;

	(void)this_val;
	if (argc < 3 || !JS_IsObject(argv[0])) {
		return JS_NULL;
	}
	n = JS_GetOpaque(argv[0], node_class_id);
	if (n == NULL) {
		return JS_NULL;
	}
	tag = JS_ToCStringLen(ctx, &tag_len, argv[1]);
	if (tag == NULL) {
		return JS_EXCEPTION;
	}
	upper = JS_ToCStringLen(ctx, &upper_len, argv[2]);
	if (upper == NULL) {
		JS_FreeCString(ctx, tag);
		return JS_EXCEPTION;
	}
	vitasurf_js_sel_closest++;
	vitasurf_js_sel_closest_native++;
	dom_node_ref(n);
	while (n != NULL) {
		dom_node_type type = 0;
		struct dom_node *up = NULL;

		if (dom_node_get_node_type(n, &type) != DOM_NO_ERR ||
		    type != DOM_ELEMENT_NODE) {
			break;
		}
		steps++;
		{
			dom_string *name = NULL, *ns = NULL;
			bool html, hit;

			dom_node_get_namespace(n, &ns);
			html = ns == NULL ||
				dom_string_is(ns, html_ns, sizeof(html_ns) - 1);
			if (dom_element_get_tag_name(n, &name) != DOM_NO_ERR) {
				name = NULL;
			}
			hit = html ? dom_string_is(name, upper, upper_len)
				: dom_string_is(name, tag, tag_len);
			if (name != NULL) dom_string_unref(name);
			if (ns != NULL) dom_string_unref(ns);
			if (hit) {
				result = wrap_node(ctx, n);
				break;
			}
		}
		if (dom_node_get_parent_node(n, &up) != DOM_NO_ERR) {
			up = NULL;
		}
		dom_node_unref(n);
		n = up;
	}
	if (n != NULL) {
		dom_node_unref(n);
	}
	vitasurf_js_sel_closest_steps += steps;
	JS_FreeCString(ctx, upper);
	JS_FreeCString(ctx, tag);
	return result;
}

static JSValue node_clone_node(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	C_WHERE;
	vitasurf_js_clones++;
	{ uint64_t y0 = now_ms();
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
	{
		unsigned took = (unsigned)(now_ms() - y0);

		if (took >= CLONE_SLOW_MS) {
			clone_was_slow(node, copy, deep, took);
		}
		vitasurf_ms_js_clones += took;
	}
	dom_node_unref(copy);
	return r;
	}

}

static JSValue node_get_elements_by_tag_name(JSContext *ctx, JSValueConst this_val,
					     int argc, JSValueConst *argv)
{
	C_WHERE;
	struct dom_node *node = this_node(ctx, this_val);
	const char *name;

	if (node == NULL || argc < 1) return JS_NewArray(ctx);
	name = JS_ToCString(ctx, argv[0]);
	if (name == NULL) return JS_NewArray(ctx);

	/* Walked, never read out of a libdom NodeList: see childNodes. A
	 * document fragment has no element vtable either way. */
	{
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
	C_WHERE;
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
	C_WHERE;
	vitasurf_js_dom_edits++;
	{ uint64_t t0 = now_ms();
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
	vitasurf_ms_js_edit_time += (unsigned)(now_ms() - t0);
	return ret_or_abort(ctx, JS_DupValue(ctx, argv[0]));
	}

}

static JSValue node_remove_child(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	C_WHERE;
	vitasurf_js_dom_edits++;
	{ uint64_t t0 = now_ms();
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
	vitasurf_ms_js_edit_time += (unsigned)(now_ms() - t0);
	return ret_or_abort(ctx, JS_DupValue(ctx, argv[0]));
	}

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
	uint64_t t_stage = now_ms();

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
	/*
	 * Parse quietly (VitaSurf). The fragment parser is created on the
	 * page's own document, so every node it built raised two mutation
	 * events into NetSurf's default action -- image, style and script
	 * processing and the inline-handler hook -- for a subtree that is
	 * not in the page yet. 415 KB of GitHub's markup took 870 ms to
	 * parse that way. With the document quiet the nodes are marked
	 * instead, and when they are moved into the target below, the
	 * insert of each top-level node settles what its descendants are
	 * owed, once.
	 */
	dom_document_quiet_mutations(doc, +1);
	if (dom_hubbub_fragment_parser_create(&params, doc, &parser,
					      &fragment) != DOM_HUBBUB_OK) {
		dom_document_quiet_mutations(doc, -1);
		goto out;
	}
	/*
	 * The fragment parser has no context element and starts as if at
	 * the top of a page, where whitespace is thrown away until the
	 * body opens: "<!> <!> <!>" came back as three comments with no
	 * text between them, and Svelte, which walks a template's nodes
	 * by count, stepped off the end. An element's markup is what goes
	 * inside a body, so open one first. (Chromium's fragment parser
	 * starts in the same "in body" mode for a div.)
	 */
	if (node != (struct dom_node *)doc &&
	    dom_hubbub_parser_parse_chunk(parser, (const uint8_t *)"<body>",
					  6) != DOM_HUBBUB_OK) {
		dom_document_quiet_mutations(doc, -1);
		goto out;
	}
	if (dom_hubbub_parser_parse_chunk(parser, (const uint8_t *)html,
					  len) != DOM_HUBBUB_OK) {
		dom_document_quiet_mutations(doc, -1);
		goto out;
	}
	if (dom_hubbub_parser_completed(parser) != DOM_HUBBUB_OK) {
		dom_document_quiet_mutations(doc, -1);
		goto out;
	}
	dom_document_quiet_mutations(doc, -1);
	vitasurf_ms_html_js_parse += (unsigned)(now_ms() - t_stage);
	t_stage = now_ms();
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
	vitasurf_ms_html_js_empty += (unsigned)(now_ms() - t_stage);
	t_stage = now_ms();
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
	vitasurf_ms_html_js_move += (unsigned)(now_ms() - t_stage);
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
	C_WHERE;
	vitasurf_js_html_sets++;
	struct dom_node *node = this_node(ctx, this_val);
	size_t len = 0;
	const char *s;

	JSValue before;

	if (node == NULL) return JS_EXCEPTION;
	before = target_snapshot(ctx, node);
	/* innerHTML is [LegacyNullToEmptyString]: null empties the element
	 * rather than writing the four letters of "null" into it. */
	if (JS_IsNull(val)) {
		s = JS_ToCStringLen(ctx, &len, JS_NewString(ctx, ""));
	} else {
		s = JS_ToCStringLen(ctx, &len, val);
	}
	if (s != NULL) {
		vitasurf_js_html_bytes += (unsigned) len;
		set_inner_html(node, s, len);
		JS_FreeCString(ctx, s);
		mark_dirty(ctx);
		notify_mutation(ctx, "childList", node,
				target_snapshot(ctx, node), before);
		before = JS_UNDEFINED;
	}
	JS_FreeValue(ctx, before);
	return ret_or_abort(ctx, JS_UNDEFINED);
}

static JSValue node_get_inner_html(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
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

/* Which chain of the index a node's listeners are on. */
static size_t listener_bucket(size_t size, const struct dom_node *node)
{
	uintptr_t h = (uintptr_t) node;

	h ^= h >> 12;
	h *= (uintptr_t) 0x9e3779b1u;
	h ^= h >> 15;

	return (size_t) h & (size - 1);
}

/*
 * Build or grow the index, threading every listener onto it again.
 *
 * Returns true when it did, which tells the caller its own listener is
 * already on a chain and must not be linked a second time -- doing that
 * makes a chain that points back into itself, and the scan never ends.
 */
static bool listener_hash_resize(jsthread *thread, size_t want)
{
	struct js_listener **fresh;
	struct js_listener *l;
	size_t size = thread->node_hash_size != 0 ?
			thread->node_hash_size * 2 : 64;

	while (size < want) {
		size *= 2;
	}
	fresh = calloc(size, sizeof(*fresh));
	if (fresh == NULL) {
		return false;	/* the old index, or none, still serves */
	}
	free(thread->node_hash);
	thread->node_hash = fresh;
	thread->node_hash_size = size;

	for (l = thread->listeners; l != NULL; l = l->next) {
		size_t b = listener_bucket(size, l->node);

		l->node_next = fresh[b];
		fresh[b] = l;
	}

	return true;
}

static void listener_hash_add(jsthread *thread, struct js_listener *l)
{
	size_t b;

	if (thread->node_hash_size == 0 ||
	    thread->listener_count > thread->node_hash_size * 4) {
		if (listener_hash_resize(thread,
					 thread->listener_count * 2 + 64)) {
			return;
		}
		if (thread->node_hash_size == 0) {
			return;	/* no index; the whole list is scanned */
		}
	}
	b = listener_bucket(thread->node_hash_size, l->node);
	l->node_next = thread->node_hash[b];
	thread->node_hash[b] = l;
}

static void listener_hash_remove(jsthread *thread, struct js_listener *l)
{
	struct js_listener **pp;
	size_t b;

	if (thread->node_hash_size == 0) {
		return;
	}
	b = listener_bucket(thread->node_hash_size, l->node);
	for (pp = &thread->node_hash[b]; *pp != NULL; pp = &(*pp)->node_next) {
		if (*pp == l) {
			*pp = l->node_next;
			break;
		}
	}
	l->node_next = NULL;
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
			if (thread->listener_count > 0) {
				thread->listener_count--;
			}
			break;
		}
	}
	listener_hash_remove(thread, l);
	if (l->dead && thread->dead_listeners > 0) {
		thread->dead_listeners--;
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

	if (thread->event_depth > 0 || thread->closed ||
	    thread->dead_listeners == 0) {
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
	if (thread->node_hash_size != 0) {
		l = thread->node_hash[listener_bucket(thread->node_hash_size,
						      node)];
		for (; l != NULL; l = l->node_next) {
			if (listener_matches(ctx, l, node, type_dom, func,
					     capture)) {
				dom_string_unref(type_dom);
				JS_FreeCString(ctx, type);
				return JS_UNDEFINED;
			}
		}
	} else {
		for (l = thread->listeners; l != NULL; l = l->next) {
			if (listener_matches(ctx, l, node, type_dom, func,
					     capture)) {
				dom_string_unref(type_dom);
				JS_FreeCString(ctx, type);
				return JS_UNDEFINED;
			}
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
	thread->listener_count++;
	listener_hash_add(thread, l);

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
	l = thread->node_hash_size != 0 ?
		thread->node_hash[listener_bucket(thread->node_hash_size,
						  node)] :
		thread->listeners;
	for (; l != NULL; l = thread->node_hash_size != 0 ?
			l->node_next : l->next) {
		if (listener_matches(ctx, l, node, type_dom, func, capture)) {
			/*
			 * A listener can remove itself from inside its own
			 * call, and libdom is walking the list it is in, so
			 * mark it and let the trampoline free it.
			 */
			if (thread->event_depth > 0) {
				l->dead = true;
				thread->dead_listeners++;
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
	C_WHERE;
	if (argc < 2) return JS_UNDEFINED;
	return add_listener(ctx, this_node(ctx, this_val), argv[0], argv[1],
			    argc > 2 ? argv[2] : JS_UNDEFINED);
}

static JSValue node_remove_event_listener(JSContext *ctx, JSValueConst this_val,
					  int argc, JSValueConst *argv)
{
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);

	(void)this_val;
	return JS_NewString(ctx, (thread != NULL && thread->ready_state != NULL)
			    ? thread->ready_state : "loading");
}

static JSValue doc_add_event_listener(JSContext *ctx, JSValueConst this_val,
				      int argc, JSValueConst *argv)
{
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	JS_CGETSET_DEF("nodeValue", node_get_node_value, node_set_node_value),
	JS_CGETSET_DEF("attributes", node_get_attributes, NULL),
	JS_CFUNC_DEF("__vitaAttrStamp", 0, node_attr_stamp),
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

/*
 * getElementById by index (VitaSurf). libdom answers it by walking the
 * document from the top, reading every element's id attribute on the
 * way, and GitHub spent 5 s of one stall in those walks. The index maps
 * each id to the first element carrying it, built by one walk. While
 * vita_id_gen has not moved it is exact, misses included. After the
 * tree has changed, an entry is still used when its element still has
 * that id and is still in the document; only a miss walks again, and
 * that walk rebuilds the whole index.
 */
struct id_entry {
	struct id_entry *next;
	dom_string *id;
	struct dom_node *el;
	uint32_t hash;
};

static void id_index_free(jsthread *thread)
{
	uint32_t b;

	for (b = 0; b < thread->id_idx_nb; b++) {
		while (thread->id_idx[b] != NULL) {
			struct id_entry *e = thread->id_idx[b];

			thread->id_idx[b] = e->next;
			dom_string_unref(e->id);
			dom_node_unref(e->el);
			free(e);
		}
	}
	free(thread->id_idx);
	thread->id_idx = NULL;
	thread->id_idx_nb = 0;
	thread->id_idx_n = 0;
	thread->id_idx_built = false;
}

static struct id_entry *id_index_find(jsthread *thread, dom_string *id,
				      uint32_t h)
{
	struct id_entry *e;

	if (thread->id_idx_nb == 0) {
		return NULL;
	}
	for (e = thread->id_idx[h & (thread->id_idx_nb - 1)]; e != NULL;
	     e = e->next) {
		if (e->hash == h && dom_string_isequal(e->id, id)) {
			return e;
		}
	}
	return NULL;
}

static void id_index_grow(jsthread *thread)
{
	uint32_t nb = thread->id_idx_nb != 0 ? thread->id_idx_nb * 2 : 256;
	struct id_entry **nt = calloc(nb, sizeof(*nt));
	uint32_t b;

	if (nt == NULL) {
		return;
	}
	for (b = 0; b < thread->id_idx_nb; b++) {
		while (thread->id_idx[b] != NULL) {
			struct id_entry *e = thread->id_idx[b];

			thread->id_idx[b] = e->next;
			e->next = nt[e->hash & (nb - 1)];
			nt[e->hash & (nb - 1)] = e;
		}
	}
	free(thread->id_idx);
	thread->id_idx = nt;
	thread->id_idx_nb = nb;
}

/* Record el under id unless an earlier element already holds it. */
static void id_index_add(jsthread *thread, dom_string *id, struct dom_node *el)
{
	uint32_t h = dom_string_hash(id);
	struct id_entry *e;

	if (id_index_find(thread, id, h) != NULL) {
		return;
	}
	if (thread->id_idx_n >= thread->id_idx_nb) {
		id_index_grow(thread);
		if (thread->id_idx_nb == 0) {
			return;
		}
	}
	e = malloc(sizeof(*e));
	if (e == NULL) {
		return;
	}
	e->id = dom_string_ref(id);
	e->el = dom_node_ref(el);
	e->hash = h;
	e->next = thread->id_idx[h & (thread->id_idx_nb - 1)];
	thread->id_idx[h & (thread->id_idx_nb - 1)] = e;
	thread->id_idx_n++;
}

/* One pre-order walk of the document, recording every id. */
static void id_index_build(jsthread *thread, struct dom_node *root)
{
	uint64_t t0 = now_ms();
	struct dom_node *n = NULL;

	id_index_free(thread);
	if (dom_node_get_first_child(root, &n) != DOM_NO_ERR) {
		n = NULL;
	}
	while (n != NULL) {
		struct dom_node *next = NULL;
		dom_node_type type = DOM_TEXT_NODE;

		if (dom_node_get_node_type(n, &type) == DOM_NO_ERR &&
		    type == DOM_ELEMENT_NODE) {
			dom_string *id = NULL;

			dom_element_get_attribute(n, corestring_dom_id, &id);
			if (id != NULL) {
				if (dom_string_byte_length(id) > 0) {
					id_index_add(thread, id, n);
				}
				dom_string_unref(id);
			}
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
				if (dom_node_get_next_sibling(cur, &sib) ==
				    DOM_NO_ERR && sib != NULL) {
					next = sib;
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_parent_node(cur, &parent) !=
				    DOM_NO_ERR) {
					parent = NULL;
				}
				dom_node_unref(cur);
				cur = parent;
			}
		}
		dom_node_unref(n);
		n = next;
	}
	thread->id_idx_built = true;
	thread->id_idx_gen = vita_id_gen;
	id_builds++;
	id_build_ms += (unsigned int)(now_ms() - t0);
}

/* Whether el still carries id and still hangs from doc. */
static bool id_entry_holds(struct id_entry *e, struct dom_node *doc)
{
	dom_string *now = NULL;
	struct dom_node *cur;
	bool same;

	dom_element_get_attribute(e->el, corestring_dom_id, &now);
	if (now == NULL) {
		return false;
	}
	same = dom_string_isequal(now, e->id);
	dom_string_unref(now);
	if (!same) {
		return false;
	}
	cur = dom_node_ref(e->el);
	while (cur != NULL) {
		struct dom_node *parent = NULL;

		if (cur == doc) {
			dom_node_unref(cur);
			return true;
		}
		if (dom_node_get_parent_node(cur, &parent) != DOM_NO_ERR) {
			parent = NULL;
		}
		dom_node_unref(cur);
		cur = parent;
	}
	return false;
}

static JSValue doc_get_element_by_id(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *id;
	dom_string *key;
	struct id_entry *e;
	uint32_t h;
	JSValue r = JS_NULL;

	(void)this_val;
	if (doc == NULL || argc < 1) return JS_NULL;
	id = JS_ToCString(ctx, argv[0]);
	key = to_dom_string(id);
	if (id) JS_FreeCString(ctx, id);
	if (key == NULL) {
		return JS_NULL;
	}
	id_calls++;
	if (dom_string_byte_length(key) == 0) {
		dom_string_unref(key);
		return JS_NULL;
	}
	h = dom_string_hash(key);
	e = thread->id_idx_built ? id_index_find(thread, key, h) : NULL;
	if (thread->id_idx_built && thread->id_idx_gen == vita_id_gen) {
		id_exact++;
	} else if (e != NULL && id_entry_holds(e, (struct dom_node *)doc)) {
		id_hits++;
	} else {
		id_index_build(thread, (struct dom_node *)doc);
		e = id_index_find(thread, key, h);
	}
	if (e != NULL) {
		r = wrap_node(ctx, e->el);
	}
	dom_string_unref(key);
	return r;
}

static JSValue doc_get_elements_by_tag_name(JSContext *ctx, JSValueConst this_val,
					    int argc, JSValueConst *argv)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	const char *name;
	struct find_key k;
	size_t i, len;
	JSValue out;

	(void)this_val;
	if (doc == NULL || argc < 1) return JS_NewArray(ctx);
	name = JS_ToCString(ctx, argv[0]);
	if (name == NULL) return JS_NewArray(ctx);

	/* Walked, never read out of a libdom NodeList: see childNodes. */
	memset(&k, 0, sizeof(k));
	len = strlen(name);
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
	out = find_in_subtree(ctx, (struct dom_node *)doc, &k, 1);
	free(k.tag);
	return out;
}

static JSValue doc_create_element(JSContext *ctx, JSValueConst this_val,
				  int argc, JSValueConst *argv)
{
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
 * document.currentScript: the inline script element NetSurf is running,
 * or the <script src> whose URL matches the script being executed.
 * SvelteKit's bootstrap reads its parent element from it.
 */
static JSValue doc_get_current_script(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_document *doc = thread_document(thread);
	struct dom_nodelist *list = NULL;
	uint32_t len = 0, i;
	JSValue r = JS_NULL;

	(void)this_val;
	/* an inline script: NetSurf keeps the element while it runs */
	if (html_script_running() != NULL) {
		return wrap_node(ctx, html_script_running());
	}
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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

/**
 * The URL of the document a script belongs to (VitaSurf).
 *
 * The browser window's URL is the page the window is showing, which
 * during a load is still the previous one: the window commits the new
 * address when the load finishes, long after the page's own scripts
 * have run. So a script reading location while its page was parsing
 * was told where the browser had been, not where it is.
 *
 * Home Assistant reads it that early to work out its own address, and
 * so decided it was served from file:, sending the login to
 * file:///authorize with a hassUrl of "file:/" in its state.
 */
static nsurl *script_page_url(jsthread *thread)
{
	nsurl *url;

	if (thread == NULL) {
		return NULL;
	}
	if (thread->htmlc != NULL) {
		url = content_get_url((struct content *) thread->htmlc);
		if (url != NULL) {
			return url;
		}
	}
	return NULL;
}


static JSValue win_navigate(JSContext *ctx, jsthread *thread, const char *href)
{
	nsurl *cur = NULL, *url = NULL;

	if (thread == NULL || thread->win == NULL || href == NULL) {
		return JS_UNDEFINED;
	}
	/*
	 * Relative to the page's own base, not the window's address: a
	 * script that navigates before its page has finished loading
	 * would otherwise be resolved against the page before it.
	 */
	if (thread->htmlc != NULL && thread->htmlc->base_url != NULL) {
		nsurl_join(thread->htmlc->base_url, href, &url);
	} else if (browser_window_get_url(thread->win, false, &cur) ==
			NSERROR_OK && cur != NULL) {
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

/** Where the location object itself is kept, out of the page's way. */
#define VITA_LOCATION_SLOT "__vitaLocation"

static JSValue loc_get_href(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	nsurl *page = script_page_url(thread);
	nsurl *url = NULL;
	JSValue r;

	(void)this_val;
	if (page != NULL) {
		return JS_NewString(ctx, nsurl_access(page));
	}

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
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *s = JS_ToCString(ctx, v);
	JSValue r;

	(void)this_val;
	r = win_navigate(ctx, thread, s);
	if (s) JS_FreeCString(ctx, s);
	return r;
}

/*
 * Assigning to window.location or document.location itself, which is
 * how a great many pages redirect (VitaSurf).
 *
 * It used to be a plain property holding the location object, so
 * "window.location = url" replaced the object with a string and went
 * nowhere: a PHP page titled REDIR sat there having done nothing, with
 * no error and no line in the log to say why. The property is an
 * accessor now, so the assignment navigates like location.href does.
 * The getter hands back the object kept under a hidden name, so
 * location.href and the rest are unchanged.
 */
static JSValue win_get_location(JSContext *ctx, JSValueConst this_val)
{
	C_WHERE;
	return JS_GetPropertyStr(ctx, this_val, VITA_LOCATION_SLOT);
}

static JSValue win_set_location(JSContext *ctx, JSValueConst this_val,
				JSValueConst v)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *s;
	JSValue r;

	(void)this_val;
	/*
	 * An object is what the page gets back from the getter, so
	 * "location = location" must not be read as a URL.
	 */
	if (JS_IsObject(v)) {
		return JS_UNDEFINED;
	}
	s = JS_ToCString(ctx, v);
	r = win_navigate(ctx, thread, s);
	if (s) JS_FreeCString(ctx, s);
	return r;
}

/** Put the location object on an object under an accessor, so that
 * assigning to it navigates. */
static void install_location(JSContext *ctx, JSValueConst on, JSValue loc)
{
	JSAtom name = JS_NewAtom(ctx, "location");

	JS_SetPropertyStr(ctx, on, VITA_LOCATION_SLOT, loc);
	JS_DefinePropertyGetSet(ctx, on, name,
		JS_NewCFunction2(ctx, (JSCFunction *)win_get_location,
				 "get location", 0, JS_CFUNC_getter, 0),
		JS_NewCFunction2(ctx, (JSCFunction *)win_set_location,
				 "set location", 1, JS_CFUNC_setter, 0),
		JS_PROP_ENUMERABLE);
	JS_FreeAtom(ctx, name);
}

static JSValue loc_assign(JSContext *ctx, JSValueConst this_val,
			  int argc, JSValueConst *argv)
{
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct js_timer *t;
	int32_t ms = 0;

	JSValue code = JS_UNDEFINED;

	(void)this_val;
	if (thread == NULL || argc < 1) {
		return JS_NewInt32(ctx, 0);
	}
	/*
	 * A string is code to run when the timer fires (VitaSurf). Old
	 * pages write setTimeout("go()", 500); a captive portal's
	 * "Please wait" page redirected that way and sat there, because
	 * anything but a function was dropped.
	 */
	if (!JS_IsFunction(ctx, argv[0])) {
		const char *s;

		code = JS_ToString(ctx, argv[0]);
		if (JS_IsException(code)) {
			return JS_EXCEPTION;
		}
		/* rare, and usually the redirect a stuck page wanted */
		s = JS_ToCString(ctx, code);
		if (s != NULL) {
			vita_log("qjs: %s given code as a string: '%.100s'",
				 repeat ? "setInterval" : "setTimeout", s);
			JS_FreeCString(ctx, s);
		}
	}
	if (argc >= 2) {
		JS_ToInt32(ctx, &ms, argv[1]);
	}
	if (ms < 10) ms = 10;

	t = calloc(1, sizeof(*t));
	if (t == NULL) {
		JS_FreeValue(ctx, code);
		return JS_NewInt32(ctx, 0);
	}
	t->thread = thread;
	t->func = JS_IsUndefined(code) ? JS_DupValue(ctx, argv[0]) : code;
	t->args = JS_UNDEFINED;
	/* setTimeout(fn, ms, a, b) calls fn(a, b) */
	if (argc > 2 && JS_IsUndefined(code)) {
		t->args = JS_NewArray(ctx);
		if (!JS_IsException(t->args)) {
			int i;

			for (i = 2; i < argc; i++) {
				JS_SetPropertyUint32(ctx, t->args, i - 2,
						     JS_DupValue(ctx, argv[i]));
			}
		} else {
			t->args = JS_UNDEFINED;
		}
	}
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
	C_WHERE;
	return win_set_timer(ctx, this_val, argc, argv, 0);
}

static JSValue win_set_interval(JSContext *ctx, JSValueConst this_val,
				int argc, JSValueConst *argv)
{
	C_WHERE;
	return win_set_timer(ctx, this_val, argc, argv, 1);
}

static JSValue win_clear_timer(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	C_WHERE;
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
/*
 * How many seconds the next piece of work gets. Less each time this
 * page has had a script stopped.
 *
 * Twenty seconds is a long time to let a script run, and it is meant to
 * be generous enough that a page doing real work on a slow processor is
 * never cut off. A page that has already had a script stopped is not
 * that page: on YouTube two scripts each ran the full twenty seconds
 * and were killed, forty seconds of a hundred-and-six second load that
 * produced nothing, and the page rendered anyway. So halve it after
 * each one, down to five seconds, which bounds what a runaway costs
 * without touching a page that never overruns -- and almost none do.
 */
static unsigned budget_secs(jsthread *thread)
{
	unsigned secs, halvings;

	if (thread->heap->timeout <= 0) {
		return 0;
	}
	secs = (unsigned)thread->heap->timeout;
	halvings = thread->scripts_killed;
	if (halvings > 2) {
		halvings = 2;
	}
	secs >>= halvings;
#ifdef __vita__
	/* never below five seconds on the device, however many scripts
	 * have been stopped; the native harness keeps what it was given
	 * so a test can drive a budget of one second (VitaSurf) */
	if (secs < 5) {
		secs = 5;
	}
#endif
	if (secs == 0) {
		secs = 1;
	}
	return secs;
}

static void rearm_deadline(jsthread *thread)
{
	unsigned secs = budget_secs(thread);


	thread->aborting = false;
	thread->overrun_count = 0;
	thread->overrun_said_ms = 0;
	/* The handler belongs to the heap, and whichever thread was made
	 * last took it; a page's scripts run under their own (VitaSurf). */
	if (thread->heap->interrupt_thread != thread) {
		JS_SetInterruptHandler(thread->heap->rt, qjs_interrupt, thread);
		thread->heap->interrupt_thread = thread;
	}
	/* the profile's clock starts with the script, not the idle before */
	prof_last_ms = prof_last_call_ms = now_ms();
	if (secs != 0) {
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

/*
 * Why we are in JavaScript (VitaSurf), so that the script bucket can be
 * split by it. A build 369 log puts 4618 ms of a 7878 ms YouTube load
 * in that bucket while the load event accounts for 1906 ms of it in
 * script elements; the remaining 2.7 s is entered some other way and
 * there is no way to aim at it without knowing which.
 */
enum script_why {
	SCRIPT_PAGE,		/**< a <script> element */
	SCRIPT_TIMER,
	SCRIPT_EVENT,
	SCRIPT_XHR		/**< a fetch or XHR settling */
};
static enum script_why script_why;

/*
 * When script last ran, for the compiled script cache to write its
 * entries out while nothing is (VitaSurf); see bc_flush_callback.
 */
static uint64_t bc_last_activity_ms;

static void begin_script(jsthread *thread, enum script_why why)
{
	if (thread->script_depth++ > 0) {
		if (thread->draining) {
			jobs_reentered++;
		}
		return;
	}
	script_why = why;
	vita_dom_gen++;	/* the parser may have added nodes since */
	vita_tree_gen++;
	vita_id_gen++;
	script_entered_ms = now_ms();
	bc_last_activity_ms = script_entered_ms;
	rearm_deadline(thread);
}

static void schedule_relayout(jsthread *thread, int ms);

/** What the longest job did, so a job of twenty seconds names its own
 * work rather than the work of whichever job ran before it. */
static void job_max_deltas(unsigned b_finds, unsigned b_edits,
			   unsigned b_html, unsigned b_attrs,
			   unsigned b_styles, unsigned b_wraps,
			   unsigned b_agets, unsigned b_cn, unsigned b_tr,
			   unsigned b_bc, unsigned b_txt)
{
	vitasurf_job_max_finds = vitasurf_js_finds - b_finds;
	vitasurf_job_max_edits = vitasurf_js_dom_edits - b_edits;
	vitasurf_job_max_html = vitasurf_js_html_bytes - b_html;
	vitasurf_job_max_attrs = vitasurf_js_attr_sets - b_attrs;
	vitasurf_job_max_styles = vitasurf_js_style_reads - b_styles;
	vitasurf_job_max_wraps = vitasurf_js_node_wraps - b_wraps;
	vitasurf_job_max_attr_gets = vitasurf_js_attr_gets - b_agets;
	vitasurf_job_max_childnodes = vitasurf_js_childnodes - b_cn;
	vitasurf_job_max_tree_reads = vitasurf_js_tree_reads - b_tr;
	vitasurf_job_max_bindings = vitasurf_js_binding_calls - b_bc;
	vitasurf_job_max_text_reads = vitasurf_js_text_reads - b_txt;
}

/** Say what the budget stopped, since a job that is killed leaves no
 * other trace of what it was doing (VitaSurf). */
static void drain_job_killed(unsigned took, unsigned nth, unsigned drain_ms,
			     unsigned b_edits, unsigned b_attrs,
			     unsigned b_wraps, unsigned b_html)
{
	vita_log("qjs: the budget stopped job %u of this drain after %u ms, "
		 "%u ms into the drain; it had made %u tree edits and %u "
		 "attribute sets, was handed a node %u times and parsed %u "
		 "bytes of HTML",
		 nth, took, drain_ms,
		 vitasurf_js_dom_edits - b_edits,
		 vitasurf_js_attr_sets - b_attrs,
		 vitasurf_js_node_wraps - b_wraps,
		 vitasurf_js_html_bytes - b_html);
}

static void end_script(jsthread *thread)
{
	if (thread->script_depth > 0 && --thread->script_depth > 0) {
		return;
	}
	thread->script_depth = 0;
	prof_tail(script_why == SCRIPT_TIMER ? "a timer" :
		  script_why == SCRIPT_EVENT ? "an event handler" :
		  script_why == SCRIPT_XHR ? "a fetch callback" :
		  "a script element");
	if (script_entered_ms != 0) {
		unsigned took = (unsigned)(now_ms() - script_entered_ms);

		vitasurf_ms_script += took;
		switch (script_why) {
		case SCRIPT_TIMER:
			vitasurf_ms_js_timer += took;
			vitasurf_js_timers++;
			break;
		case SCRIPT_EVENT:
			vitasurf_ms_js_event += took;
			vitasurf_js_events++;
			break;
		case SCRIPT_XHR:
			vitasurf_ms_js_xhr += took;
			vitasurf_js_xhrs++;
			break;
		case SCRIPT_PAGE:
		default:
			vitasurf_ms_js_page += took;
			break;
		}
		script_entered_ms = 0;
	}
	if (thread->overrun_count > 0) {
		thread->scripts_killed++;
		vita_log("qjs: that script was stopped by the budget "
			 "(%u on this page; the next gets %u seconds)",
			 thread->scripts_killed, budget_secs(thread));
	}
	/* The outermost call is over, so nothing is still unwinding. An
	 * exception left pending here is one that was reported already, or
	 * the budget abort on its way out; either way the jobs below must
	 * not start with it hanging over them. */
	thread->overrun_count = 0;
	thread->aborting = false;
	if (JS_HasException(thread->ctx)) {
		JS_FreeValue(thread->ctx, JS_GetException(thread->ctx));
	}

	/*
	 * Microtasks are the same piece of work as the script that queued
	 * them, so they answer to the same budget -- and a page does most
	 * of its work in promise chains now, so this is where the time
	 * goes. The deadline used to be cleared before this loop, which
	 * left every promise job on every page running with no budget at
	 * all: a chain that re-queues itself, Promise.resolve().then(again),
	 * drained here forever with nothing able to stop it, and the only
	 * mark it leaves on a log is a long gap with no lines in it.
	 *
	 * The deadline is armed afresh rather than carried over, because
	 * the script's own run has already been accounted for above and a
	 * deadline that has passed would stop the first job on a page that
	 * did nothing wrong.
	 *
	 * One deadline for the whole drain, not one per job. Build 405
	 * tried a budget per job on the grounds that a page should not be
	 * punished for doing its work in several pieces rather than one,
	 * and the device said that was the wrong reading: the job the old
	 * budget cut off after 6844 ms was handed a full twenty seconds,
	 * spent all of them, and was cut off anyway. It is a runaway. The
	 * page cost 65642 ms instead of 59708 for exactly the same end
	 * state, so the drain answers to one budget again.
	 */
	rearm_deadline(thread);
	/*
	 * The drain is still inside the script (VitaSurf). With the depth
	 * at zero, a job that dispatched an event or ran a listener from C
	 * entered script as a new outermost call: begin_script handed it a
	 * fresh deadline, and its end_script drained the queue again and
	 * then cleared the deadline, so the rest of the outer job ran with
	 * no budget, no profile samples and no Circle. Yamtrack's Alpine
	 * start-up ran 9242 ms that way and the profile could say only
	 * "a promise job". Holding the depth at one makes those calls the
	 * nested entries they are.
	 */
	thread->script_depth = 1;
	thread->draining = true;
	{
		/*
		 * What the microtask queue costs (VitaSurf). This runs
		 * after the script bucket above has been closed, so until
		 * now it was in no bucket at all -- and it is where async,
		 * await and every .then() continuation on the page
		 * actually run.
		 */
		uint64_t j0 = now_ms(), jlast = j0;
		unsigned in_drain = 0;
		unsigned b_finds = vitasurf_js_finds;
		unsigned b_edits = vitasurf_js_dom_edits;
		unsigned b_html = vitasurf_js_html_bytes;
		unsigned b_attrs = vitasurf_js_attr_sets;
		unsigned b_styles = vitasurf_js_style_reads;
		unsigned b_wraps = vitasurf_js_node_wraps;
		unsigned b_agets = vitasurf_js_attr_gets;
		unsigned b_cn = vitasurf_js_childnodes;
		unsigned b_tr = vitasurf_js_tree_reads;
		unsigned b_bc = vitasurf_js_binding_calls;
		unsigned b_txt = vitasurf_js_text_reads;

		vitasurf_js_drains++;
		for (;;) {
			JSContext *c = NULL;
			int r;
			uint64_t d0 = now_ms();

			r = JS_ExecutePendingJob(thread->heap->rt, &c);
			bc_last_activity_ms = now_ms();
			if (r != 0) {
				prof_tail("a promise job");
			}
			if (r <= 0) {
				unsigned took = (unsigned)(now_ms() - d0);

				/*
				 * A negative return is a job that ran and
				 * threw, not an empty queue, and its time
				 * is a job's time (VitaSurf). Counting the
				 * two together reported 7205 ms across 68
				 * drains for a call that does nothing.
				 */
				if (r < 0) {
					if (thread->overrun_count > 0) {
						vitasurf_js_jobs_budget++;
						vitasurf_ms_js_jobs_budget +=
							took;
						drain_job_killed(took,
							in_drain + 1,
							(unsigned)(now_ms() -
								   j0),
							b_edits, b_attrs,
							b_wraps, b_html);
					} else {
						vitasurf_js_jobs_threw++;
						vitasurf_ms_js_jobs_threw +=
							took;
					}
					vitasurf_ms_js_jobs_sum += took;
					/*
					 * and its own deltas if it is the
					 * longest (VitaSurf). Build 405
					 * set the time here and the
					 * deltas only where a job
					 * finishes, so a killed job of
					 * 20047 ms was described by the
					 * work of a shorter one.
					 */
					if (took > vitasurf_ms_js_job_max) {
						vitasurf_ms_js_job_max = took;
						job_max_deltas(b_finds,
							b_edits, b_html,
							b_attrs, b_styles,
							b_wraps, b_agets,
							b_cn, b_tr, b_bc,
							b_txt);
					}
					if (c != NULL) {
						qjs_report_exception(c);
					}
				} else {
					vitasurf_ms_js_drain_tail += took;
				}
				break;
			}
			{
				uint64_t j1 = now_ms();
				unsigned took = (unsigned)(j1 - jlast);

				if (took > vitasurf_ms_js_job_max) {
					vitasurf_ms_js_job_max = took;
					job_max_deltas(b_finds, b_edits,
						b_html, b_attrs, b_styles,
						b_wraps, b_agets, b_cn,
						b_tr, b_bc, b_txt);
				}
				if (took >= 5) {
					vitasurf_js_jobs_slow++;
					vitasurf_ms_js_jobs_slow += took;
				}
				/*
				 * Every job, so the drain total minus this
				 * is what the loop itself costs: a GitHub
				 * load reports 20440 ms of jobs where the
				 * ones counted come to 15680, and nothing
				 * says where the other 4760 went.
				 */
				vitasurf_ms_js_jobs_sum += took;
				jlast = j1;
				b_finds = vitasurf_js_finds;
				b_edits = vitasurf_js_dom_edits;
				b_html = vitasurf_js_html_bytes;
				b_attrs = vitasurf_js_attr_sets;
				b_styles = vitasurf_js_style_reads;
				b_wraps = vitasurf_js_node_wraps;
				b_agets = vitasurf_js_attr_gets;
				b_cn = vitasurf_js_childnodes;
				b_tr = vitasurf_js_tree_reads;
				b_bc = vitasurf_js_binding_calls;
				b_txt = vitasurf_js_text_reads;
			}
			vitasurf_js_jobs++;
			in_drain++;
		}
		{
			unsigned drain_ms = (unsigned)(now_ms() - j0);

			vitasurf_ms_js_jobs += drain_ms;
			if (drain_ms > vitasurf_ms_js_drain_max) {
				vitasurf_ms_js_drain_max = drain_ms;
				vitasurf_js_drain_max_jobs = in_drain;
			}
		}
	}
	thread->script_depth = 0;
	thread->draining = false;
	if (thread->overrun_count > 0) {
		thread->scripts_killed++;
		vita_log("qjs: promise jobs stopped by the budget "
			 "(%u on this page; the next gets %u seconds)",
			 thread->scripts_killed, budget_secs(thread));
	}
	thread->overrun_count = 0;
	thread->deadline_ms = 0;
	thread->aborting = false;
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
		/* a fetch that never ends would hold the rebuild off for
		 * good, and the page would look blank with nothing said */
		if (++thread->relayout_waits == 20) {
			vita_log("qjs: layout rebuild waiting on the page: "
				 "status %d, %d fetches active",
				 (int)htmlc->base.status,
				 (int)htmlc->base.active);
		}
		guit->misc->schedule(RELAYOUT_RETRY_MS, relayout_callback, thread);
		thread->relayout_pending = true;
		return;
	}
	thread->relayout_waits = 0;

	/*
	 * Count them again every time. The count was taken once and kept,
	 * so it was whatever the document held when the first rebuild ran
	 * -- on openmediavault the 124 elements of the shell, logged over
	 * and over while the dashboard the page went on to build was many
	 * times that. The limit below is meant to catch a document that
	 * has grown too big to rebuild, and it cannot do that from a
	 * number taken before it grew.
	 */
	{
		struct dom_document *doc = thread_document(thread);

		if (doc != NULL) {
			thread->dom_elements =
				count_elements((struct dom_node *)doc);
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
	/*
	 * What this page's own elements cost, measured while it was first
	 * laid out (VitaSurf). No measurement yet means no reason to
	 * refuse.
	 */
	if (vitasurf_box_elements > 0) {
		unsigned per_element_us = (vitasurf_ms_boxes * 1000u) /
					  vitasurf_box_elements;
		unsigned estimate = (per_element_us *
				     thread->dom_elements) / 1000u;

		if (estimate > RELAYOUT_MAX_MS) {
			vita_log("qjs: not rebuilding the layout, %u "
				 "elements at %u us each is about %u ms "
				 "and the browser is stopped for all of it",
				 thread->dom_elements, per_element_us,
				 estimate);
			thread->relayout_off = true;
			thread->dom_dirty = false;
			return;
		}
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
		 "(%u elements), %u images taken back and %u asked for "
		 "again%s",
		 thread->relayout_ms, thread->dom_elements,
		 htmlc->relayout_reused, htmlc->relayout_fetched,
		 err == NSERROR_OK ? "" : " (failed)");
	/* what the page looks like once its scripts have built it, when
	 * the flag file asks for it (VitaSurf) */
	vita_input_dump_layout();
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
	begin_script(thread, SCRIPT_TIMER);
	global = JS_GetGlobalObject(ctx);
	{
		/*
		 * How long this one took, and what it was (VitaSurf).
		 * Wikipedia's 89 timers come to 23103 ms with almost no
		 * DOM work in them, and an average cannot say whether
		 * that is one enormous callback or a crowd of middling
		 * ones; the name says which part of the page it is.
		 */
		uint64_t t0 = now_ms();
		unsigned took;

		if (JS_IsString(t->func)) {
			size_t len = 0;
			const char *src = JS_ToCStringLen(ctx, &len, t->func);

			ret = src != NULL ?
				JS_Eval(ctx, src, len, "<timer string>",
					JS_EVAL_TYPE_GLOBAL) :
				JS_EXCEPTION;
			if (src != NULL) {
				JS_FreeCString(ctx, src);
			}
		} else if (JS_IsObject(t->args)) {
			JSValue av[8];
			int64_t n = 0;
			int i;

			JS_GetLength(ctx, t->args, &n);
			if (n > 8) n = 8;
			for (i = 0; i < (int)n; i++) {
				av[i] = JS_GetPropertyUint32(ctx, t->args,
							     (uint32_t)i);
			}
			ret = JS_Call(ctx, t->func, global, (int)n, av);
			for (i = 0; i < (int)n; i++) {
				JS_FreeValue(ctx, av[i]);
			}
		} else {
			ret = JS_Call(ctx, t->func, global, 0, NULL);
		}
		took = (unsigned)(now_ms() - t0);

		if (took >= 50) {
			vitasurf_js_timers_slow++;
			vitasurf_ms_js_timers_slow += took;
		}
		if (took > vitasurf_ms_js_timer_max) {
			JSValue nm = JS_GetPropertyStr(ctx, t->func, "name");
			const char *ns = JS_ToCString(ctx, nm);

			vitasurf_ms_js_timer_max = took;
			if (ns != NULL && ns[0] != '\0') {
				strncpy(vitasurf_js_timer_max_name, ns,
					sizeof(vitasurf_js_timer_max_name) - 1);
				vitasurf_js_timer_max_name[
					sizeof(vitasurf_js_timer_max_name)
						- 1] = '\0';
			} else {
				strcpy(vitasurf_js_timer_max_name,
				       "(anonymous)");
			}
			if (ns != NULL) {
				JS_FreeCString(ctx, ns);
			}
			JS_FreeValue(ctx, nm);
		}
	}
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
		begin_script(thread, SCRIPT_XHR);
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
	(void)argc; (void)argv;
	JS_SetPropertyStr(ctx, this_val, "defaultPrevented", JS_NewBool(ctx, true));
	return JS_UNDEFINED;
}

static JSValue ev_stop_propagation(JSContext *ctx, JSValueConst this_val,
				   int argc, JSValueConst *argv)
{
	C_WHERE;
	(void)argc; (void)argv;
	JS_SetPropertyStr(ctx, this_val, "cancelBubble", JS_NewBool(ctx, true));
	return JS_UNDEFINED;
}

/**
 * Whether an event is one of the keyboard events.
 *
 * libdom has no way to ask an event what kind it is, so this goes by
 * the name, which is what decides the shape of the object a page
 * expects anyway.
 */
static bool event_is_keyboard(struct dom_event *evt)
{
	dom_string *type = NULL;
	bool is_key = false;

	if (dom_event_get_type(evt, &type) != DOM_NO_ERR || type == NULL) {
		return false;
	}
	is_key = dom_string_isequal(type, corestring_dom_keydown) ||
		 dom_string_isequal(type, corestring_dom_keypress) ||
		 dom_string_isequal(type, corestring_dom_keyup);
	dom_string_unref(type);
	return is_key;
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
	/*
	 * A key event carries which key it was, which is how a page
	 * tells Enter from Escape from a letter. Without these a
	 * listener saw undefined and every "if (e.key === 'Enter')"
	 * was false, so a form never submitted and a dialog never
	 * closed.
	 */
	if (event_is_keyboard(evt)) {
		dom_keyboard_event *kevt = (dom_keyboard_event *) evt;
		dom_string *key = NULL;
		bool flag = false;
		uint32_t code = 0;

		if (dom_keyboard_event_get_key(kevt, &key) == DOM_NO_ERR &&
		    key != NULL) {
			const char *data = dom_string_data(key);
			size_t len = dom_string_byte_length(key);

			JS_SetPropertyStr(ctx, obj, "key",
					  JS_NewStringLen(ctx, data, len));
			/* the legacy numbers a page may still read */
			if (len == 1) {
				code = (uint32_t) (unsigned char) data[0];
				if (code >= 'a' && code <= 'z') {
					code -= 32;
				}
			}
			dom_string_unref(key);
			key = NULL;
		}
		if (dom_keyboard_event_get_code(kevt, &key) == DOM_NO_ERR &&
		    key != NULL) {
			JS_SetPropertyStr(ctx, obj, "code",
					  JS_NewStringLen(ctx,
						dom_string_data(key),
						dom_string_byte_length(key)));
			dom_string_unref(key);
		}
		JS_SetPropertyStr(ctx, obj, "keyCode", JS_NewInt32(ctx, (int) code));
		JS_SetPropertyStr(ctx, obj, "which", JS_NewInt32(ctx, (int) code));
		JS_SetPropertyStr(ctx, obj, "charCode", JS_NewInt32(ctx, 0));
		if (dom_keyboard_event_get_ctrl_key(kevt, &flag) != DOM_NO_ERR) {
			flag = false;
		}
		JS_SetPropertyStr(ctx, obj, "ctrlKey", JS_NewBool(ctx, flag));
		if (dom_keyboard_event_get_shift_key(kevt, &flag) != DOM_NO_ERR) {
			flag = false;
		}
		JS_SetPropertyStr(ctx, obj, "shiftKey", JS_NewBool(ctx, flag));
		if (dom_keyboard_event_get_alt_key(kevt, &flag) != DOM_NO_ERR) {
			flag = false;
		}
		JS_SetPropertyStr(ctx, obj, "altKey", JS_NewBool(ctx, flag));
		JS_SetPropertyStr(ctx, obj, "metaKey", JS_NewBool(ctx, false));
		JS_SetPropertyStr(ctx, obj, "repeat", JS_NewBool(ctx, false));
		JS_SetPropertyStr(ctx, obj, "isComposing", JS_NewBool(ctx, false));
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
	begin_script(thread, SCRIPT_EVENT);
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
		if (l->thread != NULL) {
			l->thread->dead_listeners++;
		}
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
		for (j = 0; j < keys[i].nattrs; j++) {
			if (keys[i].attrs[j] != NULL)
				dom_string_unref(keys[i].attrs[j]);
			if (keys[i].attrs_lc[j] != NULL)
				dom_string_unref(keys[i].attrs_lc[j]);
		}
		free(keys[i].attrs);
		free(keys[i].attrs_lc);
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
		/* the attribute names the compound needs (VitaSurf) */
		{
			JSValue at = JS_GetPropertyStr(ctx, k, "attrs");
			JSValue alen = JS_GetPropertyStr(ctx, at, "length");
			uint32_t na = 0;

			JS_ToUint32(ctx, &na, alen);
			JS_FreeValue(ctx, alen);
			if (na > 0 && na <= 16) {
				keys[i].attrs = calloc(na, sizeof(dom_string *));
				keys[i].attrs_lc = calloc(na, sizeof(dom_string *));
			}
			if (keys[i].attrs != NULL && keys[i].attrs_lc != NULL) {
				for (j = 0; j < na; j++) {
					JSValue av = JS_GetPropertyUint32(ctx, at, j);
					char *nm = key_string(ctx, av, "name");

					JS_FreeValue(ctx, av);
					if (nm == NULL || nm[0] == '\0') {
						free(nm);
						continue;
					}
					keys[i].attrs[keys[i].nattrs] =
						to_dom_string(nm);
					{
						char *c;

						for (c = nm; *c; c++) {
							if (*c >= 'A' && *c <= 'Z')
								*c = (char) (*c + 32);
						}
					}
					keys[i].attrs_lc[keys[i].nattrs] =
						to_dom_string(nm);
					free(nm);
					if (keys[i].attrs[keys[i].nattrs] == NULL)
						continue;
					keys[i].nattrs++;
				}
			}
			JS_FreeValue(ctx, at);
		}
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
	for (i = 0; i < k->nattrs; i++) {
		bool has = false;

		dom_element_has_attribute(n, k->attrs[i], &has);
		if (!has && k->attrs_lc[i] != NULL) {
			dom_element_has_attribute(n, k->attrs_lc[i], &has);
		}
		if (!has) {
			return false;
		}
	}
	return true;
}

/*
 * __vitaFind(root, keys): every element under root matching at least one
 * key, in document order. root may be a node or null for the document.
 */
static JSValue vita_find_impl(JSContext *ctx, JSValueConst this_val,
			      int argc, JSValueConst *argv);

/*
 * The same, counted and timed (VitaSurf). This walks the tree, and a
 * page whose promise jobs cost a millisecond each may simply be asking
 * it to do so a great many times. It has several exits, so the timing
 * wraps it rather than being threaded through each one.
 */
static JSValue win_vita_find(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv)
{
	C_WHERE;
	uint64_t t0 = now_ms();
	JSValue r = vita_find_impl(ctx, this_val, argc, argv);

	vitasurf_js_finds++;
	vitasurf_ms_js_finds += (unsigned)(now_ms() - t0);
	return r;
}

static JSValue vita_find_impl(JSContext *ctx, JSValueConst this_val,
			      int argc, JSValueConst *argv)
{
	C_WHERE;
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

			/* The local name, as libdom's own tag lookup matched
			 * it: getElementsByTagNameNS("ns", "body") finds the
			 * element made as createElementNS("ns", "te:body"),
			 * and comparing the qualified name lost that. */
			dom_node_get_local_name(n, &tag);
			if (tag == NULL) {
				dom_element_get_tag_name(n, &tag);
			}
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
/* Selectors answered in C (VitaSurf)                                        */

/*
 * GitHub's pages asked for about 400,000 selector matches in one load:
 * catalyst's lazy loader asks every added element for each tag it may
 * load, and selector-observer asks every added element whether it
 * matches each of hundreds of selectors. Every call went through three
 * or four JavaScript frames before any work was done, and on this CPU
 * that overhead, not the matching, filled a 20 s timer the budget
 * stopped.
 *
 * So matches, querySelector, querySelectorAll and closest are native
 * functions. They answer in C any selector made only of type, #id,
 * .class and [attribute] tests joined by descendant, >, + and ~, and
 * hand everything else -- pseudo-classes, escapes, namespaces, anything
 * this parser is unsure of -- to the prelude's engine unchanged. The
 * parser is deliberately stricter than the prelude's, and the matching
 * follows the prelude's rules (matchSimple, attrOk, matchAt) exactly, so
 * a selector gets the same answer whichever side takes it.
 */

enum sel_op {
	SOP_EXISTS, SOP_EQ, SOP_INCL, SOP_DASH, SOP_PREFIX, SOP_SUFFIX,
	SOP_SUBSTR
};

struct sel_attr {
	dom_string *name;
	enum sel_op op;
	char *val;
	size_t vlen;
};

struct sel_compound {
	char *tag;		/**< type selector, NULL for none or * */
	size_t tag_len;
	uint32_t tag_hash;	/**< tag_hash_lower of tag */
	char *id;
	size_t id_len;
	char **classes;
	int nclasses;
	struct sel_attr *attrs;
	int nattrs;
	char comb;		/**< joins it to the one before: ' ' > + ~ */
};

struct sel_group {
	struct sel_compound *parts;
	int n;
};

struct sel_compiled {
	struct sel_compiled *next;
	char *text;
	struct sel_group *groups;
	int ngroups;		/**< -1: not one of ours */
};

#define SEL_CACHE_MAX 1024

static void sel_free_compound(struct sel_compound *c)
{
	int i;

	free(c->tag);
	free(c->id);
	for (i = 0; i < c->nclasses; i++) free(c->classes[i]);
	free(c->classes);
	for (i = 0; i < c->nattrs; i++) {
		if (c->attrs[i].name != NULL) dom_string_unref(c->attrs[i].name);
		free(c->attrs[i].val);
	}
	free(c->attrs);
}

static void sel_free(struct sel_compiled *s)
{
	int g, i;

	for (g = 0; g < s->ngroups; g++) {
		for (i = 0; i < s->groups[g].n; i++) {
			sel_free_compound(&s->groups[g].parts[i]);
		}
		free(s->groups[g].parts);
	}
	free(s->groups);
	free(s->text);
	free(s);
}

/*
 * Forget the strings sel_lookup remembers (VitaSurf): before the
 * selectors they point at are freed, and before the context goes.
 */
static void sel_recent_free(jsthread *thread)
{
	unsigned i;

	for (i = 0; i < SEL_RECENT; i++) {
		struct sel_recent *r = &thread->sel_recent[i];

		if (r->key != NULL && thread->ctx != NULL) {
			JS_FreeValue(thread->ctx, r->str);
		}
		r->key = NULL;
		r->s = NULL;
	}
}

static void sel_cache_free(jsthread *thread)
{
	unsigned b;

	sel_recent_free(thread);

	for (b = 0; b < 128; b++) {
		while (thread->sel_cache[b] != NULL) {
			struct sel_compiled *next = thread->sel_cache[b]->next;

			sel_free(thread->sel_cache[b]);
			thread->sel_cache[b] = next;
		}
	}
	thread->sel_cache_n = 0;
}

static bool sel_ident_char(char c)
{
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
	       (c >= '0' && c <= '9') || c == '_' || c == '-';
}

static bool sel_ws(char c)
{
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f';
}

static char *sel_dup(const char *s, size_t n)
{
	char *d = malloc(n + 1);

	if (d != NULL) {
		memcpy(d, s, n);
		d[n] = '\0';
	}
	return d;
}

/* An identifier run at *p; its length, 0 for none. */
static size_t sel_ident(const char *p, const char *end)
{
	const char *q = p;

	while (q < end && sel_ident_char(*q)) q++;
	return (size_t)(q - p);
}

/*
 * One compound, in the only order the prelude's SIMPLE_RE accepts:
 * type? #id? .class* [attr]*. false for anything else.
 */
static bool sel_parse_compound(const char **pp, const char *end,
			       struct sel_compound *c)
{
	const char *p = *pp;
	size_t n;

	if (p < end && *p == '*') {
		p++;
	} else if (p < end && ((*p >= 'a' && *p <= 'z') ||
			       (*p >= 'A' && *p <= 'Z'))) {
		n = sel_ident(p, end);
		c->tag = sel_dup(p, n);
		if (c->tag == NULL) return false;
		c->tag_len = n;
		c->tag_hash = tag_hash_lower(p, n);
		p += n;
	}
	if (p < end && *p == '#') {
		n = sel_ident(p + 1, end);
		if (n == 0) return false;
		c->id = sel_dup(p + 1, n);
		if (c->id == NULL) return false;
		c->id_len = n;
		p += 1 + n;
	}
	while (p < end && *p == '.') {
		char **grown;

		n = sel_ident(p + 1, end);
		if (n == 0) return false;
		grown = realloc(c->classes, (size_t)(c->nclasses + 1) *
				sizeof(*grown));
		if (grown == NULL) return false;
		c->classes = grown;
		c->classes[c->nclasses] = sel_dup(p + 1, n);
		if (c->classes[c->nclasses] == NULL) return false;
		c->nclasses++;
		p += 1 + n;
	}
	while (p < end && *p == '[') {
		struct sel_attr a, *grown;
		const char *name;
		size_t nlen;
		char *nm;

		memset(&a, 0, sizeof(a));
		p++;
		while (p < end && sel_ws(*p)) p++;
		name = p;
		nlen = sel_ident(p, end);
		if (nlen == 0) return false;
		p += nlen;
		while (p < end && sel_ws(*p)) p++;
		if (p >= end) return false;
		if (*p == ']') {
			a.op = SOP_EXISTS;
		} else {
			if (*p == '=') {
				a.op = SOP_EQ;
				p++;
			} else if (p + 1 < end && p[1] == '=') {
				switch (*p) {
				case '~': a.op = SOP_INCL; break;
				case '|': a.op = SOP_DASH; break;
				case '^': a.op = SOP_PREFIX; break;
				case '$': a.op = SOP_SUFFIX; break;
				case '*': a.op = SOP_SUBSTR; break;
				default: return false;
				}
				p += 2;
			} else {
				return false;
			}
			while (p < end && sel_ws(*p)) p++;
			if (p < end && (*p == '"' || *p == '\'')) {
				char q = *p++;
				const char *v = p;

				while (p < end && *p != q) {
					if (*p == '\\' || *p == '"' ||
					    *p == '\'' || *p == ']' ||
					    *p == '\n')
						return false;
					p++;
				}
				if (p >= end || p == v) return false;
				a.val = sel_dup(v, (size_t)(p - v));
				a.vlen = (size_t)(p - v);
				p++;
			} else {
				n = sel_ident(p, end);
				if (n == 0) return false;
				a.val = sel_dup(p, n);
				a.vlen = n;
				p += n;
			}
			if (a.val == NULL) return false;
			/* the prelude's ~= reads spaces in the value its
			 * own way; leave those to it */
			if (a.op == SOP_INCL) {
				size_t k;

				for (k = 0; k < a.vlen; k++) {
					if (sel_ws(a.val[k])) {
						free(a.val);
						return false;
					}
				}
			}
			while (p < end && sel_ws(*p)) p++;
			if (p >= end || *p != ']') {
				free(a.val);
				return false;
			}
		}
		p++;	/* ] */
		nm = sel_dup(name, nlen);
		if (nm == NULL) {
			free(a.val);
			return false;
		}
		a.name = to_dom_string(nm);
		free(nm);
		if (a.name == NULL) {
			free(a.val);
			return false;
		}
		grown = realloc(c->attrs, (size_t)(c->nattrs + 1) *
				sizeof(*grown));
		if (grown == NULL) {
			dom_string_unref(a.name);
			free(a.val);
			return false;
		}
		c->attrs = grown;
		c->attrs[c->nattrs++] = a;
	}
	/* a compound ends at white space, a combinator, a comma or the end */
	if (p < end && !sel_ws(*p) && *p != '>' && *p != '+' && *p != '~' &&
	    *p != ',') {
		return false;
	}
	if (p == *pp) {
		return false;	/* nothing at all */
	}
	*pp = p;
	return true;
}

/* A selector list, or NULL when any part of it is not ours. */
static struct sel_compiled *sel_parse(const char *text, size_t len)
{
	struct sel_compiled *s = calloc(1, sizeof(*s));
	const char *p = text, *end = text + len;

	if (s == NULL) return NULL;
	for (;;) {
		struct sel_group *gg;
		struct sel_group *g;
		char comb = 0;
		bool need = true;	/* a compound must come next */

		gg = realloc(s->groups, (size_t)(s->ngroups + 1) * sizeof(*gg));
		if (gg == NULL) goto fail;
		s->groups = gg;
		g = &s->groups[s->ngroups++];
		memset(g, 0, sizeof(*g));
		while (p < end && sel_ws(*p)) p++;
		for (;;) {
			struct sel_compound *pa;
			bool ws = false;

			if (need) {
				pa = realloc(g->parts, (size_t)(g->n + 1) *
					     sizeof(*pa));
				if (pa == NULL) goto fail;
				g->parts = pa;
				memset(&g->parts[g->n], 0, sizeof(*pa));
				g->n++;
				if (!sel_parse_compound(&p, end,
							&g->parts[g->n - 1]))
					goto fail;
				g->parts[g->n - 1].comb = g->n == 1 ? 0 :
					(comb != 0 ? comb : ' ');
				need = false;
				comb = 0;
			}
			while (p < end && sel_ws(*p)) {
				p++;
				ws = true;
			}
			if (p >= end || *p == ',') {
				break;
			}
			if (*p == '>' || *p == '+' || *p == '~') {
				comb = *p++;
				while (p < end && sel_ws(*p)) p++;
				if (p >= end || *p == ',' || *p == '>' ||
				    *p == '+' || *p == '~')
					goto fail;	/* dangling */
				need = true;
				continue;
			}
			if (!ws) goto fail;
			need = true;	/* descendant */
		}
		if (p >= end) break;
		p++;	/* , */
		while (p < end && sel_ws(*p)) p++;
		if (p >= end) goto fail;	/* trailing comma */
	}
	return s;
fail:
	sel_free(s);
	return NULL;
}

static unsigned sel_bucket(const char *text, size_t len)
{
	unsigned h = 5381;
	size_t i;

	for (i = 0; i < len; i++) h = h * 33u + (unsigned char)text[i];
	return h % 128u;
}

/* The compiled form of a selector, parsed once per page. */
static struct sel_compiled *sel_get(jsthread *thread, const char *text,
				    size_t len)
{
	unsigned b = sel_bucket(text, len);
	struct sel_compiled *s;

	for (s = thread->sel_cache[b]; s != NULL; s = s->next) {
		if (strlen(s->text) == len && memcmp(s->text, text, len) == 0)
			return s;
	}
	if (thread->sel_cache_n >= SEL_CACHE_MAX) {
		sel_cache_free(thread);
	}
	s = len > 0 && memchr(text, '\0', len) == NULL ?
		sel_parse(text, len) : NULL;
	if (s == NULL) {
		s = calloc(1, sizeof(*s));
		if (s == NULL) return NULL;
		s->ngroups = -1;
	}
	s->text = sel_dup(text, len);
	if (s->text == NULL) {
		sel_free(s);
		return NULL;
	}
	s->next = thread->sel_cache[b];
	thread->sel_cache[b] = s;
	thread->sel_cache_n++;
	return s;
}

static bool sel_is_element(struct dom_node *n)
{
	dom_node_type type = 0;

	return n != NULL && dom_node_get_node_type(n, &type) == DOM_NO_ERR &&
		type == DOM_ELEMENT_NODE;
}

/* The prelude's matchSimple, for the parts this side handles. */
static bool sel_match_compound(struct dom_node *n, const struct sel_compound *c)
{
	int i;

	if (c->tag != NULL) {
		dom_string *local = NULL;
		bool hit;

		dom_node_get_local_name(n, &local);
		hit = tag_is(n, local, c->tag, c->tag_len);
		if (local != NULL) dom_string_unref(local);
		if (!hit) return false;
	}
	if (c->id != NULL) {
		dom_string *v = NULL;
		bool hit;

		dom_element_get_attribute(n, corestring_dom_id, &v);
		hit = dom_string_is(v, c->id, c->id_len);
		if (v != NULL) dom_string_unref(v);
		if (!hit) return false;
	}
	if (c->nclasses > 0) {
		dom_string *v = NULL;
		bool hit = true;

		dom_element_get_attribute(n, corestring_dom_class, &v);
		if (v == NULL) return false;
		for (i = 0; i < c->nclasses && hit; i++) {
			hit = class_present(dom_string_data(v),
					    dom_string_byte_length(v),
					    c->classes[i]);
		}
		dom_string_unref(v);
		if (!hit) return false;
	}
	for (i = 0; i < c->nattrs; i++) {
		const struct sel_attr *a = &c->attrs[i];
		dom_string *v = NULL;
		const char *d;
		size_t dl;
		bool hit = false;

		dom_element_get_attribute(n, a->name, &v);
		if (v == NULL) return false;
		d = dom_string_data(v);
		dl = dom_string_byte_length(v);
		switch (a->op) {
		case SOP_EXISTS:
			hit = true;
			break;
		case SOP_EQ:
			hit = dl == a->vlen && memcmp(d, a->val, dl) == 0;
			break;
		case SOP_PREFIX:
			hit = dl >= a->vlen && memcmp(d, a->val, a->vlen) == 0;
			break;
		case SOP_SUFFIX:
			hit = dl >= a->vlen &&
				memcmp(d + dl - a->vlen, a->val, a->vlen) == 0;
			break;
		case SOP_SUBSTR: {
			size_t k;

			for (k = 0; k + a->vlen <= dl && !hit; k++) {
				hit = memcmp(d + k, a->val, a->vlen) == 0;
			}
			break;
		}
		case SOP_DASH:
			hit = (dl == a->vlen && memcmp(d, a->val, dl) == 0) ||
				(dl > a->vlen && memcmp(d, a->val, a->vlen) == 0
				 && d[a->vlen] == '-');
			break;
		case SOP_INCL: {
			/* (' '+v+' ').indexOf(' '+val+' '): a run of the
			 * value between spaces or the ends */
			size_t k;

			for (k = 0; k + a->vlen <= dl && !hit; k++) {
				if ((k == 0 || d[k - 1] == ' ') &&
				    (k + a->vlen == dl || d[k + a->vlen] == ' ') &&
				    memcmp(d + k, a->val, a->vlen) == 0)
					hit = true;
			}
			break;
		}
		}
		dom_string_unref(v);
		if (!hit) return false;
	}
	return true;
}

static struct dom_node *sel_parent_element(struct dom_node *n)
{
	struct dom_node *up = NULL;

	if (dom_node_get_parent_node(n, &up) != DOM_NO_ERR) return NULL;
	if (up != NULL && !sel_is_element(up)) {
		dom_node_unref(up);
		return NULL;
	}
	return up;
}

static struct dom_node *sel_prev_element(struct dom_node *n)
{
	struct dom_node *p = NULL;

	if (dom_node_get_previous_sibling(n, &p) != DOM_NO_ERR) return NULL;
	while (p != NULL && !sel_is_element(p)) {
		struct dom_node *q = NULL;

		dom_node_get_previous_sibling(p, &q);
		dom_node_unref(p);
		p = q;
	}
	return p;
}

/* The prelude's matchAt: parts[0..i], parts[i] applying to n. */
static bool sel_match_at(struct dom_node *n, const struct sel_group *g, int i)
{
	struct dom_node *m, *next;
	bool hit = false;

	if (!sel_match_compound(n, &g->parts[i])) return false;
	if (i == 0) return true;
	switch (g->parts[i].comb) {
	case '>':
		m = sel_parent_element(n);
		if (m == NULL) return false;
		hit = sel_match_at(m, g, i - 1);
		dom_node_unref(m);
		return hit;
	case '+':
		m = sel_prev_element(n);
		if (m == NULL) return false;
		hit = sel_match_at(m, g, i - 1);
		dom_node_unref(m);
		return hit;
	case '~':
		for (m = sel_prev_element(n); m != NULL && !hit; m = next) {
			hit = sel_match_at(m, g, i - 1);
			next = hit ? NULL : sel_prev_element(m);
			dom_node_unref(m);
		}
		return hit;
	default:
		for (m = sel_parent_element(n); m != NULL && !hit; m = next) {
			hit = sel_match_at(m, g, i - 1);
			next = hit ? NULL : sel_parent_element(m);
			dom_node_unref(m);
		}
		return hit;
	}
}

static bool sel_matches(struct dom_node *n, const struct sel_compiled *s)
{
	int g;

	if (!sel_is_element(n)) return false;
	for (g = 0; g < s->ngroups; g++) {
		if (sel_match_at(n, &s->groups[g], s->groups[g].n - 1))
			return true;
	}
	return false;
}

/*
 * The compiled selector for a script's string (VitaSurf), found by the
 * string's own address when it was asked for lately; see jsthread's
 * sel_recent. NULL with *failed set if the string could not be read.
 */
static struct sel_compiled *sel_lookup(JSContext *ctx, jsthread *thread,
				       JSValueConst str, bool *failed)
{
	const void *key = JS_VALUE_GET_PTR(str);
	struct sel_recent *r =
		&thread->sel_recent[((uintptr_t) key >> 4) & (SEL_RECENT - 1)];
	struct sel_compiled *s;
	const char *text;
	size_t len;

	*failed = false;
	if (key != NULL && r->key == key) {
		vitasurf_js_sel_recent_hits++;
		return r->s;
	}
	text = JS_ToCStringLen(ctx, &len, str);
	if (text == NULL) {
		*failed = true;
		return NULL;
	}
	s = sel_get(thread, text, len);
	JS_FreeCString(ctx, text);
	if (s != NULL && key != NULL) {
		if (r->key != NULL) JS_FreeValue(ctx, r->str);
		r->key = key;
		r->str = JS_DupValue(ctx, str);
		r->s = s;
	}
	return s;
}

/* The one compound of a selector that is a bare tag and nothing else,
 * or NULL. */
static const struct sel_compound *sel_bare_tag(const struct sel_compiled *s)
{
	const struct sel_compound *c;

	if (s->ngroups != 1 || s->groups[0].n != 1) return NULL;
	c = &s->groups[0].parts[0];
	if (c->tag == NULL || c->id != NULL || c->nclasses != 0 ||
	    c->nattrs != 0) {
		return NULL;
	}
	return c;
}

/*
 * __vitaSelectorNative(kind, fallback): the native matches (0),
 * querySelector (1), querySelectorAll (2) or closest (3), answering in C
 * what it can and calling fallback with the same this and arguments for
 * the rest.
 */
static JSValue sel_native(JSContext *ctx, JSValueConst this_val, int argc,
			  JSValueConst *argv, int magic, JSValue *data)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct dom_node *root, *n = NULL;
	struct sel_compiled *s = NULL;
	const struct sel_compound *bare;
	bool failed = false;
	JSValue out = JS_NULL;
	uint32_t out_n = 0;

	if (thread == NULL || argc < 1 || !JS_IsString(argv[0]) ||
	    (root = JS_GetOpaque(this_val, node_class_id)) == NULL) {
		return JS_Call(ctx, data[0], this_val, argc, argv);
	}
	s = sel_lookup(ctx, thread, argv[0], &failed);
	if (failed) return JS_EXCEPTION;
	if (s == NULL || s->ngroups < 0) {
		return JS_Call(ctx, data[0], this_val, argc, argv);
	}
	vitasurf_js_sel_tag_fast++;
	switch (magic) {
	case 0:
		vitasurf_js_sel_matches++;
		return JS_NewBool(ctx, sel_matches(root, s));
	case 3:
		vitasurf_js_sel_closest++;
		vitasurf_js_sel_closest_native++;
		n = sel_is_element(root) ? dom_node_ref(root) : NULL;
		while (n != NULL) {
			struct dom_node *up;

			vitasurf_js_sel_closest_steps++;
			if (sel_matches(n, s)) {
				out = wrap_node(ctx, n);
				dom_node_unref(n);
				return out;
			}
			up = sel_parent_element(n);
			dom_node_unref(n);
			n = up;
		}
		return JS_NULL;
	default:
		break;
	}
	if (magic == 2) {
		vitasurf_js_sel_all++;
		out = JS_NewArray(ctx);
	} else {
		vitasurf_js_sel_one++;
	}
	bare = sel_bare_tag(s);
	if (bare != NULL && tags_absent(thread, root, bare->tag_hash)) {
		return out;
	}
	/* iterative pre-order walk; root itself is not a candidate */
	if (dom_node_get_first_child(root, &n) != DOM_NO_ERR) n = NULL;
	while (n != NULL) {
		struct dom_node *next = NULL;

		if (sel_is_element(n)) {
			vitasurf_js_sel_tag_visits++;
			if (sel_matches(n, s)) {
				if (magic == 1) {
					out = wrap_node(ctx, n);
					dom_node_unref(n);
					return out;
				}
				JS_SetPropertyUint32(ctx, out, out_n++,
						     wrap_node(ctx, n));
			}
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
				if (dom_node_get_next_sibling(cur, &sib) ==
				    DOM_NO_ERR && sib != NULL) {
					next = sib;
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_parent_node(cur, &parent) !=
				    DOM_NO_ERR) {
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

/*
 * __vitaUtf8Decode(u8): the text of a Uint8Array that is strictly valid
 * UTF-8, with a leading byte order mark dropped, or undefined for
 * anything else, which the prelude's own decoder then handles with its
 * replacement-character rules (VitaSurf). The prelude decoded every
 * fetched body a byte at a time in script: 5 % of GitHub's profile.
 */
static JSValue win_vita_utf8_decode(JSContext *ctx, JSValueConst this_val,
				    int argc, JSValueConst *argv)
{
	C_WHERE;
	size_t n = 0, i = 0, start;
	uint8_t *p;

	(void)this_val;
	if (argc < 1) return JS_UNDEFINED;
	p = JS_GetUint8Array(ctx, &n, argv[0]);
	if (p == NULL) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		return JS_UNDEFINED;
	}
	if (n >= 3 && p[0] == 0xEF && p[1] == 0xBB && p[2] == 0xBF) i = 3;
	start = i;
	while (i < n) {
		uint8_t c = p[i];
		size_t need, k;
		uint8_t lo = 0x80, hi = 0xBF;

		if (c < 0x80) { i++; continue; }
		if (c >= 0xC2 && c <= 0xDF) need = 1;
		else if (c >= 0xE0 && c <= 0xEF) {
			need = 2;
			if (c == 0xE0) lo = 0xA0;
			if (c == 0xED) hi = 0x9F;
		} else if (c >= 0xF0 && c <= 0xF4) {
			need = 3;
			if (c == 0xF0) lo = 0x90;
			if (c == 0xF4) hi = 0x8F;
		} else {
			return JS_UNDEFINED;
		}
		if (i + need >= n) {
			return JS_UNDEFINED;	/* cut short */
		}
		if (p[i + 1] < lo || p[i + 1] > hi) return JS_UNDEFINED;
		for (k = 2; k <= need; k++) {
			if (p[i + k] < 0x80 || p[i + k] > 0xBF) {
				return JS_UNDEFINED;
			}
		}
		i += need + 1;
	}
	return JS_NewStringLen(ctx, (const char *)p + start, n - start);
}

/*
 * The Symbol.hasInstance of Node, Element, Text and the other types
 * told apart by nodeType: bit t of the mask is set for each type t
 * that counts (VitaSurf). A node wrapper's type comes straight from
 * the node; anything else is asked for its nodeType, as the prelude's
 * test did. GitHub's catalyst asks element instanceof Element of every
 * element it scans.
 */
static JSValue node_type_test(JSContext *ctx, JSValueConst this_val,
			      int argc, JSValueConst *argv, int magic,
			      JSValue *data)
{
	C_WHERE;
	struct dom_node *n;
	int32_t mask = 0, t = 0;

	(void)this_val;
	(void)magic;
	if (argc < 1 || !JS_IsObject(argv[0])) return JS_FALSE;
	JS_ToInt32(ctx, &mask, data[0]);
	n = JS_GetOpaque(argv[0], node_class_id);
	if (n != NULL) {
		dom_node_type type = 0;

		if (dom_node_get_node_type(n, &type) != DOM_NO_ERR) {
			return JS_FALSE;
		}
		t = (int32_t)type;
	} else {
		JSValue v = JS_GetPropertyStr(ctx, argv[0], "nodeType");

		if (JS_IsException(v)) return JS_EXCEPTION;
		if (!JS_IsNumber(v)) {
			JS_FreeValue(ctx, v);
			return JS_FALSE;
		}
		JS_ToInt32(ctx, &t, v);
		JS_FreeValue(ctx, v);
	}
	return JS_NewBool(ctx, t > 0 && t < 31 && (mask & (1 << t)) != 0);
}

static JSValue win_vita_node_type_test(JSContext *ctx, JSValueConst this_val,
				       int argc, JSValueConst *argv)
{
	C_WHERE;
	(void)this_val;
	if (argc < 1) return JS_UNDEFINED;
	return JS_NewCFunctionData(ctx, node_type_test, 1, 0, 1, argv);
}

/*
 * firstElementChild, lastElementChild, nextElementSibling and
 * previousElementSibling, stepped in libdom (VitaSurf). The prelude
 * built the whole children collection to answer firstElementChild, and
 * walked nextSibling wrapping every text node on the way; Alpine starts
 * a page by walking every element with exactly these two, and checks
 * each one's ancestors through parentElement, magic 4. The magic is
 * which of the five; data[0] is the JavaScript getter kept for anything
 * that is not a libdom node.
 */
static JSValue element_step(JSContext *ctx, JSValueConst this_val,
			    int argc, JSValueConst *argv, int magic,
			    JSValue *data)
{
	C_WHERE;
	struct dom_node *n = JS_GetOpaque(this_val, node_class_id);
	struct dom_node *cur = NULL;
	bool forward = magic == 0 || magic == 2;
	JSValue r;

	(void)argc;
	(void)argv;
	if (n == NULL) {
		return JS_Call(ctx, data[0], this_val, 0, NULL);
	}
	vitasurf_js_tree_reads++;
	switch (magic) {
	case 0: dom_node_get_first_child(n, &cur); break;
	case 1: dom_node_get_last_child(n, &cur); break;
	case 2: dom_node_get_next_sibling(n, &cur); break;
	case 3: dom_node_get_previous_sibling(n, &cur); break;
	default:
		dom_node_get_parent_node(n, &cur);
		if (cur != NULL && !node_is_element(cur)) {
			dom_node_unref(cur);
			cur = NULL;
		}
		break;
	}
	while (cur != NULL) {
		struct dom_node *next = NULL;
		dom_node_type type = DOM_TEXT_NODE;

		if (dom_node_get_node_type(cur, &type) == DOM_NO_ERR &&
		    type == DOM_ELEMENT_NODE) {
			break;
		}
		if (forward) {
			dom_node_get_next_sibling(cur, &next);
		} else {
			dom_node_get_previous_sibling(cur, &next);
		}
		dom_node_unref(cur);
		cur = next;
	}
	r = wrap_node(ctx, cur);
	if (cur != NULL) dom_node_unref(cur);
	return r;
}

/*
 * __vitaCECandidates(root, withRoot): the elements under root, and root
 * itself when asked, that could be custom elements -- a hyphen in the
 * local name, or an is attribute -- in document order (VitaSurf). The
 * prelude's upgrade walk visited every node of each inserted subtree
 * for the few that are, and GitHub spent 9 % of its script there.
 */
static bool ce_candidate(struct dom_node *n)
{
	dom_string *name = NULL;
	bool yes = false;

	dom_node_get_local_name(n, &name);
	if (name == NULL) {
		dom_node_get_node_name(n, &name);
	}
	if (name != NULL) {
		yes = memchr(dom_string_data(name), '-',
			     dom_string_byte_length(name)) != NULL;
		dom_string_unref(name);
	}
	if (!yes) {
		static dom_string *is_name;

		if (is_name == NULL) {
			dom_string_create_interned((const uint8_t *)"is", 2,
						   &is_name);
		}
		if (is_name != NULL) {
			dom_element_has_attribute(n, is_name, &yes);
		}
	}
	return yes;
}

static JSValue win_vita_ce_candidates(JSContext *ctx, JSValueConst this_val,
				      int argc, JSValueConst *argv)
{
	C_WHERE;
	struct dom_node *root, *n = NULL;
	JSValue out = JS_NewArray(ctx);
	uint32_t k = 0;

	(void)this_val;
	if (argc < 1 || !JS_IsObject(argv[0])) {
		return out;
	}
	root = JS_GetOpaque(argv[0], node_class_id);
	if (root == NULL) {
		return out;
	}
	if (argc > 1 && JS_ToBool(ctx, argv[1]) && node_is_element(root) &&
	    ce_candidate(root)) {
		JS_SetPropertyUint32(ctx, out, k++, wrap_node(ctx, root));
	}
	if (dom_node_get_first_child(root, &n) != DOM_NO_ERR) {
		n = NULL;
	}
	while (n != NULL) {
		struct dom_node *next = NULL;

		if (node_is_element(n)) {
			if (ce_candidate(n)) {
				JS_SetPropertyUint32(ctx, out, k++,
						     wrap_node(ctx, n));
			}
			dom_node_get_first_child(n, &next);
		}
		if (next == NULL) {
			struct dom_node *cur = dom_node_ref(n);

			while (cur != NULL) {
				struct dom_node *sib = NULL, *parent = NULL;

				if (cur == root) {
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_next_sibling(cur, &sib) ==
				    DOM_NO_ERR && sib != NULL) {
					next = sib;
					dom_node_unref(cur);
					break;
				}
				if (dom_node_get_parent_node(cur, &parent) !=
				    DOM_NO_ERR) {
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

static JSValue win_vita_element_step(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	C_WHERE;
	int32_t kind = 0;

	(void)this_val;
	if (argc < 2 || !JS_IsFunction(ctx, argv[1])) {
		return argc >= 2 ? JS_DupValue(ctx, argv[1]) : JS_UNDEFINED;
	}
	JS_ToInt32(ctx, &kind, argv[0]);
	if (kind < 0 || kind > 4) {
		return JS_DupValue(ctx, argv[1]);
	}
	return JS_NewCFunctionData(ctx, element_step, 0, kind, 1,
				   (JSValueConst *)&argv[1]);
}

static JSValue win_vita_selector_native(JSContext *ctx, JSValueConst this_val,
					int argc, JSValueConst *argv)
{
	C_WHERE;
	int32_t kind = 0;

	(void)this_val;
	if (argc < 2 || !JS_IsFunction(ctx, argv[1])) {
		return argc >= 2 ? JS_DupValue(ctx, argv[1]) : JS_UNDEFINED;
	}
	JS_ToInt32(ctx, &kind, argv[0]);
	if (kind < 0 || kind > 3) {
		return JS_DupValue(ctx, argv[1]);
	}
	return JS_NewCFunctionData(ctx, sel_native, 1, kind, 1,
				   (JSValueConst *)&argv[1]);
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
	C_WHERE;
	vitasurf_js_style_reads++;
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

/*
 * __vitaElementFromPoint(x, y): the element at a point in the page, in
 * CSS pixels from the top left of the document.
 *
 * This answered null for every point, which is not "nothing is there"
 * but "the question was never asked". It goes through the same hit
 * test as a tap, so a sheet marked pointer-events: none is seen
 * through here exactly as a finger would see through it.
 */
static JSValue win_vita_element_from_point(JSContext *ctx,
					   JSValueConst this_val,
					   int argc, JSValueConst *argv)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	struct box *box, *found;
	struct dom_node *node = NULL;
	int32_t x = 0, y = 0;
	int bx = 0, by = 0;

	(void)this_val;
	if (argc < 2 || thread == NULL || thread->htmlc == NULL) {
		return JS_NULL;
	}
	if (JS_ToInt32(ctx, &x, argv[0]) != 0 ||
	    JS_ToInt32(ctx, &y, argv[1]) != 0) {
		return JS_NULL;
	}
	if (!layout_current(thread)) {
		return JS_NULL;
	}

	box = thread->htmlc->layout;
	if (box == NULL) {
		return JS_NULL;
	}

	/*
	 * Each call descends one level, so the deepest box that contains
	 * the point is the last one returned -- which is what the click
	 * path does too.
	 */
	found = box;
	while ((box = box_at_point(&thread->htmlc->unit_len_ctx, box,
			(int) x, (int) y, &bx, &by)) != NULL) {
		found = box;
	}

	/* the nearest ancestor that is an element, as the spec asks */
	while (found != NULL && found->node == NULL) {
		found = found->parent;
	}
	if (found == NULL) {
		return JS_NULL;
	}
	node = found->node;

	return wrap_node(ctx, node);
}

/*
 * The border box of an inline element, which is the union of its
 * fragments.
 *
 * NetSurf does not nest the content of an inline element inside its
 * box: the pieces sit between the BOX_INLINE box and its BOX_INLINE_END
 * as siblings of both, and the BOX_INLINE itself is zero wide. Reading
 * the box on its own therefore said every <span> and <a> was 0 px wide,
 * and a page that measures a link to place something next to it put it
 * at the left edge.
 */
static void inline_border_box(struct box *box, int *px, int *py,
			      int *pw, int *ph)
{
	struct box *b;
	int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
	bool first = true;

	for (b = box; b != NULL; b = b->next) {
		int bx, by, l, t, r, bot;

		/* floats in the middle of an inline are not part of it,
		 * as the renderer's own walk over these boxes says */
		if (b->type == BOX_FLOAT_LEFT || b->type == BOX_FLOAT_RIGHT) {
			continue;
		}

		/*
		 * A box's position is its padding edge, so the border box
		 * is that less the border on one side and the padding plus
		 * the border on the other. This is the same arithmetic the
		 * renderer does to draw an inline's background.
		 */
		box_coords(b, &bx, &by);
		l = bx - b->border[LEFT].width;
		t = by - b->border[TOP].width;
		r = bx + b->padding[LEFT] + b->width + b->padding[RIGHT] +
				b->border[RIGHT].width;
		bot = by + b->padding[TOP] + b->height + b->padding[BOTTOM] +
				b->border[BOTTOM].width;

		if (first || l < x0) x0 = l;
		if (first || t < y0) y0 = t;
		if (first || r > x1) x1 = r;
		if (first || bot > y1) y1 = bot;
		first = false;

		if (b == box->inline_end) {
			break;
		}
	}

	*px = x0;
	*py = y0;
	*pw = x1 - x0;
	*ph = y1 - y0;
}

/* ------------------------------------------------------------------------ */
/* What a page asked for that is not there                                   */

/*
 * A page calls something the engine only pretends to have -- a canvas
 * it cannot draw into, a codec, a storage API -- and nothing was said
 * about it, so a page that came out wrong gave no clue what it wanted
 * (VitaSurf). Each name is logged the first time a page uses it and
 * counted, and the counts are reported when the page is closed.
 */
#define GAP_MAX 64

struct js_gap {
	char name[48];
	unsigned int count;
};

static struct js_gap js_gaps[GAP_MAX];
static unsigned int js_gap_count;
static unsigned int js_gap_dropped;

static void gap_report(void);

static void gap_reset(void)
{
	memset(js_gaps, 0, sizeof(js_gaps));
	js_gap_count = 0;
	js_gap_dropped = 0;
}

/*
 * The tally is printed when the page closes, which is too late for a
 * page that is stuck: the one worth asking about cannot be navigated
 * away from without losing what it had to say. The Start menu's layout
 * dump calls this to print it where it stands (VitaSurf).
 */
void vita_js_report_gaps(void)
{
	gap_report();
}


static void gap_report(void)
{
	char line[256];
	unsigned int i, at = 0;

	if (js_gap_count == 0) {
		return;
	}

	line[0] = '\0';
	for (i = 0; i < js_gap_count; i++) {
		int n = snprintf(line + at, sizeof(line) - at, "%s%s x%u",
				 at == 0 ? "" : ", ", js_gaps[i].name,
				 js_gaps[i].count);

		if (n < 0 || (unsigned int) n >= sizeof(line) - at) {
			break;
		}
		at += (unsigned int) n;
	}
	vita_log("gap: the page used %u thing%s this build does not do%s: %s",
		 js_gap_count, js_gap_count == 1 ? "" : "s",
		 js_gap_dropped > 0 ? " (and more)" : "", line);
}

/** __vitaGap(name): the page used something that is not implemented. */
static JSValue win_vita_gap(JSContext *ctx, JSValueConst this_val,
			    int argc, JSValueConst *argv)
{
	C_WHERE;
	const char *name;
	unsigned int i;

	(void) this_val;
	if (argc < 1) {
		return JS_UNDEFINED;
	}
	name = JS_ToCString(ctx, argv[0]);
	if (name == NULL) {
		return JS_UNDEFINED;
	}

	for (i = 0; i < js_gap_count; i++) {
		if (strcmp(js_gaps[i].name, name) == 0) {
			js_gaps[i].count++;
			JS_FreeCString(ctx, name);
			return JS_UNDEFINED;
		}
	}

	if (js_gap_count < GAP_MAX) {
		snprintf(js_gaps[js_gap_count].name,
			 sizeof(js_gaps[js_gap_count].name), "%s", name);
		js_gaps[js_gap_count].count = 1;
		js_gap_count++;
		vita_log("gap: not implemented, first use: %s", name);
	} else {
		js_gap_dropped++;
	}
	JS_FreeCString(ctx, name);

	return JS_UNDEFINED;
}


/* ------------------------------------------------------------------------ */
/* Canvas                                                                    */

/**
 * The drawing surface of the canvas element in argv[0] (VitaSurf).
 *
 * Its size is the width and height attributes, which is what the page
 * draws in, whatever size CSS gives the element on the screen.
 */
static struct vita_canvas *canvas_of(JSContext *ctx, JSValueConst v)
{
	struct dom_node *node = JS_GetOpaque(v, node_class_id);
	dom_string *attr = NULL;
	long width = 300, height = 150;

	(void) ctx;
	if (node == NULL) {
		return NULL;
	}

	if (dom_element_get_attribute(node, corestring_dom_width, &attr) ==
			DOM_NO_ERR && attr != NULL) {
		width = strtol(dom_string_data(attr), NULL, 10);
		dom_string_unref(attr);
	}
	attr = NULL;
	if (dom_element_get_attribute(node, corestring_dom_height, &attr) ==
			DOM_NO_ERR && attr != NULL) {
		height = strtol(dom_string_data(attr), NULL, 10);
		dom_string_unref(attr);
	}

	return vita_canvas_get(node, (int) width, (int) height);
}


/**
 * Read the points of a path out of a Float64Array.
 *
 * The context flattens curves and applies its transform before it gets
 * here, so a path is only ever points and the counts that say where one
 * subpath ends and the next starts.
 */
static double *canvas_points(JSContext *ctx, JSValueConst v, int *n_out)
{
	size_t byte_offset = 0, byte_length = 0, bytes_per = 0;
	JSValue buffer;
	uint8_t *bytes;
	size_t size = 0;

	buffer = JS_GetTypedArrayBuffer(ctx, v, &byte_offset, &byte_length,
					&bytes_per);
	if (JS_IsException(buffer)) {
		return NULL;
	}
	bytes = JS_GetArrayBuffer(ctx, &size, buffer);
	JS_FreeValue(ctx, buffer);
	if (bytes == NULL || bytes_per != sizeof(double)) {
		return NULL;
	}

	*n_out = (int) (byte_length / sizeof(double));

	return (double *) (bytes + byte_offset);
}


/**
 * Read what a fill or a stroke should lay down.
 *
 * A plain number is one colour. A gradient arrives as an array the
 * context has already put through its transform:
 *
 *   [kind, x0, y0, r0, x1, y1, r1, angle, offset, colour, ...]
 *
 * The stops are allocated here and belong to the caller.
 */
static bool canvas_paint_of(JSContext *ctx, JSValueConst v,
			    struct vita_canvas_paint *paint,
			    struct vita_canvas_stop **stops_out)
{
	uint32_t length = 0, i;
	int32_t kind = 0;
	struct vita_canvas_stop *stops;
	int n_stops;

	memset(paint, 0, sizeof(*paint));
	*stops_out = NULL;

	if (JS_IsArray(v) == false) {
		uint32_t colour = 0;

		if (JS_ToUint32(ctx, &colour, v) != 0) {
			return false;
		}
		paint->kind = CANVAS_PAINT_SOLID;
		paint->rgba = colour;
		return true;
	}

	{
		JSValue len = JS_GetPropertyStr(ctx, v, "length");

		if (JS_ToUint32(ctx, &length, len) != 0) {
			length = 0;
		}
		JS_FreeValue(ctx, len);
	}
	/* eight numbers of geometry, then a pair for each stop */
	if (length < 8 || (length - 8) % 2 != 0 || length > 8 + 2 * 256) {
		return false;
	}

	{
		JSValue item = JS_GetPropertyUint32(ctx, v, 0);

		JS_ToInt32(ctx, &kind, item);
		JS_FreeValue(ctx, item);
	}
	if (kind < CANVAS_PAINT_LINEAR || kind > CANVAS_PAINT_CONIC) {
		return false;
	}
	paint->kind = (enum vita_canvas_paint_kind) kind;

	{
		double *slot[7];
		int k;

		slot[0] = &paint->x0; slot[1] = &paint->y0;
		slot[2] = &paint->r0; slot[3] = &paint->x1;
		slot[4] = &paint->y1; slot[5] = &paint->r1;
		slot[6] = &paint->angle;
		for (k = 0; k < 7; k++) {
			JSValue item = JS_GetPropertyUint32(ctx, v,
							    (uint32_t) k + 1);

			JS_ToFloat64(ctx, slot[k], item);
			JS_FreeValue(ctx, item);
		}
	}

	n_stops = (int) ((length - 8) / 2);
	if (n_stops == 0) {
		/* a gradient with no stops paints nothing at all */
		paint->kind = CANVAS_PAINT_SOLID;
		paint->rgba = 0;
		return true;
	}

	stops = malloc((size_t) n_stops * sizeof(*stops));
	if (stops == NULL) {
		return false;
	}
	for (i = 0; i < (uint32_t) n_stops; i++) {
		JSValue off = JS_GetPropertyUint32(ctx, v, 8 + i * 2);
		JSValue col = JS_GetPropertyUint32(ctx, v, 9 + i * 2);
		uint32_t rgba = 0;
		double offset = 0;

		JS_ToFloat64(ctx, &offset, off);
		JS_ToUint32(ctx, &rgba, col);
		JS_FreeValue(ctx, off);
		JS_FreeValue(ctx, col);
		stops[i].offset = offset;
		stops[i].rgba = rgba;
	}

	paint->stops = stops;
	paint->n_stops = n_stops;
	*stops_out = stops;

	return true;
}


/**
 * The pixels of a node a page wants to draw from.
 *
 * A canvas gives up its own bitmap; anything else -- an image, and that
 * is what a page draws -- gives up the bitmap its layout box holds, so
 * only an image that has finished loading can be drawn.
 */
static bool canvas_image_of(JSContext *ctx, JSValueConst v,
			    struct vita_canvas_image *img)
{
	struct dom_node *node = JS_GetOpaque(v, node_class_id);
	struct vita_canvas *canvas;
	struct bitmap *bitmap;
	struct box *box;
	dom_string *name = NULL;
	bool is_canvas = false;

	if (node == NULL) {
		return false;
	}

	if (dom_node_get_node_name(node, &name) == DOM_NO_ERR &&
			name != NULL) {
		is_canvas = strcasecmp(dom_string_data(name), "canvas") == 0;
		dom_string_unref(name);
	}

	if (is_canvas) {
		canvas = canvas_of(ctx, v);
		return canvas != NULL && vita_canvas_as_image(canvas, img);
	}

	box = box_for_node(node);
	if (box == NULL || box->object == NULL) {
		return false;
	}
	bitmap = content_get_bitmap(box->object);
	if (bitmap == NULL) {
		return false;
	}

	return vita_canvas_image_of_bitmap(bitmap, img);
}



/**
 * __vitaCanvasPath(node, points, counts, colour, mode, lineWidth)
 *
 * mode 0 fills by the nonzero rule, 1 by even-odd, 2 strokes.
 */
static JSValue win_vita_canvas_path(JSContext *ctx, JSValueConst this_val,
				    int argc, JSValueConst *argv)
{
	C_WHERE;
	struct vita_canvas *canvas;
	struct vita_canvas_paint paint;
	struct vita_canvas_stop *stops = NULL;
	double *points;
	int *counts = NULL;
	int32_t mode = 0;
	double line_width = 1;
	int n_points = 0;
	uint32_t n_sub = 0, i;
	int total = 0;

	(void) this_val;
	if (argc < 5) {
		return JS_UNDEFINED;
	}

	canvas = canvas_of(ctx, argv[0]);
	if (canvas == NULL) {
		return JS_UNDEFINED;
	}

	points = canvas_points(ctx, argv[1], &n_points);
	if (points == NULL || n_points < 4) {
		return JS_UNDEFINED;
	}

	if (canvas_paint_of(ctx, argv[3], &paint, &stops) == false ||
	    JS_ToInt32(ctx, &mode, argv[4]) != 0) {
		free(stops);
		return JS_UNDEFINED;
	}
	if (argc > 5) {
		JS_ToFloat64(ctx, &line_width, argv[5]);
	}

	{
		JSValue len = JS_GetPropertyStr(ctx, argv[2], "length");

		if (JS_ToUint32(ctx, &n_sub, len) != 0) {
			n_sub = 0;
		}
		JS_FreeValue(ctx, len);
	}
	if (n_sub == 0 || n_sub > 4096) {
		free(stops);
		return JS_UNDEFINED;
	}

	counts = malloc(n_sub * sizeof(*counts));
	if (counts == NULL) {
		free(stops);
		return JS_UNDEFINED;
	}
	for (i = 0; i < n_sub; i++) {
		JSValue item = JS_GetPropertyUint32(ctx, argv[2], i);
		int32_t count = 0;

		JS_ToInt32(ctx, &count, item);
		JS_FreeValue(ctx, item);
		counts[i] = count;
		total += count;
	}
	if (total * 2 > n_points) {
		free(counts);
		free(stops);
		return JS_UNDEFINED;
	}

	if (mode == 2) {
		vita_canvas_stroke_path(canvas, points, counts, (int) n_sub,
					&paint, line_width);
	} else {
		vita_canvas_fill_path(canvas, points, counts, (int) n_sub,
				      &paint, mode == 1);
	}
	vita_canvas_finish(canvas);
	free(counts);
	free(stops);

	return JS_UNDEFINED;
}


/**
 * __vitaCanvasText(node, x, y, text, colour, sizePx, family, weight,
 *                  italic, align, baseline)
 */
static JSValue win_vita_canvas_text(JSContext *ctx, JSValueConst this_val,
				    int argc, JSValueConst *argv)
{
	C_WHERE;
	struct vita_canvas *canvas;
	struct vita_canvas_paint paint;
	struct vita_canvas_stop *stops = NULL;
	const char *text;
	size_t len = 0;
	double x = 0, y = 0, size_px = 10;
	int32_t family = 0, weight = 400, italic = 0, align = 0, baseline = 0;

	(void) this_val;
	if (argc < 6) {
		return JS_UNDEFINED;
	}
	canvas = canvas_of(ctx, argv[0]);
	if (canvas == NULL) {
		return JS_UNDEFINED;
	}

	JS_ToFloat64(ctx, &x, argv[1]);
	JS_ToFloat64(ctx, &y, argv[2]);
	text = JS_ToCStringLen(ctx, &len, argv[3]);
	if (text == NULL) {
		return JS_UNDEFINED;
	}
	if (canvas_paint_of(ctx, argv[4], &paint, &stops) == false) {
		JS_FreeCString(ctx, text);
		return JS_UNDEFINED;
	}
	JS_ToFloat64(ctx, &size_px, argv[5]);
	if (argc > 6) JS_ToInt32(ctx, &family, argv[6]);
	if (argc > 7) JS_ToInt32(ctx, &weight, argv[7]);
	if (argc > 8) JS_ToInt32(ctx, &italic, argv[8]);
	if (argc > 9) JS_ToInt32(ctx, &align, argv[9]);
	if (argc > 10) JS_ToInt32(ctx, &baseline, argv[10]);

	vita_canvas_text(canvas, x, y, text, (unsigned int) len, size_px,
			 family, weight, italic != 0, &paint, align, baseline);
	vita_canvas_finish(canvas);
	JS_FreeCString(ctx, text);
	free(stops);

	return JS_UNDEFINED;
}


/** __vitaCanvasMeasure(text, sizePx, family, weight, italic) */
static JSValue win_vita_canvas_measure(JSContext *ctx, JSValueConst this_val,
				       int argc, JSValueConst *argv)
{
	C_WHERE;
	const char *text;
	size_t len = 0;
	double size_px = 10, width;
	int32_t family = 0, weight = 400, italic = 0;

	(void) this_val;
	if (argc < 2) {
		return JS_NewFloat64(ctx, 0);
	}
	text = JS_ToCStringLen(ctx, &len, argv[0]);
	if (text == NULL) {
		return JS_NewFloat64(ctx, 0);
	}
	JS_ToFloat64(ctx, &size_px, argv[1]);
	if (argc > 2) JS_ToInt32(ctx, &family, argv[2]);
	if (argc > 3) JS_ToInt32(ctx, &weight, argv[3]);
	if (argc > 4) JS_ToInt32(ctx, &italic, argv[4]);

	width = vita_canvas_text_width(text, (unsigned int) len, size_px,
				       family, weight, italic != 0);
	JS_FreeCString(ctx, text);

	return JS_NewFloat64(ctx, width);
}


/** __vitaCanvasClear(node, x, y, w, h) */
static JSValue win_vita_canvas_clear(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	C_WHERE;
	struct vita_canvas *canvas;
	double v[4] = { 0, 0, 0, 0 };
	int i;

	(void) this_val;
	if (argc < 5) {
		return JS_UNDEFINED;
	}
	canvas = canvas_of(ctx, argv[0]);
	if (canvas == NULL) {
		return JS_UNDEFINED;
	}
	for (i = 0; i < 4; i++) {
		JS_ToFloat64(ctx, &v[i], argv[i + 1]);
	}
	vita_canvas_clear_rect(canvas, v[0], v[1], v[2], v[3]);
	vita_canvas_finish(canvas);

	return JS_UNDEFINED;
}


/**
 * __vitaCanvasImageSize(node): [width, height] of what a page would
 * draw from that node, or null if there is nothing to draw yet.
 */
static JSValue win_vita_canvas_image_size(JSContext *ctx,
					  JSValueConst this_val,
					  int argc, JSValueConst *argv)
{
	C_WHERE;
	struct vita_canvas_image img;
	JSValue arr;

	(void) this_val;
	if (argc < 1 || canvas_image_of(ctx, argv[0], &img) == false) {
		return JS_NULL;
	}

	arr = JS_NewArray(ctx);
	set_index(ctx, arr, 0, img.width);
	set_index(ctx, arr, 1, img.height);

	return arr;
}


/**
 * __vitaCanvasImage(dst, src, sx, sy, sw, sh, m, alpha, smooth)
 *
 * m is the six numbers that map the unit square onto where the image
 * goes, so the context's rotation and scale come along with it.
 */
static JSValue win_vita_canvas_image(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	C_WHERE;
	struct vita_canvas *canvas;
	struct vita_canvas_image img;
	double s[4] = { 0, 0, 0, 0 };
	double m[6] = { 1, 0, 0, 1, 0, 0 };
	double alpha = 1;
	int32_t smooth = 1;
	int i;

	(void) this_val;
	if (argc < 7) {
		return JS_UNDEFINED;
	}
	/*
	 * The source is read first: one canvas surface is described at a
	 * time, and asking for the destination would forget the source.
	 * The image keeps its own pointers, so it survives that.
	 */
	if (canvas_image_of(ctx, argv[1], &img) == false) {
		return JS_UNDEFINED;
	}
	canvas = canvas_of(ctx, argv[0]);
	if (canvas == NULL) {
		return JS_UNDEFINED;
	}

	for (i = 0; i < 4; i++) {
		JS_ToFloat64(ctx, &s[i], argv[i + 2]);
	}
	for (i = 0; i < 6; i++) {
		JSValue item = JS_GetPropertyUint32(ctx, argv[6],
						    (uint32_t) i);

		JS_ToFloat64(ctx, &m[i], item);
		JS_FreeValue(ctx, item);
	}
	if (argc > 7) JS_ToFloat64(ctx, &alpha, argv[7]);
	if (argc > 8) JS_ToInt32(ctx, &smooth, argv[8]);

	vita_canvas_draw_image(canvas, &img, s[0], s[1], s[2], s[3], m,
			       alpha, smooth != 0);
	vita_canvas_finish(canvas);

	return JS_UNDEFINED;
}


/**
 * __vitaCanvasRead(node, x, y, w, h): the pixels, as getImageData wants
 * them, in an ArrayBuffer the caller wraps.
 */
static JSValue win_vita_canvas_read(JSContext *ctx, JSValueConst this_val,
				    int argc, JSValueConst *argv)
{
	C_WHERE;
	struct vita_canvas *canvas;
	unsigned char *pixels;
	int32_t v[4] = { 0, 0, 0, 0 };
	JSValue buffer;
	int i;

	(void) this_val;
	if (argc < 5) {
		return JS_NULL;
	}
	canvas = canvas_of(ctx, argv[0]);
	if (canvas == NULL) {
		return JS_NULL;
	}
	for (i = 0; i < 4; i++) {
		JS_ToInt32(ctx, &v[i], argv[i + 1]);
	}
	/*
	 * The buffer is made twice over, once here and once as the array
	 * the script gets, so a read is capped at a megapixel: four
	 * megabytes of the Vita's heap is already more than a page has
	 * any business asking for in one call.
	 */
	if (v[2] <= 0 || v[3] <= 0 ||
	    (long) v[2] * (long) v[3] > 1024L * 1024L) {
		return JS_NULL;
	}

	pixels = malloc((size_t) v[2] * (size_t) v[3] * 4);
	if (pixels == NULL) {
		return JS_NULL;
	}
	vita_canvas_read_pixels(canvas, v[0], v[1], v[2], v[3], pixels);

	buffer = JS_NewArrayBufferCopy(ctx, pixels,
				       (size_t) v[2] * (size_t) v[3] * 4);
	free(pixels);

	return buffer;
}


/**
 * __vitaCanvasWrite(node, bytes, inW, inH, sx, sy, sw, sh, dx, dy)
 */
static JSValue win_vita_canvas_write(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	C_WHERE;
	struct vita_canvas *canvas;
	size_t byte_offset = 0, byte_length = 0, bytes_per = 0;
	int32_t v[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
	JSValue buffer;
	uint8_t *bytes;
	size_t size = 0;
	int i;

	(void) this_val;
	if (argc < 10) {
		return JS_UNDEFINED;
	}
	canvas = canvas_of(ctx, argv[0]);
	if (canvas == NULL) {
		return JS_UNDEFINED;
	}
	for (i = 0; i < 8; i++) {
		JS_ToInt32(ctx, &v[i], argv[i + 2]);
	}

	buffer = JS_GetTypedArrayBuffer(ctx, argv[1], &byte_offset,
					&byte_length, &bytes_per);
	if (JS_IsException(buffer)) {
		return JS_UNDEFINED;
	}
	bytes = JS_GetArrayBuffer(ctx, &size, buffer);
	JS_FreeValue(ctx, buffer);
	if (bytes == NULL || bytes_per != 1 || v[0] <= 0 || v[1] <= 0 ||
	    byte_length < (size_t) v[0] * (size_t) v[1] * 4) {
		return JS_UNDEFINED;
	}

	vita_canvas_write_pixels(canvas, bytes + byte_offset, v[0], v[1],
				 v[2], v[3], v[4], v[5], v[6], v[7]);
	vita_canvas_finish(canvas);

	return JS_UNDEFINED;
}


static JSValue win_vita_box(JSContext *ctx, JSValueConst this_val,
			    int argc, JSValueConst *argv)
{
	C_WHERE;
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
	if (box->type == BOX_INLINE && box->inline_end != NULL) {
		int ix, iy, iw, ih;

		inline_border_box(box, &ix, &iy, &iw, &ih);
		set_index(ctx, arr, 0, ix);
		set_index(ctx, arr, 1, iy);
		set_index(ctx, arr, 2, iw);
		set_index(ctx, arr, 3, ih);
		/* CSSOM View: a non-replaced inline has no client box */
		set_index(ctx, arr, 4, 0);
		set_index(ctx, arr, 5, 0);
	} else {
		set_index(ctx, arr, 0, x - box->border[LEFT].width);
		set_index(ctx, arr, 1, y - box->border[TOP].width);
		set_index(ctx, arr, 2, cw + box->border[LEFT].width + box->border[RIGHT].width);
		set_index(ctx, arr, 3, ch + box->border[TOP].width + box->border[BOTTOM].width);
		set_index(ctx, arr, 4, cw);
		set_index(ctx, arr, 5, ch);
	}
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
	C_WHERE;
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
	C_WHERE;
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
	C_WHERE;
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

/*
 * The prelude's name in the compiled script cache on the memory card
 * (VitaSurf). The cache is keyed by URL and checks the source's hash, so
 * a build whose prelude has changed misses and compiles once more. It
 * carries no '<' because the cache uses that to mean a script with no
 * URL of its own, which is what the prelude used to count as.
 */
#define PRELUDE_URL "vitasurf:prelude"

static JSValue bc_load(JSContext *ctx, const char *url,
		       const char *src, size_t srclen);
static void bc_store(JSContext *ctx, const char *url,
		     const char *src, size_t srclen, JSValueConst fn);
static JSValue bc_load_module(JSContext *ctx, const char *url,
			      const char *src, size_t srclen);
static void bc_store_module(JSContext *ctx, const char *url,
			    const char *src, size_t srclen, JSValueConst fn);
static void bc_index_flush(void);

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
	install_location(ctx, global, JS_DupValue(ctx, loc));
	install_location(ctx, doc, loc);

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
	JS_SetPropertyStr(ctx, global, "__vitaConnected",
			  JS_NewCFunction(ctx, win_vita_connected,
					  "__vitaConnected", 1));
	JS_SetPropertyStr(ctx, global, "__vitaMOWatch",
			  JS_NewCFunction(ctx, win_vita_mo_watch,
					  "__vitaMOWatch", 4));
	JS_SetPropertyStr(ctx, global, "__vitaMOUnwatch",
			  JS_NewCFunction(ctx, win_vita_mo_unwatch,
					  "__vitaMOUnwatch", 1));
	JS_SetPropertyStr(ctx, global, "__vitaUtf8Decode",
			  JS_NewCFunction(ctx, win_vita_utf8_decode,
					  "__vitaUtf8Decode", 1));
	JS_SetPropertyStr(ctx, global, "__vitaNodeTypeTest",
			  JS_NewCFunction(ctx, win_vita_node_type_test,
					  "__vitaNodeTypeTest", 1));
	JS_SetPropertyStr(ctx, global, "__vitaCECandidates",
			  JS_NewCFunction(ctx, win_vita_ce_candidates,
					  "__vitaCECandidates", 2));
	/* the tree generation itself, for the prelude to read without a
	 * call: an ArrayBuffer over the static counter, never freed */
	JS_SetPropertyStr(ctx, global, "__vitaGenBuf",
			  JS_NewArrayBuffer(ctx, (uint8_t *)vita_gens,
					    sizeof(vita_gens), NULL, NULL,
					    false));
	JS_SetPropertyStr(ctx, global, "__vitaElementStep",
			  JS_NewCFunction(ctx, win_vita_element_step,
					  "__vitaElementStep", 2));
	JS_SetPropertyStr(ctx, global, "__vitaSelectorNative",
			  JS_NewCFunction(ctx, win_vita_selector_native,
					  "__vitaSelectorNative", 2));
	JS_SetPropertyStr(ctx, global, "__vitaTagQuery",
			  JS_NewCFunction(ctx, win_vita_tag_query,
					  "__vitaTagQuery", 3));
	JS_SetPropertyStr(ctx, global, "__vitaClosestTag",
			  JS_NewCFunction(ctx, win_vita_closest_tag,
					  "__vitaClosestTag", 3));
	JS_SetPropertyStr(ctx, global, "__vitaSelector",
			  JS_NewCFunction(ctx, win_vita_selector,
					  "__vitaSelector", 1));
	JS_SetPropertyStr(ctx, global, "__vitaModuleState",
			  JS_NewCFunction(ctx, win_vita_module_state,
					  "__vitaModuleState", 2));
	JS_SetPropertyStr(ctx, global, "__vitaDomGen",
			  JS_NewCFunction(ctx, win_vita_dom_gen, "__vitaDomGen", 0));
	JS_SetPropertyStr(ctx, global, "__vitaBox",
			  JS_NewCFunction(ctx, win_vita_box, "__vitaBox", 1));
	JS_SetPropertyStr(ctx, global, "__vitaCanvasPath",
			  JS_NewCFunction(ctx, win_vita_canvas_path,
					  "__vitaCanvasPath", 6));
	JS_SetPropertyStr(ctx, global, "__vitaCanvasImage",
			  JS_NewCFunction(ctx, win_vita_canvas_image,
					  "__vitaCanvasImage", 9));
	JS_SetPropertyStr(ctx, global, "__vitaCanvasImageSize",
			  JS_NewCFunction(ctx, win_vita_canvas_image_size,
					  "__vitaCanvasImageSize", 1));
	JS_SetPropertyStr(ctx, global, "__vitaCanvasRead",
			  JS_NewCFunction(ctx, win_vita_canvas_read,
					  "__vitaCanvasRead", 5));
	JS_SetPropertyStr(ctx, global, "__vitaCanvasWrite",
			  JS_NewCFunction(ctx, win_vita_canvas_write,
					  "__vitaCanvasWrite", 10));
	JS_SetPropertyStr(ctx, global, "__vitaCanvasClear",
			  JS_NewCFunction(ctx, win_vita_canvas_clear,
					  "__vitaCanvasClear", 5));
	JS_SetPropertyStr(ctx, global, "__vitaCanvasText",
			  JS_NewCFunction(ctx, win_vita_canvas_text,
					  "__vitaCanvasText", 11));
	JS_SetPropertyStr(ctx, global, "__vitaCanvasMeasure",
			  JS_NewCFunction(ctx, win_vita_canvas_measure,
					  "__vitaCanvasMeasure", 5));
	JS_SetPropertyStr(ctx, global, "__vitaGap",
			  JS_NewCFunction(ctx, win_vita_gap, "__vitaGap", 1));
	JS_SetPropertyStr(ctx, global, "__vitaElementFromPoint",
			  JS_NewCFunction(ctx, win_vita_element_from_point,
					  "__vitaElementFromPoint", 2));
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
	/* what prefers-color-scheme answers, so matchMedia and the
	 * stylesheets cannot disagree */
	JS_SetPropertyStr(ctx, global, "__vitaDarkMode",
			  nsoption_bool(prefer_dark_mode) ? JS_TRUE : JS_FALSE);
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
		const char *how = prelude_bc != NULL ? "bytecode" : "source";

		/*
		 * The prelude runs once per page, so its own cost is part
		 * of every load, and on the device parsing it was 374 ms of
		 * every one. Parse it once for the life of the process and
		 * keep the bytecode: QuickJS bytecode is portable between
		 * runtimes, which is how qjsc precompiles a script, so each
		 * later page reads the same buffer back instead of parsing
		 * 172 KB of source again.
		 *
		 * That left the first page of every run paying the whole
		 * parse: a build 362 log reads 828 ms for 432 KB, which was
		 * four fifths of a 1039 ms load, and the first page of a run
		 * is the home page. The compiled script cache on the memory
		 * card already holds the bytecode of a page's scripts
		 * between runs, and the prelude is larger than anything it
		 * was written for; it was excluded only because it has no
		 * URL. Give it one. Compiling it now happens once per build
		 * rather than once per boot.
		 */
		nsu_getmonotonic_ms(&t0);
		if (prelude_bc != NULL) {
			fn = JS_ReadObject(ctx, prelude_bc, prelude_bc_len,
					   JS_READ_OBJ_BYTECODE);
		} else {
			fn = bc_load(ctx, PRELUDE_URL, src, len);
			if (JS_IsUndefined(fn)) {
				fn = JS_Eval(ctx, src, len, "<prelude>",
					     JS_EVAL_TYPE_GLOBAL |
					     JS_EVAL_FLAG_COMPILE_ONLY);
				if (!JS_IsException(fn)) {
					bc_store(ctx, PRELUDE_URL, src, len,
						 fn);
				}
			} else {
				how = "card";
			}
			/* and keep it in memory for this run's later pages */
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
			 (unsigned int)(t1 - t0), how);
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
	/*
	 * The engine's version, because how large a compiled script is
	 * depends on it: a host build of quickjs-ng 0.14 writes bytecode
	 * three times the size of its source, keeping every function's
	 * text so that toString can return it, where a build 362 log
	 * cached 73 KB for 221 KB of source. Comparing a measurement
	 * taken here against one taken on a host means knowing both.
	 */
#ifdef QJS_VERSION_MAJOR
	vita_log("qjs: QuickJS engine initialised (content handler %s), "
		 "quickjs-ng %d.%d.%d%s",
		 err == NSERROR_OK ? "registered" : "FAILED",
		 QJS_VERSION_MAJOR, QJS_VERSION_MINOR, QJS_VERSION_PATCH,
		 QJS_VERSION_SUFFIX);
#else
	vita_log("qjs: QuickJS engine initialised (content handler %s), "
		 "version not reported by the headers",
		 err == NSERROR_OK ? "registered" : "FAILED");
#endif
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
#ifdef __vita__
	if (timeout > 0 && timeout < SCRIPT_TIMEOUT_MIN) {
		timeout = SCRIPT_TIMEOUT_MIN;
	}
#endif
	/* the floor is the device's; the native harness keeps the option
	 * as given so that a test can drive a budget of one second
	 * (VitaSurf) */
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
	ret->all_next = all_threads;
	all_threads = ret;
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
		JS_FreeValue(thread->ctx, t->args);
		t->args = JS_UNDEFINED;
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
	gap_report();
	gap_reset();
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
	free(thread->node_hash);
	thread->node_hash = NULL;
	thread->node_hash_size = 0;
	/* the MutationObserver watch list (VitaSurf) */
	{
		unsigned i;

		for (i = 0; i < thread->mo_n; i++) {
			mo_watch_free(&thread->mo[i]);
		}
		free(thread->mo);
		thread->mo = NULL;
		thread->mo_n = thread->mo_alloc = 0;
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
	{
		jsthread **pp = &all_threads;

		while (*pp != NULL && *pp != thread) pp = &(*pp)->all_next;
		if (*pp != NULL) *pp = thread->all_next;
	}
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

/*
 * How much of an entry to move at a time (VitaSurf).
 *
 * newlib's fread refills through the FILE's own buffer and never asks
 * the system for more than that buffer holds, and a stream nobody has
 * given a buffer to gets BUFSIZ, which is a kilobyte. Reading a 6063 KB
 * entry that way is six thousand reads, and a build 368 log puts 1601
 * ms of a 1991 ms read on the card at 3878 KB/s while JS_ReadObject
 * needs only 288 ms of it. glibc would have bypassed the buffer for a
 * request this size; newlib does not.
 */
#define BC_IO_BUF     (256 * 1024)

#define BC_MAGIC      0x43425356u        /* 'VSBC' */
#define BC_FORMAT     1u
/*
 * An ES module's entry (VitaSurf). Its bytecode names the modules it
 * imports rather than holding them, so it can only be used once those
 * are loaded; see bc_module_deps_ready.
 */
#define BC_FORMAT_MODULE 2u
/* Below this, compiling is quicker than finding the file on the card. */
#define BC_MIN_SRC    (128 * 1024)
/*
 * The same for a module. A build 416 log compiles GitHub's 35 imports,
 * 1077 KB of source, at about 250 KB a second, so a 16 KB module costs
 * some 60 ms to compile against a few to open a file.
 */
#define BC_MIN_MODULE_SRC (16 * 1024)
/* One entry. Bytecode runs three to five times the size of its source. */
#define BC_MAX_ENTRY  (48u * 1024 * 1024)
/* The whole directory. An unbounded cache is a bug (see CLAUDE.md). */
#define BC_BUDGET     (96u * 1024 * 1024)
/* GitHub alone is some forty modules. */
#define BC_MAX_ENTRIES 256

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
static bool bc_index_dirty;

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

/** Write the index if a hit has changed its use order (VitaSurf). */
static void bc_index_flush(void)
{
	if (bc_index_dirty) {
		bc_index_dirty = false;
		bc_index_save();
	}
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
static bool bc_module_deps_ready(JSContext *ctx, const char *url,
				 const char *src, size_t srclen);
static int module_graph_check(jsthread *thread, const char *root,
			      const char *src, size_t len, char *waiting,
			      size_t waiting_len);
/** Set while a graph walk resolves specifiers, to keep the log quiet. */
static bool normalize_quiet;

static JSValue bc_load_kind(JSContext *ctx, const char *url,
			    const char *src, size_t srclen, bool module)
{
	char path[256];
	struct bc_header h;
	FILE *f;
	uint8_t *buf;
	JSValue fn;
	uint64_t hash;
	uint64_t t_read0 = 0, t_read1 = 0, t_decode = 0;

	if (srclen < (module ? BC_MIN_MODULE_SRC : BC_MIN_SRC) ||
	    url == NULL || url[0] == '<' || vitasurf_cache_disabled()) {
		return JS_UNDEFINED;
	}
	bc_path(path, sizeof(path), url);
	f = fopen(path, "rb");
	if (f == NULL) {
		return JS_UNDEFINED;
	}
	/* before the first read, or it has no effect */
	setvbuf(f, NULL, _IOFBF, BC_IO_BUF);
	if (fread(&h, 1, sizeof(h), f) != sizeof(h) ||
	    h.magic != BC_MAGIC ||
	    h.format != (module ? BC_FORMAT_MODULE : BC_FORMAT) ||
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
	/*
	 * A module's bytecode can only be used once everything it imports
	 * is loaded (VitaSurf). Checked before the entry is read, so a
	 * page whose chunks are still arriving pays only for the check.
	 */
	if (module && !bc_module_deps_ready(ctx, url, src, srclen)) {
		fclose(f);
		return JS_UNDEFINED;
	}
	buf = malloc(h.bc_len);
	if (buf == NULL) {
		fclose(f);
		return JS_UNDEFINED;
	}
	/*
	 * Where reading an entry back actually goes (VitaSurf). A build
	 * 362 log reads 1822 KB of script back in 1984 ms against 3947
	 * ms to compile it, barely twice as quick; the same pair of
	 * operations on a host is fifteen to eighteen times apart,
	 * measured over three real bundles. One of these two halves is
	 * out of proportion and the totals cannot say which.
	 */
	nsu_getmonotonic_ms(&t_read0);
	if (fread(buf, 1, h.bc_len, f) != h.bc_len) {
		free(buf);
		fclose(f);
		return JS_UNDEFINED;
	}
	fclose(f);
	nsu_getmonotonic_ms(&t_read1);
	/*
	 * QuickJS stamps its own bytecode version into the stream and
	 * refuses a stream it did not write, so an entry left behind by an
	 * older engine comes back as an exception here rather than as
	 * something that runs. Treat it as a miss and compile.
	 */
	fn = JS_ReadObject(ctx, buf, h.bc_len, JS_READ_OBJ_BYTECODE);
	nsu_getmonotonic_ms(&t_decode);
	vita_log("qjs: cache entry %u KB: %u ms off the card at %u KB/s, "
		 "%u ms decoding it",
		 (unsigned)(h.bc_len / 1024),
		 (unsigned)(t_read1 - t_read0),
		 t_read1 > t_read0 ?
			(unsigned)(h.bc_len / (t_read1 - t_read0)) : 0u,
		 (unsigned)(t_decode - t_read1));
	free(buf);
	if (JS_IsException(fn)) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		remove(path);
		return JS_UNDEFINED;
	}
	/*
	 * The kind it was stored as is in the header, but what the
	 * bytes turned into is what counts (VitaSurf). A module value is
	 * never freed through JS_FreeValue, so a wrong one is left alone
	 * and compiled over: a cached module whose stream decoded as
	 * something else is only possible from a corrupt entry, and a
	 * stray function is garbage the next collection takes.
	 */
	if ((JS_VALUE_GET_TAG(fn) == JS_TAG_MODULE) != module) {
		if (JS_VALUE_GET_TAG(fn) != JS_TAG_MODULE) {
			JS_FreeValue(ctx, fn);
		}
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
			/*
			 * Written out later, once: forty module hits a
			 * page each rewriting the index on the card cost
			 * more than the hits save (VitaSurf).
			 */
			e->stamp = ++bc_stamp;
			bc_index_dirty = true;
		}
	}
	return fn;
}

/** Keep the compiled form of this source for the next visit. */
/*
 * Entries waiting to be written to the card (VitaSurf).
 *
 * Writing an entry as soon as its script compiled put the card in the
 * middle of the page load: a build 418 log wrote 4730 KB of bytecode
 * for GitHub's modules and the compile figure went from 2768 ms to
 * 4626. Serialising has to happen then -- once a module has run,
 * QuickJS has swapped its bytecode for a live function that cannot be
 * written out -- but the bytes stand alone, so they wait here and go
 * to the card one entry at a time once script has been quiet for a
 * while. They outlive the page that made them. Held to a total so a
 * page of large bundles cannot eat the heap; past it an entry is
 * simply not kept, and compiles again next time.
 */
#define BC_QUEUE_BUDGET   (24u * 1024 * 1024)
#define BC_QUIET_MS       1000
#define BC_FIRST_WAIT_MS  2000

struct bc_pending {
	struct bc_pending *next;
	char path[256];
	struct bc_header h;
	uint8_t *out;		/* a plain malloc: the runtime that
				 * serialised it goes with its page */
	size_t out_len;
};

static struct bc_pending *bc_queue, **bc_queue_tail = &bc_queue;
static size_t bc_queue_bytes;
static bool bc_flush_scheduled;

static void bc_flush_callback(void *p);

/** Write one serialised entry to the card, beside the index. */
static void bc_write_entry(const char *path, const struct bc_header *h,
			   const uint8_t *out, size_t out_len, bool module)
{
	char tmp[264], nm[24];
	FILE *f;
	struct bc_entry *e;
	uint64_t t0 = now_ms();

	snprintf(nm, sizeof(nm), "%s", strrchr(path, '/') + 1);
	bc_index_load();
	e = bc_index_find(nm);
	if (e != NULL) {			/* replacing our own entry */
		unsigned i = (unsigned)(e - bc_index);
		bc_index_drop(i);
	}
	bc_index_make_room((uint32_t)out_len);
	if (bc_index_n >= BC_MAX_ENTRIES) {
		return;
	}
	/*
	 * Written beside the entry and renamed over it, so a battery that
	 * runs out mid-write leaves the old entry or no entry, never half
	 * of one under a name that claims to be whole.
	 */
	snprintf(tmp, sizeof(tmp), "%s.new", path);
	f = fopen(tmp, "wb");
	if (f == NULL) {
		return;
	}
	setvbuf(f, NULL, _IOFBF, BC_IO_BUF);
	if (fwrite(h, 1, sizeof(*h), f) != sizeof(*h) ||
	    fwrite(out, 1, out_len, f) != out_len) {
		fclose(f);
		remove(tmp);
		return;
	}
	fclose(f);
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
	vita_log("qjs: wrote %u KB of %s bytecode to the card in %u ms",
		 (unsigned)(out_len / 1024), module ? "module" : "script",
		 (unsigned)(now_ms() - t0));
}

/**
 * Write the next waiting entry, once script has been quiet a while.
 */
static void bc_flush_callback(void *p)
{
	struct bc_pending *q;
	uint64_t now = now_ms();

	(void)p;
	bc_flush_scheduled = false;
	if (bc_queue == NULL) {
		return;
	}
	if (now - bc_last_activity_ms < BC_QUIET_MS) {
		bc_flush_scheduled = true;
		guit->misc->schedule(BC_QUIET_MS / 2, bc_flush_callback, NULL);
		return;
	}
	q = bc_queue;
	bc_queue = q->next;
	if (bc_queue == NULL) {
		bc_queue_tail = &bc_queue;
	}
	bc_queue_bytes -= q->out_len;
	bc_write_entry(q->path, &q->h, q->out, q->out_len,
		       q->h.format == BC_FORMAT_MODULE);
	free(q->out);
	free(q);
	if (bc_queue != NULL) {
		bc_flush_scheduled = true;
		guit->misc->schedule(20, bc_flush_callback, NULL);
	}
}

/** Keep the compiled form of this source for the next visit. */
static void bc_store_kind(JSContext *ctx, const char *url,
			  const char *src, size_t srclen, JSValueConst fn,
			  bool module)
{
	struct bc_pending *q;
	uint8_t *out;
	size_t out_len = 0;
	uint64_t hash;
	uint64_t t0;

	if (srclen < (module ? BC_MIN_MODULE_SRC : BC_MIN_SRC) ||
	    url == NULL || url[0] == '<' || vitasurf_cache_disabled()) {
		return;
	}
	t0 = now_ms();
	out = JS_WriteObject(ctx, &out_len, fn, JS_WRITE_OBJ_BYTECODE);
	if (out == NULL) {
		return;
	}
	if (out_len == 0 || out_len > BC_MAX_ENTRY ||
	    bc_queue_bytes + out_len > BC_QUEUE_BUDGET) {
		if (out_len != 0 && out_len <= BC_MAX_ENTRY) {
			vita_log("qjs: not keeping %u KB of bytecode: %u KB "
				 "already wait to be written",
				 (unsigned)(out_len / 1024),
				 (unsigned)(bc_queue_bytes / 1024));
		}
		js_free(ctx, out);
		return;
	}
	q = calloc(1, sizeof(*q));
	if (q != NULL) {
		q->out = malloc(out_len);
	}
	if (q == NULL || q->out == NULL) {
		free(q);
		js_free(ctx, out);
		return;
	}
	memcpy(q->out, out, out_len);
	js_free(ctx, out);
	bc_path(q->path, sizeof(q->path), url);
	hash = bc_hash(src, srclen);
	q->h.magic = BC_MAGIC;
	q->h.format = module ? BC_FORMAT_MODULE : BC_FORMAT;
	q->h.src_len = (uint32_t)srclen;
	q->h.src_hash_lo = (uint32_t)(hash & 0xffffffffu);
	q->h.src_hash_hi = (uint32_t)(hash >> 32);
	q->h.bc_len = (uint32_t)out_len;
	q->out_len = out_len;
	*bc_queue_tail = q;
	bc_queue_tail = &q->next;
	bc_queue_bytes += out_len;
	vitasurf_js_bc_queued_kb += (unsigned)(out_len / 1024);
	vitasurf_ms_js_bc_serialise += (unsigned)(now_ms() - t0);
	if (!bc_flush_scheduled) {
		bc_flush_scheduled = true;
		guit->misc->schedule(BC_FIRST_WAIT_MS, bc_flush_callback, NULL);
	}
}

static JSValue bc_load(JSContext *ctx, const char *url,
		       const char *src, size_t srclen)
{
	return bc_load_kind(ctx, url, src, srclen, false);
}

static void bc_store(JSContext *ctx, const char *url,
		     const char *src, size_t srclen, JSValueConst fn)
{
	bc_store_kind(ctx, url, src, srclen, fn, false);
}

static JSValue bc_load_module(JSContext *ctx, const char *url,
			      const char *src, size_t srclen)
{
	return bc_load_kind(ctx, url, src, srclen, true);
}

static void bc_store_module(JSContext *ctx, const char *url,
			    const char *src, size_t srclen, JSValueConst fn)
{
	bc_store_kind(ctx, url, src, srclen, fn, true);
}

/*
 * The static imports of a module's source (VitaSurf).
 *
 * Every static form names its module in a string that directly follows
 * the keyword "from" or "import": import x from "a", import {x} from
 * "a", import * as x from "a", import "a", export {x} from "a", export
 * * from "a". Dynamic import() is followed by a parenthesis and is not
 * resolved until it runs, so it is not one.
 *
 * What matters is never missing one: a missed import is a module the
 * cached bytecode needs that was not checked for. So anything this
 * cannot read with certainty -- a comment between the keyword and the
 * string, an escape inside the string, a specifier with a space in it,
 * more of them than fit -- gives up, and the caller compiles from source
 * as it always did. A string that only looks like an import, inside a
 * comment or another string, is harmless the other way: it is one more
 * module asked for, and if nothing has it the cache is not used.
 *
 * Writes each specifier as its own import statement into out, and
 * returns how many, or -1 to give up.
 */
#define BC_DEPS_MAX 256

static bool bc_ident_char(char c)
{
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
	       (c >= '0' && c <= '9') || c == '_' || c == '$' ||
	       (unsigned char)c >= 0x80;
}

static int bc_scan_imports(const char *src, size_t len, char *out,
			   size_t outsz)
{
	size_t i, used = 0;
	int n = 0;

	for (i = 0; i + 4 <= len; i++) {
		size_t kw, j, k;
		char q;

		if (src[i] == 'f' && i + 4 <= len &&
		    memcmp(src + i, "from", 4) == 0) {
			kw = 4;
		} else if (src[i] == 'i' && i + 6 <= len &&
			   memcmp(src + i, "import", 6) == 0) {
			kw = 6;
		} else {
			continue;
		}
		/* the whole word, and not a property: x.from, a.import */
		if (i > 0 && (bc_ident_char(src[i - 1]) || src[i - 1] == '.')) {
			continue;
		}
		j = i + kw;
		if (j < len && bc_ident_char(src[j])) {
			continue;
		}
		while (j < len && (src[j] == ' ' || src[j] == '\t' ||
				   src[j] == '\n' || src[j] == '\r')) {
			j++;
		}
		if (j >= len) {
			break;
		}
		if (src[j] == '/') {
			return -1;	/* a comment, or worse: cannot tell */
		}
		if (src[j] != '"' && src[j] != '\'') {
			continue;	/* import( , import{ , from= ... */
		}
		q = src[j];
		for (k = j + 1; k < len && src[k] != q; k++) {
			if (src[k] == '\\' || src[k] == '\n' ||
			    src[k] == ' ') {
				return -1;
			}
		}
		if (k >= len || k == j + 1) {
			return -1;
		}
		/*
		 * What follows the string decides whether it was an import.
		 * A static import or export-from statement ends there, so
		 * the next thing is a semicolon, a line break, the end, or
		 * an import attribute clause; anything else on the same
		 * line would be a syntax error. Prose in a string -- "moved
		 * from 'fixed' to 'sticky'", which GitHub's React bundle
		 * carries -- goes on with more words, and is not one.
		 */
		{
			size_t t = k + 1;

			while (t < len && (src[t] == ' ' || src[t] == '\t')) {
				t++;
			}
			if (t < len && src[t] == '/') {
				return -1;	/* a comment: cannot tell */
			}
			if (!(t >= len || src[t] == ';' || src[t] == '\n' ||
			      src[t] == '\r' ||
			      (t + 4 <= len && memcmp(src + t, "with", 4) == 0 &&
			       (t + 4 == len || !bc_ident_char(src[t + 4]))) ||
			      (t + 6 <= len &&
			       memcmp(src + t, "assert", 6) == 0 &&
			       (t + 6 == len || !bc_ident_char(src[t + 6]))))) {
				i = k;
				continue;
			}
		}
		/* import "<spec>";\n */
		if (n >= BC_DEPS_MAX || used + (k - j + 1) + 10 >= outsz) {
			return -1;
		}
		memcpy(out + used, "import ", 7);
		used += 7;
		memcpy(out + used, src + j, k - j + 1);
		used += k - j + 1;
		out[used++] = ';';
		out[used++] = '\n';
		out[used] = '\0';
		n++;
		i = k;
	}
	return n;
}

/*
 * Whether a cached module can be used now (VitaSurf).
 *
 * Bytecode read back from the card is a module that has not resolved its
 * imports yet; QuickJS resolves them after the loader hands it over. If
 * one of them cannot be found then, the module is left in the engine's
 * list marked resolved with an empty slot where the import should be,
 * and the next module that imports it links against the empty slot.
 * Compiling from source never gets that far: a failed compile takes its
 * module out of the list again.
 *
 * So the imports are resolved first, by compiling a module of nothing
 * but those import statements, from source, under a name beside the
 * real one so relative specifiers resolve the same. If that compiles,
 * everything the cached bytecode names is loaded and resolved, and
 * resolving the bytecode cannot fail. If it does not, the engine has
 * cleaned up after it, and the caller compiles the real module from
 * source, which fails or waits exactly as it did before there was a
 * cache. The empty module stays loaded and is never run.
 */
static bool bc_module_deps_ready(JSContext *ctx, const char *url,
				 const char *src, size_t srclen)
{
	jsthread *thread = JS_GetContextOpaque(ctx);

	/*
	 * This compiled a module of nothing but the imports, from source,
	 * which asked the loader for each of them -- and the loader read
	 * each from the cache and checked its imports the same way. Two
	 * modules that import each other went round that loop, reading
	 * both from the card at every turn, until the stack ran out: on
	 * build 422 GitHub's element registry was read 122 times in 3 s,
	 * and every turn left a copy of it in the engine's module list.
	 * The walk below reads the imports as text instead, and a module
	 * already on the walk is not visited again. Only a graph whose
	 * every module is here and readable counts (VitaSurf).
	 */
	if (thread == NULL) {
		return false;
	}
	return module_graph_check(thread, url, src, srclen, NULL, 0) == 1;
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
	C_WHERE;
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
	C_WHERE;
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
	if (!normalize_quiet) {
		vita_log("qjs: import map resolved '%s' to '%s'", name, out);
	}
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

/* ------------------------------------------------------------------------ */
/* Whether a module's import graph is all here (VitaSurf)                    */

/*
 * QuickJS cannot take back a module compile that fails half way. It
 * marks each module resolved as it starts on it, before its imports are
 * found, and when one import cannot be had it frees only the module it
 * was compiling. Anything else loaded on the way stays in the engine's
 * list, marked resolved. When two modules import each other, the one
 * that stays holds a pointer to the one that was freed, and the next
 * attempt runs through it: a page whose chunks import each other and
 * arrive out of order crashed when it finally had them all.
 *
 * So a module is not compiled until everything it imports, all the way
 * down, has arrived. That is worked out from the text: each module's
 * import statements are read once and kept, a walk visits every module
 * once however they cycle, and a graph found whole is remembered as
 * whole. The text is read with a heuristic (bc_scan_imports), so only
 * a module that is actually on its way holds a compile back; one that
 * cannot be found or read is left to the compile to judge, as before.
 */

struct mod_deps {
	struct mod_deps *next;
	char *url;
	char **deps;	/**< its imports, resolved to URLs */
	int n;		/**< how many, or -1 when they could not be read */
	bool scanned;	/**< its source has been read; else only asked for */
	bool asked;	/**< a fetch was started for it from here */
	bool complete;	/**< everything under it was here */
};

enum mod_src { MOD_SRC_HERE, MOD_SRC_ARRIVING, MOD_SRC_NONE, MOD_SRC_FAILED };

#define GRAPH_MAX_NODES 1024

static unsigned mod_deps_bucket(const char *url)
{
	unsigned h = 5381;

	while (*url != '\0') {
		h = h * 33u + (unsigned char)*url++;
	}
	return h % 64u;
}

static struct mod_deps *mod_deps_find(jsthread *thread, const char *url)
{
	struct mod_deps *e = thread->mod_deps[mod_deps_bucket(url)];

	while (e != NULL && strcmp(e->url, url) != 0) {
		e = e->next;
	}
	return e;
}

static void mod_deps_free(jsthread *thread)
{
	unsigned b;

	for (b = 0; b < 64; b++) {
		struct mod_deps *e = thread->mod_deps[b];

		while (e != NULL) {
			struct mod_deps *next = e->next;
			int i;

			for (i = 0; i < e->n; i++) {
				free(e->deps[i]);
			}
			free(e->deps);
			free(e->url);
			free(e);
			e = next;
		}
		thread->mod_deps[b] = NULL;
	}
}

/** Where the page stands with a module's source. */
static enum mod_src module_source(jsthread *thread, const char *url,
				  const uint8_t **data, size_t *size)
{
	char stripped[1024];
	const char *want = without_retry_suffix(url, stripped,
						sizeof(stripped));
	enum mod_src best = MOD_SRC_NONE;
	unsigned int i;

	if (thread->htmlc == NULL) {
		return MOD_SRC_NONE;
	}
	for (i = 0; i < thread->htmlc->scripts_count; i++) {
		struct html_script *sc = &thread->htmlc->scripts[i];
		int st;

		if (sc->type == HTML_SCRIPT_INLINE ||
		    sc->data.handle == NULL ||
		    strcmp(nsurl_access(hlcache_handle_get_url(
				sc->data.handle)), want) != 0) {
			continue;
		}
		st = (int)content_get_status(sc->data.handle);
		if (st == CONTENT_STATUS_DONE) {
			*data = content_get_source_data(sc->data.handle,
							size);
			if (*data != NULL && *size > 0) {
				return MOD_SRC_HERE;
			}
			if (best == MOD_SRC_NONE) best = MOD_SRC_FAILED;
		} else if (st == CONTENT_STATUS_ERROR) {
			if (best == MOD_SRC_NONE) best = MOD_SRC_FAILED;
		} else {
			best = MOD_SRC_ARRIVING;
		}
	}
	return best;
}

/** A module's imports, read from its source once and kept. */
static struct mod_deps *mod_deps_get(jsthread *thread, const char *url,
				     const char *src, size_t len)
{
	struct mod_deps *e = mod_deps_find(thread, url);
	size_t outsz = 64 * 1024;
	char *out, *p;
	int n, i;
	bool fresh = false;

	if (e != NULL && e->scanned) {
		return e;
	}
	if (e == NULL) {
		e = calloc(1, sizeof(*e));
		if (e == NULL) {
			return NULL;
		}
		e->url = strdup(url);
		if (e->url == NULL) {
			free(e);
			return NULL;
		}
		fresh = true;
	}
	e->scanned = true;
	out = malloc(outsz);
	n = out != NULL ? bc_scan_imports(src, len, out, outsz) : -1;
	e->n = -1;
	if (n > 0) {
		e->deps = calloc((size_t)n, sizeof(char *));
	}
	if (n == 0) {
		e->n = 0;
	} else if (n > 0 && e->deps != NULL) {
		/* out holds one  import "<spec>";  per line */
		e->n = 0;
		p = out;
		for (i = 0; i < n && p != NULL; i++) {
			char *q0 = strpbrk(p, "\"'"), *q1, *norm;

			if (q0 == NULL) break;
			q1 = strchr(q0 + 1, *q0);
			if (q1 == NULL) break;
			*q1 = '\0';
			normalize_quiet = true;
			norm = qjs_module_normalize(thread->ctx, url, q0 + 1,
						    NULL);
			normalize_quiet = false;
			if (norm != NULL) {
				e->deps[e->n] = strdup(norm);
				js_free(thread->ctx, norm);
				if (e->deps[e->n] != NULL) e->n++;
			}
			p = strchr(q1 + 1, '\n');
		}
	}
	free(out);
	if (fresh) {
		e->next = thread->mod_deps[mod_deps_bucket(url)];
		thread->mod_deps[mod_deps_bucket(url)] = e;
	}
	return e;
}

/** Note that a fetch was started for url, so it is not started again. */
static void mod_deps_asked(jsthread *thread, const char *url)
{
	struct mod_deps *e = mod_deps_find(thread, url);

	if (e == NULL) {
		e = calloc(1, sizeof(*e));
		if (e == NULL) {
			return;
		}
		e->url = strdup(url);
		if (e->url == NULL) {
			free(e);
			return;
		}
		e->n = -1;
		e->next = thread->mod_deps[mod_deps_bucket(url)];
		thread->mod_deps[mod_deps_bucket(url)] = e;
	}
	e->asked = true;
}

/*
 * The module root, whose source is src, and everything it imports:
 * 1 when all of it is here, 0 when some of it is still arriving (a
 * fetch is started for any that was never asked for; its URL is copied
 * to waiting), -1 when the walk cannot tell.
 */
static int module_graph_check(jsthread *thread, const char *root,
			      const char *src, size_t len, char *waiting,
			      size_t waiting_len)
{
	struct mod_deps **queue, *e;
	unsigned n = 0, i;
	bool pending = false, unknown = false;

	if (thread == NULL || thread->closed) {
		return -1;
	}
	e = mod_deps_get(thread, root, src, len);
	if (e == NULL) {
		return -1;
	}
	if (e->complete) {
		return 1;
	}
	queue = malloc(GRAPH_MAX_NODES * sizeof(*queue));
	if (queue == NULL) {
		return -1;
	}
	queue[n++] = e;
	for (i = 0; i < n; i++) {
		int j;

		e = queue[i];
		if (e->n < 0) {
			unknown = true;
			continue;
		}
		for (j = 0; j < e->n; j++) {
			const char *d = e->deps[j];
			struct mod_deps *de = mod_deps_find(thread, d);
			const uint8_t *data = NULL;
			size_t size = 0;
			enum mod_src s;
			unsigned k;

			if (de == NULL || !de->scanned) {
				bool asked = de != NULL && de->asked;

				de = NULL;
				s = module_source(thread, d, &data, &size);
				if (s == MOD_SRC_HERE) {
					de = mod_deps_get(thread, d,
							  (const char *)data,
							  size);
				} else if (s == MOD_SRC_ARRIVING) {
					if (!pending && waiting != NULL)
						snprintf(waiting, waiting_len,
							 "%s", d);
					pending = true;
					continue;
				} else if (s == MOD_SRC_NONE && !asked &&
					   thread->htmlc != NULL &&
					   strstr(d, "://") != NULL) {
					/* once: a fetch that failed leaves it
					 * to the compile, as before */
					dom_string *href = to_dom_string(d);
					bool started = href != NULL &&
						html_process_module_preload(
							thread->htmlc, href);

					if (href != NULL)
						dom_string_unref(href);
					if (started) {
						mod_deps_asked(thread, d);
						thread->js_import_fetches++;
						vita_log("qjs: fetching '%s', "
							 "which '%s' imports",
							 d, e->url);
						if (!pending && waiting != NULL)
							snprintf(waiting,
								 waiting_len,
								 "%s", d);
						pending = true;
						continue;
					}
				}
				if (de == NULL) {
					unknown = true;
					continue;
				}
			}
			if (de->complete) {
				continue;
			}
			for (k = 0; k < n && queue[k] != de; k++) {
			}
			if (k < n) {
				continue;	/* already on this walk */
			}
			if (n >= GRAPH_MAX_NODES) {
				unknown = true;
				continue;
			}
			queue[n++] = de;
		}
	}
	if (!pending && !unknown) {
		for (i = 0; i < n; i++) {
			queue[i]->complete = true;
		}
	}
	free(queue);
	return pending ? 0 : unknown ? -1 : 1;
}

/*
 * A dynamic import() in page code is rewritten to __vitaImport(base, spec)
 * before the source is compiled. QuickJS asks its loader for the module
 * synchronously, and the loader can only hand over source the page has
 * already received: a module still on its way (SvelteKit's bootstrap
 * imports two the head is preloading) failed on the spot, and nothing
 * retried it. The helper in the prelude asks __vitaModuleState until the
 * module has arrived and only then does the real import.
 */
static bool is_ident_char(unsigned char c)
{
	return isalnum(c) || c == '_' || c == '$' || c >= 0x80;
}

/*
 * Find the next "import (" that is code: not part of a longer name, and
 * not inside a string, a template or a comment. A regular expression
 * literal holding the word is not told apart, and is not expected.
 * Returns the offset of "import", with *paren the offset of the "(",
 * or len when there is none.
 */
static size_t next_dynamic_import(const char *src, size_t len, size_t from,
				  size_t *paren)
{
	size_t i = from;

	while (i < len) {
		char c = src[i];

		if (c == '"' || c == '\'' || c == '`') {
			char q = c;

			for (i++; i < len && src[i] != q; i++) {
				if (src[i] == '\\') i++;
			}
			i++;
		} else if (c == '/' && i + 1 < len && src[i + 1] == '/') {
			while (i < len && src[i] != '\n') i++;
		} else if (c == '/' && i + 1 < len && src[i + 1] == '*') {
			/* newlib has no memmem */
			for (i += 2; i + 1 < len; i++) {
				if (src[i] == '*' && src[i + 1] == '/') {
					break;
				}
			}
			i = i + 1 < len ? i + 2 : len;
		} else if (c == 'i' && len - i >= 6 &&
			   memcmp(src + i, "import", 6) == 0 &&
			   (i == 0 || !is_ident_char((unsigned char)src[i - 1])) &&
			   !(len - i > 6 && is_ident_char((unsigned char)src[i + 6]))) {
			size_t q = i + 6;

			while (q < len && (src[q] == ' ' || src[q] == '\t' ||
					   src[q] == '\n' || src[q] == '\r')) {
				q++;
			}
			if (q < len && src[q] == '(') {
				*paren = q;
				return i;
			}
			i = q;
		} else {
			i++;
		}
	}
	return len;
}

static char *rewrite_dynamic_imports(const char *src, size_t len,
				     const char *name, size_t *outlen)
{
	size_t count = 0, namelen, extra, o = 0, i, at, paren;
	char *out, *ename;

	/* count first, so the copy is made in one piece */
	for (at = next_dynamic_import(src, len, 0, &paren); at < len;
	     at = next_dynamic_import(src, len, paren + 1, &paren)) {
		count++;
	}
	if (count == 0) {
		return NULL;
	}
	/* the base name, as a JS string literal */
	namelen = strlen(name);
	ename = malloc(namelen * 2 + 1);
	if (ename == NULL) {
		return NULL;
	}
	for (i = 0; i < namelen; i++) {
		unsigned char c = (unsigned char)name[i];

		if (c == '"' || c == '\\') {
			ename[o++] = '\\';
			ename[o++] = c;
		} else if (c < 0x20) {
			ename[o++] = ' ';
		} else {
			ename[o++] = c;
		}
	}
	ename[o] = 0;
	/* "import(" -> "__vitaImport("<name>"," */
	extra = strlen("__vitaImport(\"\",") + o;
	out = malloc(len + count * extra + 1);
	if (out == NULL) {
		free(ename);
		return NULL;
	}
	o = 0;
	i = 0;
	for (at = next_dynamic_import(src, len, 0, &paren); at < len;
	     at = next_dynamic_import(src, len, paren + 1, &paren)) {
		memcpy(out + o, src + i, at - i);
		o += at - i;
		o += (size_t)sprintf(out + o, "__vitaImport(\"%s\",", ename);
		i = paren + 1;
	}
	memcpy(out + o, src + i, len - i);
	o += len - i;
	out[o] = 0;
	*outlen = o;
	free(ename);
	return out;
}

/*
 * __vitaModuleState(base, specifier) -> {url, state}: whether the module
 * a dynamic import names is "done" (its source is here), "arriving" (a
 * fetch is under way, started here if nothing had it), or "none" (it
 * cannot be fetched, so the import may as well fail now).
 */
static JSValue win_vita_module_state(JSContext *ctx, JSValueConst this_val,
				     int argc, JSValueConst *argv)
{
	C_WHERE;
	jsthread *thread = JS_GetContextOpaque(ctx);
	const char *base = NULL, *spec = NULL, *state = "none";
	char *url = NULL;
	JSValue r;
	unsigned int i;

	(void)this_val;
	if (argc < 2 || thread == NULL || thread->closed) {
		return JS_ThrowTypeError(ctx, "__vitaModuleState(base, spec)");
	}
	base = JS_ToCString(ctx, argv[0]);
	spec = JS_ToCString(ctx, argv[1]);
	if (base != NULL && spec != NULL) {
		url = qjs_module_normalize(ctx, base, spec, NULL);
	}
	r = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, r, "url",
			  JS_NewString(ctx, url != NULL ? url :
				       spec != NULL ? spec : ""));
	if (url != NULL && thread->htmlc != NULL) {
		bool found = false;

		for (i = 0; i < thread->htmlc->scripts_count; i++) {
			struct html_script *sc = &thread->htmlc->scripts[i];

			if (sc->type == HTML_SCRIPT_INLINE ||
			    sc->data.handle == NULL ||
			    strcmp(nsurl_access(hlcache_handle_get_url(
					sc->data.handle)), url) != 0) {
				continue;
			}
			found = true;
			state = content_get_status(sc->data.handle) ==
				CONTENT_STATUS_DONE ? "done" : "arriving";
			break;
		}
		if (!found && strstr(url, "://") != NULL) {
			dom_string *href = to_dom_string(url);

			if (href != NULL) {
				if (html_process_module_preload(thread->htmlc,
								href)) {
					thread->js_import_fetches++;
					state = "arriving";
				}
				dom_string_unref(href);
			}
		}
	}
	JS_SetPropertyStr(ctx, r, "state", JS_NewString(ctx, state));
	if (url != NULL) js_free(ctx, url);
	if (base != NULL) JS_FreeCString(ctx, base);
	if (spec != NULL) JS_FreeCString(ctx, spec);
	return r;
}

/*
 * Whether a module compile must wait for its imports: true when some
 * module under it is still arriving. Counted as a missed import, which
 * is what the retry logic reads as "try again later", and logged.
 */
static bool module_graph_wait_for(jsthread *thread, const char *name,
				  const char *src, size_t len, char *waiting,
				  size_t waiting_len)
{
	waiting[0] = '\0';
	if (module_graph_check(thread, name, src, len, waiting,
			       waiting_len) != 0) {
		return false;
	}
	thread->js_imports_missed++;
	vita_log("qjs: module '%s' waits for '%s' before compiling", name,
		 waiting);
	return true;
}

static bool module_graph_wait(jsthread *thread, const char *name,
			      const char *src, size_t len)
{
	char waiting[512];

	return module_graph_wait_for(thread, name, src, len, waiting,
				     sizeof(waiting));
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
			{
				size_t rwlen = 0;
				char *rw = rewrite_dynamic_imports(src, size,
								   name, &rwlen);

				if (rw != NULL) {
					free(src);
					src = rw;
					size = rwlen;
				}
			}
			/*
			 * The compiled module from an earlier visit, if its
			 * imports can all be had now (VitaSurf). Not under a
			 * retry name: the bytecode carries the name it was
			 * compiled under, and the engine files it by that.
			 */
			if (strcmp(name, want) == 0) {
				uint64_t t_c0 = now_ms();

				fn = bc_load_module(ctx, name, src, size);
				if (!JS_IsUndefined(fn)) {
					free(src);
					vitasurf_ms_js_import_cached +=
						(unsigned)(now_ms() - t_c0);
					vitasurf_js_import_cache_hits++;
					vitasurf_js_import_cached_kb +=
						(unsigned)(size / 1024);
					set_import_meta(ctx, fn, name);
					m = JS_VALUE_GET_PTR(fn);
					JS_FreeValue(ctx, fn);
					thread->js_modules++;
					vita_log("qjs: module for import '%s' "
						 "from the cache (%u KB) in "
						 "%u ms", name,
						 (unsigned)(size / 1024),
						 (unsigned)(now_ms() - t_c0));
					return m;
				}
			}
			{
				char waiting[512];

				/* named for the one on its way: the dynamic
				 * import helper waits for that and retries */
				if (module_graph_wait_for(thread, name, src,
							  size, waiting,
							  sizeof(waiting))) {
					free(src);
					JS_ThrowReferenceError(ctx, "could not "
						"load module '%s'", waiting);
					return NULL;
				}
			}
			{
				unsigned missed = thread->js_imports_missed;
				uint64_t t_c0 = now_ms();

				fn = JS_Eval(ctx, src, size, name,
					     JS_EVAL_TYPE_MODULE |
					     JS_EVAL_FLAG_COMPILE_ONLY);
				vitasurf_ms_js_import_compile +=
					(unsigned)(now_ms() - t_c0);
				vitasurf_js_import_compiles++;
				vitasurf_js_import_kb +=
					(unsigned)(size / 1024);
				if (!JS_IsException(fn) &&
				    strcmp(name, want) == 0) {
					bc_store_module(ctx, name, src, size,
							fn);
				}
				free(src);
				if (JS_IsException(fn)) {
					/* a static import of its own that is
					 * not here yet was already logged */
					if (thread->js_imports_missed == missed) {
						vita_log("qjs: module '%s' did "
							 "not compile", name);
					}
					return NULL;
				}
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

		bc_last_activity_ms = now_ms();
		if (r != 0) {
			prof_tail("a promise job");
		}

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
	mod_deps_free(thread);
	sel_cache_free(thread);
	tags_free(thread);
	id_index_free(thread);
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

		begin_script(thread, SCRIPT_TIMER);
		thread->current_script = d->name;
		/*
		 * The compiled module from an earlier visit (VitaSurf),
		 * once everything it imports is here; bc_load_module checks
		 * that, so resolving it cannot fail.
		 */
		fn = bc_load_module(thread->ctx, d->name, d->src, d->len);
		if (!JS_IsUndefined(fn) &&
		    JS_ResolveModule(thread->ctx, fn) < 0) {
			vita_log("qjs: cached module '%s' did not resolve",
				 d->name);
			fn = JS_EXCEPTION;
		} else if (JS_IsUndefined(fn) &&
			   module_graph_wait(thread, d->name, d->src,
					     d->len)) {
			fn = JS_ThrowReferenceError(thread->ctx,
						    "imports still arriving");
		} else if (JS_IsUndefined(fn)) {
			fn = JS_Eval(thread->ctx, d->src, d->len, d->name,
				     JS_EVAL_TYPE_MODULE |
				     JS_EVAL_FLAG_COMPILE_ONLY);
			if (!JS_IsException(fn)) {
				bc_store_module(thread->ctx, d->name, d->src,
						d->len, fn);
			}
		} else {
			vita_log("qjs: module '%s' from the cache", d->name);
		}
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
	uint64_t t_after0 = 0;	/* when the script's run ended (VitaSurf) */

	if (thread == NULL || txt == NULL || txtlen == 0) {
		return false;
	}
	if (thread->closed) {
		/*
		 * The page's engine has already been torn down, so this
		 * script will never run and nothing said so: a bundle
		 * that mounts an app leaves the page on its loading
		 * screen for good (VitaSurf).
		 */
		vita_log("script: %s handed over after the page's "
			 "JavaScript was closed, so it did not run",
			 name != NULL ? name : "<script>");
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
	/*
	 * A caller may count the terminator in the length it gives, and
	 * a NUL in the middle of the source is where QuickJS's lexer
	 * stops, so every such script failed to parse with a message
	 * about a missing semicolon. NetSurf's own javascript: URLs and
	 * the monkey harness both do this (VitaSurf).
	 */
	while (txtlen > 0 && txt[txtlen - 1] == '\0') {
		txtlen--;
	}
	if (txtlen == 0) {
		vita_log("script: %s is empty, so nothing ran",
			 name != NULL ? name : "<script>");
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
	{
		size_t rwlen = 0;
		char *rw = rewrite_dynamic_imports(src, txtlen, name, &rwlen);

		if (rw != NULL) {
			free(src);
			src = rw;
			txtlen = rwlen;
		}
	}
	begin_script(thread, SCRIPT_PAGE);
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
		/*
		 * Or a module's (VitaSurf). Bytecode read back has not
		 * resolved its imports, which a compile does as it goes, so
		 * that is done here; bc_load_module has already made sure
		 * each of them can be found.
		 */
		fn = bc_load_module(thread->ctx, name, src, txtlen);
		if (!JS_IsUndefined(fn)) {
			if (JS_ResolveModule(thread->ctx, fn) < 0) {
				vita_log("qjs: cached module '%s' did not "
					 "resolve", name);
				fn = JS_EXCEPTION;
			} else {
				set_import_meta(thread->ctx, fn, name);
			}
			module = true;
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
			/* the classic parse that failed, and is thrown
			 * away if this compiles as a module (VitaSurf) */
			uint64_t t_reparse = now_ms();
			unsigned wasted = (unsigned)(t_reparse - t_start);
			JSValue as_module;

			/* not while anything it imports is on its way;
			 * see module_graph_check (VitaSurf) */
			if (!module_graph_wait(thread, name, src, txtlen)) {
				as_module = JS_Eval(thread->ctx, src, txtlen,
						    name,
						    JS_EVAL_TYPE_MODULE |
						    JS_EVAL_FLAG_COMPILE_ONLY);
			} else {
				as_module = JS_ThrowReferenceError(
					thread->ctx, "imports still arriving");
			}

			if (!JS_IsException(as_module)) {
				bc_store_module(thread->ctx, name, src,
						txtlen, as_module);
				vitasurf_ms_js_reparse += wasted;
				vitasurf_js_reparses++;
				vitasurf_js_reparse_kb +=
					(unsigned)(txtlen / 1024);
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
				/*
				 * The source as compiled, with its dynamic
				 * imports rewritten: txtlen is that text's
				 * length now, and copying that much of the
				 * original ran past its end whenever the
				 * rewrite made it longer (VitaSurf).
				 */
				defer_module(thread, src, txtlen, name);
				free(src);
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
		t_after0 = t_done;

		if (module) {
			thread->js_modules++;
		}
		thread->js_scripts++;
		thread->js_bytes += (unsigned)txtlen;
		thread->js_compile_ms += (unsigned)(t_compiled - t_start);
		thread->js_run_ms += (unsigned)(t_done - t_compiled);
		/* the same two, per page, so the script bucket can be
		 * told apart from what else js_exec does (VitaSurf) */
		vitasurf_ms_js_compile += (unsigned)(t_compiled - t_start);
		vitasurf_ms_js_run += (unsigned)(t_done - t_compiled);

		/*
		 * runtime_kb walks the whole runtime -- every object,
		 * shape and string -- to add up what it holds, and asking
		 * it once per script was 26 walks on a YouTube page
		 * (VitaSurf). It is worth knowing after a script big
		 * enough to move the number and not otherwise.
		 */
		if (txtlen > SCRIPT_LOG_BYTES) {
			vita_log("qjs: script %u KB %s in %u ms, "
				 "ran in %u ms, runtime memory now %u KB: %s",
				 (unsigned)(txtlen / 1024),
				 cached ? "read from cache" : "compiled",
				 (unsigned)(t_compiled - t_start),
				 (unsigned)(t_done - t_compiled),
				 runtime_kb(thread->heap->rt),
				 name);
			vita_log_memory("after a large script");
		} else if (vita_verbose_requested()) {
			vita_log("qjs: script %u KB %s in %u ms, "
				 "ran in %u ms: %s",
				 (unsigned)(txtlen / 1024),
				 cached ? "read from cache" : "compiled",
				 (unsigned)(t_compiled - t_start),
				 (unsigned)(t_done - t_compiled),
				 name);
		}
	}
	ok = !JS_IsException(ret);
	if (!ok) {
		qjs_report_exception_src(thread->ctx, name, src, txtlen);
	}
	{
		/*
		 * The tail, split (VitaSurf). Everything from the end of
		 * the run to the close of the script bucket lands here,
		 * and freeing the script's result is the one part of it
		 * that could plausibly cost anything.
		 */
		uint64_t f0 = now_ms(), f1;

		JS_FreeValue(thread->ctx, ret);
		f1 = now_ms();
		vitasurf_ms_js_free += (unsigned)(f1 - f0);
		vitasurf_ms_js_after += (unsigned)(f1 - t_after0);
	}
	thread->current_script = NULL;
	end_script(thread);
	free(src);
	return ok;
}

/*
 * The page moved (VitaSurf). NetSurf scrolls without telling script, so
 * nothing ever fired a scroll event: lazysizes, which unveils an image
 * when a scroll, resize or click makes it check, left Yamtrack's posters
 * as placeholders until something was clicked. vita/input calls this
 * when the scroll position has changed, at most every 100 ms while it
 * moves and once when it stops; the event goes to the document, where
 * document and window listeners both hear it. A NULL window means every
 * page, which is how the native harness drives it.
 */
void vita_js_scrolled(struct browser_window *bw);
void vita_js_scrolled(struct browser_window *bw)
{
	jsthread *t;

	for (t = all_threads; t != NULL; t = t->all_next) {
		if ((bw == NULL || t->win == bw) && !t->closed &&
		    t->script_depth == 0) {
			struct dom_document *doc = thread_document(t);

			if (doc != NULL) {
				static unsigned int fired;
				unsigned int before = img_src_sets;
				uint64_t t0 = now_ms();

				js_fire_event(t, "scroll", NULL,
					      (struct dom_node *)doc);
				fired++;
				/* what a scroll made the page do, when it did
				 * anything: a lazy loader setting sources */
				if (img_src_sets != before) {
					vita_log("scroll: event %u set %u image "
						 "sources, %u ms of script",
						 fired, img_src_sets - before,
						 (unsigned int)(now_ms() - t0));
				}
			}
		}
	}
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
		bc_index_flush();
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
