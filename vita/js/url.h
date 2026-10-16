/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * The URL Standard's parser (url.c): a URL's parts, parsing against a
 * base, and the setters' state override.
 */

#ifndef VITASURF_URL_H
#define VITASURF_URL_H

#include <stdbool.h>
#include <stddef.h>

/* a NUL-terminated byte string that knows its length */
struct url_buf {
	char *p;
	size_t n, cap;
};

struct url {
	struct url_buf scheme, username, password;
	struct url_buf host;	/* serialised */
	bool host_null;
	int port;		/* -1 for null */
	bool opaque;		/* the path is opaque_path, not segs */
	struct url_buf opaque_path;
	struct url_buf *segs;
	size_t nsegs, capsegs;
	struct url_buf query, fragment;
	bool query_null, fragment_null;
};

/* the parts a setter takes, and URL_HREF for a whole URL */
enum url_part {
	URL_HREF, URL_PROTOCOL, URL_USERNAME, URL_PASSWORD, URL_HOST,
	URL_HOSTNAME, URL_PORT, URL_PATHNAME, URL_SEARCH, URL_HASH
};

enum { URL_OK = 0, URL_FAILURE = 1, URL_UNCHANGED = 2, URL_NOMEM = 3 };

/*
 * Maps a domain's Unicode as UTS #46 does (to lower case and NFKC), for
 * a domain that is not all ASCII: returns a malloc'd UTF-8 string and
 * its length, or NULL when the domain is not one.
 */
typedef char *(*url_domain_map_fn)(void *pw, const char *s, size_t n,
				   size_t *out_n);
void url_set_domain_map(url_domain_map_fn fn, void *pw);
/* the one used unless another is set: QuickJS's NFKC and lower case */
char *url_uts46_map(void *pw, const char *s, size_t n, size_t *out_n);

void url_init(struct url *u);
void url_free(struct url *u);

/* input is UTF-8; base may be NULL */
int url_parse(const char *input, size_t len, const struct url *base,
	      struct url *out);
/* changes one part as the URL's setter for it does */
int url_set(struct url *u, enum url_part part, const char *value, size_t len);

bool url_serialize(const struct url *u, struct url_buf *out,
		   bool exclude_fragment);
bool url_pathname(const struct url *u, struct url_buf *out);

/* application/x-www-form-urlencoded: decode one name or value into out,
   or append the encoding of one to out */
bool url_form_decode(const char *s, size_t n, struct url_buf *out);
bool url_form_encode(const char *s, size_t n, struct url_buf *out);
void url_buf_free(struct url_buf *b);
bool url_buf_append(struct url_buf *b, const char *s, size_t n);

#endif
