/*
 * FlareSolverr client: hand a Cloudflare browser check to a FlareSolverr
 * server the user runs on the same network, and reuse its answer.
 *
 * FlareSolverr (MIT, https://github.com/FlareSolverr/FlareSolverr) drives
 * a real browser to pass the check and reports the cookies it was given
 * and the user agent it used. Cloudflare ties the clearance cookie to
 * that user agent and to the client's public address, so this only works
 * when the Vita and the FlareSolverr host share a connection, and the
 * browser switches to the reported user agent for the rest of the
 * session.
 *
 * Off unless ux0:data/VitaSurf/flaresolverr exists and holds the server
 * URL, for example http://192.168.1.20:8191/v1. The request blocks the
 * browser for the time the solver needs (usually 5 to 20 s, 90 s at most).
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <curl/curl.h>

#include "utils/errors.h"
#include "utils/nsurl.h"
#include "utils/useragent.h"
#include "content/urldb.h"

#include "vita_platform.h"

/* ------------------------------------------------------------------------ */
/* Configuration                                                            */

static char endpoint[256];
static bool endpoint_loaded;

const char *vita_flaresolverr_endpoint(void)
{
	char *data = NULL;
	size_t len = 0, n;

	if (endpoint_loaded) {
		return endpoint[0] ? endpoint : NULL;
	}
	endpoint_loaded = true;
	if (vita_read_file(VITASURF_FLARESOLVERR_PATH, &data, &len) != 0) {
		return NULL;
	}
	/* first line, trimmed */
	for (n = 0; n < len && n < sizeof(endpoint) - 1; n++) {
		if (data[n] == '\n' || data[n] == '\r') {
			break;
		}
		endpoint[n] = data[n];
	}
	endpoint[n] = '\0';
	while (n > 0 && isspace((unsigned char)endpoint[n - 1])) {
		endpoint[--n] = '\0';
	}
	free(data);
	if (strncmp(endpoint, "http://", 7) != 0 &&
	    strncmp(endpoint, "https://", 8) != 0) {
		vita_log("flaresolverr: %s does not hold a URL, ignored",
			 VITASURF_FLARESOLVERR_PATH);
		endpoint[0] = '\0';
		return NULL;
	}
	vita_log("flaresolverr: using %s", endpoint);
	return endpoint;
}

/* ------------------------------------------------------------------------ */
/* Minimal JSON reader: enough for FlareSolverr's reply                     */

enum jtype { J_NULL, J_BOOL, J_NUMBER, J_STRING, J_ARRAY, J_OBJECT };

struct jval {
	enum jtype type;
	char *str;            /* J_STRING */
	double num;           /* J_NUMBER, J_BOOL */
	struct jval **items;  /* J_ARRAY, J_OBJECT (values) */
	char **keys;          /* J_OBJECT */
	int count;
};

static void jfree(struct jval *v)
{
	int i;

	if (v == NULL) return;
	free(v->str);
	for (i = 0; i < v->count; i++) {
		jfree(v->items[i]);
		if (v->keys != NULL) free(v->keys[i]);
	}
	free(v->items);
	free(v->keys);
	free(v);
}

static const char *skip_ws(const char *p)
{
	while (*p != '\0' && isspace((unsigned char)*p)) p++;
	return p;
}

static struct jval *jparse(const char **pp, int depth);

static char *jparse_string(const char **pp)
{
	const char *p = *pp;
	char *out;
	size_t cap = 64, n = 0;

	if (*p != '"') return NULL;
	p++;
	out = malloc(cap);
	if (out == NULL) return NULL;
	while (*p != '\0' && *p != '"') {
		unsigned int c = (unsigned char)*p++;
		char buf[4];
		size_t blen = 1;

		if (c == '\\') {
			c = (unsigned char)*p++;
			switch (c) {
			case 'n': c = '\n'; break;
			case 't': c = '\t'; break;
			case 'r': c = '\r'; break;
			case 'b': c = '\b'; break;
			case 'f': c = '\f'; break;
			case 'u': {
				unsigned int cp = 0;
				int i;
				for (i = 0; i < 4 && isxdigit((unsigned char)p[i]); i++) {
					cp = cp * 16 + (unsigned)(isdigit((unsigned char)p[i]) ?
						p[i] - '0' : (tolower((unsigned char)p[i]) - 'a' + 10));
				}
				p += i;
				if (cp < 0x80) {
					buf[0] = (char)cp; blen = 1;
				} else if (cp < 0x800) {
					buf[0] = (char)(0xC0 | (cp >> 6));
					buf[1] = (char)(0x80 | (cp & 0x3F)); blen = 2;
				} else {
					buf[0] = (char)(0xE0 | (cp >> 12));
					buf[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
					buf[2] = (char)(0x80 | (cp & 0x3F)); blen = 3;
				}
				c = 0;
				break;
			}
			case '\0': free(out); return NULL;
			default: break; /* \" \\ \/ */
			}
		}
		if (blen == 1 && c != 0) buf[0] = (char)c;
		else if (c != 0) { buf[0] = (char)c; blen = 1; }
		if (n + blen + 1 > cap) {
			char *grown;
			cap *= 2;
			grown = realloc(out, cap);
			if (grown == NULL) { free(out); return NULL; }
			out = grown;
		}
		memcpy(out + n, buf, blen);
		n += blen;
	}
	if (*p != '"') { free(out); return NULL; }
	out[n] = '\0';
	*pp = p + 1;
	return out;
}

static bool jpush(struct jval *v, char *key, struct jval *item)
{
	struct jval **items = realloc(v->items, sizeof(*items) * (size_t)(v->count + 1));

	if (items == NULL) return false;
	v->items = items;
	if (v->type == J_OBJECT) {
		char **keys = realloc(v->keys, sizeof(*keys) * (size_t)(v->count + 1));
		if (keys == NULL) return false;
		v->keys = keys;
		v->keys[v->count] = key;
	}
	v->items[v->count++] = item;
	return true;
}

static struct jval *jparse(const char **pp, int depth)
{
	const char *p = skip_ws(*pp);
	struct jval *v;

	if (depth > 32 || *p == '\0') return NULL;
	v = calloc(1, sizeof(*v));
	if (v == NULL) return NULL;

	if (*p == '{' || *p == '[') {
		bool object = (*p == '{');
		char close = object ? '}' : ']';

		v->type = object ? J_OBJECT : J_ARRAY;
		p = skip_ws(p + 1);
		while (*p != close) {
			char *key = NULL;
			struct jval *item;

			if (object) {
				key = jparse_string(&p);
				if (key == NULL) goto fail;
				p = skip_ws(p);
				if (*p != ':') { free(key); goto fail; }
				p++;
			}
			item = jparse(&p, depth + 1);
			if (item == NULL || !jpush(v, key, item)) {
				free(key);
				jfree(item);
				goto fail;
			}
			p = skip_ws(p);
			if (*p == ',') p = skip_ws(p + 1);
			else if (*p != close) goto fail;
		}
		p++;
	} else if (*p == '"') {
		v->type = J_STRING;
		v->str = jparse_string(&p);
		if (v->str == NULL) goto fail;
	} else if (strncmp(p, "true", 4) == 0) {
		v->type = J_BOOL; v->num = 1; p += 4;
	} else if (strncmp(p, "false", 5) == 0) {
		v->type = J_BOOL; v->num = 0; p += 5;
	} else if (strncmp(p, "null", 4) == 0) {
		v->type = J_NULL; p += 4;
	} else {
		char *end;
		v->type = J_NUMBER;
		v->num = strtod(p, &end);
		if (end == p) goto fail;
		p = end;
	}
	*pp = p;
	return v;
fail:
	jfree(v);
	return NULL;
}

static struct jval *jget(struct jval *obj, const char *key)
{
	int i;

	if (obj == NULL || obj->type != J_OBJECT) return NULL;
	for (i = 0; i < obj->count; i++) {
		if (strcmp(obj->keys[i], key) == 0) return obj->items[i];
	}
	return NULL;
}

static const char *jstr(struct jval *obj, const char *key)
{
	struct jval *v = jget(obj, key);
	return (v != NULL && v->type == J_STRING) ? v->str : NULL;
}

/* ------------------------------------------------------------------------ */
/* HTTP                                                                     */

struct buffer {
	char *data;
	size_t len;
};

#define REPLY_MAX (8 * 1024 * 1024)

static size_t on_data(char *ptr, size_t size, size_t nmemb, void *userdata)
{
	struct buffer *b = userdata;
	size_t n = size * nmemb;
	char *grown;

	if (b->len + n + 1 > REPLY_MAX) {
		return 0; /* abort: reply too large */
	}
	grown = realloc(b->data, b->len + n + 1);
	if (grown == NULL) {
		return 0;
	}
	b->data = grown;
	memcpy(b->data + b->len, ptr, n);
	b->len += n;
	b->data[b->len] = '\0';
	return n;
}

/** Append s to out as a JSON string body (no quotes), escaping as needed. */
static void json_escape(const char *s, char *out, size_t len)
{
	size_t n = 0;

	while (*s != '\0' && n + 7 < len) {
		unsigned char c = (unsigned char)*s++;
		if (c == '"' || c == '\\') {
			out[n++] = '\\';
			out[n++] = (char)c;
		} else if (c < 0x20) {
			n += (size_t)snprintf(out + n, len - n, "\\u%04x", c);
		} else {
			out[n++] = (char)c;
		}
	}
	out[n] = '\0';
}

/* ------------------------------------------------------------------------ */
/* Solving                                                                  */

static void set_cookie(struct jval *cookie, nsurl *url)
{
	const char *name = jstr(cookie, "name");
	const char *value = jstr(cookie, "value");
	const char *domain = jstr(cookie, "domain");
	const char *path = jstr(cookie, "path");
	struct jval *expires = jget(cookie, "expires");
	struct jval *secure = jget(cookie, "secure");
	struct jval *httponly = jget(cookie, "httpOnly");
	char header[2048];
	size_t n;

	if (name == NULL || value == NULL) {
		return;
	}
	n = (size_t)snprintf(header, sizeof(header), "%s=%s; Path=%s",
			     name, value, path != NULL ? path : "/");
	if (domain != NULL && domain[0] != '\0' && n < sizeof(header)) {
		n += (size_t)snprintf(header + n, sizeof(header) - n,
				      "; Domain=%s", domain);
	}
	if (expires != NULL && expires->type == J_NUMBER && expires->num > 0 &&
	    n < sizeof(header)) {
		time_t t = (time_t)expires->num;
		struct tm *tm = gmtime(&t);
		char date[48];

		if (tm != NULL &&
		    strftime(date, sizeof(date), "%a, %d %b %Y %H:%M:%S GMT", tm) > 0) {
			n += (size_t)snprintf(header + n, sizeof(header) - n,
					      "; Expires=%s", date);
		}
	}
	if (secure != NULL && secure->type == J_BOOL && secure->num != 0 &&
	    n < sizeof(header)) {
		n += (size_t)snprintf(header + n, sizeof(header) - n, "; Secure");
	}
	if (httponly != NULL && httponly->type == J_BOOL && httponly->num != 0 &&
	    n < sizeof(header)) {
		n += (size_t)snprintf(header + n, sizeof(header) - n, "; HttpOnly");
	}
	if (!urldb_set_cookie(header, url, NULL)) {
		vita_log("flaresolverr: cookie %s for %s rejected", name,
			 domain != NULL ? domain : nsurl_access(url));
	}
}

bool vita_flaresolverr_solve(nsurl *url)
{
	const char *ep = vita_flaresolverr_endpoint();
	CURL *curl;
	CURLcode res;
	struct curl_slist *headers = NULL;
	struct buffer reply = { NULL, 0 };
	char escaped[2048];
	char body[2200];
	long status = 0;
	struct jval *root = NULL, *solution, *cookies;
	const char *ua, *state;
	bool ok = false;
	int i;

	if (ep == NULL || url == NULL) {
		return false;
	}
	json_escape(nsurl_access(url), escaped, sizeof(escaped));
	snprintf(body, sizeof(body),
		 "{\"cmd\":\"request.get\",\"url\":\"%s\",\"maxTimeout\":60000}",
		 escaped);

	curl = curl_easy_init();
	if (curl == NULL) {
		return false;
	}
	headers = curl_slist_append(headers, "Content-Type: application/json");
	curl_easy_setopt(curl, CURLOPT_URL, ep);
	curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
	curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
	curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_data);
	curl_easy_setopt(curl, CURLOPT_WRITEDATA, &reply);
	curl_easy_setopt(curl, CURLOPT_TIMEOUT, 90L);
	curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
	curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

	vita_log("flaresolverr: asking %s to solve %s", ep, nsurl_access(url));
	res = curl_easy_perform(curl);
	curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
	curl_slist_free_all(headers);
	curl_easy_cleanup(curl);

	if (res != CURLE_OK) {
		vita_log("flaresolverr: request failed: %s", curl_easy_strerror(res));
		free(reply.data);
		return false;
	}
	if (reply.data == NULL) {
		vita_log("flaresolverr: empty reply (HTTP %ld)", status);
		return false;
	}
	{
		const char *p = reply.data;
		root = jparse(&p, 0);
	}
	state = jstr(root, "status");
	solution = jget(root, "solution");
	if (root == NULL || state == NULL || strcmp(state, "ok") != 0 ||
	    solution == NULL) {
		const char *msg = jstr(root, "message");
		vita_log("flaresolverr: solver answered HTTP %ld, status %s: %s",
			 status, state != NULL ? state : "(none)",
			 msg != NULL ? msg : "(no message)");
		goto out;
	}

	cookies = jget(solution, "cookies");
	if (cookies != NULL && cookies->type == J_ARRAY) {
		for (i = 0; i < cookies->count; i++) {
			set_cookie(cookies->items[i], url);
		}
		vita_log("flaresolverr: %d cookies stored", cookies->count);
	}
	ua = jstr(solution, "userAgent");
	if (ua != NULL && ua[0] != '\0') {
		user_agent_override(ua);
		vita_log("flaresolverr: user agent is now \"%s\"", ua);
	}
	ok = true;
out:
	jfree(root);
	free(reply.data);
	return ok;
}
