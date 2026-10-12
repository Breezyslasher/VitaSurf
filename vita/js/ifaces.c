/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * The interfaces' WebIDL shapes, done in C for the prelude (VitaSurf).
 *
 * interfaces.js gave each of 290 interfaces its shape in script, and
 * nodes.js moved some 600 members of the nodes' one prototype to the
 * interfaces Chrome has them on: a third of the prelude's time on
 * every page, frame and worker, nearly all of it defining properties
 * one at a time through the interpreter. The same steps are taken here,
 * in the same order and with the same outcome; the scripts keep what
 * only script can be (the constructors' wrappers, which ask who calls
 * them) and describe the rest.
 */

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "ifaces.h"

/* a failure to define is ignored, as the scripts' try/catch did */
static void swallow(JSContext *ctx, int r)
{
	if (r < 0) {
		JS_FreeValue(ctx, JS_GetException(ctx));
	}
}

static void define_value(JSContext *ctx, JSValueConst o, JSAtom k,
			 JSValue v, int flags)
{
	swallow(ctx, JS_DefinePropertyValue(ctx, o, k, v, flags));
}

/* a descriptor as Object.defineProperty takes it, when only value and
 * configurable are given */
static void define_value_conf(JSContext *ctx, JSValueConst o, JSAtom k,
			      JSValue v)
{
	swallow(ctx, JS_DefineProperty(ctx, o, k, v, JS_UNDEFINED,
				       JS_UNDEFINED, JS_PROP_HAS_VALUE |
				       JS_PROP_HAS_CONFIGURABLE |
				       JS_PROP_CONFIGURABLE));
	JS_FreeValue(ctx, v);
}

/* define o[k] from a whole descriptor, which this frees */
static void define_desc(JSContext *ctx, JSValueConst o, JSAtom k,
			JSPropertyDescriptor *d)
{
	int flags = d->flags & (JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE |
				JS_PROP_ENUMERABLE);

	flags |= JS_PROP_HAS_CONFIGURABLE | JS_PROP_HAS_ENUMERABLE;
	if (d->flags & JS_PROP_GETSET) {
		flags |= JS_PROP_HAS_GET | JS_PROP_HAS_SET;
	} else {
		flags |= JS_PROP_HAS_VALUE | JS_PROP_HAS_WRITABLE;
	}
	swallow(ctx, JS_DefineProperty(ctx, o, k, d->value, d->getter,
				       d->setter, flags));
	JS_FreeValue(ctx, d->value);
	JS_FreeValue(ctx, d->getter);
	JS_FreeValue(ctx, d->setter);
}

/* 1 own, 0 not, and -1 failed (cleared) */
static int get_own(JSContext *ctx, JSPropertyDescriptor *d, JSValueConst o,
		   JSAtom k)
{
	int r = JS_GetOwnProperty(ctx, d, o, k);

	if (r < 0) {
		JS_FreeValue(ctx, JS_GetException(ctx));
	}
	return r;
}

static bool has_own(JSContext *ctx, JSValueConst o, JSAtom k)
{
	JSPropertyDescriptor d;

	if (get_own(ctx, &d, o, k) <= 0) {
		return false;
	}
	JS_FreeValue(ctx, d.value);
	JS_FreeValue(ctx, d.getter);
	JS_FreeValue(ctx, d.setter);
	return true;
}

/* whether proto is on obj's chain, as proto.isPrototypeOf(obj) */
static bool is_proto_of(JSContext *ctx, JSValueConst proto, JSValueConst obj)
{
	JSValue cur;
	int n = 0;

	if (!JS_IsObject(proto) || !JS_IsObject(obj)) {
		return false;
	}
	cur = JS_GetPrototype(ctx, obj);
	while (JS_IsObject(cur) && n++ < 1000) {
		JSValue next;

		if (JS_VALUE_GET_PTR(cur) == JS_VALUE_GET_PTR(proto)) {
			JS_FreeValue(ctx, cur);
			return true;
		}
		next = JS_GetPrototype(ctx, cur);
		JS_FreeValue(ctx, cur);
		cur = next;
	}
	if (JS_IsException(cur)) {
		JS_FreeValue(ctx, JS_GetException(ctx));
	}
	JS_FreeValue(ctx, cur);
	return false;
}

static bool same(JSValueConst a, JSValueConst b)
{
	return JS_IsObject(a) && JS_IsObject(b) &&
		JS_VALUE_GET_PTR(a) == JS_VALUE_GET_PTR(b);
}

static JSValue get_str(JSContext *ctx, JSValueConst o, const char *k)
{
	JSValue v = JS_GetPropertyStr(ctx, o, k);

	if (JS_IsException(v)) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		return JS_UNDEFINED;
	}
	return v;
}

/* names to indexes, open addressing over a power of two */
struct names {
	const char **key;
	int *idx;
	unsigned int cap;
};

static unsigned int name_hash(const char *s)
{
	unsigned int h = 2166136261u;

	while (*s != '\0') {
		h = (h ^ (unsigned char)*s++) * 16777619u;
	}
	return h;
}

static bool names_init(struct names *t, unsigned int n)
{
	t->cap = 64;
	while (t->cap < n * 2) {
		t->cap *= 2;
	}
	t->key = calloc(t->cap, sizeof(*t->key));
	t->idx = calloc(t->cap, sizeof(*t->idx));
	return t->key != NULL && t->idx != NULL;
}

static void names_free(struct names *t)
{
	free(t->key);
	free(t->idx);
}

static void names_put(struct names *t, const char *k, int i)
{
	unsigned int h = name_hash(k) & (t->cap - 1);

	while (t->key[h] != NULL) {
		if (strcmp(t->key[h], k) == 0) {
			return;		/* the first keeps it */
		}
		h = (h + 1) & (t->cap - 1);
	}
	t->key[h] = k;
	t->idx[h] = i;
}

static int names_get(const struct names *t, const char *k)
{
	unsigned int h = name_hash(k) & (t->cap - 1);

	while (t->key[h] != NULL) {
		if (strcmp(t->key[h], k) == 0) {
			return t->idx[h];
		}
		h = (h + 1) & (t->cap - 1);
	}
	return -1;
}

/* ------------------------------------------------------- interfaces.js */

/* one row of interfaces.js's TABLE: name|parent|kind|length|tag|consts */
struct row {
	char *name, *parent, *kind, *len, *tag, *consts;
	int up;			/* the parent's row, or -1 */
	int node;		/* by its ancestry: -1 not known yet */
};

/* split text into rows, in place */
static struct row *parse_rows(char *text, int *count)
{
	struct row *rows;
	int n = 1, i = 0;
	char *p;

	for (p = text; *p != '\0'; p++) {
		if (*p == '\n') {
			n++;
		}
	}
	rows = calloc((size_t)n, sizeof(*rows));
	if (rows == NULL) {
		return NULL;
	}
	p = text;
	while (p != NULL && *p != '\0' && i < n) {
		char *end = strchr(p, '\n'), *f[6];
		int k;

		if (end != NULL) {
			*end = '\0';
		}
		for (k = 0; k < 6; k++) {
			f[k] = p;
			if (p != NULL) {
				p = strchr(p, '|');
				if (p != NULL) {
					*p++ = '\0';
				}
			}
		}
		for (k = 0; k < 6; k++) {
			if (f[k] == NULL) {
				f[k] = (char *)"";
			}
		}
		rows[i].name = f[0];
		rows[i].parent = f[1];
		rows[i].kind = f[2];
		rows[i].len = f[3];
		rows[i].tag = f[4];
		rows[i].consts = f[5];
		rows[i].up = -1;
		rows[i].node = -1;
		i++;
		p = end != NULL ? end + 1 : NULL;
	}
	*count = i;
	return rows;
}

static int row_is_node(struct row *rows, int i, int depth)
{
	if (i < 0 || depth > 64) {
		return 0;
	}
	if (rows[i].node < 0) {
		rows[i].node = strcmp(rows[i].name, "Node") == 0 ? 1 :
			row_is_node(rows, rows[i].up, depth + 1);
	}
	return rows[i].node;
}

static int row_depth(const struct row *rows, int i)
{
	int d = 0;

	/* PARENT[n] is there for every row, Object included */
	while (i >= 0 && d < 64) {
		d++;
		i = rows[i].up;
	}
	return d;
}

/* one constructor under the names of an interface and one under it
 * (StyleSheet and CSSStyleSheet): the name the function itself has is
 * what it makes, so that one keeps the prototype, and failing that the
 * one furthest down */
struct owner {
	void *p;
	int row;
};

static int owner_of(const struct owner *o, int n, JSValueConst p)
{
	int i;

	for (i = 0; i < n; i++) {
		if (o[i].p == JS_VALUE_GET_PTR(p)) {
			return o[i].row;
		}
	}
	return -1;
}

static bool fn_name_is(JSContext *ctx, JSValueConst f, const char *name)
{
	JSValue v = get_str(ctx, f, "name");
	const char *s = JS_IsString(v) ? JS_ToCString(ctx, v) : NULL;
	bool r = s != NULL && strcmp(s, name) == 0;

	JS_FreeCString(ctx, s);
	JS_FreeValue(ctx, v);
	return r;
}

static bool skip_static(JSContext *ctx, JSAtom k);

/* the shapes' state: what lives in script across calls, and this
 * call's tables */
struct shape_state {
	JSContext *ctx;
	JSValue win, done, orig, claimed, nodep, mk, later, objproto;
	JSAtom a_length, a_name, a_prototype, a_constructor, a_tag;
	void **claim;		/* claimed prototypes */
	int nclaim, capclaim;
	struct row *rows;
	int nrows;
	struct owner *own;
	int nown;
};

static bool claimed(struct shape_state *s, JSValueConst p)
{
	int i;

	for (i = 0; i < s->nclaim; i++) {
		if (s->claim[i] == JS_VALUE_GET_PTR(p)) {
			return true;
		}
	}
	return false;
}

static void claim(struct shape_state *s, JSValueConst p)
{
	JSContext *ctx = s->ctx;
	uint32_t n = 0;
	JSValue len;

	if (!JS_IsObject(p)) {
		return;
	}
	if (s->nclaim == s->capclaim) {
		int cap = s->capclaim ? s->capclaim * 2 : 512;
		void **nw = realloc(s->claim, (size_t)cap * sizeof(*nw));

		if (nw == NULL) {
			return;
		}
		s->claim = nw;
		s->capclaim = cap;
	}
	s->claim[s->nclaim++] = JS_VALUE_GET_PTR(p);
	/* and in script's list, which holds it, for the next call */
	len = get_str(ctx, s->claimed, "length");
	if (JS_ToUint32(ctx, &n, len) < 0) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		n = 0;
	}
	JS_FreeValue(ctx, len);
	JS_SetPropertyUint32(ctx, s->claimed, n, JS_DupValue(ctx, p));
}

/* isNode(name, P) */
static bool is_node(struct shape_state *s, int row, JSValueConst p)
{
	if (JS_IsObject(p) && JS_IsObject(s->nodep) &&
	    (same(p, s->nodep) || is_proto_of(s->ctx, s->nodep, p))) {
		return true;
	}
	return row_is_node(s->rows, row, 0) != 0;
}

/* a global still waiting for its unit (lazy.js) is not read, which
 * would run the unit: it is shaped when the unit has run */
static bool waits(struct shape_state *s, const char *name)
{
	JSContext *ctx = s->ctx;
	JSAtom a = JS_NewAtom(ctx, name);
	bool lazy = JS_IsLazyProperty(ctx, s->win, a);

	if (lazy && JS_IsObject(s->later)) {
		JS_SetProperty(ctx, s->later, a, JS_TRUE);
	}
	JS_FreeAtom(ctx, a);
	return lazy;
}

static void shape_row(struct shape_state *s, int ri)
{
	JSContext *ctx = s->ctx;
	struct row *r = &s->rows[ri];
	const char *tag = strcmp(r->tag, "1") == 0 ? r->name :
		strcmp(r->tag, "0") == 0 ? "" : r->tag;
	int len = atoi(r->len);
	JSValue C, P, F, pF = JS_UNDEFINED, pFP = JS_UNDEFINED;
	JSAtom a_self = JS_NewAtom(ctx, r->name);

	if (r->parent[0] != '\0') {
		pF = get_str(ctx, s->done, r->parent);
	}
	C = JS_GetProperty(ctx, s->win, a_self);
	if (JS_IsException(C)) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		C = JS_UNDEFINED;
	}
	if (!JS_IsFunction(ctx, C)) {
		goto out;
	}
	P = get_str(ctx, C, "prototype");
	JS_SetPropertyStr(ctx, s->orig, r->name, JS_DupValue(ctx, C));
	if (is_node(s, ri, P)) {
		/* the interface object alone */
		F = JS_DupValue(ctx, C);
		define_value_conf(ctx, F, s->a_length, JS_NewInt32(ctx, len));
	} else {
		JSValue args[4];
		JSPropertyEnum *tab = NULL;
		uint32_t n = 0, i;
		int o;

		/* the prelude makes its own objects through the same names,
		 * and is let through what a page is refused: script makes
		 * the wrapper, which asks who calls it */
		args[0] = C;
		args[1] = JS_NewString(ctx, r->name);
		args[2] = JS_NewInt32(ctx, len);
		args[3] = JS_NewString(ctx, r->kind);
		F = JS_Call(ctx, s->mk, JS_UNDEFINED, 4, args);
		JS_FreeValue(ctx, args[1]);
		JS_FreeValue(ctx, args[3]);
		if (!JS_IsObject(F)) {
			if (JS_IsException(F)) {
				JS_FreeValue(ctx, JS_GetException(ctx));
			}
			JS_FreeValue(ctx, F);
			JS_FreeValue(ctx, P);
			goto out;
		}
		define_value_conf(ctx, F, s->a_name, JS_NewString(ctx, r->name));
		define_value_conf(ctx, F, s->a_length, JS_NewInt32(ctx, len));
		/* one prototype under two names: the second gets a
		 * prototype of its own, so each says its own constructor */
		o = JS_IsObject(P) ? owner_of(s->own, s->nown, P) : -1;
		if (!JS_IsObject(P) || JS_IsFunction(ctx, P) ||
		    claimed(s, P) ||
		    (o >= 0 && strcmp(s->rows[o].name, r->name) != 0)) {
			JSValue pP = JS_IsObject(pF) ?
				get_str(ctx, pF, "prototype") :
				JS_DupValue(ctx, s->objproto);

			JS_FreeValue(ctx, P);
			P = JS_NewObjectProto(ctx, pP);
			JS_FreeValue(ctx, pP);
			if (JS_IsException(P)) {
				JS_FreeValue(ctx, JS_GetException(ctx));
				JS_FreeValue(ctx, F);
				goto out;
			}
		}
		claim(s, P);
		define_value(ctx, F, s->a_prototype, JS_DupValue(ctx, P), 0);
		/* what the implementation carried: its statics */
		if (JS_GetOwnPropertyNames(ctx, &tab, &n, C,
					   JS_GPN_STRING_MASK |
					   JS_GPN_SYMBOL_MASK) < 0) {
			JS_FreeValue(ctx, JS_GetException(ctx));
			tab = NULL;
			n = 0;
		}
		for (i = 0; i < n; i++) {
			JSAtom k = tab[i].atom;
			JSPropertyDescriptor d;

			if (k == s->a_length || k == s->a_name ||
			    k == s->a_prototype || skip_static(ctx, k)) {
				continue;
			}
			if (get_own(ctx, &d, C, k) > 0) {
				define_desc(ctx, F, k, &d);
			}
		}
		if (tab != NULL) {
			JS_FreePropertyEnum(ctx, tab, n);
		}
		/* under its parent: where it inherited from nothing, or from
		 * an interface further up that its parent sits below */
		if (JS_IsObject(pF)) {
			pFP = get_str(ctx, pF, "prototype");
			if (!same(P, pFP)) {
				JSValue cur = JS_GetPrototype(ctx, P);

				if (!same(cur, pFP) &&
				    (same(cur, s->objproto) ||
				     (JS_IsObject(cur) &&
				      is_proto_of(ctx, cur, pFP)))) {
					swallow(ctx, JS_SetPrototype(ctx, P,
								     pFP));
				}
				JS_FreeValue(ctx, cur);
			}
		}
		define_value(ctx, P, s->a_constructor, JS_DupValue(ctx, F),
			     JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
		if (tag[0] != '\0' && s->a_tag != JS_ATOM_NULL &&
		    !has_own(ctx, P, s->a_tag)) {
			define_value(ctx, P, s->a_tag, JS_NewString(ctx, tag),
				     JS_PROP_CONFIGURABLE);
		}
	}
	if (JS_IsObject(pF)) {
		swallow(ctx, JS_SetPrototype(ctx, F, pF));
	}
	if (r->consts[0] != '\0') {
		JSValue FP = get_str(ctx, F, "prototype");
		bool fp_node = is_node(s, ri, FP);
		char *c = r->consts;

		while (c != NULL && *c != '\0') {
			char *comma = strchr(c, ','), *eq = strchr(c, '=');
			char key[128];

			if (eq != NULL && (comma == NULL || eq < comma) &&
			    (size_t)(eq - c) < sizeof(key)) {
				double v = strtod(eq + 1, NULL);
				JSAtom ak;

				memcpy(key, c, (size_t)(eq - c));
				key[eq - c] = '\0';
				ak = JS_NewAtom(ctx, key);
				define_value(ctx, F, ak, JS_NewFloat64(ctx, v),
					     JS_PROP_ENUMERABLE);
				if (!fp_node) {
					define_value(ctx, FP, ak,
						     JS_NewFloat64(ctx, v),
						     JS_PROP_ENUMERABLE);
				}
				JS_FreeAtom(ctx, ak);
			}
			c = comma != NULL ? comma + 1 : NULL;
		}
		JS_FreeValue(ctx, FP);
	}
	define_value(ctx, s->win, a_self, JS_DupValue(ctx, F),
		     JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_SetPropertyStr(ctx, s->done, r->name, F);
	JS_FreeValue(ctx, P);
out:
	JS_FreeValue(ctx, pFP);
	JS_FreeValue(ctx, C);
	JS_FreeValue(ctx, pF);
	JS_FreeAtom(ctx, a_self);
}

/* an own key of an implementation that its interface object does not
 * take: caller and arguments, as strings */
static bool skip_static(JSContext *ctx, JSAtom k)
{
	JSValue v = JS_AtomToValue(ctx, k);
	const char *s;
	bool r = false;

	if (JS_IsString(v)) {
		s = JS_ToCString(ctx, v);
		r = s != NULL && (strcmp(s, "caller") == 0 ||
				  strcmp(s, "arguments") == 0);
		JS_FreeCString(ctx, s);
	}
	JS_FreeValue(ctx, v);
	return r;
}

/*
 * __vitaShapeInterfaces(table, state, later): give the interfaces of
 * interfaces.js's TABLE their shapes, or with later true only those
 * state.later names whose units have run since. state carries win,
 * done, orig, claimed (an array of the prototypes taken), nodeP, mk
 * (which makes a constructor's wrapper) and later.
 */
static JSValue win_shape_interfaces(JSContext *ctx, JSValueConst this_val,
				    int argc, JSValueConst *argv)
{
	struct shape_state s;
	struct names byname;
	const char *text;
	char *buf;
	size_t tlen;
	bool only_later;
	int i;
	uint32_t n = 0;
	JSValue v, obj;

	(void)this_val;
	if (argc < 2 || !JS_IsObject(argv[1])) {
		return JS_FALSE;
	}
	only_later = argc > 2 && JS_ToBool(ctx, argv[2]) > 0;
	text = JS_ToCStringLen(ctx, &tlen, argv[0]);
	if (text == NULL) {
		return JS_EXCEPTION;
	}
	buf = malloc(tlen + 1);
	if (buf == NULL) {
		JS_FreeCString(ctx, text);
		return JS_ThrowOutOfMemory(ctx);
	}
	memcpy(buf, text, tlen + 1);
	JS_FreeCString(ctx, text);

	memset(&s, 0, sizeof(s));
	s.ctx = ctx;
	s.rows = parse_rows(buf, &s.nrows);
	if (s.rows == NULL || !names_init(&byname, (unsigned int)s.nrows)) {
		free(s.rows);
		free(buf);
		return JS_ThrowOutOfMemory(ctx);
	}
	for (i = 0; i < s.nrows; i++) {
		names_put(&byname, s.rows[i].name, i);
	}
	for (i = 0; i < s.nrows; i++) {
		s.rows[i].up = names_get(&byname, s.rows[i].parent);
	}
	s.win = get_str(ctx, argv[1], "win");
	s.done = get_str(ctx, argv[1], "done");
	s.orig = get_str(ctx, argv[1], "orig");
	s.claimed = get_str(ctx, argv[1], "claimed");
	s.nodep = get_str(ctx, argv[1], "nodeP");
	s.mk = get_str(ctx, argv[1], "mk");
	s.later = get_str(ctx, argv[1], "later");
	obj = JS_NewObject(ctx);
	s.objproto = JS_GetPrototype(ctx, obj);
	JS_FreeValue(ctx, obj);
	s.a_length = JS_NewAtom(ctx, "length");
	s.a_name = JS_NewAtom(ctx, "name");
	s.a_prototype = JS_NewAtom(ctx, "prototype");
	s.a_constructor = JS_NewAtom(ctx, "constructor");
	{
		JSValue g = JS_GetGlobalObject(ctx);
		JSValue sym = get_str(ctx, g, "Symbol");
		JSValue t = JS_IsObject(sym) ?
			get_str(ctx, sym, "toStringTag") : JS_UNDEFINED;

		s.a_tag = JS_IsSymbol(t) ? JS_ValueToAtom(ctx, t) :
			JS_ATOM_NULL;
		JS_FreeValue(ctx, t);
		JS_FreeValue(ctx, sym);
		JS_FreeValue(ctx, g);
	}
	if (!JS_IsObject(s.win) || !JS_IsObject(s.done) ||
	    !JS_IsObject(s.orig) || !JS_IsObject(s.claimed) ||
	    !JS_IsFunction(ctx, s.mk)) {
		goto out;
	}
	/* the prototypes taken before, by the language or an earlier call */
	v = get_str(ctx, s.claimed, "length");
	if (JS_ToUint32(ctx, &n, v) < 0) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		n = 0;
	}
	JS_FreeValue(ctx, v);
	s.claim = malloc((size_t)(n + 512) * sizeof(*s.claim));
	s.capclaim = s.claim != NULL ? (int)n + 512 : 0;
	for (i = 0; s.claim != NULL && i < (int)n; i++) {
		v = JS_GetPropertyUint32(ctx, s.claimed, (uint32_t)i);
		if (JS_IsObject(v)) {
			s.claim[s.nclaim++] = JS_VALUE_GET_PTR(v);
		}
		JS_FreeValue(ctx, v);
	}
	/* which rows this call shapes */
	{
		bool *take = calloc((size_t)s.nrows, sizeof(*take));

		s.own = calloc((size_t)s.nrows, sizeof(*s.own));
		if (take == NULL || s.own == NULL) {
			free(take);
			goto out;
		}
		for (i = 0; i < s.nrows; i++) {
			if (only_later) {
				JSAtom a = JS_NewAtom(ctx, s.rows[i].name);
				bool has = JS_IsObject(s.later) &&
					has_own(ctx, s.later, a);

				if (has &&
				    !JS_IsLazyProperty(ctx, s.win, a)) {
					take[i] = true;
					JS_DeleteProperty(ctx, s.later, a, 0);
				}
				JS_FreeAtom(ctx, a);
			} else {
				take[i] = !waits(&s, s.rows[i].name);
			}
		}
		/* the owners of the prototypes */
		for (i = 0; i < s.nrows; i++) {
			JSValue C, P;
			int o;

			if (!take[i]) {
				continue;
			}
			C = get_str(ctx, s.win, s.rows[i].name);
			P = JS_IsFunction(ctx, C) ?
				get_str(ctx, C, "prototype") : JS_UNDEFINED;
			if (JS_IsObject(P) && !JS_IsFunction(ctx, P)) {
				o = owner_of(s.own, s.nown, P);
				if (o < 0) {
					s.own[s.nown].p = JS_VALUE_GET_PTR(P);
					s.own[s.nown++].row = i;
				} else if (strcmp(s.rows[o].name,
						  s.rows[i].name) != 0 &&
					   !fn_name_is(ctx, C, s.rows[o].name) &&
					   (fn_name_is(ctx, C, s.rows[i].name) ||
					    row_depth(s.rows, i) >
					    row_depth(s.rows, o))) {
					int k;

					for (k = 0; k < s.nown; k++) {
						if (s.own[k].p ==
						    JS_VALUE_GET_PTR(P)) {
							s.own[k].row = i;
						}
					}
				}
			}
			JS_FreeValue(ctx, P);
			JS_FreeValue(ctx, C);
		}
		for (i = 0; i < s.nrows; i++) {
			if (take[i]) {
				shape_row(&s, i);
			}
		}
		free(take);
	}
out:
	JS_FreeAtom(ctx, s.a_length);
	JS_FreeAtom(ctx, s.a_name);
	JS_FreeAtom(ctx, s.a_prototype);
	JS_FreeAtom(ctx, s.a_constructor);
	if (s.a_tag != JS_ATOM_NULL) {
		JS_FreeAtom(ctx, s.a_tag);
	}
	JS_FreeValue(ctx, s.objproto);
	JS_FreeValue(ctx, s.win);
	JS_FreeValue(ctx, s.done);
	JS_FreeValue(ctx, s.orig);
	JS_FreeValue(ctx, s.claimed);
	JS_FreeValue(ctx, s.nodep);
	JS_FreeValue(ctx, s.mk);
	JS_FreeValue(ctx, s.later);
	free(s.own);
	free(s.claim);
	names_free(&byname);
	free(s.rows);
	free(buf);
	return JS_TRUE;
}

/* ------------------------------------------------------------ nodes.js */

/* PLACE: each member's interfaces, as indexes into nodes.js's ROWS */
struct place {
	struct names byname;	/* member to its entry */
	int *at;		/* each entry's indexes, -1 after the last */
	int *start;
	char *keys;
	int n;
};

static void place_free(struct place *pl)
{
	names_free(&pl->byname);
	free(pl->at);
	free(pl->start);
	free(pl->keys);
}

/* {"name":[1,2],...}, with names that need no escapes */
static bool place_parse(struct place *pl, const char *t, size_t len)
{
	size_t i, nq = 0, nat = 0, nkeys = 0;
	char *kp;
	int *ap, e = 0;

	memset(pl, 0, sizeof(*pl));
	for (i = 0; i < len; i++) {
		if (t[i] == '"') {
			nq++;
		} else if (t[i] == ',' || t[i] == '[') {
			nat++;
		}
	}
	nkeys = nq / 2;
	pl->keys = malloc(len + 1);
	pl->at = malloc((nat + nkeys + 1) * sizeof(*pl->at));
	pl->start = malloc((nkeys + 1) * sizeof(*pl->start));
	if (pl->keys == NULL || pl->at == NULL || pl->start == NULL ||
	    !names_init(&pl->byname, (unsigned int)nkeys + 1)) {
		place_free(pl);
		return false;
	}
	kp = pl->keys;
	ap = pl->at;
	i = 0;
	while (i < len && (size_t)e < nkeys) {
		const char *k;

		while (i < len && t[i] != '"') {
			i++;
		}
		if (++i >= len) {
			break;
		}
		k = kp;
		while (i < len && t[i] != '"') {
			*kp++ = t[i++];
		}
		*kp++ = '\0';
		i++;
		while (i < len && t[i] != '[') {
			i++;
		}
		pl->start[e] = (int)(ap - pl->at);
		while (i < len && t[i] != ']') {
			i++;
			while (i < len && (t[i] == ' ' || t[i] == '\n')) {
				i++;
			}
			if (i < len && t[i] >= '0' && t[i] <= '9') {
				int v = 0;

				while (i < len && t[i] >= '0' && t[i] <= '9') {
					v = v * 10 + (t[i++] - '0');
				}
				*ap++ = v;
			}
			while (i < len && t[i] != ',' && t[i] != ']') {
				i++;
			}
		}
		*ap++ = -1;
		names_put(&pl->byname, k, e);
		e++;
	}
	pl->n = e;
	return true;
}

/* a member's indexes, or NULL when it is not in PLACE */
static const int *place_at(const struct place *pl, JSContext *ctx, JSAtom k)
{
	const char *s = JS_AtomToCString(ctx, k);
	int e;

	if (s == NULL) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		return NULL;
	}
	e = names_get(&pl->byname, s);
	JS_FreeCString(ctx, s);
	return e < 0 ? NULL : pl->at + pl->start[e];
}

static bool at_has(const int *at, int i)
{
	for (; at != NULL && *at >= 0; at++) {
		if (*at == i) {
			return true;
		}
	}
	return false;
}

/* the string keys of o, constructor aside */
static JSPropertyEnum *string_keys(JSContext *ctx, JSValueConst o,
				   uint32_t *n)
{
	JSPropertyEnum *tab = NULL;

	if (JS_GetOwnPropertyNames(ctx, &tab, n, o, JS_GPN_STRING_MASK) < 0) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		*n = 0;
		return NULL;
	}
	return tab;
}

static void dup_desc(JSContext *ctx, JSPropertyDescriptor *to,
		     const JSPropertyDescriptor *d)
{
	to->flags = d->flags;
	to->value = JS_DupValue(ctx, d->value);
	to->getter = JS_DupValue(ctx, d->getter);
	to->setter = JS_DupValue(ctx, d->setter);
}

/*
 * __vitaPlaceMembers(P, DOCP, place, protos, html, doc, levels): each of
 * the member of P where Chrome has it, as nodes.js did in script. An
 * interface's own goes to it and one of a mixin to each interface that
 * includes it (protos[i] for PLACE's index i), and WebIDL's attributes
 * and operations are enumerable; what is HTMLElement's (html) stays on P
 * and what is not leaves it; a document other than the window's (DOCP)
 * gets what is a document's (doc) or this browser's own. levels are
 * [object, index] for Element, Node and EventTarget, which held copies:
 * what is not theirs in Chrome goes, and what is is enumerable.
 */
static JSValue win_place_members(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	JSValueConst P, DOCP, protos_v, levels;
	JSValue *protos = NULL;
	struct place pl;
	const char *text;
	size_t tlen;
	int32_t html = -1, doc = -1;
	uint32_t nprotos = 0, n = 0, i, l;
	JSPropertyEnum *tab;
	JSAtom a_ctor;
	JSValue v;

	(void)this_val;
	if (argc < 7 || !JS_IsObject(argv[0]) || !JS_IsObject(argv[1]) ||
	    !JS_IsObject(argv[3]) || !JS_IsObject(argv[6])) {
		return JS_FALSE;
	}
	P = argv[0];
	DOCP = argv[1];
	protos_v = argv[3];
	levels = argv[6];
	if (JS_ToInt32(ctx, &html, argv[4]) < 0 ||
	    JS_ToInt32(ctx, &doc, argv[5]) < 0) {
		return JS_EXCEPTION;
	}
	text = JS_ToCStringLen(ctx, &tlen, argv[2]);
	if (text == NULL) {
		return JS_EXCEPTION;
	}
	if (!place_parse(&pl, text, tlen)) {
		JS_FreeCString(ctx, text);
		return JS_ThrowOutOfMemory(ctx);
	}
	JS_FreeCString(ctx, text);
	v = get_str(ctx, protos_v, "length");
	if (JS_ToUint32(ctx, &nprotos, v) < 0) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		nprotos = 0;
	}
	JS_FreeValue(ctx, v);
	protos = calloc((size_t)nprotos + 1, sizeof(*protos));
	if (protos == NULL) {
		place_free(&pl);
		return JS_ThrowOutOfMemory(ctx);
	}
	for (i = 0; i < nprotos; i++) {
		protos[i] = JS_GetPropertyUint32(ctx, protos_v, i);
		if (JS_IsException(protos[i])) {
			JS_FreeValue(ctx, JS_GetException(ctx));
			protos[i] = JS_UNDEFINED;
		}
	}
	a_ctor = JS_NewAtom(ctx, "constructor");

	/* each member where Chrome has it */
	tab = string_keys(ctx, P, &n);
	for (i = 0; i < n; i++) {
		JSAtom k = tab[i].atom;
		const int *at, *a;
		JSPropertyDescriptor d, t;
		bool stay = false;

		if (k == a_ctor || get_own(ctx, &d, P, k) <= 0) {
			continue;
		}
		at = place_at(&pl, ctx, k);
		if (at == NULL || at_has(at, doc)) {
			dup_desc(ctx, &t, &d);
			define_desc(ctx, DOCP, k, &t);
		}
		if (at == NULL) {
			JS_FreeValue(ctx, d.value);
			JS_FreeValue(ctx, d.getter);
			JS_FreeValue(ctx, d.setter);
			continue;
		}
		/* WebIDL's attributes and operations are enumerable */
		if (d.flags & JS_PROP_CONFIGURABLE) {
			d.flags |= JS_PROP_ENUMERABLE;
		}
		for (a = at; *a >= 0; a++) {
			if (*a == html) {
				stay = true;
				continue;
			}
			if ((uint32_t)*a < nprotos && JS_IsObject(protos[*a])) {
				dup_desc(ctx, &t, &d);
				define_desc(ctx, protos[*a], k, &t);
			}
		}
		if (!stay) {
			swallow(ctx, JS_DeleteProperty(ctx, P, k, 0));
		} else if (d.flags & JS_PROP_CONFIGURABLE) {
			dup_desc(ctx, &t, &d);
			define_desc(ctx, P, k, &t);
		}
		JS_FreeValue(ctx, d.value);
		JS_FreeValue(ctx, d.getter);
		JS_FreeValue(ctx, d.setter);
	}
	if (tab != NULL) {
		JS_FreePropertyEnum(ctx, tab, n);
	}

	/* the levels above: what is not theirs goes, and what is is
	 * enumerable */
	for (l = 0; l < 3; l++) {
		JSValue lv = JS_GetPropertyUint32(ctx, levels, l), o;
		int32_t li = -1;

		o = JS_IsObject(lv) ? JS_GetPropertyUint32(ctx, lv, 0) :
			JS_UNDEFINED;
		v = JS_IsObject(lv) ? JS_GetPropertyUint32(ctx, lv, 1) :
			JS_UNDEFINED;
		if (JS_ToInt32(ctx, &li, v) < 0) {
			JS_FreeValue(ctx, JS_GetException(ctx));
		}
		JS_FreeValue(ctx, v);
		JS_FreeValue(ctx, lv);
		if (!JS_IsObject(o)) {
			JS_FreeValue(ctx, o);
			continue;
		}
		tab = string_keys(ctx, o, &n);
		for (i = 0; i < n; i++) {
			JSAtom k = tab[i].atom;
			const int *at;
			JSPropertyDescriptor d;

			if (k == a_ctor) {
				continue;
			}
			at = place_at(&pl, ctx, k);
			if (at == NULL) {
				continue;
			}
			if (!at_has(at, li)) {
				swallow(ctx, JS_DeleteProperty(ctx, o, k, 0));
				continue;
			}
			if (get_own(ctx, &d, o, k) <= 0) {
				continue;
			}
			if ((d.flags & JS_PROP_CONFIGURABLE) &&
			    !(d.flags & JS_PROP_ENUMERABLE)) {
				d.flags |= JS_PROP_ENUMERABLE;
				define_desc(ctx, o, k, &d);
			} else {
				JS_FreeValue(ctx, d.value);
				JS_FreeValue(ctx, d.getter);
				JS_FreeValue(ctx, d.setter);
			}
		}
		if (tab != NULL) {
			JS_FreePropertyEnum(ctx, tab, n);
		}
		JS_FreeValue(ctx, o);
	}
	JS_FreeAtom(ctx, a_ctor);
	for (i = 0; i < nprotos; i++) {
		JS_FreeValue(ctx, protos[i]);
	}
	free(protos);
	place_free(&pl);
	return JS_TRUE;
}

/* --------------------------------------------------------- accessors */

/*
 * Accessors that hand their property's name to one function of script's
 * (VitaSurf). The prelude made a getter and a setter closure for each of
 * several hundred properties -- the CSS properties' camel-cased names,
 * the event handler properties, the setters that let a page assign to a
 * read-only member -- and defined them one at a time: a fifth of the
 * prelude's time. These are made in C, each a function that calls the
 * shared one with the name it was made for (data[1]) before anything
 * it was given.
 */
static JSValue fwd_get(JSContext *ctx, JSValueConst this_val, int argc,
		       JSValueConst *argv, int magic, JSValueConst *data)
{
	(void)argc; (void)argv; (void)magic;
	return JS_Call(ctx, data[0], this_val, 1, &data[1]);
}

static JSValue fwd_set(JSContext *ctx, JSValueConst this_val, int argc,
		       JSValueConst *argv, int magic, JSValueConst *data)
{
	JSValueConst args[2];
	JSValue r;

	(void)magic;
	args[0] = data[1];
	args[1] = argc > 0 ? argv[0] : JS_UNDEFINED;
	r = JS_Call(ctx, data[0], this_val, 2, args);
	if (JS_IsException(r)) {
		return r;
	}
	JS_FreeValue(ctx, r);
	return JS_UNDEFINED;
}

/* a forwarding accessor's function, named as script's were */
static JSValue fwd_fn(JSContext *ctx, bool set, JSValueConst fn,
		      JSValueConst arg)
{
	JSValueConst data[2];

	data[0] = fn;
	data[1] = arg;
	return JS_NewCFunctionData2(ctx, set ? fwd_set : fwd_get,
				    set ? "set" : "get", set ? 1 : 0, 0, 2,
				    data);
}

/*
 * __vitaAccessors(obj, keys, args, get, set, flags): for each keys[i],
 * an accessor on obj whose getter is get.call(this, arg) and whose
 * setter is set.call(this, arg, value), arg being args[i] (or the key
 * when args is not an array); either may be absent. flags are QuickJS's
 * (configurable 1, enumerable 4), for all of them or, an array, for each.
 */
static JSValue win_accessors(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv)
{
	JSValueConst obj, keys, args, get, set;
	int32_t flags = 0;
	uint32_t n = 0, i;
	bool has_args, has_get, has_set, each_flags;
	JSValue v;

	(void)this_val;
	if (argc < 6 || !JS_IsObject(argv[0]) || !JS_IsObject(argv[1])) {
		return JS_FALSE;
	}
	obj = argv[0];
	keys = argv[1];
	args = argv[2];
	get = argv[3];
	set = argv[4];
	each_flags = JS_IsObject(argv[5]);
	if (!each_flags && JS_ToInt32(ctx, &flags, argv[5]) < 0) {
		return JS_EXCEPTION;
	}
	has_args = JS_IsObject(args);
	has_get = JS_IsFunction(ctx, get);
	has_set = JS_IsFunction(ctx, set);
	v = get_str(ctx, keys, "length");
	if (JS_ToUint32(ctx, &n, v) < 0) {
		JS_FreeValue(ctx, v);
		return JS_EXCEPTION;
	}
	JS_FreeValue(ctx, v);
	for (i = 0; i < n; i++) {
		JSValue key = JS_GetPropertyUint32(ctx, keys, i);
		JSValue arg = has_args ? JS_GetPropertyUint32(ctx, args, i) :
			JS_DupValue(ctx, key);
		JSValue g = JS_UNDEFINED, s = JS_UNDEFINED;
		JSAtom a = JS_ValueToAtom(ctx, key);
		int r = -1;

		if (each_flags) {
			JSValue f = JS_GetPropertyUint32(ctx, argv[5], i);

			if (JS_ToInt32(ctx, &flags, f) < 0) {
				JS_FreeValue(ctx, JS_GetException(ctx));
				flags = 0;
			}
			JS_FreeValue(ctx, f);
		}
		if (a != JS_ATOM_NULL && !JS_IsException(arg)) {
			if (has_get) {
				g = fwd_fn(ctx, false, get, arg);
			}
			if (has_set) {
				s = fwd_fn(ctx, true, set, arg);
			}
			if (!JS_IsException(g) && !JS_IsException(s)) {
				r = JS_DefineProperty(ctx, obj, a, JS_UNDEFINED,
						      g, s, JS_PROP_HAS_GET |
						      JS_PROP_HAS_SET |
						      JS_PROP_HAS_CONFIGURABLE |
						      JS_PROP_HAS_ENUMERABLE |
						      (flags & (JS_PROP_CONFIGURABLE |
								JS_PROP_ENUMERABLE)));
			}
		}
		if (a != JS_ATOM_NULL) {
			JS_FreeAtom(ctx, a);
		}
		JS_FreeValue(ctx, g);
		JS_FreeValue(ctx, s);
		JS_FreeValue(ctx, arg);
		JS_FreeValue(ctx, key);
		if (r < 0) {
			return JS_EXCEPTION;
		}
	}
	return JS_TRUE;
}

/*
 * __vitaAddSetters(obj, skip, set): each own accessor of obj with a
 * getter, no setter and configurable, whose name is not in skip (" a b "),
 * gets the setter set.call(this, name, value), keeping the rest.
 */
static JSValue win_add_setters(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	JSPropertyEnum *tab;
	const char *skip;
	uint32_t n = 0, i;

	(void)this_val;
	if (argc < 3 || !JS_IsObject(argv[0]) ||
	    !JS_IsFunction(ctx, argv[2])) {
		return JS_FALSE;
	}
	skip = JS_ToCString(ctx, argv[1]);
	if (skip == NULL) {
		return JS_EXCEPTION;
	}
	tab = string_keys(ctx, argv[0], &n);
	for (i = 0; i < n; i++) {
		JSAtom k = tab[i].atom;
		JSPropertyDescriptor d;
		const char *name;
		bool skipped = false;

		if (get_own(ctx, &d, argv[0], k) <= 0) {
			continue;
		}
		if (!(d.flags & JS_PROP_GETSET) || !JS_IsFunction(ctx, d.getter) ||
		    !JS_IsUndefined(d.setter) ||
		    !(d.flags & JS_PROP_CONFIGURABLE)) {
			JS_FreeValue(ctx, d.value);
			JS_FreeValue(ctx, d.getter);
			JS_FreeValue(ctx, d.setter);
			continue;
		}
		name = JS_AtomToCString(ctx, k);
		if (name != NULL) {
			size_t len = strlen(name);
			const char *p = skip;

			while ((p = strstr(p, name)) != NULL) {
				if (p > skip && p[-1] == ' ' && p[len] == ' ') {
					skipped = true;
					break;
				}
				p++;
			}
		}
		if (name != NULL && !skipped) {
			JSValue key = JS_AtomToValue(ctx, k);

			JS_FreeValue(ctx, d.setter);
			d.setter = fwd_fn(ctx, true, argv[2], key);
			JS_FreeValue(ctx, key);
			if (JS_IsException(d.setter)) {
				d.setter = JS_UNDEFINED;
				JS_FreeValue(ctx, JS_GetException(ctx));
			}
			define_desc(ctx, argv[0], k, &d);
		} else {
			JS_FreeValue(ctx, d.value);
			JS_FreeValue(ctx, d.getter);
			JS_FreeValue(ctx, d.setter);
		}
		JS_FreeCString(ctx, name);
	}
	if (tab != NULL) {
		JS_FreePropertyEnum(ctx, tab, n);
	}
	JS_FreeCString(ctx, skip);
	return JS_TRUE;
}

/*
 * __vitaCopyProps(target, source): each of source's own properties,
 * strings and symbols, onto target with its attributes, but for a
 * function's own length, name, prototype, caller and arguments. The
 * prelude's node interfaces each took a score of them through
 * Object.defineProperties, which reads a descriptor object for each.
 */
static JSValue win_copy_props(JSContext *ctx, JSValueConst this_val,
			      int argc, JSValueConst *argv)
{
	JSPropertyEnum *tab = NULL;
	uint32_t n = 0, i;
	JSAtom skip[5];
	static const char *const skip_names[5] = {
		"length", "name", "prototype", "caller", "arguments"
	};
	int k;

	(void)this_val;
	if (argc < 2 || !JS_IsObject(argv[0]) || !JS_IsObject(argv[1])) {
		return JS_FALSE;
	}
	if (JS_GetOwnPropertyNames(ctx, &tab, &n, argv[1],
				   JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0) {
		return JS_EXCEPTION;
	}
	for (k = 0; k < 5; k++) {
		skip[k] = JS_NewAtom(ctx, skip_names[k]);
	}
	for (i = 0; i < n; i++) {
		JSPropertyDescriptor d;
		bool skipped = false;

		for (k = 0; k < 5; k++) {
			if (tab[i].atom == skip[k]) {
				skipped = true;
			}
		}
		if (!skipped && get_own(ctx, &d, argv[1], tab[i].atom) > 0) {
			define_desc(ctx, argv[0], tab[i].atom, &d);
		}
	}
	for (k = 0; k < 5; k++) {
		JS_FreeAtom(ctx, skip[k]);
	}
	JS_FreePropertyEnum(ctx, tab, n);
	return JS_TRUE;
}

void ifaces_register(JSContext *ctx, JSValueConst obj)
{
	JS_SetPropertyStr(ctx, obj, "__vitaShapeInterfaces",
			  JS_NewCFunction(ctx, win_shape_interfaces,
					  "__vitaShapeInterfaces", 3));
	JS_SetPropertyStr(ctx, obj, "__vitaPlaceMembers",
			  JS_NewCFunction(ctx, win_place_members,
					  "__vitaPlaceMembers", 7));
	JS_SetPropertyStr(ctx, obj, "__vitaAccessors",
			  JS_NewCFunction(ctx, win_accessors,
					  "__vitaAccessors", 6));
	JS_SetPropertyStr(ctx, obj, "__vitaAddSetters",
			  JS_NewCFunction(ctx, win_add_setters,
					  "__vitaAddSetters", 3));
	JS_SetPropertyStr(ctx, obj, "__vitaCopyProps",
			  JS_NewCFunction(ctx, win_copy_props,
					  "__vitaCopyProps", 2));
}
