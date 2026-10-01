/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * The native half of Intl.DateTimeFormat (VitaSurf), and the reader of
 * the locale data Intl.NumberFormat formats with.
 *
 * The engine has no Intl, and a page that finds the prelude's stand-in
 * wanting loads a polyfill: Home Assistant loads FormatJS's, with every
 * time zone in the world as JSON, and spent eight seconds of a cold load
 * on a Vita unpacking it. Here the time zones are a table compiled from
 * the IANA database (intl_tz.h, scripts/gen-tzdata.py), the English
 * locales' names and patterns come from ICU (intl_locale.h,
 * scripts/gen-intl-data.mjs), and the formatting is done in C.
 * vita/js/intl.js builds the API on this, and vita/js/intl_pattern.js
 * picks the pattern a set of options asks for.
 *
 * A time zone is passed around as a number: the index of its entry in
 * the table, or an offset from UTC in minutes plus TZ_OFFSET for one
 * written "+05:30".
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include <zlib.h>

#include "intl.h"
#include "vita_platform.h"

#include "intl_tz.h"

struct intl_tzname {
	const char *zone;
	/* short standard, short daylight, long standard, long daylight,
	 * short generic, long generic; NULL where the name is the GMT
	 * offset */
	const char *n[6];
};

struct intl_locale {
	const char *tag;
	const char *json;		/* the patterns, for intl_pattern.js */
	const char *month[2][3][12];	/* format, stand-alone; long, short,
					 * narrow */
	const char *weekday[3][7];	/* from Sunday */
	const char *era[3][2];		/* BC, AD */
	const char *ampm[2];
	const char *period[3][25];	/* at each hour, and at noon */
	const struct intl_tzname *tz;	/* sorted by zone; what differs from
					 * the first locale's */
	unsigned int ntz;
};

#include "intl_locale.h"

#define TZ_COUNT ((int) (sizeof(tz_zones) / sizeof(tz_zones[0])))
#define TZ_OFFSET 100000	/* a zone number at or above is an offset */

/* ---- calendar ---- */

static int64_t floor_div(int64_t a, int64_t b)
{
	int64_t q = a / b;

	if ((a % b != 0) && ((a < 0) != (b < 0)))
		q--;
	return q;
}

/* days since 1970-01-01 of a proleptic Gregorian date (Hinnant) */
static int64_t days_from_civil(int64_t y, int m, int d)
{
	int64_t era, yoe, doy, doe;

	y -= m <= 2;
	era = floor_div(y, 400);
	yoe = y - era * 400;
	doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
	doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	return era * 146097 + doe - 719468;
}

static void civil_from_days(int64_t z, int64_t *y, int *m, int *d)
{
	int64_t era, doe, yoe, doy, mp;

	z += 719468;
	era = floor_div(z, 146097);
	doe = z - era * 146097;
	yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	mp = (5 * doy + 2) / 153;
	*d = (int) (doy - (153 * mp + 2) / 5 + 1);
	*m = (int) (mp < 10 ? mp + 3 : mp - 9);
	*y = yoe + era * 400 + (*m <= 2);
}

static int days_in_month(int64_t y, int m)
{
	static const int dm[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31,
		30, 31 };

	if (m == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0))
		return 29;
	return dm[m - 1];
}

/* ---- POSIX time zone rules ---- */

struct tz_rule_when {
	char kind;		/* 'M', 'J' or 'N' */
	int a, b, c;		/* month, week, day; or the day number */
	int32_t time;		/* seconds after local midnight */
};

struct tz_rule {
	int32_t std, dst;	/* seconds east of UTC */
	int has_dst;
	struct tz_rule_when start, end;
};

static const char *rule_name(const char *p)
{
	if (*p == '<') {
		while (*p && *p != '>')
			p++;
		return *p ? p + 1 : p;
	}
	while ((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z'))
		p++;
	return p;
}

static const char *rule_offset(const char *p, int32_t *out)
{
	int sign = 1;
	int32_t v = 0, part;

	if (*p == '+' || *p == '-') {
		sign = *p == '-' ? -1 : 1;
		p++;
	}
	part = 0;
	while (*p >= '0' && *p <= '9')
		part = part * 10 + (*p++ - '0');
	v = part * 3600;
	if (*p == ':') {
		p++;
		part = 0;
		while (*p >= '0' && *p <= '9')
			part = part * 10 + (*p++ - '0');
		v += part * 60;
		if (*p == ':') {
			p++;
			part = 0;
			while (*p >= '0' && *p <= '9')
				part = part * 10 + (*p++ - '0');
			v += part;
		}
	}
	*out = sign * v;
	return p;
}

static const char *rule_int(const char *p, int *out)
{
	int v = 0;

	while (*p >= '0' && *p <= '9')
		v = v * 10 + (*p++ - '0');
	*out = v;
	return p;
}

static const char *rule_when(const char *p, struct tz_rule_when *w)
{
	w->time = 7200;
	w->a = w->b = w->c = 0;
	if (*p == 'M') {
		w->kind = 'M';
		p = rule_int(p + 1, &w->a);
		if (*p == '.')
			p++;
		p = rule_int(p, &w->b);
		if (*p == '.')
			p++;
		p = rule_int(p, &w->c);
	} else {
		w->kind = 'N';
		if (*p == 'J') {
			w->kind = 'J';
			p++;
		}
		p = rule_int(p, &w->a);
	}
	if (*p == '/')
		p = rule_offset(p + 1, &w->time);
	return p;
}

static void rule_parse(const char *s, struct tz_rule *r)
{
	const char *p = rule_name(s);
	int32_t off;

	memset(r, 0, sizeof(*r));
	p = rule_offset(p, &off);
	r->std = -off;
	if (*p == '\0')
		return;
	p = rule_name(p);
	r->dst = r->std + 3600;
	if (*p && *p != ',') {
		p = rule_offset(p, &off);
		r->dst = -off;
	}
	if (*p != ',')
		return;
	r->has_dst = 1;
	p = rule_when(p + 1, &r->start);
	if (*p == ',')
		rule_when(p + 1, &r->end);
}

/* UTC seconds of a rule's change in a year, given the offset before it */
static int64_t rule_time(int64_t year, const struct tz_rule_when *w,
			 int32_t before)
{
	int64_t days;

	if (w->kind == 'M') {
		/* weekday of the first of the month, Sunday 0 */
		int64_t first = days_from_civil(year, w->a, 1);
		int wd = (int) ((first % 7 + 7 + 4) % 7);
		int day = 1 + (w->c - wd + 7) % 7 + (w->b - 1) * 7;
		int last = days_in_month(year, w->a);

		while (day > last)
			day -= 7;
		days = first + day - 1;
	} else if (w->kind == 'J') {
		int d = w->a - 1;
		int leap = days_in_month(year, 2) == 29;

		if (leap && w->a >= 60)
			d++;
		days = days_from_civil(year, 1, 1) + d;
	} else {
		days = days_from_civil(year, 1, 1) + w->a;
	}
	return days * 86400 + w->time - before;
}

static struct tz_rule rules[sizeof(tz_footer) / sizeof(tz_footer[0])];
static unsigned char rule_ready[sizeof(tz_footer) / sizeof(tz_footer[0])];

static const struct tz_rule *rule_get(int i)
{
	if (!rule_ready[i]) {
		rule_parse(tz_footer[i], &rules[i]);
		rule_ready[i] = 1;
	}
	return &rules[i];
}

static int32_t rule_offset_at(const struct tz_rule *r, int64_t t, int *dst)
{
	int64_t y, s, e;
	int m, d;

	*dst = 0;
	if (!r->has_dst)
		return r->std;
	civil_from_days(floor_div(t + r->std, 86400), &y, &m, &d);
	s = rule_time(y, &r->start, r->std);
	e = rule_time(y, &r->end, r->dst);
	if (s < e ? (t >= s && t < e) : !(t >= e && t < s)) {
		*dst = 1;
		return r->dst;
	}
	return r->std;
}

/* ---- zones ---- */

static const struct tz_zone *zone_data(int z)
{
	const struct tz_zone *e = &tz_zones[z];

	return e->zone >= 0 ? &tz_zones[e->zone] : e;
}

/* seconds east of UTC in a zone at a UTC time in seconds */
static int32_t zone_offset(int z, int64_t t, int *dst)
{
	const struct tz_zone *e;
	int lo, hi;

	*dst = 0;
	if (z >= TZ_OFFSET)
		return (z - 2 * TZ_OFFSET) * 60;
	if (z < 0 || z >= TZ_COUNT)
		return 0;
	e = zone_data(z);
	if (e->count == 0 || t >= tz_trans_time[e->first + e->count - 1]) {
		/* after the last change the rule has them all; before 1970
		 * the offset at 1970 */
		if (e->count == 0 && t < 0) {
			*dst = tz_type_dst[e->start];
			return tz_type_off[e->start];
		}
		return rule_offset_at(rule_get(e->footer), t, dst);
	}
	if (t < tz_trans_time[e->first]) {
		*dst = tz_type_dst[e->start];
		return tz_type_off[e->start];
	}
	lo = 0;
	hi = e->count - 1;
	while (lo < hi) {
		int mid = (lo + hi + 1) / 2;

		if (tz_trans_time[e->first + mid] <= t)
			lo = mid;
		else
			hi = mid - 1;
	}
	*dst = tz_type_dst[tz_trans_type[e->first + lo]];
	return tz_type_off[tz_trans_type[e->first + lo]];
}

static int zone_find(const char *name)
{
	int lo = 0, hi = TZ_COUNT - 1;

	while (lo <= hi) {
		int mid = (lo + hi) / 2;
		int c = strcasecmp(name, tz_zones[mid].name);

		if (c == 0)
			return mid;
		if (c < 0)
			hi = mid - 1;
		else
			lo = mid + 1;
	}
	return -1;
}

/* the name of a zone its names are looked up under */
static const char *zone_canonical(int z)
{
	const struct tz_zone *e = &tz_zones[z];

	return e->zone >= 0 ? tz_zones[e->zone].name : e->name;
}

static const struct intl_tzname *tzname_find(const struct intl_locale *l,
					     const char *zone)
{
	unsigned int lo = 0, hi = l->ntz;

	while (lo < hi) {
		unsigned int mid = (lo + hi) / 2;
		int c;

		if (l->tz[mid].zone == NULL)
			return NULL;
		c = strcmp(zone, l->tz[mid].zone);
		if (c == 0)
			return &l->tz[mid];
		if (c < 0)
			hi = mid;
		else
			lo = mid + 1;
	}
	return NULL;
}

/* one of a zone's names, or NULL for the GMT offset */
static const char *zone_name(const struct intl_locale *l, int z, int which)
{
	const struct intl_tzname *n;
	const char *zone;

	if (z < 0 || z >= TZ_COUNT)
		return NULL;
	zone = zone_canonical(z);
	n = tzname_find(l, zone);
	if (n == NULL && l != &intl_locales[0])
		n = tzname_find(&intl_locales[0], zone);
	return n ? n->n[which] : NULL;
}

/* ---- the formatter ---- */

struct fields {
	int64_t year;		/* astronomical: 0 is 1 BC */
	int month, day, wday;	/* 1-12, 1-31, Sunday 0 */
	int hour, minute, second, ms;
	int32_t offset;		/* seconds east of UTC */
	int dst;
};

static void fields_at(int z, double epoch_ms, struct fields *f)
{
	int64_t ms = (int64_t) epoch_ms, t, days, secs;

	if ((double) ms > epoch_ms)
		ms--;		/* floor for negative fractions */
	t = floor_div(ms, 1000);
	f->offset = zone_offset(z, t, &f->dst);
	f->ms = (int) (ms - t * 1000);
	t += f->offset;
	days = floor_div(t, 86400);
	secs = t - days * 86400;
	civil_from_days(days, &f->year, &f->month, &f->day);
	f->wday = (int) (((days % 7) + 7 + 4) % 7);
	f->hour = (int) (secs / 3600);
	f->minute = (int) (secs / 60 % 60);
	f->second = (int) (secs % 60);
}

struct out {
	char buf[512];
	size_t len;
};

static void put(struct out *o, const char *s, size_t n)
{
	if (o->len + n >= sizeof(o->buf))
		n = sizeof(o->buf) - 1 - o->len;
	memcpy(o->buf + o->len, s, n);
	o->len += n;
	o->buf[o->len] = '\0';
}

/* digits by hand: no 64-bit printf formats on the Vita */
static void put_num(struct out *o, int64_t v, int width)
{
	char tmp[24];
	int n = 0, i;
	uint64_t u;

	if (v < 0) {
		put(o, "-", 1);
		u = (uint64_t) -v;
	} else {
		u = (uint64_t) v;
	}
	do {
		tmp[n++] = (char) ('0' + (int) (u % 10));
		u /= 10;
	} while (u && n < (int) sizeof(tmp));
	for (i = n; i < width && i < 20; i++)
		put(o, "0", 1);
	while (n > 0)
		put(o, &tmp[--n], 1);
}

static void put_gmt(struct out *o, int32_t off, int longform)
{
	int32_t a = off < 0 ? -off : off;
	int h = (int) (a / 3600), m = (int) (a / 60 % 60);
	char tmp[24];
	int n;

	if (off == 0) {
		if (longform)
			put(o, "GMT+00:00", 9);
		else
			put(o, "GMT+0", 5);
		return;
	}
	if (longform)
		n = snprintf(tmp, sizeof(tmp), "GMT%c%02d:%02d",
			     off < 0 ? '-' : '+', h, m);
	else if (m)
		n = snprintf(tmp, sizeof(tmp), "GMT%c%d:%02d",
			     off < 0 ? '-' : '+', h, m);
	else
		n = snprintf(tmp, sizeof(tmp), "GMT%c%d",
			     off < 0 ? '-' : '+', h);
	put(o, tmp, (size_t) n);
}

static int width_of(int len)
{
	/* long, short, narrow */
	return len == 4 ? 0 : len == 5 ? 2 : 1;
}

/* the part type a pattern letter formats */
static const char *part_type(char c)
{
	switch (c) {
	case 'G': return "era";
	case 'y': case 'Y': case 'u': return "year";
	case 'M': case 'L': return "month";
	case 'd': return "day";
	case 'E': case 'c': case 'e': return "weekday";
	case 'a': case 'b': case 'B': return "dayPeriod";
	case 'h': case 'H': case 'K': case 'k': return "hour";
	case 'm': return "minute";
	case 's': return "second";
	case 'S': return "fractionalSecond";
	case 'z': case 'Z': case 'O': case 'v': case 'V': case 'x':
	case 'X': return "timeZoneName";
	}
	return NULL;
}

static void field(struct out *o, const struct intl_locale *l, int z,
		  const struct fields *f, char c, int len)
{
	const char *s = NULL;
	int h;

	switch (c) {
	case 'G':
		s = l->era[width_of(len)][f->year > 0];
		break;
	case 'y': case 'Y': case 'u': {
		int64_t y = f->year > 0 ? f->year : 1 - f->year;

		if (len == 2)
			put_num(o, y % 100, 2);
		else
			put_num(o, y, len);
		return;
	}
	case 'M': case 'L':
		if (len <= 2) {
			put_num(o, f->month, len);
			return;
		}
		s = l->month[c == 'L'][width_of(len)][f->month - 1];
		break;
	case 'd':
		put_num(o, f->day, len);
		return;
	case 'E': case 'c': case 'e':
		if (len <= 2 && c != 'E') {
			put_num(o, f->wday + 1, len);
			return;
		}
		s = l->weekday[len == 4 ? 0 : len == 5 ? 2 : 1][f->wday];
		break;
	case 'a': case 'b':
		s = l->ampm[f->hour >= 12];
		break;
	case 'B':
		s = l->period[width_of(len)][f->hour == 12 && f->minute == 0 &&
			f->second == 0 ? 24 : f->hour];
		break;
	case 'h':
		h = f->hour % 12;
		put_num(o, h == 0 ? 12 : h, len);
		return;
	case 'K':
		put_num(o, f->hour % 12, len);
		return;
	case 'H':
		put_num(o, f->hour, len);
		return;
	case 'k':
		put_num(o, f->hour == 0 ? 24 : f->hour, len);
		return;
	case 'm':
		put_num(o, f->minute, len);
		return;
	case 's':
		put_num(o, f->second, len);
		return;
	case 'S': {
		char tmp[16];
		int i;

		snprintf(tmp, sizeof(tmp), "%03d", f->ms);
		for (i = 3; i < len && i < 9; i++)
			tmp[i] = '0';
		put(o, tmp, (size_t) (len < 9 ? len : 9));
		return;
	}
	case 'z':
		s = zone_name(l, z, (len == 4 ? 2 : 0) + (f->dst ? 1 : 0));
		if (s == NULL) {
			put_gmt(o, f->offset, len == 4);
			return;
		}
		break;
	case 'v': case 'V':
		/* a zone with no name for itself goes by its standard
		 * offset */
		s = zone_name(l, z, len == 4 ? 5 : 4);
		if (s == NULL) {
			put_gmt(o, f->dst ? f->offset - 3600 : f->offset,
				len == 4);
			return;
		}
		break;
	case 'O': case 'Z': case 'x': case 'X':
		put_gmt(o, f->offset, len == 4);
		return;
	}
	if (s)
		put(o, s, strlen(s));
}

/*
 * Format a time with a pattern. With parts, each run of text is handed
 * to the callback with its type, literals together as one.
 */
typedef void (*part_fn)(void *pw, const char *type, const char *s, size_t n);

static void format_pattern(const struct intl_locale *l, const char *pattern,
			   int z, double t, struct out *o, part_fn part,
			   void *pw)
{
	struct fields f;
	const char *p = pattern;
	size_t lit_start = 0;
	int in_lit = 0;

	fields_at(z, t, &f);
	o->len = 0;
	o->buf[0] = '\0';
	while (*p) {
		char c = *p;

		if (c == '\'') {
			if (!in_lit && part)
				lit_start = o->len, in_lit = 1;
			if (p[1] == '\'') {
				put(o, "'", 1);
				p += 2;
				continue;
			}
			p++;
			while (*p && !(*p == '\'' && p[1] != '\'')) {
				if (*p == '\'')
					p++;
				put(o, p, 1);
				p++;
			}
			if (*p)
				p++;
			continue;
		}
		if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
			int len = 0;
			size_t start;

			while (p[len] == c)
				len++;
			if (in_lit && part) {
				part(pw, "literal", o->buf + lit_start,
				     o->len - lit_start);
				in_lit = 0;
			}
			start = o->len;
			field(o, l, z, &f, c, len);
			if (part) {
				const char *ty = part_type(c);

				part(pw, ty ? ty : "literal", o->buf + start,
				     o->len - start);
			}
			p += len;
			continue;
		}
		if (!in_lit && part)
			lit_start = o->len, in_lit = 1;
		put(o, p, 1);
		p++;
	}
	if (in_lit && part && o->len > lit_start)
		part(pw, "literal", o->buf + lit_start, o->len - lit_start);
}

/* ---- the JS side ---- */

static const struct intl_locale *locale_arg(JSContext *ctx, JSValueConst v)
{
	int32_t i = 0;

	JS_ToInt32(ctx, &i, v);
	if (i < 0 || i >= INTL_LOCALES)
		i = 0;
	return &intl_locales[i];
}

/* zone(name): [the name of the zone it is, as the database writes it,
 * its number], or null */
static JSValue js_zone(JSContext *ctx, JSValueConst this_val, int argc,
		       JSValueConst *argv)
{
	const char *name = JS_ToCString(ctx, argv[0]);
	JSValue r = JS_NULL;
	int z;

	if (name == NULL)
		return JS_EXCEPTION;
	if ((name[0] == '+' || name[0] == '-') && name[1] >= '0' &&
	    name[1] <= '9') {
		/* +HH, +HHMM, +HH:MM */
		int h = 0, m = 0, n = 0;
		const char *p = name + 1;

		while (*p >= '0' && *p <= '9' && n < 2)
			h = h * 10 + (*p++ - '0'), n++;
		if (n == 2) {
			if (*p == ':')
				p++;
			n = 0;
			while (*p >= '0' && *p <= '9' && n < 2)
				m = m * 10 + (*p++ - '0'), n++;
			if (*p == '\0' && (n == 0 || n == 2) && h <= 23 &&
			    m <= 59) {
				char buf[8];
				int off = (h * 60 + m) * (name[0] == '-' ?
							  -1 : 1);

				snprintf(buf, sizeof(buf), "%c%02d:%02d",
					 off < 0 ? '-' : '+', h, m);
				r = JS_NewArray(ctx);
				JS_SetPropertyUint32(ctx, r, 0,
						     JS_NewString(ctx, buf));
				JS_SetPropertyUint32(ctx, r, 1,
					JS_NewInt32(ctx, 2 * TZ_OFFSET + off));
			}
		}
	} else if ((z = zone_find(name)) >= 0) {
		/* a link goes by the zone it names */
		int c = tz_zones[z].zone >= 0 ? tz_zones[z].zone : z;

		r = JS_NewArray(ctx);
		JS_SetPropertyUint32(ctx, r, 0,
				     JS_NewString(ctx, tz_zones[c].name));
		JS_SetPropertyUint32(ctx, r, 1, JS_NewInt32(ctx, c));
	}
	JS_FreeCString(ctx, name);
	return r;
}

/* zones(): every canonical zone, for Intl.supportedValuesOf */
static JSValue js_zones(JSContext *ctx, JSValueConst this_val, int argc,
			JSValueConst *argv)
{
	JSValue a = JS_NewArray(ctx);
	uint32_t n = 0;
	int i;

	for (i = 0; i < TZ_COUNT; i++) {
		if (tz_zones[i].zone >= 0)
			continue;
		JS_SetPropertyUint32(ctx, a, n++,
				     JS_NewString(ctx, tz_zones[i].name));
	}
	return a;
}

/* offset(zone, ms): minutes east of UTC */
static JSValue js_offset(JSContext *ctx, JSValueConst this_val, int argc,
			 JSValueConst *argv)
{
	int32_t z = 0;
	double t = 0;
	int dst;

	JS_ToInt32(ctx, &z, argv[0]);
	JS_ToFloat64(ctx, &t, argv[1]);
	return JS_NewInt32(ctx, zone_offset(z, (int64_t) floor_div(
		(int64_t) t, 1000), &dst) / 60);
}

/* fields(zone, ms): [era, year, month, day, am/pm, hour, minute,
 * second, ms] as a range compares them */
static JSValue js_fields(JSContext *ctx, JSValueConst this_val, int argc,
			 JSValueConst *argv)
{
	int32_t z = 0;
	double t = 0;
	struct fields f;
	JSValue a;
	int64_t v[9];
	int i;

	JS_ToInt32(ctx, &z, argv[0]);
	JS_ToFloat64(ctx, &t, argv[1]);
	fields_at(z, t, &f);
	v[0] = f.year > 0;
	v[1] = f.year;
	v[2] = f.month;
	v[3] = f.day;
	v[4] = f.hour >= 12;
	v[5] = f.hour;
	v[6] = f.minute;
	v[7] = f.second;
	v[8] = f.ms;
	a = JS_NewArray(ctx);
	for (i = 0; i < 9; i++)
		JS_SetPropertyUint32(ctx, a, (uint32_t) i,
				     JS_NewFloat64(ctx, (double) v[i]));
	return a;
}

/* locales(): the tags there is data for */
static JSValue js_locales(JSContext *ctx, JSValueConst this_val, int argc,
			  JSValueConst *argv)
{
	JSValue a = JS_NewArray(ctx);
	int i;

	for (i = 0; i < INTL_LOCALES; i++)
		JS_SetPropertyUint32(ctx, a, (uint32_t) i,
				     JS_NewString(ctx, intl_locales[i].tag));
	return a;
}

/* data(locale): the locale's patterns, parsed */
static JSValue js_data(JSContext *ctx, JSValueConst this_val, int argc,
		       JSValueConst *argv)
{
	const struct intl_locale *l = locale_arg(ctx, argv[0]);

	return JS_ParseJSON(ctx, l->json, strlen(l->json), "<intl>");
}

struct parts_ctx {
	JSContext *ctx;
	JSValue arr;
	uint32_t n;
};

static void add_part(void *pw, const char *type, const char *s, size_t n)
{
	struct parts_ctx *pc = pw;

	if (n == 0)
		return;
	JS_SetPropertyUint32(pc->ctx, pc->arr, pc->n++,
			     JS_NewString(pc->ctx, type));
	JS_SetPropertyUint32(pc->ctx, pc->arr, pc->n++,
			     JS_NewStringLen(pc->ctx, s, n));
}

/* format(locale, pattern, zone, ms[, parts]): the string, or with parts
 * an array of type, text, type, text... */
static JSValue js_format(JSContext *ctx, JSValueConst this_val, int argc,
			 JSValueConst *argv)
{
	const struct intl_locale *l = locale_arg(ctx, argv[0]);
	const char *pattern = JS_ToCString(ctx, argv[1]);
	int32_t z = 0;
	double t = 0;
	struct out o;
	JSValue r;

	if (pattern == NULL)
		return JS_EXCEPTION;
	JS_ToInt32(ctx, &z, argv[2]);
	JS_ToFloat64(ctx, &t, argv[3]);
	if (argc > 4 && JS_ToBool(ctx, argv[4])) {
		struct parts_ctx pc;

		pc.ctx = ctx;
		pc.arr = JS_NewArray(ctx);
		pc.n = 0;
		format_pattern(l, pattern, z, t, &o, add_part, &pc);
		r = pc.arr;
	} else {
		format_pattern(l, pattern, z, t, &o, NULL, NULL);
		r = JS_NewStringLen(ctx, o.buf, o.len);
	}
	JS_FreeCString(ctx, pattern);
	return r;
}

/*
 * The pack of locale data vita/js/intl_number.js formats numbers with,
 * resources/intl.pak from scripts/gen-intl-numbers.mjs: "VSIP", a count,
 * then for each entry its name and where its zlib stream lies, then the
 * streams. The index is read the first time an entry is asked for and
 * kept; an entry is read and inflated each time it is asked for, which
 * intl_number.js does once per locale.
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
	JS_CFUNC_DEF("zone", 1, js_zone),
	JS_CFUNC_DEF("zones", 0, js_zones),
	JS_CFUNC_DEF("offset", 2, js_offset),
	JS_CFUNC_DEF("fields", 2, js_fields),
	JS_CFUNC_DEF("locales", 0, js_locales),
	JS_CFUNC_DEF("data", 1, js_data),
	JS_CFUNC_DEF("format", 5, js_format),
	JS_CFUNC_DEF("pak", 1, js_pak),
	JS_CFUNC_DEF("has", 1, js_pak_has),
	JS_PROP_STRING_DEF("tzVersion", TZ_VERSION, 0),
	JS_PROP_STRING_DEF("cldrVersion", INTL_CLDR_VERSION, 0),
};

void vita_intl_register(JSContext *ctx, JSValueConst global)
{
	JSValue obj = JS_NewObject(ctx);

	JS_SetPropertyFunctionList(ctx, obj, intl_funcs,
				   sizeof(intl_funcs) / sizeof(intl_funcs[0]));
	JS_SetPropertyStr(ctx, global, "__vitaIntl", obj);
}
