/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * WebSocket connections on libcurl's ws API, for the script engine's
 * WebSocket class. Home Assistant's whole interface talks to its server
 * over one, and without it the app stopped at "WebSocket is not
 * defined" the moment the login finished.
 *
 * Each connection is an easy handle set up with CONNECT_ONLY=2, which
 * has curl do the HTTP upgrade and then hand the connection over for
 * curl_ws_send and curl_ws_recv. The handshake runs on a multi handle so
 * that it does not hold up the browser; after it, the connection is
 * polled from NetSurf's scheduler, as everything else here is. There
 * are no threads.
 *
 * curl answers pings itself. A message is gathered from its frames
 * before it is handed on, up to MAX_MESSAGE, past which the connection
 * is closed with 1009 as the protocol says.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#include <curl/curl.h>

#include "utils/errors.h"
#include "netsurf/misc.h"
#include "desktop/gui_internal.h"
#include "content/fetchers/curl.h"

#include "vita_platform.h"
#include "websocket.h"
#if defined(__vita__) || defined(VITASURF_RESOLVE_TEST)
#include "utils/nsoption.h"
#include "vita_resolve.h"
#define VWS_RESOLVE 1
#endif

#define POLL_MS 20		/**< how often a connection is looked at */
/** How long one look may spend handing messages to the page. A page that
 * takes long over each message (Home Assistant building its dashboard
 * took 27 s over a backlog) left the rest of the browser, layout and
 * drawing included, waiting until the backlog was gone. */
#define POLL_BUDGET_MS 100
#define CLOSE_WAIT_MS 3000	/**< how long a close waits for the server */
#define LATE_MS 5000		/**< a look later than this is logged */
#define MAX_MESSAGE (16u * 1024u * 1024u)
#define MAX_SOCKETS 32		/**< a page that opens more gets errors */

enum vws_state { ST_CONNECTING, ST_OPEN, ST_CLOSING, ST_DONE };

struct vws_out {
	char *data;
	size_t len;
	size_t off;
	unsigned int flags;
	struct vws_out *next;
};

struct vws {
	int id;
	enum vws_state state;
	CURL *h;
	struct curl_slist *headers;
	char errbuf[CURL_ERROR_SIZE];
	vws_event_cb cb;
	void *owner;
	char *url;		/**< for the log */
	/* the message being gathered */
	char *msg;
	size_t msg_len, msg_cap;
	bool msg_binary;
	bool in_message;
	char protocol[128];	/**< the Sec-WebSocket-Protocol answered */
	/* a close frame being gathered */
	char close_buf[128];
	size_t close_len;
	struct vws_out *out, *out_last;
	size_t buffered;
	uint64_t close_started;
#ifdef VWS_RESOLVE
	bool waiting;		/**< for its host's address, not yet curl's */
	struct curl_slist *resolve; /**< that address, for CURLOPT_RESOLVE */
#endif
	struct vws *next;
};

static struct vws *sockets;
static CURLM *multi;
static int next_id = 1;
static bool scheduled;

static uint64_t ms_now(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);
}

static struct vws *find(int id)
{
	struct vws *s;

	for (s = sockets; s != NULL; s = s->next) {
		if (s->id == id && s->state != ST_DONE) {
			return s;
		}
	}
	return NULL;
}

static void poll_cb(void *p);

static uint64_t poll_due;	/**< when the next look was asked for */

static void schedule_poll(void)
{
	if (!scheduled && sockets != NULL) {
		scheduled = true;
		poll_due = ms_now() + POLL_MS;
		guit->misc->schedule(POLL_MS, poll_cb, NULL);
	}
}

static void free_out(struct vws *s)
{
	struct vws_out *o = s->out, *n;

	while (o != NULL) {
		n = o->next;
		free(o->data);
		free(o);
		o = n;
	}
	s->out = s->out_last = NULL;
	s->buffered = 0;
}

/* Take a connection down: off the multi handle, and freed once the
 * poll next walks the list, so a callback can close its own socket. */
static void finish(struct vws *s)
{
	if (s->h != NULL) {
		if (multi != NULL) {
			curl_multi_remove_handle(multi, s->h);
		}
		curl_easy_cleanup(s->h);
		s->h = NULL;
	}
	if (s->headers != NULL) {
		curl_slist_free_all(s->headers);
		s->headers = NULL;
	}
#ifdef VWS_RESOLVE
	if (s->resolve != NULL) {
		curl_slist_free_all(s->resolve);
		s->resolve = NULL;
	}
	s->waiting = false;
#endif
	free_out(s);
	free(s->msg);
	s->msg = NULL;
	s->msg_len = s->msg_cap = 0;
	s->state = ST_DONE;
}

/* Tell the owner the connection is closed, and take it down. */
static void closed(struct vws *s, int code, const char *reason, size_t len)
{
	vws_event_cb cb = s->cb;
	void *owner = s->owner;
	int id = s->id;

	finish(s);
	if (cb != NULL) {
		cb(owner, id, VWS_CLOSE, reason != NULL ? reason : "", len, code);
	}
}

static void failed(struct vws *s, const char *why)
{
	vws_event_cb cb = s->cb;

	vita_log("websocket: %s: %s", s->url != NULL ? s->url : "?", why);
	if (cb != NULL) {
		cb(s->owner, s->id, VWS_ERROR, why, strlen(why), 0);
	}
	if (s->state != ST_DONE) {
		closed(s, 1006, "", 0);
	}
}

static bool msg_append(struct vws *s, const char *data, size_t len)
{
	if (s->msg_len + len > MAX_MESSAGE) {
		return false;
	}
	if (s->msg_len + len + 1 > s->msg_cap) {
		size_t cap = s->msg_cap ? s->msg_cap : 4096;
		char *n;

		while (cap < s->msg_len + len + 1) {
			cap *= 2;
		}
		n = realloc(s->msg, cap);
		if (n == NULL) {
			return false;
		}
		s->msg = n;
		s->msg_cap = cap;
	}
	memcpy(s->msg + s->msg_len, data, len);
	s->msg_len += len;
	s->msg[s->msg_len] = '\0';
	return true;
}

static void send_close_frame(struct vws *s, int code, const char *reason,
			     size_t reason_len)
{
	unsigned char buf[2 + 123];
	size_t n = 0, sent = 0;

	if (code > 0) {
		buf[0] = (unsigned char)((code >> 8) & 0xff);
		buf[1] = (unsigned char)(code & 0xff);
		n = 2;
		if (reason != NULL && reason_len > 0) {
			if (reason_len > 123) {
				reason_len = 123;
			}
			memcpy(buf + 2, reason, reason_len);
			n += reason_len;
		}
	}
	(void)curl_ws_send(s->h, buf, n, &sent, 0, CURLWS_CLOSE);
}

/* The handshakes in progress. */
#ifdef VWS_RESOLVE
/*
 * Connect once the host's address is known (VitaSurf). curl would look
 * the name up inside curl_multi_perform and hold the browser up until
 * the answer came, as the fetcher's transfers did (fetch_curl_resolve_try
 * in NetSurf's curl.c); vita_resolve looks it up on a thread instead,
 * and curl gets the address with CURLOPT_RESOLVE.
 *
 * Returns 1 once curl has the connection, 0 while the lookup goes on,
 * and -1 with why filled in if it cannot be made.
 */
static int connect_resolved(struct vws *s, char *why, size_t why_len)
{
	CURLU *u = curl_url();
	char *host = NULL, *port = NULL;
	char addrs[16], entry[300];
	int r = 1;

	if (u == NULL ||
	    curl_url_set(u, CURLUPART_URL, s->url,
			 CURLU_NON_SUPPORT_SCHEME) != CURLUE_OK ||
	    curl_url_get(u, CURLUPART_HOST, &host, 0) != CURLUE_OK ||
	    curl_url_get(u, CURLUPART_PORT, &port,
			 CURLU_DEFAULT_PORT) != CURLUE_OK ||
	    host[0] == '[' || strspn(host, "0123456789.") == strlen(host) ||
	    strcasecmp(host, "localhost") == 0 ||
	    (nsoption_bool(http_proxy) &&
	     nsoption_charp(http_proxy_host) != NULL)) {
		/* curl reads the URL, or connects to an address or a
		 * proxy, itself */
		goto add;
	}
	switch (vita_resolve(host, addrs, sizeof(addrs), why, why_len)) {
	case VITA_RESOLVE_PENDING:
		r = 0;
		goto out;
	case VITA_RESOLVE_FAILED:
		r = -1;
		goto out;
	default:
		break;
	}
	snprintf(entry, sizeof(entry), "+%s:%s:%s", host, port, addrs);
	s->resolve = curl_slist_append(NULL, entry);
	if (s->resolve != NULL) {
		curl_easy_setopt(s->h, CURLOPT_RESOLVE, s->resolve);
	}
add:
	if (curl_multi_add_handle(multi, s->h) != CURLM_OK) {
		snprintf(why, why_len, "the connection could not be started");
		r = -1;
	} else {
		s->waiting = false;
	}
out:
	curl_free(host);
	curl_free(port);
	curl_url_cleanup(u);
	return r;
}
#endif

static void poll_connecting(void)
{
	int running = 0, left = 0;
	CURLMsg *m;

	if (multi == NULL) {
		return;
	}
#ifdef VWS_RESOLVE
	{
		struct vws *s;
		char why[96];

		/* a failure tells the page, which may open or close
		 * sockets; those it opens go on the front of the list */
		for (s = sockets; s != NULL; s = s->next) {
			if (s->state == ST_CONNECTING && s->waiting &&
			    connect_resolved(s, why, sizeof(why)) < 0) {
				failed(s, why);
			}
		}
	}
#endif
	curl_multi_perform(multi, &running);
	while ((m = curl_multi_info_read(multi, &left)) != NULL) {
		struct vws *s;

		if (m->msg != CURLMSG_DONE) {
			continue;
		}
		for (s = sockets; s != NULL; s = s->next) {
			if (s->h == m->easy_handle) {
				break;
			}
		}
		if (s == NULL || s->state != ST_CONNECTING) {
			continue;
		}
		if (m->data.result != CURLE_OK) {
			failed(s, s->errbuf[0] != '\0' ? s->errbuf :
			       curl_easy_strerror(m->data.result));
			continue;
		} else {
			long status = 0;
			const char *proto = s->protocol;

			curl_easy_getinfo(s->h, CURLINFO_RESPONSE_CODE, &status);
			if (status != 101) {
				char why[64];

				snprintf(why, sizeof(why),
					 "the server answered %d, not 101",
					 (int)status);
				failed(s, why);
				continue;
			}
			s->state = ST_OPEN;
			if (s->cb != NULL) {
				s->cb(s->owner, s->id, VWS_OPEN, proto,
				      strlen(proto), 0);
			}
		}
	}
}

/* Hand queued messages to the connection, as far as it takes them. A
 * failure is reported unless quiet, which leaves it for the next look:
 * send() must not fire the page's error and close events from inside
 * the script that called it. */
static bool flush_out_as(struct vws *s, bool quiet)
{
	while (s->out != NULL && s->state != ST_DONE) {
		struct vws_out *o = s->out;
		size_t sent = 0;
		CURLcode rc;

		rc = curl_ws_send(s->h, o->data + o->off, o->len - o->off,
				  &sent, 0, o->flags);
		if (rc == CURLE_AGAIN) {
			o->off += sent;
			s->buffered -= sent;
			return true;
		}
		if (rc != CURLE_OK) {
			if (!quiet) {
				failed(s, curl_easy_strerror(rc));
			}
			return false;
		}
		o->off += sent;
		s->buffered -= sent;
		if (o->off < o->len && o->len > 0) {
			return true;	/* the rest next time */
		}
		s->out = o->next;
		if (s->out == NULL) {
			s->out_last = NULL;
		}
		free(o->data);
		free(o);
	}
	return true;
}

static bool flush_out(struct vws *s)
{
	return flush_out_as(s, false);
}

/* Read what has arrived, message by message, until the deadline. */
static void poll_open(struct vws *s, uint64_t deadline)
{
	char buf[16384];
	unsigned int rounds = 0;

	if (!flush_out(s)) {
		return;
	}
	while (s->state == ST_OPEN || s->state == ST_CLOSING) {
		size_t got = 0;
		const struct curl_ws_frame *meta = NULL;
		CURLcode rc;

		/* a flood of messages does not starve the rest of the
		 * browser: what is left waits for the next poll */
		if (++rounds > 256) {
			break;
		}
		rc = curl_ws_recv(s->h, buf, sizeof(buf), &got, &meta);
		if (rc == CURLE_AGAIN) {
			break;
		}
		if (rc == CURLE_GOT_NOTHING) {
			/* the server went without a close frame */
			closed(s, 1006, "", 0);
			return;
		}
		if (rc != CURLE_OK || meta == NULL) {
			failed(s, curl_easy_strerror(rc));
			return;
		}
		if (meta->flags & CURLWS_CLOSE) {
			size_t room = sizeof(s->close_buf) - s->close_len;

			if (got > room) {
				got = room;
			}
			memcpy(s->close_buf + s->close_len, buf, got);
			s->close_len += got;
			if (meta->bytesleft == 0) {
				int code = 1005;
				const char *reason = "";
				size_t rlen = 0;

				if (s->close_len >= 2) {
					code = ((unsigned char)s->close_buf[0] << 8) |
					       (unsigned char)s->close_buf[1];
					reason = s->close_buf + 2;
					rlen = s->close_len - 2;
				}
				if (s->state == ST_OPEN) {
					/* the server's close: answer it */
					send_close_frame(s, code == 1005 ? 0 : code,
							 NULL, 0);
				}
				closed(s, code, reason, rlen);
				return;
			}
			continue;
		}
		if (meta->flags & (CURLWS_PING | CURLWS_PONG)) {
			continue;
		}
		if (!s->in_message) {
			s->in_message = true;
			s->msg_binary = (meta->flags & CURLWS_BINARY) != 0;
			s->msg_len = 0;
		}
		if (!msg_append(s, buf, got)) {
			send_close_frame(s, 1009, "message too big", 15);
			closed(s, 1009, "message too big", 15);
			return;
		}
		if (meta->bytesleft == 0 && (meta->flags & CURLWS_CONT) == 0) {
			s->in_message = false;
			if (s->state == ST_OPEN && s->cb != NULL) {
				s->cb(s->owner, s->id,
				      s->msg_binary ? VWS_BINARY : VWS_TEXT,
				      s->msg != NULL ? s->msg : "", s->msg_len, 0);
			}
			/* the callback may have closed or dropped it */
			if (s->state == ST_DONE) {
				return;
			}
			if (s->msg_cap > 65536) {
				free(s->msg);
				s->msg = NULL;
				s->msg_cap = 0;
			}
			s->msg_len = 0;
			/* the rest waits in curl for the next look */
			if (ms_now() >= deadline) {
				break;
			}
		}
	}
	if (s->state == ST_CLOSING &&
	    ms_now() - s->close_started > CLOSE_WAIT_MS) {
		closed(s, 1006, "", 0);
	}
}

static void poll_cb(void *p)
{
	struct vws *s, **pp;

	uint64_t now = ms_now();
	uint64_t deadline = now + POLL_BUDGET_MS;

	(void)p;
	scheduled = false;
	/* A look the page held up: messages, pings included, waited this
	 * long in both directions. */
	if (now > poll_due + LATE_MS) {
		size_t waiting = 0;

		for (s = sockets; s != NULL; s = s->next) {
			waiting += s->buffered;
		}
		vita_log("websocket: looked %u ms late, with %u bytes still "
			 "to send", (unsigned int)(now - poll_due),
			 (unsigned int)waiting);
	}
	poll_connecting();
	for (s = sockets; s != NULL; s = s->next) {
		if (s->state == ST_OPEN || s->state == ST_CLOSING) {
			poll_open(s, deadline);
		}
	}
	/* free what is done */
	pp = &sockets;
	while (*pp != NULL) {
		s = *pp;
		if (s->state == ST_DONE) {
			*pp = s->next;
			free(s->url);
			free(s);
		} else {
			pp = &s->next;
		}
	}
	schedule_poll();
}

/* The response headers: only the protocol the server chose is kept. */
static size_t header_cb(char *buf, size_t size, size_t n, void *p)
{
	struct vws *s = p;
	size_t len = size * n, i;
	static const char name[] = "sec-websocket-protocol:";
	size_t nl = sizeof(name) - 1;

	if (len > nl && strncasecmp(buf, name, nl) == 0) {
		const char *v = buf + nl;
		size_t vl = len - nl;

		while (vl > 0 && (*v == ' ' || *v == '\t')) {
			v++;
			vl--;
		}
		while (vl > 0 && (v[vl - 1] == '\r' || v[vl - 1] == '\n' ||
				  v[vl - 1] == ' ')) {
			vl--;
		}
		if (vl >= sizeof(s->protocol)) {
			vl = sizeof(s->protocol) - 1;
		}
		for (i = 0; i < vl; i++) {
			s->protocol[i] = v[i];
		}
		s->protocol[vl] = '\0';
	}
	return len;
}

int vws_open(const char *url, const char *origin, const char *protocols,
	     const char *cookie, vws_event_cb cb, void *owner)
{
	struct vws *s;
	unsigned count = 0;
	char line[512];

	/* whether this libcurl was built with ws at all, asked once */
	static int have_ws = -1;

	if (have_ws < 0) {
		const curl_version_info_data *v = curl_version_info(CURLVERSION_NOW);
		const char *const *p;

		have_ws = 0;
		for (p = v != NULL ? v->protocols : NULL; p != NULL && *p != NULL; p++) {
			if (strcmp(*p, "ws") == 0) {
				have_ws = 1;
			}
		}
		vita_log("websocket: libcurl %s %s WebSocket support",
			 v != NULL ? v->version : "?",
			 have_ws ? "has" : "was built without");
	}
	if (!have_ws) {
		return -1;
	}
	for (s = sockets; s != NULL; s = s->next) {
		if (s->state != ST_DONE) {
			count++;
		}
	}
	if (count >= MAX_SOCKETS || url == NULL) {
		return -1;
	}
	if (multi == NULL) {
		multi = curl_multi_init();
		if (multi == NULL) {
			return -1;
		}
	}
	s = calloc(1, sizeof(*s));
	if (s == NULL) {
		return -1;
	}
	/* the handle every fetch starts from: CA bundle, proxy, agent */
	s->h = fetch_curl_blank_dup();
	if (s->h == NULL) {
		s->h = curl_easy_init();
	}
	s->url = strdup(url);
	if (s->h == NULL || s->url == NULL) {
		if (s->h != NULL) {
			curl_easy_cleanup(s->h);
		}
		free(s->url);
		free(s);
		return -1;
	}
	curl_easy_setopt(s->h, CURLOPT_URL, url);
	curl_easy_setopt(s->h, CURLOPT_CONNECT_ONLY, 2L);
	curl_easy_setopt(s->h, CURLOPT_ERRORBUFFER, s->errbuf);
	curl_easy_setopt(s->h, CURLOPT_PRIVATE, NULL);
	curl_easy_setopt(s->h, CURLOPT_WRITEFUNCTION, NULL);
	curl_easy_setopt(s->h, CURLOPT_HEADERFUNCTION, header_cb);
	curl_easy_setopt(s->h, CURLOPT_WRITEDATA, NULL);
	curl_easy_setopt(s->h, CURLOPT_HEADERDATA, s);
	curl_easy_setopt(s->h, CURLOPT_NOPROGRESS, 1L);
	curl_easy_setopt(s->h, CURLOPT_HTTPGET, 1L);
	curl_easy_setopt(s->h, CURLOPT_TIMEOUT, 0L);
	curl_easy_setopt(s->h, CURLOPT_CONNECTTIMEOUT, 30L);
	/* the upgrade is HTTP/1.1 only; the fetch template may ask for 2 */
	curl_easy_setopt(s->h, CURLOPT_HTTP_VERSION,
			 (long)CURL_HTTP_VERSION_1_1);
	if (origin != NULL && origin[0] != '\0') {
		snprintf(line, sizeof(line), "Origin: %s", origin);
		s->headers = curl_slist_append(s->headers, line);
	}
	if (protocols != NULL && protocols[0] != '\0') {
		snprintf(line, sizeof(line), "Sec-WebSocket-Protocol: %s",
			 protocols);
		s->headers = curl_slist_append(s->headers, line);
	}
	if (s->headers != NULL) {
		curl_easy_setopt(s->h, CURLOPT_HTTPHEADER, s->headers);
	}
	if (cookie != NULL && cookie[0] != '\0') {
		curl_easy_setopt(s->h, CURLOPT_COOKIE, cookie);
	}
#ifdef VWS_RESOLVE
	/* curl has it once the host's address is known; a failure is the
	 * poll's to report, as any failure to connect is */
	s->waiting = true;
	{
		char why[96];

		(void)connect_resolved(s, why, sizeof(why));
	}
#else
	if (curl_multi_add_handle(multi, s->h) != CURLM_OK) {
		finish(s);
		free(s->url);
		free(s);
		return -1;
	}
#endif
	s->id = next_id++;
	if (next_id <= 0) {
		next_id = 1;
	}
	s->state = ST_CONNECTING;
	s->cb = cb;
	s->owner = owner;
	s->next = sockets;
	sockets = s;
	schedule_poll();
	return s->id;
}

bool vws_send(int id, const void *data, size_t len, bool binary)
{
	struct vws *s = find(id);
	struct vws_out *o;

	if (s == NULL || s->state != ST_OPEN) {
		return false;
	}
	o = calloc(1, sizeof(*o));
	if (o == NULL) {
		return false;
	}
	o->data = malloc(len > 0 ? len : 1);
	if (o->data == NULL) {
		free(o);
		return false;
	}
	if (len > 0) {
		memcpy(o->data, data, len);
	}
	o->len = len;
	o->flags = binary ? CURLWS_BINARY : CURLWS_TEXT;
	if (s->out_last != NULL) {
		s->out_last->next = o;
	} else {
		s->out = o;
	}
	s->out_last = o;
	s->buffered += len;
	/* Sent now, as far as the connection takes it, and the rest at the
	 * next look. Waiting for the look held a message back for as long
	 * as the page kept the browser busy after sending it: Home
	 * Assistant's ping left during a long script only when it ended,
	 * and its 15 s timer for the answer ran out first. */
	if (s->out == o) {
		(void)flush_out_as(s, true);
	}
	schedule_poll();
	return true;
}

void vws_close(int id, int code, const char *reason, size_t reason_len)
{
	struct vws *s = find(id);

	if (s == NULL) {
		return;
	}
	if (s->state == ST_CONNECTING) {
		/* closing before it opened fails the connection */
		failed(s, "closed before the connection was made");
		return;
	}
	if (s->state != ST_OPEN) {
		return;
	}
	(void)flush_out(s);
	if (s->state != ST_OPEN) {
		return;
	}
	send_close_frame(s, code, reason, reason_len);
	s->state = ST_CLOSING;
	s->close_started = ms_now();
	schedule_poll();
}

void vws_drop_owner(void *owner)
{
	struct vws *s;

	for (s = sockets; s != NULL; s = s->next) {
		if (s->owner == owner && s->state != ST_DONE) {
			s->cb = NULL;
			if (s->state == ST_OPEN) {
				send_close_frame(s, 1001, NULL, 0);
			}
			finish(s);
		}
	}
	schedule_poll();
}

size_t vws_buffered(int id)
{
	struct vws *s = find(id);

	return s != NULL ? s->buffered : 0;
}
