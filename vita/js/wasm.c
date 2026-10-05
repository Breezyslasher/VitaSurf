/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * The native half of the WebAssembly JS API, as __vitaWasm, for
 * vita/js/wasm.js to build the API on. Modules run on WAMR's interpreter
 * through vita/wasm/glue.h.
 *
 * What lives here: compiling and instantiating, the exported function
 * objects (native, so a call converts its arguments without a trip
 * through script), the host side of each import, memory buffers, table
 * and global access, and the table of externref handles. What wasm.js
 * does: reading the binary for imports and exports, resolving an import
 * object, the classes and their checks, and object identity.
 *
 * Values move between JavaScript and wasm as the interpreter's 32-bit
 * cells, typed by one letter each: i i32, I i64, f f32, d f64,
 * x externref, r funcref. A signature is its parameter letters, a colon
 * and its result letters ("ii:i").
 *
 * A funcref is a function index of one instance, so a function from
 * another instance cannot be stored in a table or passed where a funcref
 * is wanted; that is a TypeError. wasm.js maps between function objects
 * and indexes (funcFor and funcIndex in init).
 */

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <quickjs.h>

#include "glue.h"
#include "vita_platform.h"
#include "wasm.h"

/* each call gets this much interpreter stack */
#define WASM_STACK (128 * 1024)
/* no memory grows past 64 MB: the Vita has little to give */
#define WASM_MAX_PAGES 1024

#define ERR_LEN 256

static JSClassID state_class_id, module_class_id, instance_class_id;

struct buffer_entry;

/* What one context's WebAssembly keeps, on the __vitaWasm object. */
struct wasm_state {
	JSContext *ctx;
	/* from wasm.js: the error classes and the funcref mapping */
	JSValue compile_error, link_error, runtime_error;
	JSValue func_for, func_index;
	/* the exception a host function threw, until its call unwinds */
	JSValue pending;
	bool has_pending;

	/* externref handles: values, a free list, and marks */
	JSValue *refs;
	uint8_t *ref_mark;
	uint32_t ref_cap, ref_count, ref_free, ref_live_after_gc;

	/* live instances, for marking externrefs */
	struct instance_state **insts;
	uint32_t inst_count, inst_cap;

	/* buffers aliasing wasm memory, to detach when it moves or grows */
	struct buffer_entry *buffers;
};

struct host_import {
	struct instance_state *owner;
	JSValue fn;
	char *sig;
};

/* the opaque of an instance handle */
struct instance_state {
	struct wasm_state *st;
	vw_instance *inst;
	/* the handle object itself, not held: it holds this */
	JSValue self;
	struct host_import *imports;
	uint32_t import_count;
};

struct buffer_entry {
	struct buffer_entry *next;
	struct wasm_state *st;
	vw_instance *inst;
	uint32_t index;
	uint8_t *data;
	uint32_t len;
	bool released;
	JSValue ab; /* not held */
};

/* ------------------------------------------------------------------------ */
/* Externref handles                                                        */

static uint32_t ref_new(struct wasm_state *st, JSValueConst v)
{
	uint32_t h;

	if (JS_IsNull(v)) {
		return VW_NULL_REF;
	}
	if (st->ref_free != VW_NULL_REF) {
		h = st->ref_free;
		st->ref_free = (uint32_t)JS_VALUE_GET_INT(st->refs[h]);
	} else {
		if (st->ref_count == st->ref_cap) {
			uint32_t cap = st->ref_cap ? st->ref_cap * 2 : 64;
			JSValue *r = realloc(st->refs, sizeof(JSValue) * cap);
			uint8_t *m;

			if (r == NULL) {
				return VW_NULL_REF;
			}
			st->refs = r;
			m = realloc(st->ref_mark, cap);
			if (m == NULL) {
				return VW_NULL_REF;
			}
			st->ref_mark = m;
			st->ref_cap = cap;
		}
		h = st->ref_count++;
	}
	st->refs[h] = JS_DupValue(st->ctx, v);
	st->ref_mark[h] = 1; /* in use */
	return h;
}

static JSValue ref_get(struct wasm_state *st, uint32_t h)
{
	if (h == VW_NULL_REF || h >= st->ref_count || st->ref_mark[h] == 0) {
		return JS_NULL;
	}
	return JS_DupValue(st->ctx, st->refs[h]);
}

static void mark_ref(uint32_t h, void *ud)
{
	struct wasm_state *st = ud;

	if (h < st->ref_count && st->ref_mark[h] != 0) {
		st->ref_mark[h] = 2;
	}
}

/*
 * Free the handles no global or table holds. Only between calls: a handle
 * on the wasm stack is not seen. Run once the table has doubled since the
 * last time, so the cost is spread over the handles made.
 */
static void ref_reclaim(struct wasm_state *st)
{
	uint32_t i, live = 0;

	if (vw_busy() || st->ref_count < 256 ||
	    st->ref_count < 2 * st->ref_live_after_gc) {
		return;
	}
	for (i = 0; i < st->inst_count; i++) {
		vw_mark_externrefs(st->insts[i]->inst, mark_ref, st);
	}
	for (i = 0; i < st->ref_count; i++) {
		if (st->ref_mark[i] == 2) {
			st->ref_mark[i] = 1;
			live++;
		} else if (st->ref_mark[i] == 1) {
			JS_FreeValue(st->ctx, st->refs[i]);
			st->refs[i] = JS_NewInt32(st->ctx, (int32_t)st->ref_free);
			st->ref_mark[i] = 0;
			st->ref_free = i;
		}
	}
	st->ref_live_after_gc = live;
}

/* ------------------------------------------------------------------------ */
/* Memory buffers                                                           */

/*
 * QuickJS calls this when the buffer is detached and again when it is
 * finalized, detached or not; only the finalizer's call finds the object
 * no longer live, and only then does the entry go.
 */
static void buffer_free(JSRuntime *rt, void *opaque, void *ptr)
{
	struct buffer_entry *e = opaque, **pp;

	(void)ptr;
	if (!e->released) {
		for (pp = e->st ? &e->st->buffers : NULL; pp && *pp;
		     pp = &(*pp)->next) {
			if (*pp == e) {
				*pp = e->next;
				break;
			}
		}
		vw_instance_unref(e->inst);
		e->released = true;
	}
	if (!JS_IsLiveObject(rt, e->ab)) {
		free(e);
	}
}

/*
 * Detach every buffer whose memory moved or changed size, or every buffer
 * of one memory when key is given (Memory.grow detaches even for 0).
 */
static void buffers_check(struct wasm_state *st, const void *key)
{
	for (;;) {
		struct buffer_entry *e;

		for (e = st->buffers; e != NULL; e = e->next) {
			uint32_t len;
			uint8_t *data = vw_memory_data(e->inst, e->index, &len);

			if ((key != NULL &&
			     vw_memory_key(e->inst, e->index) == key) ||
			    data != e->data || len != e->len) {
				break;
			}
		}
		if (e == NULL) {
			return;
		}
		/* calls buffer_free, which unlinks it */
		JS_DetachArrayBuffer(st->ctx, e->ab);
	}
}

/* ------------------------------------------------------------------------ */
/* Values                                                                   */

static char *copy_string(const char *s)
{
	size_t n = strlen(s) + 1;
	char *c = malloc(n);

	if (c != NULL) {
		memcpy(c, s, n);
	}
	return c;
}

static uint32_t type_cells(char t)
{
	return (t == 'I' || t == 'd') ? 2 : 1;
}

static JSValue throw_error(JSContext *ctx, JSValueConst cls, const char *msg)
{
	JSValue m = JS_NewString(ctx, msg);
	JSValue e = JS_CallConstructor(ctx, cls, 1, (JSValueConst *)&m);

	JS_FreeValue(ctx, m);
	if (JS_IsException(e)) {
		return e;
	}
	return JS_Throw(ctx, e);
}

/* The index of a function object in inst, or -1 with an exception. */
static int64_t func_to_index(struct wasm_state *st, struct instance_state *is,
			     JSValueConst v)
{
	JSValueConst args[2];
	JSValue r;
	int32_t idx;

	if (JS_IsNull(v)) {
		return VW_NULL_REF;
	}
	args[0] = v;
	args[1] = is->self;
	r = JS_Call(st->ctx, st->func_index, JS_UNDEFINED, 2, args);
	if (JS_IsException(r)) {
		return -1;
	}
	if (JS_ToInt32(st->ctx, &idx, r) != 0) {
		JS_FreeValue(st->ctx, r);
		return -1;
	}
	JS_FreeValue(st->ctx, r);
	return (uint32_t)idx;
}

/* ToWebAssemblyValue: a JS value to cells. -1 with an exception. */
static int to_cells(struct wasm_state *st, struct instance_state *is, char t,
		    JSValueConst v, uint32_t *cells)
{
	JSContext *ctx = st->ctx;

	switch (t) {
	case 'i': {
		int32_t x;

		if (JS_ToInt32(ctx, &x, v) != 0) return -1;
		cells[0] = (uint32_t)x;
		return 0;
	}
	case 'I': {
		int64_t x;

		if (JS_ToBigInt64(ctx, &x, v) != 0) return -1;
		memcpy(cells, &x, 8);
		return 0;
	}
	case 'f': {
		double d;
		float f;

		if (JS_ToFloat64(ctx, &d, v) != 0) return -1;
		f = (float)d;
		memcpy(cells, &f, 4);
		return 0;
	}
	case 'd': {
		double d;

		if (JS_ToFloat64(ctx, &d, v) != 0) return -1;
		memcpy(cells, &d, 8);
		return 0;
	}
	case 'x':
		cells[0] = ref_new(st, v);
		return 0;
	case 'r': {
		int64_t idx = func_to_index(st, is, v);

		if (idx < 0) return -1;
		cells[0] = (uint32_t)idx;
		return 0;
	}
	}
	JS_ThrowTypeError(ctx, "unsupported value type");
	return -1;
}

/* ToJSValue: cells to a JS value. */
static JSValue from_cells(struct wasm_state *st, struct instance_state *is,
			  char t, const uint32_t *cells)
{
	JSContext *ctx = st->ctx;

	switch (t) {
	case 'i':
		return JS_NewInt32(ctx, (int32_t)cells[0]);
	case 'I': {
		int64_t x;

		memcpy(&x, cells, 8);
		return JS_NewBigInt64(ctx, x);
	}
	case 'f': {
		float f;

		memcpy(&f, cells, 4);
		return JS_NewFloat64(ctx, (double)f);
	}
	case 'd': {
		double d;

		memcpy(&d, cells, 8);
		return JS_NewFloat64(ctx, d);
	}
	case 'x':
		return ref_get(st, cells[0]);
	case 'r': {
		JSValueConst args[2];

		if (cells[0] == VW_NULL_REF) {
			return JS_NULL;
		}
		args[0] = is->self;
		args[1] = JS_NewInt32(ctx, (int32_t)cells[0]);
		return JS_Call(ctx, st->func_for, JS_UNDEFINED, 2, args);
	}
	}
	return JS_UNDEFINED;
}

/* A wasm_val_t, as a host function receives one, to cells. */
static void val_to_cells(const wasm_val_t *v, uint32_t *cells)
{
	switch (v->kind) {
	case WASM_I64:
	case WASM_F64:
		memcpy(cells, &v->of.i64, 8);
		break;
	case WASM_F32:
		memcpy(cells, &v->of.f32, 4);
		break;
	default:
		cells[0] = (uint32_t)v->of.i32;
		break;
	}
}

static void cells_to_val(char t, const uint32_t *cells, wasm_val_t *v)
{
	memset(v, 0, sizeof(*v));
	switch (t) {
	case 'I':
		v->kind = WASM_I64;
		memcpy(&v->of.i64, cells, 8);
		break;
	case 'd':
		v->kind = WASM_F64;
		memcpy(&v->of.f64, cells, 8);
		break;
	case 'f':
		v->kind = WASM_F32;
		memcpy(&v->of.f32, cells, 4);
		break;
	case 'x':
		v->kind = WASM_EXTERNREF;
		v->of.i32 = (int32_t)cells[0];
		break;
	case 'r':
		v->kind = WASM_FUNCREF;
		v->of.i32 = (int32_t)cells[0];
		break;
	default:
		v->kind = WASM_I32;
		v->of.i32 = (int32_t)cells[0];
		break;
	}
}

/* Take what a failed wasm call left: the host exception, or a trap. */
static JSValue throw_trap(struct wasm_state *st, const char *msg)
{
	if (st->has_pending) {
		JSValue e = st->pending;

		st->pending = JS_UNDEFINED;
		st->has_pending = false;
		return JS_Throw(st->ctx, e);
	}
	if (strstr(msg, "stack overflow") != NULL) {
		return JS_ThrowRangeError(st->ctx,
					  "Maximum call stack size exceeded");
	}
	return throw_error(st->ctx, st->runtime_error, msg);
}

/* ------------------------------------------------------------------------ */
/* Host functions: wasm calling an import                                   */

static wasm_trap_t *host_pending(struct wasm_state *st)
{
	JSValue e = JS_GetException(st->ctx);

	if (st->has_pending) {
		JS_FreeValue(st->ctx, st->pending);
	}
	st->pending = e;
	st->has_pending = true;
	return vw_trap_new("exception from JavaScript");
}

static wasm_trap_t *host_call(void *env, const wasm_val_vec_t *args,
			      wasm_val_vec_t *results)
{
	struct host_import *hi = env;
	struct instance_state *is = hi->owner;
	struct wasm_state *st = is->st;
	JSContext *ctx;
	JSValue argv_buf[8], *argv = argv_buf, r;
	const char *params = hi->sig, *res = strchr(hi->sig, ':') + 1;
	uint32_t n = (uint32_t)(res - 1 - params), nres = (uint32_t)strlen(res);
	uint32_t i, cells[2];

	if (st == NULL || JS_IsUndefined(hi->fn)) {
		return vw_trap_new("import is gone");
	}
	ctx = st->ctx;
	/* script is about to run: nothing may see memory that moved */
	buffers_check(st, NULL);
	if (n > 8 && !(argv = malloc(sizeof(JSValue) * n))) {
		JS_ThrowOutOfMemory(ctx);
		return host_pending(st);
	}
	for (i = 0; i < n; i++) {
		val_to_cells(&args->data[i], cells);
		argv[i] = from_cells(st, is, params[i], cells);
		if (JS_IsException(argv[i])) {
			while (i-- > 0) JS_FreeValue(ctx, argv[i]);
			if (argv != argv_buf) free(argv);
			return host_pending(st);
		}
	}
	r = JS_Call(ctx, hi->fn, JS_UNDEFINED, (int)n, (JSValueConst *)argv);
	for (i = 0; i < n; i++) {
		JS_FreeValue(ctx, argv[i]);
	}
	if (argv != argv_buf) free(argv);
	if (JS_IsException(r)) {
		return host_pending(st);
	}
	if (nres == 1) {
		uint32_t c[2] = { 0, 0 };

		if (to_cells(st, is, res[0], r, c) != 0) {
			JS_FreeValue(ctx, r);
			return host_pending(st);
		}
		cells_to_val(res[0], c, &results->data[0]);
	} else if (nres > 1) {
		/* several results come back as an iterable, as many as the
		   type has; wasm.js made it an array */
		int64_t len = 0;

		if (JS_GetLength(ctx, r, &len) != 0) {
			JS_FreeValue(ctx, r);
			return host_pending(st);
		}
		if (len != (int64_t)nres) {
			JS_FreeValue(ctx, r);
			JS_ThrowTypeError(ctx, "expected %u results",
					  (unsigned)nres);
			return host_pending(st);
		}
		for (i = 0; i < nres; i++) {
			uint32_t c[2] = { 0, 0 };
			JSValue x = JS_GetPropertyUint32(ctx, r, i);

			if (JS_IsException(x) ||
			    to_cells(st, is, res[i], x, c) != 0) {
				JS_FreeValue(ctx, x);
				JS_FreeValue(ctx, r);
				return host_pending(st);
			}
			JS_FreeValue(ctx, x);
			cells_to_val(res[i], c, &results->data[i]);
		}
	}
	results->num_elems = nres;
	JS_FreeValue(ctx, r);
	return NULL;
}

/* ------------------------------------------------------------------------ */
/* Classes                                                                  */

static void state_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark)
{
	struct wasm_state *st = JS_GetOpaque(val, state_class_id);
	uint32_t i;

	if (st == NULL) return;
	JS_MarkValue(rt, st->compile_error, mark);
	JS_MarkValue(rt, st->link_error, mark);
	JS_MarkValue(rt, st->runtime_error, mark);
	JS_MarkValue(rt, st->func_for, mark);
	JS_MarkValue(rt, st->func_index, mark);
	JS_MarkValue(rt, st->pending, mark);
	for (i = 0; i < st->ref_count; i++) {
		if (st->ref_mark[i] != 0) {
			JS_MarkValue(rt, st->refs[i], mark);
		}
	}
}

static void state_finalizer(JSRuntime *rt, JSValueConst val)
{
	struct wasm_state *st = JS_GetOpaque(val, state_class_id);
	uint32_t i;

	if (st == NULL) return;
	JS_FreeValueRT(rt, st->compile_error);
	JS_FreeValueRT(rt, st->link_error);
	JS_FreeValueRT(rt, st->runtime_error);
	JS_FreeValueRT(rt, st->func_for);
	JS_FreeValueRT(rt, st->func_index);
	JS_FreeValueRT(rt, st->pending);
	for (i = 0; i < st->ref_count; i++) {
		if (st->ref_mark[i] != 0) {
			JS_FreeValueRT(rt, st->refs[i]);
		}
	}
	free(st->refs);
	free(st->ref_mark);
	/* instances outlive this only while the runtime is torn down */
	for (i = 0; i < st->inst_count; i++) {
		st->insts[i]->st = NULL;
	}
	free(st->insts);
	/* buffers still alive keep their entries; unhook them */
	while (st->buffers != NULL) {
		struct buffer_entry *e = st->buffers;

		st->buffers = e->next;
		e->next = NULL;
		e->st = NULL;
	}
	free(st);
}

static JSClassDef state_class = {
	"WebAssemblyState",
	.finalizer = state_finalizer,
	.gc_mark = state_mark,
};

static void module_finalizer(JSRuntime *rt, JSValueConst val)
{
	vw_module *m = JS_GetOpaque(val, module_class_id);

	(void)rt;
	vw_module_unref(m);
}

static JSClassDef module_class = {
	"WebAssemblyModuleHandle",
	.finalizer = module_finalizer,
};

static void instance_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark)
{
	struct instance_state *is = JS_GetOpaque(val, instance_class_id);
	uint32_t i;

	if (is == NULL) return;
	for (i = 0; i < is->import_count; i++) {
		JS_MarkValue(rt, is->imports[i].fn, mark);
	}
}

static void instance_finalizer(JSRuntime *rt, JSValueConst val)
{
	struct instance_state *is = JS_GetOpaque(val, instance_class_id);
	uint32_t i;

	if (is == NULL) return;
	for (i = 0; i < is->import_count; i++) {
		JS_FreeValueRT(rt, is->imports[i].fn);
		is->imports[i].fn = JS_UNDEFINED;
		free(is->imports[i].sig);
	}
	if (is->st != NULL) {
		struct wasm_state *st = is->st;

		for (i = 0; i < st->inst_count; i++) {
			if (st->insts[i] == is) {
				st->insts[i] = st->insts[--st->inst_count];
				break;
			}
		}
	}
	/*
	 * The instance may live on (a buffer or another instance holds
	 * it), but nothing can call into it once its handle is gone: the
	 * imports array goes with the instance.
	 */
	vw_instance_unref(is->inst);
	free(is->imports);
	free(is);
}

static JSClassDef instance_class = {
	"WebAssemblyInstanceHandle",
	.finalizer = instance_finalizer,
	.gc_mark = instance_mark,
};

static struct wasm_state *get_state(JSContext *ctx, JSValueConst this_val)
{
	return JS_GetOpaque2(ctx, this_val, state_class_id);
}

static struct instance_state *get_instance(JSContext *ctx, JSValueConst v)
{
	return JS_GetOpaque2(ctx, v, instance_class_id);
}

/* ------------------------------------------------------------------------ */
/* Natives                                                                  */

/* init({CompileError, LinkError, RuntimeError, funcFor, funcIndex}) */
static JSValue w_init(JSContext *ctx, JSValueConst this_val, int argc,
		      JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);

	(void)argc;
	if (st == NULL) return JS_EXCEPTION;
#define TAKE(field, name)                                                     \
	JS_FreeValue(ctx, st->field);                                         \
	st->field = JS_GetPropertyStr(ctx, argv[0], name)
	TAKE(compile_error, "CompileError");
	TAKE(link_error, "LinkError");
	TAKE(runtime_error, "RuntimeError");
	TAKE(func_for, "funcFor");
	TAKE(func_index, "funcIndex");
#undef TAKE
	return JS_UNDEFINED;
}

/* bytes of an ArrayBuffer or a view */
static uint8_t *get_bytes(JSContext *ctx, JSValueConst v, size_t *len)
{
	uint8_t *p;

	if (JS_IsArrayBuffer(v)) {
		return JS_GetArrayBuffer(ctx, len, v);
	}
	p = JS_GetUint8Array(ctx, len, v);
	return p;
}

/* compile(bytes) -> module handle; throws CompileError */
static JSValue w_compile(JSContext *ctx, JSValueConst this_val, int argc,
			 JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	char err[ERR_LEN] = "";
	size_t len = 0;
	uint8_t *p;
	vw_module *m;
	JSValue h;

	(void)argc;
	if (st == NULL) return JS_EXCEPTION;
	p = get_bytes(ctx, argv[0], &len);
	if (p == NULL) return JS_EXCEPTION;
	if (len > UINT32_MAX) {
		return throw_error(ctx, st->compile_error, "module too large");
	}
	{
		struct timespec t0, t1;

		clock_gettime(CLOCK_MONOTONIC, &t0);
		m = vw_module_load(p, (uint32_t)len, err, sizeof(err));
		clock_gettime(CLOCK_MONOTONIC, &t1);
		/* a page's modules are worth a line each: what WebAssembly
		   the web sends, and what it costs the Vita to load */
		vita_log("wasm: %s a %u KB module in %u ms%s%s",
			 m ? "compiled" : "refused",
			 (unsigned int)((len + 1023) / 1024),
			 (unsigned int)((t1.tv_sec - t0.tv_sec) * 1000 +
					(t1.tv_nsec - t0.tv_nsec) / 1000000),
			 m ? "" : ": ", m ? "" : err);
	}
	if (m == NULL) {
		return throw_error(ctx, st->compile_error, err);
	}
	h = JS_NewObjectClass(ctx, module_class_id);
	if (JS_IsException(h)) {
		vw_module_unref(m);
		return h;
	}
	JS_SetOpaque(h, m);
	return h;
}

/* read an array of instance handles or nulls, and one of indexes */
static int read_owners(JSContext *ctx, JSValueConst owners, JSValueConst idxs,
		       uint32_t n, vw_instance ***out_owner,
		       uint32_t **out_index)
{
	uint32_t i;

	*out_owner = NULL;
	*out_index = NULL;
	if (n == 0) {
		return 0;
	}
	*out_owner = calloc(n, sizeof(vw_instance *));
	*out_index = calloc(n, sizeof(uint32_t));
	if (*out_owner == NULL || *out_index == NULL) {
		JS_ThrowOutOfMemory(ctx);
		return -1;
	}
	for (i = 0; i < n; i++) {
		JSValue o = JS_GetPropertyUint32(ctx, owners, i);
		JSValue x = JS_GetPropertyUint32(ctx, idxs, i);
		int r = 0;

		if (!JS_IsNull(o) && !JS_IsUndefined(o)) {
			struct instance_state *os = get_instance(ctx, o);

			if (os == NULL || JS_ToUint32(ctx, &(*out_index)[i], x)) {
				r = -1;
			} else {
				(*out_owner)[i] = os->inst;
			}
		}
		JS_FreeValue(ctx, o);
		JS_FreeValue(ctx, x);
		if (r != 0) return -1;
	}
	return 0;
}

/*
 * instantiate(module, funcs, sigs, globals, globalOwners, globalIndexes,
 *             memOwners, memIndexes, tableOwners, tableIndexes)
 *   funcs, sigs: the function each imported function calls, and its type
 *   globals: [type, value] for each imported global
 *   *Owners, *Indexes: for each imported global, memory and table, the
 *     instance handle and index of the one to share, or null
 * -> instance handle. A trap in the start function is a RuntimeError;
 * what an import throws comes out as it is.
 */
static JSValue w_instantiate(JSContext *ctx, JSValueConst this_val, int argc,
			     JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	vw_module *m;
	struct instance_state *is = NULL;
	vw_func_link *funcs = NULL;
	uint32_t *gcells = NULL;
	vw_links links;
	vw_instance **gown = NULL, **mown = NULL, **town = NULL;
	uint32_t *gidx = NULL, *midx = NULL, *tidx = NULL;
	int64_t nf = 0, ng = 0, nm = 0, nt = 0;
	char err[ERR_LEN] = "";
	bool trapped = false;
	JSValue h = JS_UNDEFINED, r = JS_EXCEPTION;
	uint32_t i;

	(void)argc;
	if (st == NULL) return JS_EXCEPTION;
	m = JS_GetOpaque2(ctx, argv[0], module_class_id);
	if (m == NULL) return JS_EXCEPTION;
	if (JS_GetLength(ctx, argv[1], &nf) != 0 ||
	    JS_GetLength(ctx, argv[3], &ng) != 0 ||
	    JS_GetLength(ctx, argv[6], &nm) != 0 ||
	    JS_GetLength(ctx, argv[8], &nt) != 0) {
		return JS_EXCEPTION;
	}
	ref_reclaim(st);

	h = JS_NewObjectClass(ctx, instance_class_id);
	if (JS_IsException(h)) return h;
	is = calloc(1, sizeof(*is));
	if (is == NULL) {
		JS_ThrowOutOfMemory(ctx);
		goto out;
	}
	is->st = st;
	is->self = h;
	JS_SetOpaque(h, is);
	if (nf > 0) {
		is->imports = calloc((size_t)nf, sizeof(*is->imports));
		funcs = calloc((size_t)nf, sizeof(*funcs));
		if (is->imports == NULL || funcs == NULL) {
			JS_ThrowOutOfMemory(ctx);
			goto out;
		}
	}
	is->import_count = (uint32_t)nf;
	for (i = 0; i < (uint32_t)nf; i++) {
		JSValue sig = JS_GetPropertyUint32(ctx, argv[2], i);
		const char *sc = JS_ToCString(ctx, sig);

		JS_FreeValue(ctx, sig);
		is->imports[i].owner = is;
		is->imports[i].fn = JS_UNDEFINED;
		if (sc == NULL) goto out;
		is->imports[i].sig = copy_string(sc);
		JS_FreeCString(ctx, sc);
		if (is->imports[i].sig == NULL) {
			JS_ThrowOutOfMemory(ctx);
			goto out;
		}
		is->imports[i].fn = JS_GetPropertyUint32(ctx, argv[1], i);
		funcs[i].cb = host_call;
		funcs[i].env = &is->imports[i];
	}
	if (ng > 0 && !(gcells = calloc((size_t)ng * 2, sizeof(uint32_t)))) {
		JS_ThrowOutOfMemory(ctx);
		goto out;
	}
	for (i = 0; i < (uint32_t)ng; i++) {
		JSValue pair = JS_GetPropertyUint32(ctx, argv[3], i);
		JSValue t = JS_GetPropertyUint32(ctx, pair, 0);
		JSValue v = JS_GetPropertyUint32(ctx, pair, 1);
		const char *ts = JS_ToCString(ctx, t);
		int rr = ts ? to_cells(st, is, ts[0], v, gcells + 2 * i) : -1;

		if (ts) JS_FreeCString(ctx, ts);
		JS_FreeValue(ctx, t);
		JS_FreeValue(ctx, v);
		JS_FreeValue(ctx, pair);
		if (rr != 0) goto out;
	}
	if (read_owners(ctx, argv[4], argv[5], (uint32_t)ng, &gown, &gidx) ||
	    read_owners(ctx, argv[6], argv[7], (uint32_t)nm, &mown, &midx) ||
	    read_owners(ctx, argv[8], argv[9], (uint32_t)nt, &town, &tidx)) {
		goto out;
	}
	links.funcs = funcs;
	links.globals = gcells;
	links.global_owner = gown;
	links.global_index = gidx;
	links.mem_owner = mown;
	links.mem_index = midx;
	links.table_owner = town;
	links.table_index = tidx;

	is->inst = vw_instantiate(m, &links, WASM_STACK, WASM_MAX_PAGES, err,
				  sizeof(err), &trapped);
	if (is->inst == NULL) {
		buffers_check(st, NULL);
		r = trapped ? throw_trap(st, err)
			    : throw_error(ctx, st->link_error, err);
		goto out;
	}
	if (st->inst_count == st->inst_cap) {
		uint32_t cap = st->inst_cap ? st->inst_cap * 2 : 16;
		struct instance_state **n =
			realloc(st->insts, sizeof(*n) * cap);

		if (n == NULL) {
			JS_ThrowOutOfMemory(ctx);
			goto out;
		}
		st->insts = n;
		st->inst_cap = cap;
	}
	st->insts[st->inst_count++] = is;
	buffers_check(st, NULL);
	r = h;
	h = JS_UNDEFINED;
out:
	free(funcs);
	free(gcells);
	free(gown);
	free(gidx);
	free(mown);
	free(midx);
	free(town);
	free(tidx);
	/* the finalizer frees what a failed handle has */
	JS_FreeValue(ctx, h);
	return r;
}

/* An exported function: func_data = [instance handle, index, signature] */
static JSValue exported_call(JSContext *ctx, JSValueConst this_val, int argc,
			     JSValueConst *argv, int magic,
			     JSValueConst *func_data)
{
	struct instance_state *is = get_instance(ctx, func_data[0]);
	struct wasm_state *st;
	uint32_t idx, cells_buf[32], *cells = cells_buf, pc = 0, rc = 0, i;
	const char *sig, *res, *p;
	char err[ERR_LEN] = "";
	JSValue r;

	(void)this_val;
	(void)magic;
	if (is == NULL) return JS_EXCEPTION;
	st = is->st;
	if (st == NULL) return JS_ThrowTypeError(ctx, "WebAssembly is gone");
	if (JS_ToUint32(ctx, &idx, func_data[1]) != 0) return JS_EXCEPTION;
	sig = JS_ToCString(ctx, func_data[2]);
	if (sig == NULL) return JS_EXCEPTION;
	res = strchr(sig, ':') + 1;
	for (p = sig; *p != ':'; p++) pc += type_cells(*p);
	for (p = res; *p; p++) rc += type_cells(*p);
	if (pc > 32 || rc > 32) {
		uint32_t n = pc > rc ? pc : rc;

		cells = calloc(n, sizeof(uint32_t));
		if (cells == NULL) {
			JS_FreeCString(ctx, sig);
			return JS_ThrowOutOfMemory(ctx);
		}
	}
	ref_reclaim(st);
	/* every argument, the missing ones as undefined, in order */
	{
		uint32_t at = 0;
		int k = 0;

		for (p = sig; *p != ':'; p++, k++) {
			JSValueConst a = k < argc ? argv[k] : JS_UNDEFINED;

			if (to_cells(st, is, *p, a, cells + at) != 0) {
				r = JS_EXCEPTION;
				goto out;
			}
			at += type_cells(*p);
		}
	}
	if (!vw_call(is->inst, idx, cells, pc, err, sizeof(err))) {
		buffers_check(st, NULL);
		r = throw_trap(st, err);
		goto out;
	}
	buffers_check(st, NULL);
	if (*res == '\0') {
		r = JS_UNDEFINED;
	} else if (res[1] == '\0') {
		r = from_cells(st, is, res[0], cells);
	} else {
		uint32_t at = 0;

		r = JS_NewArray(ctx);
		for (i = 0; res[i]; i++) {
			JSValue v = from_cells(st, is, res[i], cells + at);

			if (JS_IsException(v)) {
				JS_FreeValue(ctx, r);
				r = v;
				break;
			}
			JS_SetPropertyUint32(ctx, r, i, v);
			at += type_cells(res[i]);
		}
	}
out:
	if (cells != cells_buf) free(cells);
	JS_FreeCString(ctx, sig);
	return r;
}

/* func(instance, index, signature, name) -> the exported function */
static JSValue w_func(JSContext *ctx, JSValueConst this_val, int argc,
		      JSValueConst *argv)
{
	int64_t nparams = 0;
	const char *sig = JS_ToCString(ctx, argv[2]);
	const char *colon;
	JSValue f, data[3];

	(void)this_val;
	(void)argc;
	if (sig == NULL) return JS_EXCEPTION;
	colon = strchr(sig, ':');
	nparams = colon ? colon - sig : 0;
	JS_FreeCString(ctx, sig);
	data[0] = argv[0];
	data[1] = argv[1];
	data[2] = argv[2];
	f = JS_NewCFunctionData(ctx, exported_call, (int)nparams, 0, 3,
				(JSValueConst *)data);
	if (JS_IsException(f)) return f;
	JS_DefinePropertyValueStr(ctx, f, "name", JS_DupValue(ctx, argv[3]),
				  JS_PROP_CONFIGURABLE);
	return f;
}

static int instance_index(JSContext *ctx, JSValueConst *argv,
			  struct instance_state **is, uint32_t *idx)
{
	*is = get_instance(ctx, argv[0]);
	if (*is == NULL) return -1;
	return JS_ToUint32(ctx, idx, argv[1]);
}

/* memBuffer(instance, index) -> an ArrayBuffer over the memory */
static JSValue w_mem_buffer(JSContext *ctx, JSValueConst this_val, int argc,
			    JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	struct instance_state *is;
	struct buffer_entry *e;
	uint32_t idx, len;
	uint8_t *data;
	JSValue ab;

	(void)argc;
	if (st == NULL || instance_index(ctx, argv, &is, &idx) != 0) {
		return JS_EXCEPTION;
	}
	data = vw_memory_data(is->inst, idx, &len);
	e = calloc(1, sizeof(*e));
	if (e == NULL) return JS_ThrowOutOfMemory(ctx);
	e->st = st;
	e->inst = is->inst;
	e->index = idx;
	e->data = data;
	e->len = len;
	vw_instance_ref(is->inst);
	/* a zero-length memory has no data; give the buffer a pointer */
	ab = JS_NewArrayBuffer(ctx, data ? data : (uint8_t *)e, len,
			       buffer_free, e, false);
	if (JS_IsException(ab)) {
		vw_instance_unref(is->inst);
		free(e);
		return ab;
	}
	e->ab = ab;
	e->next = st->buffers;
	st->buffers = e;
	return ab;
}

/* memGrow(instance, index, delta) -> old pages or -1; detaches buffers */
static JSValue w_mem_grow(JSContext *ctx, JSValueConst this_val, int argc,
			  JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	struct instance_state *is;
	uint32_t idx, delta;
	int32_t old;

	(void)argc;
	if (st == NULL || instance_index(ctx, argv, &is, &idx) != 0 ||
	    JS_ToUint32(ctx, &delta, argv[2]) != 0) {
		return JS_EXCEPTION;
	}
	old = vw_memory_grow(is->inst, idx, delta);
	if (old >= 0) {
		buffers_check(st, vw_memory_key(is->inst, idx));
	}
	return JS_NewInt32(ctx, old);
}

/* memInfo(instance, index) -> [pages, max pages] */
static JSValue w_mem_info(JSContext *ctx, JSValueConst this_val, int argc,
			  JSValueConst *argv)
{
	struct instance_state *is;
	uint32_t idx;
	JSValue r;

	(void)this_val;
	(void)argc;
	if (instance_index(ctx, argv, &is, &idx) != 0) return JS_EXCEPTION;
	r = JS_NewArray(ctx);
	JS_SetPropertyUint32(ctx, r, 0,
			     JS_NewUint32(ctx, vw_memory_pages(is->inst, idx)));
	JS_SetPropertyUint32(ctx, r, 1,
			     JS_NewUint32(ctx,
					  vw_memory_max_pages(is->inst, idx)));
	return r;
}

/* key(instance, kind, index): a number naming the memory, table or
   global itself, for wasm.js to keep one object per thing */
static JSValue w_key(JSContext *ctx, JSValueConst this_val, int argc,
		     JSValueConst *argv)
{
	struct instance_state *is = get_instance(ctx, argv[0]);
	uint32_t kind, idx;
	const void *k = NULL;

	(void)this_val;
	(void)argc;
	if (is == NULL || JS_ToUint32(ctx, &kind, argv[1]) ||
	    JS_ToUint32(ctx, &idx, argv[2])) {
		return JS_EXCEPTION;
	}
	switch (kind) {
	case 1: k = vw_table_key(is->inst, idx); break;
	case 2: k = vw_memory_key(is->inst, idx); break;
	case 3: k = vw_global_key(is->inst, idx); break;
	}
	return JS_NewFloat64(ctx, (double)(uintptr_t)k);
}

/* tableInfo(instance, index) -> [size, capacity] */
static JSValue w_table_info(JSContext *ctx, JSValueConst this_val, int argc,
			    JSValueConst *argv)
{
	struct instance_state *is;
	uint32_t idx;
	JSValue r;

	(void)this_val;
	(void)argc;
	if (instance_index(ctx, argv, &is, &idx) != 0) return JS_EXCEPTION;
	r = JS_NewArray(ctx);
	JS_SetPropertyUint32(ctx, r, 0,
			     JS_NewUint32(ctx, vw_table_size(is->inst, idx)));
	JS_SetPropertyUint32(ctx, r, 1,
			     JS_NewUint32(ctx,
					  vw_table_capacity(is->inst, idx)));
	return r;
}

static char table_type(struct instance_state *is, uint32_t idx)
{
	return vw_table_is_extern(is->inst, idx) ? 'x' : 'r';
}

/*
 * The instance whose function indexes a funcref table holds: the one
 * given (wasm.js tracks it), or the table's own.
 */
static struct instance_state *space_of(JSContext *ctx, JSValueConst v,
				       struct instance_state *own)
{
	if (JS_IsNull(v) || JS_IsUndefined(v)) {
		return own;
	}
	return get_instance(ctx, v);
}

/* tableGet(instance, index, at, space) -> the element; RangeError past
   the end */
static JSValue w_table_get(JSContext *ctx, JSValueConst this_val, int argc,
			   JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	struct instance_state *is;
	uint32_t idx, at, cell;

	(void)argc;
	if (st == NULL || instance_index(ctx, argv, &is, &idx) != 0 ||
	    JS_ToUint32(ctx, &at, argv[2]) != 0) {
		return JS_EXCEPTION;
	}
	if (!vw_table_get(is->inst, idx, at, &cell)) {
		return JS_ThrowRangeError(ctx, "table index out of bounds");
	}
	{
		struct instance_state *sp = space_of(ctx, argv[3], is);

		if (sp == NULL) return JS_EXCEPTION;
		return from_cells(st, sp, table_type(is, idx), &cell);
	}
}

/* tableSet(instance, index, at, value, space) */
static JSValue w_table_set(JSContext *ctx, JSValueConst this_val, int argc,
			   JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	struct instance_state *is;
	uint32_t idx, at, cell;

	(void)argc;
	if (st == NULL || instance_index(ctx, argv, &is, &idx) != 0 ||
	    JS_ToUint32(ctx, &at, argv[2]) != 0) {
		return JS_EXCEPTION;
	}
	if (at >= vw_table_size(is->inst, idx)) {
		return JS_ThrowRangeError(ctx, "table index out of bounds");
	}
	ref_reclaim(st);
	{
		struct instance_state *sp = space_of(ctx, argv[4], is);

		if (sp == NULL ||
		    to_cells(st, sp, table_type(is, idx), argv[3], &cell) != 0) {
			return JS_EXCEPTION;
		}
	}
	vw_table_set(is->inst, idx, at, cell);
	return JS_UNDEFINED;
}

/* tableGrow(instance, index, delta, init, space) -> old size or -1 */
static JSValue w_table_grow(JSContext *ctx, JSValueConst this_val, int argc,
			    JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	struct instance_state *is;
	uint32_t idx, delta, cell;

	(void)argc;
	if (st == NULL || instance_index(ctx, argv, &is, &idx) != 0 ||
	    JS_ToUint32(ctx, &delta, argv[2]) != 0) {
		return JS_EXCEPTION;
	}
	ref_reclaim(st);
	{
		struct instance_state *sp = space_of(ctx, argv[4], is);

		if (sp == NULL ||
		    to_cells(st, sp, table_type(is, idx), argv[3], &cell) != 0) {
			return JS_EXCEPTION;
		}
	}
	return JS_NewInt32(ctx, vw_table_grow(is->inst, idx, delta, cell));
}

/* globalGet(instance, index, type) */
static JSValue w_global_get(JSContext *ctx, JSValueConst this_val, int argc,
			    JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	struct instance_state *is;
	uint32_t idx, cells[2];
	const char *t;
	JSValue r;

	(void)argc;
	if (st == NULL || instance_index(ctx, argv, &is, &idx) != 0) {
		return JS_EXCEPTION;
	}
	t = JS_ToCString(ctx, argv[2]);
	if (t == NULL) return JS_EXCEPTION;
	vw_global_get(is->inst, idx, cells);
	r = from_cells(st, is, t[0], cells);
	JS_FreeCString(ctx, t);
	return r;
}

/* globalSet(instance, index, type, value) */
static JSValue w_global_set(JSContext *ctx, JSValueConst this_val, int argc,
			    JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	struct instance_state *is;
	uint32_t idx, cells[2] = { 0, 0 };
	const char *t;
	int r;

	(void)argc;
	if (st == NULL || instance_index(ctx, argv, &is, &idx) != 0) {
		return JS_EXCEPTION;
	}
	t = JS_ToCString(ctx, argv[2]);
	if (t == NULL) return JS_EXCEPTION;
	ref_reclaim(st);
	r = to_cells(st, is, t[0], argv[3], cells);
	JS_FreeCString(ctx, t);
	if (r != 0) return JS_EXCEPTION;
	vw_global_set(is->inst, idx, cells);
	return JS_UNDEFINED;
}

/* toValue(type, value): ToWebAssemblyValue and back, for a Global's
   initial value and for checks wasm.js makes before instantiating */
static JSValue w_to_value(JSContext *ctx, JSValueConst this_val, int argc,
			  JSValueConst *argv)
{
	struct wasm_state *st = get_state(ctx, this_val);
	const char *t;
	uint32_t cells[2] = { 0, 0 };
	int r;

	(void)argc;
	if (st == NULL) return JS_EXCEPTION;
	t = JS_ToCString(ctx, argv[0]);
	if (t == NULL) return JS_EXCEPTION;
	if (t[0] == 'x' || t[0] == 'r') {
		JS_FreeCString(ctx, t);
		return JS_DupValue(ctx, argv[1]);
	}
	r = to_cells(st, NULL, t[0], argv[1], cells);
	if (r == 0) {
		JSValue v = from_cells(st, NULL, t[0], cells);

		JS_FreeCString(ctx, t);
		return v;
	}
	JS_FreeCString(ctx, t);
	return JS_EXCEPTION;
}

static const JSCFunctionListEntry wasm_funcs[] = {
	JS_CFUNC_DEF("init", 1, w_init),
	JS_CFUNC_DEF("compile", 1, w_compile),
	JS_CFUNC_DEF("instantiate", 10, w_instantiate),
	JS_CFUNC_DEF("func", 4, w_func),
	JS_CFUNC_DEF("memBuffer", 2, w_mem_buffer),
	JS_CFUNC_DEF("memGrow", 3, w_mem_grow),
	JS_CFUNC_DEF("memInfo", 2, w_mem_info),
	JS_CFUNC_DEF("key", 3, w_key),
	JS_CFUNC_DEF("tableInfo", 2, w_table_info),
	JS_CFUNC_DEF("tableGet", 4, w_table_get),
	JS_CFUNC_DEF("tableSet", 5, w_table_set),
	JS_CFUNC_DEF("tableGrow", 5, w_table_grow),
	JS_CFUNC_DEF("globalGet", 3, w_global_get),
	JS_CFUNC_DEF("globalSet", 4, w_global_set),
	JS_CFUNC_DEF("toValue", 2, w_to_value),
};

void vita_wasm_register(JSContext *ctx, JSValueConst global)
{
	static bool runtime_ok, runtime_tried;
	JSRuntime *rt = JS_GetRuntime(ctx);
	struct wasm_state *st;
	JSValue obj;

	if (!runtime_tried) {
		runtime_tried = true;
		runtime_ok = vw_init();
	}
	if (!runtime_ok) {
		return;
	}
	JS_NewClassID(rt, &state_class_id);
	JS_NewClassID(rt, &module_class_id);
	JS_NewClassID(rt, &instance_class_id);
	if (!JS_IsRegisteredClass(rt, state_class_id)) {
		JS_NewClass(rt, state_class_id, &state_class);
		JS_NewClass(rt, module_class_id, &module_class);
		JS_NewClass(rt, instance_class_id, &instance_class);
	}
	st = calloc(1, sizeof(*st));
	if (st == NULL) {
		return;
	}
	st->ctx = ctx;
	st->compile_error = st->link_error = st->runtime_error = JS_UNDEFINED;
	st->func_for = st->func_index = JS_UNDEFINED;
	st->pending = JS_UNDEFINED;
	st->ref_free = VW_NULL_REF;
	obj = JS_NewObjectClass(ctx, state_class_id);
	if (JS_IsException(obj)) {
		free(st);
		return;
	}
	JS_SetOpaque(obj, st);
	JS_SetPropertyFunctionList(ctx, obj, wasm_funcs,
				   sizeof(wasm_funcs) / sizeof(wasm_funcs[0]));
	JS_SetPropertyStr(ctx, global, "__vitaWasm", obj);
}
