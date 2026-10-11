/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * The URL Standard's basic URL parser, in C (VitaSurf).
 *
 * URL was a regular expression and some string surgery in the prelude:
 * slow enough that a page building URLs in a loop spent a tenth of its
 * script there on the Vita, and wrong wherever the regular expression
 * and the standard part ways (a backslash in a special URL, a port of
 * the scheme's default, "..", hosts that are IPv4 numbers, a percent
 * that encodes nothing). This is the standard's state machine, with
 * the state override its setters use, and the host parser: IPv4 and
 * IPv6 addresses, opaque hosts, and domains made ASCII by Punycode.
 * Mapping a domain's Unicode (UTS #46) is left to the caller, which
 * done with the engine's normalisation and case tables, as NFKC, lower
 * case and NFKC again, which is UTS #46's mapping for every code point
 * but a few (url_uts46_map; url_set_domain_map replaces it).
 *
 * A URL is kept as its parts, and handed back as its serialisation and
 * the parts a URL object reads; vita/js/qjs.c wraps it for script.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "url.h"

/* --- growable byte strings ------------------------------------------ */

static bool buf_reserve(struct url_buf *b, size_t more)
{
	size_t want = b->n + more + 1;
	char *p;

	if (want <= b->cap) {
		return true;
	}
	if (want < 32) want = 32;
	if (want < b->cap * 2) want = b->cap * 2;
	p = realloc(b->p, want);
	if (p == NULL) {
		return false;
	}
	b->p = p;
	b->cap = want;
	return true;
}

static bool buf_add(struct url_buf *b, const char *s, size_t n)
{
	if (!buf_reserve(b, n)) {
		return false;
	}
	memcpy(b->p + b->n, s, n);
	b->n += n;
	b->p[b->n] = '\0';
	return true;
}

static bool buf_addc(struct url_buf *b, char c)
{
	return buf_add(b, &c, 1);
}

static bool buf_adds(struct url_buf *b, const char *s)
{
	return buf_add(b, s, strlen(s));
}

static void buf_clear(struct url_buf *b)
{
	b->n = 0;
	if (b->p != NULL) b->p[0] = '\0';
}

static void buf_free(struct url_buf *b)
{
	free(b->p);
	b->p = NULL;
	b->n = b->cap = 0;
}

static bool buf_set(struct url_buf *b, const char *s, size_t n)
{
	buf_clear(b);
	return buf_add(b, s, n);
}

static bool buf_copy(struct url_buf *to, const struct url_buf *from)
{
	return buf_set(to, from->p != NULL ? from->p : "", from->n);
}

/* UTF-8 of one code point */
static bool buf_addcp(struct url_buf *b, uint32_t c)
{
	char u[4];
	size_t n;

	if (c < 0x80) {
		u[0] = (char)c; n = 1;
	} else if (c < 0x800) {
		u[0] = (char)(0xc0 | (c >> 6));
		u[1] = (char)(0x80 | (c & 0x3f)); n = 2;
	} else if (c < 0x10000) {
		u[0] = (char)(0xe0 | (c >> 12));
		u[1] = (char)(0x80 | ((c >> 6) & 0x3f));
		u[2] = (char)(0x80 | (c & 0x3f)); n = 3;
	} else {
		u[0] = (char)(0xf0 | (c >> 18));
		u[1] = (char)(0x80 | ((c >> 12) & 0x3f));
		u[2] = (char)(0x80 | ((c >> 6) & 0x3f));
		u[3] = (char)(0x80 | (c & 0x3f)); n = 4;
	}
	return buf_add(b, u, n);
}

/* --- the record ----------------------------------------------------- */

void url_init(struct url *u)
{
	memset(u, 0, sizeof(*u));
	u->host_null = true;
	u->port = -1;
	u->query_null = true;
	u->fragment_null = true;
}

static void path_clear(struct url *u)
{
	size_t i;

	for (i = 0; i < u->nsegs; i++) {
		buf_free(&u->segs[i]);
	}
	u->nsegs = 0;
}

void url_free(struct url *u)
{
	buf_free(&u->scheme);
	buf_free(&u->username);
	buf_free(&u->password);
	buf_free(&u->host);
	buf_free(&u->opaque_path);
	path_clear(u);
	free(u->segs);
	buf_free(&u->query);
	buf_free(&u->fragment);
	url_init(u);
}

static bool path_push(struct url *u, const char *s, size_t n)
{
	if (u->nsegs == u->capsegs) {
		size_t cap = u->capsegs ? u->capsegs * 2 : 8;
		struct url_buf *p = realloc(u->segs, cap * sizeof(*p));

		if (p == NULL) {
			return false;
		}
		memset(p + u->capsegs, 0, (cap - u->capsegs) * sizeof(*p));
		u->segs = p;
		u->capsegs = cap;
	}
	return buf_set(&u->segs[u->nsegs++], s, n);
}

static void path_pop(struct url *u)
{
	if (u->nsegs > 0) {
		u->nsegs--;
		buf_free(&u->segs[u->nsegs]);
	}
}

static bool url_copy(struct url *to, const struct url *from)
{
	size_t i;
	bool ok;

	url_free(to);
	ok = buf_copy(&to->scheme, &from->scheme) &&
		buf_copy(&to->username, &from->username) &&
		buf_copy(&to->password, &from->password) &&
		buf_copy(&to->host, &from->host) &&
		buf_copy(&to->opaque_path, &from->opaque_path) &&
		buf_copy(&to->query, &from->query) &&
		buf_copy(&to->fragment, &from->fragment);
	to->host_null = from->host_null;
	to->port = from->port;
	to->opaque = from->opaque;
	to->query_null = from->query_null;
	to->fragment_null = from->fragment_null;
	for (i = 0; ok && i < from->nsegs; i++) {
		ok = path_push(to, from->segs[i].p ? from->segs[i].p : "",
			       from->segs[i].n);
	}
	return ok;
}

/* --- code point classes and percent-encode sets ---------------------- */

static bool is_alpha(uint32_t c)
{
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

static bool is_digit(uint32_t c)
{
	return c >= '0' && c <= '9';
}

static bool is_hex(uint32_t c)
{
	return is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static int hexval(uint32_t c)
{
	if (is_digit(c)) return (int)(c - '0');
	if (c >= 'a' && c <= 'f') return (int)(c - 'a' + 10);
	return (int)(c - 'A' + 10);
}

static uint32_t lower(uint32_t c)
{
	return c >= 'A' && c <= 'Z' ? c + 32 : c;
}

enum pe_set { PE_C0, PE_FRAGMENT, PE_QUERY, PE_SPECIAL_QUERY, PE_PATH,
	      PE_USERINFO };

static bool in_set(uint32_t c, enum pe_set set)
{
	if (c < 0x20 || c > 0x7e) return true;	/* C0 control or not ASCII */
	switch (set) {
	case PE_C0:
		return false;
	case PE_FRAGMENT:
		return c == ' ' || c == '"' || c == '<' || c == '>' || c == '`';
	case PE_QUERY:
		return c == ' ' || c == '"' || c == '#' || c == '<' || c == '>';
	case PE_SPECIAL_QUERY:
		return c == ' ' || c == '"' || c == '#' || c == '<' ||
			c == '>' || c == '\'';
	case PE_PATH:
		return c == ' ' || c == '"' || c == '#' || c == '<' ||
			c == '>' || c == '?' || c == '^' || c == '`' ||
			c == '{' || c == '}';
	case PE_USERINFO:
		return c == ' ' || c == '"' || c == '#' || c == '<' ||
			c == '>' || c == '?' || c == '^' || c == '`' ||
			c == '{' || c == '}' || c == '/' || c == ':' ||
			c == ';' || c == '=' || c == '@' || c == '[' ||
			c == '\\' || c == ']' || c == '|';
	}
	return false;
}

/* a code point, percent-encoded if it is in the set */
static bool add_encoded(struct url_buf *b, uint32_t c, enum pe_set set)
{
	static const char hx[] = "0123456789ABCDEF";
	struct url_buf t = { NULL, 0, 0 };
	size_t i;
	bool ok;

	if (!in_set(c, set)) {
		return buf_addc(b, (char)c);
	}
	if (!buf_addcp(&t, c)) {
		return false;
	}
	ok = true;
	for (i = 0; ok && i < t.n; i++) {
		unsigned char x = (unsigned char)t.p[i];
		char e[3] = { '%', hx[x >> 4], hx[x & 15] };

		ok = buf_add(b, e, 3);
	}
	buf_free(&t);
	return ok;
}

/* --- special schemes ------------------------------------------------- */

static int special_port(const char *s, size_t n)
{
	if (n == 4 && memcmp(s, "http", 4) == 0) return 80;
	if (n == 5 && memcmp(s, "https", 5) == 0) return 443;
	if (n == 2 && memcmp(s, "ws", 2) == 0) return 80;
	if (n == 3 && memcmp(s, "wss", 3) == 0) return 443;
	if (n == 3 && memcmp(s, "ftp", 3) == 0) return 21;
	if (n == 4 && memcmp(s, "file", 4) == 0) return 0;	/* no default */
	return -1;
}

static bool is_special_s(const char *s, size_t n)
{
	return special_port(s, n) >= 0;
}

static bool is_special(const struct url *u)
{
	return u->scheme.p != NULL && is_special_s(u->scheme.p, u->scheme.n);
}

static bool scheme_is(const struct url *u, const char *s)
{
	size_t n = strlen(s);

	return u->scheme.n == n && memcmp(u->scheme.p, s, n) == 0;
}

static int default_port(const struct url *u)
{
	int p = u->scheme.p ? special_port(u->scheme.p, u->scheme.n) : -1;

	return p > 0 ? p : -1;
}

/* --- code points of the input --------------------------------------- */

/* UTF-8 to code points; a byte sequence that is not UTF-8 is U+FFFD */
static uint32_t *decode(const char *s, size_t n, size_t *out_n)
{
	uint32_t *cp = malloc((n + 1) * sizeof(*cp));
	size_t i = 0, k = 0;

	if (cp == NULL) {
		return NULL;
	}
	while (i < n) {
		unsigned char c = (unsigned char)s[i];
		uint32_t v;
		size_t len, j;

		if (c < 0x80) { v = c; len = 1; }
		else if ((c & 0xe0) == 0xc0) { v = c & 0x1f; len = 2; }
		else if ((c & 0xf0) == 0xe0) { v = c & 0x0f; len = 3; }
		else if ((c & 0xf8) == 0xf0) { v = c & 0x07; len = 4; }
		else { cp[k++] = 0xfffd; i++; continue; }
		if (i + len > n) { cp[k++] = 0xfffd; i++; continue; }
		for (j = 1; j < len; j++) {
			unsigned char d = (unsigned char)s[i + j];

			if ((d & 0xc0) != 0x80) break;
			v = (v << 6) | (d & 0x3f);
		}
		if (j < len) { cp[k++] = 0xfffd; i++; continue; }
		/* a surrogate (an engine's lone one) is not a scalar value */
		if (v >= 0xd800 && v <= 0xdfff) v = 0xfffd;
		cp[k++] = v;
		i += len;
	}
	cp[k] = 0;
	*out_n = k;
	return cp;
}

/* --- hosts ----------------------------------------------------------- */

/*
 * QuickJS's Unicode tables (libunicode.c, in libquickjs.a), declared here
 * as libunicode.h has them: it is not installed with quickjs.h.
 */
enum { LU_NFC, LU_NFD, LU_NFKC, LU_NFKD };
int lre_case_conv(uint32_t *res, uint32_t c, int conv_type);
int unicode_normalize(uint32_t **pdst, const uint32_t *src, int src_len,
		      int n_type, void *opaque,
		      void *(*realloc_func)(void *opaque, void *ptr, size_t size));

static void *lu_realloc(void *opaque, void *ptr, size_t size)
{
	(void)opaque;
	if (size == 0) {
		free(ptr);
		return NULL;
	}
	return realloc(ptr, size);
}

/* NFKC of n code points, as a malloc'd array; -1 on failure */
static int nfkc(const uint32_t *in, int n, uint32_t **out)
{
	return unicode_normalize(out, in, n, LU_NFKC, NULL, lu_realloc);
}

char *url_uts46_map(void *pw, const char *s, size_t n, size_t *out_n)
{
	uint32_t *cp, *a = NULL, *b = NULL, *f;
	size_t cn, i;
	int an, bn, k = 0;
	struct url_buf o = { NULL, 0, 0 };

	(void)pw;
	cp = decode(s, n, &cn);
	if (cp == NULL) return NULL;
	an = nfkc(cp, (int)cn, &a);
	free(cp);
	if (an < 0) return NULL;
	f = malloc(((size_t)an * 3 + 1) * sizeof(*f));
	if (f == NULL) { free(a); return NULL; }
	for (i = 0; i < (size_t)an; i++) {
		/* to lower case, not folded: UTS #46 keeps ß and final sigma */
		k += lre_case_conv(f + k, a[i], 1);
	}
	free(a);
	bn = nfkc(f, k, &b);
	free(f);
	if (bn < 0) return NULL;
	for (i = 0; i < (size_t)bn; i++) {
		if (!buf_addcp(&o, b[i])) { free(b); buf_free(&o); return NULL; }
	}
	free(b);
	if (o.p == NULL && !buf_adds(&o, "")) return NULL;
	*out_n = o.n;
	return o.p;
}

static url_domain_map_fn domain_map = url_uts46_map;
static void *domain_map_pw;

void url_set_domain_map(url_domain_map_fn fn, void *pw)
{
	domain_map = fn;
	domain_map_pw = pw;
}

static bool forbidden_host(uint32_t c)
{
	return c == 0 || c == '\t' || c == '\n' || c == '\r' || c == ' ' ||
		c == '#' || c == '/' || c == ':' || c == '<' || c == '>' ||
		c == '?' || c == '@' || c == '[' || c == '\\' || c == ']' ||
		c == '^' || c == '|';
}

static bool forbidden_domain(uint32_t c)
{
	return forbidden_host(c) || c <= 0x1f || c == '%' || c == 0x7f;
}

/* the IPv6 parser; false on failure */
static bool parse_ipv6(const uint32_t *in, size_t n, uint16_t addr[8])
{
	size_t p = 0;
	int piece = 0, compress = -1;

	memset(addr, 0, 8 * sizeof(addr[0]));
	if (p < n && in[p] == ':') {
		if (p + 1 >= n || in[p + 1] != ':') return false;
		p += 2;
		piece = 1;
		compress = 1;
	}
	while (p < n) {
		unsigned value = 0, length = 0;

		if (piece == 8) return false;
		if (in[p] == ':') {
			if (compress != -1) return false;
			p++;
			piece++;
			compress = piece;
			continue;
		}
		while (length < 4 && p < n && is_hex(in[p])) {
			value = value * 16 + (unsigned)hexval(in[p]);
			p++;
			length++;
		}
		if (p < n && in[p] == '.') {
			int seen = 0;

			if (length == 0) return false;
			p -= length;
			if (piece > 6) return false;
			while (p < n) {
				int v4 = -1;

				if (seen > 0) {
					if (in[p] == '.' && seen < 4) p++;
					else return false;
				}
				if (p >= n || !is_digit(in[p])) return false;
				while (p < n && is_digit(in[p])) {
					int d = (int)(in[p] - '0');

					if (v4 == -1) v4 = d;
					else if (v4 == 0) return false;
					else v4 = v4 * 10 + d;
					if (v4 > 255) return false;
					p++;
				}
				addr[piece] = (uint16_t)(addr[piece] * 0x100 + v4);
				seen++;
				if (seen == 2 || seen == 4) piece++;
			}
			if (seen != 4) return false;
			break;
		} else if (p < n && in[p] == ':') {
			p++;
			if (p >= n) return false;
		} else if (p < n) {
			return false;
		}
		addr[piece] = (uint16_t)value;
		piece++;
	}
	if (compress != -1) {
		int swaps = piece - compress;
		int i = 7;

		piece = 7;
		while (piece != 0 && swaps > 0) {
			uint16_t t = addr[piece];

			addr[piece] = addr[compress + swaps - 1];
			addr[compress + swaps - 1] = t;
			piece--;
			swaps--;
		}
		(void)i;
	} else if (piece != 8) {
		return false;
	}
	return true;
}

static bool serialize_ipv6(struct url_buf *b, const uint16_t a[8])
{
	int best = -1, bestlen = 1, i, j;
	bool ignore0 = false;
	char t[16];

	for (i = 0; i < 8; i++) {
		if (a[i] != 0) continue;
		for (j = i; j < 8 && a[j] == 0; j++);
		if (j - i > bestlen) { best = i; bestlen = j - i; }
		i = j;
	}
	if (!buf_addc(b, '[')) return false;
	for (i = 0; i < 8; i++) {
		if (ignore0 && a[i] == 0) continue;
		ignore0 = false;
		if (best == i) {
			if (!buf_adds(b, i == 0 ? "::" : ":")) return false;
			ignore0 = true;
			continue;
		}
		snprintf(t, sizeof(t), "%x", (unsigned)a[i]);
		if (!buf_adds(b, t)) return false;
		if (i != 7 && !buf_addc(b, ':')) return false;
	}
	return buf_addc(b, ']');
}

/* one IPv4 number; -1 when it is none, -2 when it is too big */
static int64_t ipv4_number(const char *s, size_t n)
{
	int radix = 10;
	int64_t v = 0;
	size_t i;

	if (n == 0) return -1;
	if (n >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
		radix = 16;
		s += 2; n -= 2;
	} else if (n >= 2 && s[0] == '0') {
		radix = 8;
		s += 1; n -= 1;
	}
	if (n == 0) return 0;
	for (i = 0; i < n; i++) {
		int d;

		if (radix == 16 && is_hex((unsigned char)s[i])) d = hexval((unsigned char)s[i]);
		else if (radix == 10 && is_digit((unsigned char)s[i])) d = s[i] - '0';
		else if (radix == 8 && s[i] >= '0' && s[i] <= '7') d = s[i] - '0';
		else return -1;
		v = v * radix + d;
		if (v > 0xffffffffLL * 256) v = 0xffffffffLL * 256;	/* stays too big */
	}
	return v;
}

/* whether the host ends in a number, which makes it an IPv4 address */
static bool ends_in_number(const char *s, size_t n)
{
	size_t start, i;
	bool all_digits = true;

	if (n > 0 && s[n - 1] == '.') n--;
	if (n == 0) return false;
	start = n;
	while (start > 0 && s[start - 1] != '.') start--;
	if (start == n) return false;
	for (i = start; i < n; i++) {
		if (!is_digit((unsigned char)s[i])) { all_digits = false; break; }
	}
	if (all_digits) return true;
	return ipv4_number(s + start, n - start) >= 0;
}

/* the IPv4 parser; false on failure */
static bool parse_ipv4(const char *s, size_t n, uint32_t *out)
{
	int64_t nums[5];
	int count = 0, i;
	size_t start = 0, j;
	uint64_t v;

	if (n > 0 && s[n - 1] == '.') n--;	/* one trailing dot */
	for (j = 0; j <= n; j++) {
		if (j == n || s[j] == '.') {
			if (count == 4) return false;
			nums[count] = ipv4_number(s + start, j - start);
			if (nums[count] < 0) return false;
			count++;
			start = j + 1;
		}
	}
	for (i = 0; i < count - 1; i++) {
		if (nums[i] > 255) return false;
	}
	if (nums[count - 1] >= ((int64_t)1 << (8 * (5 - count)))) return false;
	v = (uint64_t)nums[count - 1];
	for (i = 0; i < count - 1; i++) {
		v += (uint64_t)nums[i] << (8 * (3 - i));
	}
	*out = (uint32_t)v;
	return true;
}

/* Punycode (RFC 3492) of one label's code points */
static bool punycode(struct url_buf *b, const uint32_t *in, size_t n)
{
	uint32_t m, nn = 0x80, delta = 0, bias = 72, h, b0 = 0, q, k, t;
	size_t i;

	for (i = 0; i < n; i++) {
		if (in[i] < 0x80) {
			if (!buf_addc(b, (char)in[i])) return false;
			b0++;
		}
	}
	h = b0;
	if (b0 > 0 && !buf_addc(b, '-')) return false;
	while (h < n) {
		m = 0xffffffffu;
		for (i = 0; i < n; i++) {
			if (in[i] >= nn && in[i] < m) m = in[i];
		}
		if ((uint64_t)(m - nn) * (h + 1) + delta > 0xffffffffu) return false;
		delta += (m - nn) * (h + 1);
		nn = m;
		for (i = 0; i < n; i++) {
			if (in[i] < nn && ++delta == 0) return false;
			if (in[i] == nn) {
				for (q = delta, k = 36;; k += 36) {
					uint32_t d;

					t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
					if (q < t) break;
					d = t + (q - t) % (36 - t);
					if (!buf_addc(b, (char)(d < 26 ? 'a' + d : '0' + d - 26)))
						return false;
					q = (q - t) / (36 - t);
				}
				if (!buf_addc(b, (char)(q < 26 ? 'a' + q : '0' + q - 26)))
					return false;
				/* adapt */
				{
					uint32_t dd = h == b0 ? delta / 700 : delta / 2;

					dd += dd / (h + 1);
					for (k = 0; dd > 455; k += 36) dd /= 35;
					bias = k + (36 * dd) / (dd + 38);
				}
				delta = 0;
				h++;
			}
		}
		delta++;
		nn++;
	}
	return true;
}

/* code points UTS #46 drops from a domain */
static bool idna_ignored(uint32_t c)
{
	return c == 0xad || c == 0x34f || (c >= 0x180b && c <= 0x180f) ||
		c == 0x200b || c == 0x2060 || c == 0x2064 ||
		(c >= 0xfe00 && c <= 0xfe0f) || c == 0xfeff ||
		(c >= 0x1bca0 && c <= 0x1bca3) || (c >= 0xe0100 && c <= 0xe01ef);
}

/* and the ones it refuses outright, whatever the mapping */
static bool idna_disallowed(uint32_t c)
{
	return (c >= 0x7f && c <= 0x9f) || c == 0xfffd ||
		(c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) == 0xfffe ||
		(c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000 ||
		c == 0x2028 || c == 0x2029;
}

/* domain to ASCII: the caller's mapping, then Punycode label by label */
static bool domain_to_ascii(const char *s, size_t n, struct url_buf *out,
			    bool *failed)
{
	char *mapped = NULL;
	size_t mn = n, i, k, start;
	uint32_t *cp;
	bool ascii = true, ok = true;

	*failed = false;
	for (i = 0; i < n; i++) {
		if ((unsigned char)s[i] >= 0x80) { ascii = false; break; }
	}
	if (!ascii && domain_map != NULL) {
		mapped = domain_map(domain_map_pw, s, n, &mn);
		if (mapped == NULL) { *failed = true; return true; }
		s = mapped;
		n = mn;
	}
	cp = decode(s, n, &mn);
	if (cp == NULL) { free(mapped); return false; }
	/* the full stops UTS #46 maps to one, what it drops, and what it
	   refuses */
	for (i = 0, k = 0; i < mn; i++) {
		uint32_t c = cp[i];

		if (idna_ignored(c)) continue;
		if (idna_disallowed(c)) {
			free(cp);
			free(mapped);
			*failed = true;
			return true;
		}
		if (c == 0x3002 || c == 0xff0e || c == 0xff61) c = '.';
		cp[k++] = lower(c);
	}
	mn = k;
	buf_clear(out);
	start = 0;
	for (k = 0; k <= mn && ok; k++) {
		if (k < mn && cp[k] != '.') continue;
		{
			bool lascii = true;

			for (i = start; i < k; i++) {
				if (cp[i] >= 0x80) { lascii = false; break; }
			}
			if (lascii) {
				for (i = start; i < k && ok; i++) ok = buf_addc(out, (char)cp[i]);
			} else {
				ok = buf_adds(out, "xn--") &&
					punycode(out, cp + start, k - start);
			}
		}
		if (k < mn && ok) ok = buf_addc(out, '.');
		start = k + 1;
	}
	free(cp);
	free(mapped);
	if (ok && out->n == 0) *failed = true;
	return ok;
}

/*
 * The host parser: input is code points, already without tabs and
 * newlines; failure is reported in *failed. The host is serialised.
 */
static bool parse_host_to(const uint32_t *in, size_t n, bool not_special,
			  struct url_buf *out, bool *failed)
{
	struct url_buf dec = { NULL, 0, 0 }, ascii = { NULL, 0, 0 };
	size_t i;
	bool ok = true, f;
	uint32_t v4;

	*failed = false;
	buf_clear(out);
	if (n > 0 && in[0] == '[') {
		uint16_t a[8];

		if (in[n - 1] != ']' || !parse_ipv6(in + 1, n - 2, a)) {
			*failed = true;
			return true;
		}
		return serialize_ipv6(out, a);
	}
	if (not_special) {
		/* an opaque host */
		for (i = 0; i < n; i++) {
			if (forbidden_host(in[i])) { *failed = true; return true; }
		}
		for (i = 0; i < n && ok; i++) ok = add_encoded(out, in[i], PE_C0);
		return ok;
	}
	/* percent-decode the UTF-8 of the input */
	for (i = 0; i < n && ok; i++) {
		if (in[i] == '%' && i + 2 < n && is_hex(in[i + 1]) && is_hex(in[i + 2])) {
			ok = buf_addc(&dec, (char)(hexval(in[i + 1]) * 16 + hexval(in[i + 2])));
			i += 2;
		} else {
			ok = buf_addcp(&dec, in[i]);
		}
	}
	if (ok) ok = domain_to_ascii(dec.p ? dec.p : "", dec.n, &ascii, &f);
	buf_free(&dec);
	if (!ok) { buf_free(&ascii); return false; }
	if (f) { buf_free(&ascii); *failed = true; return true; }
	for (i = 0; i < ascii.n; i++) {
		if (forbidden_domain((unsigned char)ascii.p[i])) {
			buf_free(&ascii);
			*failed = true;
			return true;
		}
	}
	if (ends_in_number(ascii.p, ascii.n)) {
		char t[20];

		if (!parse_ipv4(ascii.p, ascii.n, &v4)) {
			buf_free(&ascii);
			*failed = true;
			return true;
		}
		snprintf(t, sizeof(t), "%u.%u.%u.%u", (unsigned)(v4 >> 24),
			 (unsigned)((v4 >> 16) & 255), (unsigned)((v4 >> 8) & 255),
			 (unsigned)(v4 & 255));
		buf_free(&ascii);
		return buf_adds(out, t);
	}
	ok = buf_copy(out, &ascii);
	buf_free(&ascii);
	return ok;
}

/* the host parser into out, which is left as it was on failure */
static bool parse_host(const uint32_t *in, size_t n, bool not_special,
		       struct url_buf *out, bool *failed)
{
	struct url_buf t = { NULL, 0, 0 };
	bool ok = parse_host_to(in, n, not_special, &t, failed);

	if (ok && !*failed) ok = buf_copy(out, &t);
	buf_free(&t);
	return ok;
}

/* --- paths ----------------------------------------------------------- */

static bool windows_letter(const uint32_t *c, size_t n, bool normalized)
{
	if (n < 2 || !is_alpha(c[0])) return false;
	return c[1] == ':' || (!normalized && c[1] == '|');
}

static bool starts_with_letter(const uint32_t *c, size_t n)
{
	return n >= 2 && windows_letter(c, 2, false) &&
		(n == 2 || c[2] == '/' || c[2] == '\\' || c[2] == '?' || c[2] == '#');
}

static bool seg_is_normalized_letter(const struct url_buf *s)
{
	return s->n == 2 && is_alpha((unsigned char)s->p[0]) && s->p[1] == ':';
}

static void shorten(struct url *u)
{
	if (scheme_is(u, "file") && u->nsegs == 1 &&
	    seg_is_normalized_letter(&u->segs[0])) {
		return;
	}
	path_pop(u);
}

static bool single_dot(const struct url_buf *b)
{
	const char *s = b->p ? b->p : "";

	return (b->n == 1 && s[0] == '.') ||
		(b->n == 3 && s[0] == '%' && s[1] == '2' && (s[2] == 'e' || s[2] == 'E'));
}

static bool double_dot(const struct url_buf *b)
{
	const char *s = b->p ? b->p : "";
	size_t i = 0, dots = 0;

	while (i < b->n) {
		if (s[i] == '.') { dots++; i++; }
		else if (i + 2 < b->n + 0 && s[i] == '%' && s[i + 1] == '2' &&
			 (s[i + 2] == 'e' || s[i + 2] == 'E')) { dots++; i += 3; }
		else return false;
	}
	return dots == 2;
}

/* --- the parser ------------------------------------------------------ */

enum state {
	S_NONE, S_SCHEME_START, S_SCHEME, S_NO_SCHEME,
	S_SPECIAL_RELATIVE_OR_AUTHORITY, S_PATH_OR_AUTHORITY, S_RELATIVE,
	S_RELATIVE_SLASH, S_SPECIAL_AUTHORITY_SLASHES,
	S_SPECIAL_AUTHORITY_IGNORE_SLASHES, S_AUTHORITY, S_HOST, S_HOSTNAME,
	S_PORT, S_FILE, S_FILE_SLASH, S_FILE_HOST, S_PATH_START, S_PATH,
	S_OPAQUE_PATH, S_QUERY, S_FRAGMENT
};

static enum state state_of(enum url_part override)
{
	switch (override) {
	case URL_PROTOCOL: return S_SCHEME_START;
	case URL_HOST: return S_HOST;
	case URL_HOSTNAME: return S_HOSTNAME;
	case URL_PORT: return S_PORT;
	case URL_PATHNAME: return S_PATH_START;
	case URL_SEARCH: return S_QUERY;
	case URL_HASH: return S_FRAGMENT;
	default: return S_NONE;
	}
}

#define EOF_CP 0xffffffffu

/*
 * The basic URL parser. With override, u is the URL to change and
 * input the new value of that part. Returns URL_OK, URL_FAILURE, or
 * URL_UNCHANGED when an override returns early leaving u as it was;
 * URL_NOMEM when memory ran out.
 */
static int parse(const char *input, size_t len, const struct url *base,
		 struct url *u, enum url_part override)
{
	uint32_t *cp0, *cp;
	size_t n, i, k;
	enum state st = override != URL_HREF ? state_of(override) : S_SCHEME_START;
	struct url_buf buf = { NULL, 0, 0 };
	bool at_seen = false, inside_brackets = false, password_seen = false;
	int rc = URL_OK;
	size_t p;

	cp0 = decode(input, len, &n);
	if (cp0 == NULL) return URL_NOMEM;
	cp = cp0;
	if (override == URL_HREF) {
		/* leading and trailing C0 controls and spaces */
		while (n > 0 && cp[0] <= 0x20) { cp++; n--; }
		while (n > 0 && cp[n - 1] <= 0x20) n--;
	}
	/* every ASCII tab or newline */
	for (i = 0, k = 0; i < n; i++) {
		if (cp[i] != '\t' && cp[i] != '\n' && cp[i] != '\r') cp[k++] = cp[i];
	}
	n = k;

#define C (p < n ? cp[p] : EOF_CP)
#define REM(o) (p + (o) < n ? cp[p + (o)] : EOF_CP)
#define FAIL do { rc = URL_FAILURE; goto out; } while (0)
#define NOMEM do { rc = URL_NOMEM; goto out; } while (0)
#define TRY(x) do { if (!(x)) NOMEM; } while (0)

	for (p = 0;; p++) {
		uint32_t c = C;

		switch (st) {
		case S_SCHEME_START:
			if (c != EOF_CP && is_alpha(c)) {
				TRY(buf_addc(&buf, (char)lower(c)));
				st = S_SCHEME;
			} else if (override == URL_HREF) {
				st = S_NO_SCHEME;
				p--;
			} else {
				FAIL;
			}
			break;

		case S_SCHEME:
			if (c != EOF_CP && (is_alpha(c) || is_digit(c) || c == '+' ||
					    c == '-' || c == '.')) {
				TRY(buf_addc(&buf, (char)lower(c)));
			} else if (c == ':') {
				if (override != URL_HREF) {
					bool was = is_special(u), now = is_special_s(buf.p, buf.n);

					if (was != now) { rc = URL_UNCHANGED; goto out; }
					if ((u->username.n || u->password.n || u->port >= 0) &&
					    buf.n == 4 && memcmp(buf.p, "file", 4) == 0) {
						rc = URL_UNCHANGED; goto out;
					}
					if (scheme_is(u, "file") && !u->host_null && u->host.n == 0) {
						rc = URL_UNCHANGED; goto out;
					}
				}
				TRY(buf_set(&u->scheme, buf.p, buf.n));
				if (override != URL_HREF) {
					if (u->port == default_port(u)) u->port = -1;
					goto out;
				}
				buf_clear(&buf);
				if (scheme_is(u, "file")) {
					st = S_FILE;
				} else if (is_special(u) && base != NULL &&
					   base->scheme.n == u->scheme.n &&
					   memcmp(base->scheme.p, u->scheme.p, u->scheme.n) == 0) {
					st = S_SPECIAL_RELATIVE_OR_AUTHORITY;
				} else if (is_special(u)) {
					st = S_SPECIAL_AUTHORITY_SLASHES;
				} else if (REM(1) == '/') {
					st = S_PATH_OR_AUTHORITY;
					p++;
				} else {
					u->opaque = true;
					buf_clear(&u->opaque_path);
					st = S_OPAQUE_PATH;
				}
			} else if (override == URL_HREF) {
				buf_clear(&buf);
				st = S_NO_SCHEME;
				p = (size_t)-1;	/* start over */
			} else {
				FAIL;
			}
			break;

		case S_NO_SCHEME:
			if (base == NULL || (base->opaque && c != '#')) FAIL;
			if (base->opaque && c == '#') {
				TRY(url_copy(u, base));
				buf_clear(&u->fragment);
				u->fragment_null = false;
				st = S_FRAGMENT;
			} else if (!(base->scheme.n == 4 && memcmp(base->scheme.p, "file", 4) == 0)) {
				st = S_RELATIVE;
				p--;
			} else {
				st = S_FILE;
				p--;
			}
			break;

		case S_SPECIAL_RELATIVE_OR_AUTHORITY:
			if (c == '/' && REM(1) == '/') {
				st = S_SPECIAL_AUTHORITY_IGNORE_SLASHES;
				p++;
			} else {
				st = S_RELATIVE;
				p--;
			}
			break;

		case S_PATH_OR_AUTHORITY:
			if (c == '/') {
				st = S_AUTHORITY;
			} else {
				st = S_PATH;
				p--;
			}
			break;

		case S_RELATIVE:
			TRY(buf_copy(&u->scheme, &base->scheme));
			if (c == '/') {
				st = S_RELATIVE_SLASH;
			} else if (is_special(u) && c == '\\') {
				st = S_RELATIVE_SLASH;
			} else {
				TRY(buf_copy(&u->username, &base->username));
				TRY(buf_copy(&u->password, &base->password));
				TRY(buf_copy(&u->host, &base->host));
				u->host_null = base->host_null;
				u->port = base->port;
				path_clear(u);
				for (k = 0; k < base->nsegs; k++)
					TRY(path_push(u, base->segs[k].p ? base->segs[k].p : "", base->segs[k].n));
				TRY(buf_copy(&u->query, &base->query));
				u->query_null = base->query_null;
				if (c == '?') {
					buf_clear(&u->query);
					u->query_null = false;
					st = S_QUERY;
				} else if (c == '#') {
					buf_clear(&u->fragment);
					u->fragment_null = false;
					st = S_FRAGMENT;
				} else if (c != EOF_CP) {
					buf_clear(&u->query);
					u->query_null = true;
					shorten(u);
					st = S_PATH;
					p--;
				}
			}
			break;

		case S_RELATIVE_SLASH:
			if (is_special(u) && (c == '/' || c == '\\')) {
				st = S_SPECIAL_AUTHORITY_IGNORE_SLASHES;
			} else if (c == '/') {
				st = S_AUTHORITY;
			} else {
				TRY(buf_copy(&u->username, &base->username));
				TRY(buf_copy(&u->password, &base->password));
				TRY(buf_copy(&u->host, &base->host));
				u->host_null = base->host_null;
				u->port = base->port;
				st = S_PATH;
				p--;
			}
			break;

		case S_SPECIAL_AUTHORITY_SLASHES:
			if (c == '/' && REM(1) == '/') {
				st = S_SPECIAL_AUTHORITY_IGNORE_SLASHES;
				p++;
			} else {
				st = S_SPECIAL_AUTHORITY_IGNORE_SLASHES;
				p--;
			}
			break;

		case S_SPECIAL_AUTHORITY_IGNORE_SLASHES:
			if (c != '/' && c != '\\') {
				st = S_AUTHORITY;
				p--;
			}
			break;

		case S_AUTHORITY:
			if (c == '@') {
				uint32_t *dc;
				size_t dn, j;

				if (at_seen) {
					struct url_buf t = { NULL, 0, 0 };

					TRY(buf_adds(&t, "%40"));
					TRY(buf_add(&t, buf.p ? buf.p : "", buf.n));
					TRY(buf_set(&buf, t.p, t.n));
					buf_free(&t);
				}
				at_seen = true;
				dc = decode(buf.p ? buf.p : "", buf.n, &dn);
				if (dc == NULL) NOMEM;
				for (j = 0; j < dn; j++) {
					if (dc[j] == ':' && !password_seen) {
						password_seen = true;
						continue;
					}
					if (!add_encoded(password_seen ? &u->password : &u->username,
							 dc[j], PE_USERINFO)) {
						free(dc);
						NOMEM;
					}
				}
				free(dc);
				buf_clear(&buf);
			} else if (c == EOF_CP || c == '/' || c == '?' || c == '#' ||
				   (is_special(u) && c == '\\')) {
				size_t back;

				if (at_seen && buf.n == 0) FAIL;
				{	/* the buffer's code points */
					size_t dn;
					uint32_t *dc = decode(buf.p ? buf.p : "", buf.n, &dn);

					if (dc == NULL) NOMEM;
					back = dn;
					free(dc);
				}
				p -= back + 1;
				buf_clear(&buf);
				st = S_HOST;
			} else {
				TRY(buf_addcp(&buf, c));
			}
			break;

		case S_HOST:
		case S_HOSTNAME:
			if (override != URL_HREF && scheme_is(u, "file")) {
				p--;
				st = S_FILE_HOST;
			} else if (c == ':' && !inside_brackets) {
				uint32_t *dc;
				size_t dn;
				bool f;

				if (buf.n == 0) FAIL;
				if (override == URL_HOSTNAME) { rc = URL_UNCHANGED; goto out; }
				dc = decode(buf.p, buf.n, &dn);
				if (dc == NULL) NOMEM;
				if (!parse_host(dc, dn, !is_special(u), &u->host, &f)) { free(dc); NOMEM; }
				free(dc);
				if (f) FAIL;
				u->host_null = false;
				buf_clear(&buf);
				st = S_PORT;
			} else if (c == EOF_CP || c == '/' || c == '?' || c == '#' ||
				   (is_special(u) && c == '\\')) {
				uint32_t *dc;
				size_t dn;
				bool f;

				p--;
				if (is_special(u) && buf.n == 0) FAIL;
				else if (override != URL_HREF && buf.n == 0 &&
					 (u->username.n || u->password.n || u->port >= 0)) {
					rc = URL_UNCHANGED; goto out;
				}
				dc = decode(buf.p ? buf.p : "", buf.n, &dn);
				if (dc == NULL) NOMEM;
				if (!parse_host(dc, dn, !is_special(u), &u->host, &f)) { free(dc); NOMEM; }
				free(dc);
				if (f) FAIL;
				u->host_null = false;
				buf_clear(&buf);
				st = S_PATH_START;
				if (override != URL_HREF) goto out;
			} else {
				if (c == '[') inside_brackets = true;
				if (c == ']') inside_brackets = false;
				TRY(buf_addcp(&buf, c));
			}
			break;

		case S_PORT:
			if (c != EOF_CP && is_digit(c)) {
				TRY(buf_addc(&buf, (char)c));
			} else if (c == EOF_CP || c == '/' || c == '?' || c == '#' ||
				   (is_special(u) && c == '\\') || override != URL_HREF) {
				if (buf.n != 0) {
					unsigned long v = 0;

					for (k = 0; k < buf.n; k++) {
						v = v * 10 + (unsigned long)(buf.p[k] - '0');
						if (v > 65535) FAIL;
					}
					u->port = (int)v == default_port(u) ? -1 : (int)v;
					buf_clear(&buf);
					if (override != URL_HREF) goto out;
				}
				if (override != URL_HREF) { rc = URL_FAILURE; goto out; }
				st = S_PATH_START;
				p--;
			} else {
				FAIL;
			}
			break;

		case S_FILE:
			TRY(buf_set(&u->scheme, "file", 4));
			buf_clear(&u->host);
			u->host_null = false;
			if (c == '/' || c == '\\') {
				st = S_FILE_SLASH;
			} else if (base != NULL && base->scheme.n == 4 &&
				   memcmp(base->scheme.p, "file", 4) == 0) {
				TRY(buf_copy(&u->host, &base->host));
				u->host_null = base->host_null;
				path_clear(u);
				for (k = 0; k < base->nsegs; k++)
					TRY(path_push(u, base->segs[k].p ? base->segs[k].p : "", base->segs[k].n));
				TRY(buf_copy(&u->query, &base->query));
				u->query_null = base->query_null;
				if (c == '?') {
					buf_clear(&u->query);
					u->query_null = false;
					st = S_QUERY;
				} else if (c == '#') {
					buf_clear(&u->fragment);
					u->fragment_null = false;
					st = S_FRAGMENT;
				} else if (c != EOF_CP) {
					buf_clear(&u->query);
					u->query_null = true;
					if (!starts_with_letter(cp + p, n - p)) {
						shorten(u);
					} else {
						path_clear(u);
					}
					st = S_PATH;
					p--;
				}
			} else {
				st = S_PATH;
				p--;
			}
			break;

		case S_FILE_SLASH:
			if (c == '/' || c == '\\') {
				st = S_FILE_HOST;
			} else {
				if (base != NULL && base->scheme.n == 4 &&
				    memcmp(base->scheme.p, "file", 4) == 0) {
					TRY(buf_copy(&u->host, &base->host));
					u->host_null = base->host_null;
					if (!starts_with_letter(cp + p, n - p) &&
					    base->nsegs > 0 &&
					    seg_is_normalized_letter(&base->segs[0])) {
						TRY(path_push(u, base->segs[0].p, base->segs[0].n));
					}
				}
				st = S_PATH;
				p--;
			}
			break;

		case S_FILE_HOST:
			if (c == EOF_CP || c == '/' || c == '\\' || c == '?' || c == '#') {
				uint32_t *dc;
				size_t dn;
				bool f;

				p--;
				dc = decode(buf.p ? buf.p : "", buf.n, &dn);
				if (dc == NULL) NOMEM;
				if (override == URL_HREF && windows_letter(dc, dn, false) && dn == 2) {
					free(dc);
					st = S_PATH;
				} else if (buf.n == 0) {
					free(dc);
					buf_clear(&u->host);
					u->host_null = false;
					if (override != URL_HREF) goto out;
					st = S_PATH_START;
				} else {
					if (!parse_host(dc, dn, !is_special(u), &u->host, &f)) { free(dc); NOMEM; }
					free(dc);
					if (f) FAIL;
					u->host_null = false;
					if (u->host.n == 9 && memcmp(u->host.p, "localhost", 9) == 0)
						buf_clear(&u->host);
					if (override != URL_HREF) goto out;
					buf_clear(&buf);
					st = S_PATH_START;
				}
			} else {
				TRY(buf_addcp(&buf, c));
			}
			break;

		case S_PATH_START:
			if (is_special(u)) {
				st = S_PATH;
				if (c != '/' && c != '\\') p--;
			} else if (override == URL_HREF && c == '?') {
				buf_clear(&u->query);
				u->query_null = false;
				st = S_QUERY;
			} else if (override == URL_HREF && c == '#') {
				buf_clear(&u->fragment);
				u->fragment_null = false;
				st = S_FRAGMENT;
			} else if (c != EOF_CP) {
				st = S_PATH;
				if (c != '/') p--;
			} else if (override != URL_HREF && u->host_null) {
				TRY(path_push(u, "", 0));
			}
			break;

		case S_PATH:
			if (c == EOF_CP || c == '/' || (is_special(u) && c == '\\') ||
			    (override == URL_HREF && (c == '?' || c == '#'))) {
				bool slash = c == '/' || (is_special(u) && c == '\\');

				if (double_dot(&buf)) {
					shorten(u);
					if (!slash) TRY(path_push(u, "", 0));
				} else if (single_dot(&buf) && !slash) {
					TRY(path_push(u, "", 0));
				} else if (!single_dot(&buf)) {
					if (scheme_is(u, "file") && u->nsegs == 0 &&
					    buf.n == 2 && is_alpha((unsigned char)buf.p[0]) &&
					    (buf.p[1] == ':' || buf.p[1] == '|')) {
						buf.p[1] = ':';
					}
					TRY(path_push(u, buf.p ? buf.p : "", buf.n));
				}
				buf_clear(&buf);
				if (c == '?') {
					buf_clear(&u->query);
					u->query_null = false;
					st = S_QUERY;
				}
				if (c == '#') {
					buf_clear(&u->fragment);
					u->fragment_null = false;
					st = S_FRAGMENT;
				}
			} else {
				TRY(add_encoded(&buf, c, PE_PATH));
			}
			break;

		case S_OPAQUE_PATH:
			if (c == '?') {
				buf_clear(&u->query);
				u->query_null = false;
				st = S_QUERY;
			} else if (c == '#') {
				buf_clear(&u->fragment);
				u->fragment_null = false;
				st = S_FRAGMENT;
			} else if (c == ' ') {
				/* a trailing space is %20 when a query or fragment follows */
				if (REM(1) == '?' || REM(1) == '#') TRY(buf_adds(&u->opaque_path, "%20"));
				else TRY(buf_addc(&u->opaque_path, ' '));
			} else if (c != EOF_CP) {
				TRY(add_encoded(&u->opaque_path, c, PE_C0));
			}
			break;

		case S_QUERY:
			if ((override == URL_HREF && c == '#') || c == EOF_CP) {
				size_t j;

				for (j = 0; j < buf.n; j++) {
					/* buf holds UTF-8; encode its code points */
				}
				{
					size_t dn;
					uint32_t *dc = decode(buf.p ? buf.p : "", buf.n, &dn);

					if (dc == NULL) NOMEM;
					for (j = 0; j < dn; j++) {
						if (!add_encoded(&u->query, dc[j],
								 is_special(u) ? PE_SPECIAL_QUERY : PE_QUERY)) {
							free(dc);
							NOMEM;
						}
					}
					free(dc);
				}
				buf_clear(&buf);
				if (c == '#') {
					buf_clear(&u->fragment);
					u->fragment_null = false;
					st = S_FRAGMENT;
				}
			} else if (c != EOF_CP) {
				TRY(buf_addcp(&buf, c));
			}
			break;

		case S_FRAGMENT:
			if (c != EOF_CP) TRY(add_encoded(&u->fragment, c, PE_FRAGMENT));
			break;

		case S_NONE:
			FAIL;
		}
		if (p != (size_t)-1 && p >= n) break;
	}
out:
	buf_free(&buf);
	free(cp0);
	return rc;
#undef C
#undef REM
#undef FAIL
#undef NOMEM
#undef TRY
}

/* --- serialising ------------------------------------------------------ */

static bool serialize_path(const struct url *u, struct url_buf *b)
{
	size_t i;

	if (u->opaque) {
		return buf_add(b, u->opaque_path.p ? u->opaque_path.p : "", u->opaque_path.n);
	}
	for (i = 0; i < u->nsegs; i++) {
		if (!buf_addc(b, '/') ||
		    !buf_add(b, u->segs[i].p ? u->segs[i].p : "", u->segs[i].n)) return false;
	}
	return true;
}

bool url_serialize(const struct url *u, struct url_buf *b, bool exclude_fragment)
{
	char t[16];

	buf_clear(b);
	if (!buf_add(b, u->scheme.p ? u->scheme.p : "", u->scheme.n) || !buf_addc(b, ':'))
		return false;
	if (!u->host_null) {
		if (!buf_adds(b, "//")) return false;
		if (u->username.n || u->password.n) {
			if (!buf_add(b, u->username.p ? u->username.p : "", u->username.n)) return false;
			if (u->password.n && (!buf_addc(b, ':') ||
					      !buf_add(b, u->password.p, u->password.n))) return false;
			if (!buf_addc(b, '@')) return false;
		}
		if (!buf_add(b, u->host.p ? u->host.p : "", u->host.n)) return false;
		if (u->port >= 0) {
			snprintf(t, sizeof(t), ":%d", u->port);
			if (!buf_adds(b, t)) return false;
		}
	} else if (!u->opaque && u->nsegs > 1 && u->segs[0].n == 0) {
		/* a path that would read as a host is kept a path */
		if (!buf_adds(b, "/.")) return false;
	}
	if (!serialize_path(u, b)) return false;
	if (!u->query_null && (!buf_addc(b, '?') ||
			       !buf_add(b, u->query.p ? u->query.p : "", u->query.n))) return false;
	if (!exclude_fragment && !u->fragment_null &&
	    (!buf_addc(b, '#') || !buf_add(b, u->fragment.p ? u->fragment.p : "", u->fragment.n)))
		return false;
	return true;
}

bool url_pathname(const struct url *u, struct url_buf *b)
{
	buf_clear(b);
	return serialize_path(u, b);
}

/* --- the API ----------------------------------------------------------- */

int url_parse(const char *input, size_t len, const struct url *base,
	      struct url *out)
{
	int rc;

	url_free(out);
	rc = parse(input, len, base, out, URL_HREF);
	if (rc != URL_OK) url_free(out);
	return rc;
}

int url_set(struct url *u, enum url_part part, const char *value, size_t len)
{
	struct url t;
	int rc;
	char *v = NULL;

	url_init(&t);
	if (!url_copy(&t, u)) { url_free(&t); return URL_NOMEM; }
	switch (part) {
	case URL_USERNAME:
	case URL_PASSWORD: {
		struct url_buf *dst = part == URL_USERNAME ? &t.username : &t.password;
		size_t dn, j;
		uint32_t *dc;

		if (t.host_null || t.host.n == 0 || scheme_is(&t, "file")) {
			url_free(&t);
			return URL_UNCHANGED;
		}
		dc = decode(value, len, &dn);
		if (dc == NULL) { url_free(&t); return URL_NOMEM; }
		buf_clear(dst);
		for (j = 0; j < dn; j++) {
			if (!add_encoded(dst, dc[j], PE_USERINFO)) { free(dc); url_free(&t); return URL_NOMEM; }
		}
		free(dc);
		rc = URL_OK;
		break;
	}
	case URL_PROTOCOL: {
		/* the value and a colon, through the scheme start state */
		v = malloc(len + 2);
		if (v == NULL) { url_free(&t); return URL_NOMEM; }
		memcpy(v, value, len);
		v[len] = ':';
		rc = parse(v, len + 1, NULL, &t, URL_PROTOCOL);
		break;
	}
	case URL_HOST:
	case URL_HOSTNAME:
		if (t.opaque) { url_free(&t); return URL_UNCHANGED; }
		rc = parse(value, len, NULL, &t, part);
		break;
	case URL_PORT:
		if (t.host_null || t.host.n == 0 || scheme_is(&t, "file")) {
			url_free(&t);
			return URL_UNCHANGED;
		}
		if (len == 0) { t.port = -1; rc = URL_OK; break; }
		rc = parse(value, len, NULL, &t, URL_PORT);
		break;
	case URL_PATHNAME:
		if (t.opaque) { url_free(&t); return URL_UNCHANGED; }
		path_clear(&t);
		rc = parse(value, len, NULL, &t, URL_PATHNAME);
		break;
	case URL_SEARCH:
		if (len == 0) {
			buf_clear(&t.query);
			t.query_null = true;
			rc = URL_OK;
			break;
		}
		if (value[0] == '?') { value++; len--; }
		buf_clear(&t.query);
		t.query_null = false;
		rc = parse(value, len, NULL, &t, URL_SEARCH);
		break;
	case URL_HASH:
		if (len == 0) {
			buf_clear(&t.fragment);
			t.fragment_null = true;
			rc = URL_OK;
			break;
		}
		if (value[0] == '#') { value++; len--; }
		buf_clear(&t.fragment);
		t.fragment_null = false;
		rc = parse(value, len, NULL, &t, URL_HASH);
		break;
	default:
		rc = URL_FAILURE;
		break;
	}
	free(v);
	/* what the parser changed before it stopped stays changed, as the
	   standard's setters work on the URL itself: "example.com:invalid"
	   sets the host and not the port */
	if (rc != URL_NOMEM) {
		/* an opaque path loses a trailing space with its query or
		   fragment, as the standard strips it */
		if (t.opaque && t.fragment_null && t.query_null) {
			while (t.opaque_path.n > 0 && t.opaque_path.p[t.opaque_path.n - 1] == ' ')
				t.opaque_path.p[--t.opaque_path.n] = '\0';
		}
		url_free(u);
		*u = t;
		return rc == URL_OK ? URL_OK : URL_UNCHANGED;
	}
	url_free(&t);
	return URL_NOMEM;
}

/* --- application/x-www-form-urlencoded --------------------------------- */

/* one name or value of a query: '+' is a space, a percent-encoded byte is
   that byte, and what is not UTF-8 is U+FFFD */
bool url_form_decode(const char *s, size_t n, struct url_buf *out)
{
	struct url_buf bytes = { NULL, 0, 0 };
	uint32_t *cp;
	size_t i, cn;
	bool ok = true;

	buf_clear(out);
	for (i = 0; i < n && ok; i++) {
		unsigned char c = (unsigned char)s[i];

		if (c == '+') {
			ok = buf_addc(&bytes, ' ');
		} else if (c == '%' && i + 2 < n + 0 && is_hex((unsigned char)s[i + 1]) &&
			   is_hex((unsigned char)s[i + 2])) {
			ok = buf_addc(&bytes, (char)(hexval((unsigned char)s[i + 1]) * 16 +
						   hexval((unsigned char)s[i + 2])));
			i += 2;
		} else {
			ok = buf_addc(&bytes, (char)c);
		}
	}
	if (!ok) { buf_free(&bytes); return false; }
	cp = decode(bytes.p ? bytes.p : "", bytes.n, &cn);
	buf_free(&bytes);
	if (cp == NULL) return false;
	for (i = 0; i < cn && ok; i++) ok = buf_addcp(out, cp[i]);
	free(cp);
	if (ok && out->p == NULL) ok = buf_adds(out, "");
	return ok;
}

/* the serialiser's encoding of one name or value, appended to out */
bool url_form_encode(const char *s, size_t n, struct url_buf *out)
{
	static const char hx[] = "0123456789ABCDEF";
	uint32_t *cp;
	size_t i, cn;
	bool ok = true;
	struct url_buf u = { NULL, 0, 0 };

	/* through code points, so a lone surrogate becomes U+FFFD */
	cp = decode(s, n, &cn);
	if (cp == NULL) return false;
	for (i = 0; i < cn && ok; i++) ok = buf_addcp(&u, cp[i]);
	free(cp);
	for (i = 0; ok && i < u.n; i++) {
		unsigned char c = (unsigned char)u.p[i];

		if (c == ' ') {
			ok = buf_addc(out, '+');
		} else if (c == '*' || c == '-' || c == '.' || c == '_' ||
			   is_digit(c) || is_alpha(c)) {
			ok = buf_addc(out, (char)c);
		} else {
			char e[3] = { '%', hx[c >> 4], hx[c & 15] };

			ok = buf_add(out, e, 3);
		}
	}
	buf_free(&u);
	if (ok && out->p == NULL) ok = buf_adds(out, "");
	return ok;
}

void url_buf_free(struct url_buf *b)
{
	buf_free(b);
}

bool url_buf_append(struct url_buf *b, const char *s, size_t n)
{
	return buf_add(b, s, n);
}
