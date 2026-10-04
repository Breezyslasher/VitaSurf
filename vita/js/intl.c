/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * The reader of the locale data Intl is built on (VitaSurf).
 *
 * The engine has no Intl, and a page that finds the prelude's stand-in
 * wanting loads a polyfill: Home Assistant loads FormatJS's, with every
 * time zone in the world as JSON, and spent eight seconds of a cold load
 * on a Vita unpacking it. Intl is instead written in JavaScript from ICU's
 * own data (vita/js/intl*.js), which is resources/intl.pak; this hands
 * them its entries as JSON text, as __vitaIntl.pak(name) and
 * __vitaIntl.has(name).
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zlib.h>

#include "intl.h"
#include "vita_platform.h"

/*
 * resources/intl.pak, from scripts/gen-intl-numbers.mjs: "VSIP", a count,
 * then for each entry its name and where its zlib stream lies, then the
 * streams. The index is read the first time an entry is asked for and
 * kept; an entry is read and inflated each time it is asked for, which
 * the modules do once per locale and kind of data, and keep.
 */
struct pak_entry {
	uint32_t name;			/* offset into pak_names */
	uint32_t off, zlen, len;
};

static struct pak_entry *pak;
static char *pak_names;
static unsigned int pak_count;
static int pak_tried;

static uint32_t le32(const unsigned char *b)
{
	return (uint32_t) b[0] | (uint32_t) b[1] << 8 |
		(uint32_t) b[2] << 16 | (uint32_t) b[3] << 24;
}

static void pak_open(void)
{
	unsigned char head[8], rec[12];
	FILE *f;
	unsigned int i, used = 0, room = 0;
	int ok = 0;

	pak_tried = 1;
	f = fopen(VITASURF_INTL_PAK, "rb");
	if (f == NULL) {
		vita_log("intl: no %s", VITASURF_INTL_PAK);
		return;
	}
	if (fread(head, 1, 8, f) != 8 || memcmp(head, "VSIP", 4) != 0)
		goto out;
	pak_count = le32(head + 4);
	if (pak_count == 0 || pak_count > 65536)
		goto out;
	pak = calloc(pak_count, sizeof(*pak));
	room = pak_count * 16;
	pak_names = malloc(room);
	if (pak == NULL || pak_names == NULL)
		goto out;
	for (i = 0; i < pak_count; i++) {
		int n = fgetc(f);

		if (n == EOF || used + (unsigned int) n + 1 > room)
			goto out;
		if (fread(pak_names + used, 1, (size_t) n, f) != (size_t) n ||
		    fread(rec, 1, 12, f) != 12)
			goto out;
		pak_names[used + (unsigned int) n] = '\0';
		pak[i].off = le32(rec);
		pak[i].zlen = le32(rec + 4);
		pak[i].len = le32(rec + 8);
		pak[i].name = used;
		used += (unsigned int) n + 1;
	}
	ok = 1;
out:
	fclose(f);
	if (!ok) {
		vita_log("intl: %s is damaged", VITASURF_INTL_PAK);
		free(pak);
		free(pak_names);
		pak = NULL;
		pak_names = NULL;
		pak_count = 0;
	}
}

static const struct pak_entry *pak_find(const char *name)
{
	unsigned int lo = 0, hi, mid;

	if (!pak_tried)
		pak_open();
	hi = pak_count;
	while (lo < hi) {
		int c;

		mid = (lo + hi) / 2;
		c = strcmp(name, pak_names + pak[mid].name);
		if (c == 0)
			return &pak[mid];
		if (c < 0)
			hi = mid;
		else
			lo = mid + 1;
	}
	return NULL;
}

/* has(name): whether the pack has the entry */
static JSValue js_pak_has(JSContext *ctx, JSValueConst this_val, int argc,
			  JSValueConst *argv)
{
	const char *name = JS_ToCString(ctx, argv[0]);
	int found;

	if (name == NULL)
		return JS_EXCEPTION;
	found = pak_find(name) != NULL;
	JS_FreeCString(ctx, name);
	return JS_NewBool(ctx, found);
}

/* pak(name): the entry's JSON text, or undefined */
static JSValue js_pak(JSContext *ctx, JSValueConst this_val, int argc,
		      JSValueConst *argv)
{
	const char *name = JS_ToCString(ctx, argv[0]);
	const struct pak_entry *e;
	unsigned char *z = NULL;
	char *raw = NULL;
	uLongf len;
	JSValue r = JS_UNDEFINED;
	FILE *f = NULL;

	if (name == NULL)
		return JS_EXCEPTION;
	e = pak_find(name);
	JS_FreeCString(ctx, name);
	if (e == NULL)
		return JS_UNDEFINED;
	z = malloc(e->zlen);
	raw = malloc(e->len + 1);
	f = fopen(VITASURF_INTL_PAK, "rb");
	len = e->len;
	if (z != NULL && raw != NULL && f != NULL &&
	    fseek(f, (long) e->off, SEEK_SET) == 0 &&
	    fread(z, 1, e->zlen, f) == e->zlen &&
	    uncompress((Bytef *) raw, &len, z, e->zlen) == Z_OK &&
	    len == e->len)
		r = JS_NewStringLen(ctx, raw, len);
	else
		vita_log("intl: could not read %s from %s",
			 pak_names + e->name, VITASURF_INTL_PAK);
	if (f != NULL)
		fclose(f);
	free(z);
	free(raw);
	return r;
}

static const JSCFunctionListEntry intl_funcs[] = {
	JS_CFUNC_DEF("pak", 1, js_pak),
	JS_CFUNC_DEF("has", 1, js_pak_has),
};

void vita_intl_register(JSContext *ctx, JSValueConst global)
{
	JSValue obj = JS_NewObject(ctx);

	JS_SetPropertyFunctionList(ctx, obj, intl_funcs,
				   sizeof(intl_funcs) / sizeof(intl_funcs[0]));
	JS_SetPropertyStr(ctx, global, "__vitaIntl", obj);
}
