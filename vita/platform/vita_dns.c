/*
 * VitaSurf's own DNS client.
 *
 * SceNet's resolver gives a name's address or an error after its own
 * timeout, 32 s, with nothing in between: on claude.ai a Cloudflare host
 * the browser must reach failed that way on every visit, holding the
 * check up, while a browser elsewhere had its answer at once. Here the
 * lookup thread asks the network's DNS servers itself, as Chrome's own
 * resolver does: one A query over UDP, asked again of the next server
 * when none answers, followed through any aliases, asked again over TCP
 * when the answer was truncated, and an answer that the name has no
 * IPv4 address, or does not exist, is taken as the answer it is. What
 * the server said is kept for the log. vita_resolve.c falls back to
 * SceNet's resolver when no server answered at all.
 *
 * Every function here runs on a lookup thread: no globals but the query
 * id counter, no logging.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#ifdef __vita__
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/threadmgr.h>
#include <psp2/net/net.h>
#include <psp2/net/netctl.h>
#else
#include <errno.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#endif

#include "vita_dns.h"

#define DNS_PORT        53
#define DNS_TYPE_A      1
#define DNS_TYPE_CNAME  5
#define DNS_TYPE_AAAA   28
#define DNS_CLASS_IN    1

/* each try waits this long for its server, then the next server is
 * asked: three tries, about as long as a browser's resolver waits */
#define DNS_TRY_MS      1500
#define DNS_TRIES       3
/* aliases followed before giving up on a loop */
#define DNS_MAX_CNAMES  8
/* the answer records looked at */
#define DNS_MAX_RRS     24
/* what a UDP answer may be: EDNS is not asked for, so 512, but some
 * servers send more */
#define DNS_UDP_MAX     1500

/* ------------------------------------------------------------------------ */
/* Sockets                                                                  */

#ifdef __vita__
static int sock_open(bool tcp)
{
	return sceNetSocket("vitasurf_dns", SCE_NET_AF_INET,
			    tcp ? SCE_NET_SOCK_STREAM : SCE_NET_SOCK_DGRAM, 0);
}

static void sock_close(int s)
{
	sceNetSocketClose(s);
}

static bool sock_timeout(int s, int ms)
{
	int us = ms * 1000;

	return sceNetSetsockopt(s, SCE_NET_SOL_SOCKET, SCE_NET_SO_RCVTIMEO,
				&us, sizeof us) >= 0 &&
	       sceNetSetsockopt(s, SCE_NET_SOL_SOCKET, SCE_NET_SO_SNDTIMEO,
				&us, sizeof us) >= 0;
}

static void sock_addr(SceNetSockaddrIn *sa, uint32_t ip, uint16_t port)
{
	memset(sa, 0, sizeof *sa);
	sa->sin_len = sizeof *sa;
	sa->sin_family = SCE_NET_AF_INET;
	sa->sin_port = sceNetHtons(port);
	sa->sin_addr.s_addr = ip;
}

static int sock_sendto(int s, const void *buf, int len, uint32_t ip,
		       uint16_t port)
{
	SceNetSockaddrIn sa;

	sock_addr(&sa, ip, port);
	return sceNetSendto(s, buf, (unsigned int)len, 0,
			    (const SceNetSockaddr *)&sa, sizeof sa);
}

/* SceNet's error for "nothing yet" on a socket that does not wait */
#define DNS_EAGAIN ((int)0x80410123)

static uint32_t clock_ms(void);

static void nap(void)
{
	sceKernelDelayThread(5 * 1000);
}

/*
 * Receive what has come, polling until the deadline: a socket timeout
 * that SceNet did not honour would hold the lookup's thread for good.
 */
static int sock_recvfrom(int s, void *buf, int len, uint32_t *from,
			 uint32_t until)
{
	SceNetSockaddrIn sa;
	unsigned int sl;
	int n;

	for (;;) {
		sl = sizeof sa;
		memset(&sa, 0, sizeof sa);
		n = sceNetRecvfrom(s, buf, (unsigned int)len,
				   SCE_NET_MSG_DONTWAIT,
				   (SceNetSockaddr *)&sa, &sl);
		if (n >= 0) {
			*from = sa.sin_addr.s_addr;
			return n;
		}
		if (n != DNS_EAGAIN || (int32_t)(until - clock_ms()) <= 0) {
			return -1;
		}
		nap();
	}
}

static int sock_connect(int s, uint32_t ip, uint16_t port)
{
	SceNetSockaddrIn sa;

	sock_addr(&sa, ip, port);
	return sceNetConnect(s, (const SceNetSockaddr *)&sa, sizeof sa);
}

static int sock_send(int s, const void *buf, int len)
{
	return sceNetSend(s, buf, (unsigned int)len, 0);
}

static int sock_recv(int s, void *buf, int len, uint32_t until)
{
	int n;

	for (;;) {
		n = sceNetRecv(s, buf, (unsigned int)len, SCE_NET_MSG_DONTWAIT);
		if (n >= 0) {
			return n;
		}
		if (n != DNS_EAGAIN || (int32_t)(until - clock_ms()) <= 0) {
			return -1;
		}
		nap();
	}
}

static uint32_t clock_ms(void)
{
	return (uint32_t)(sceKernelGetProcessTimeWide() / 1000);
}

static bool parse_ip(const char *text, uint32_t *ip)
{
	SceNetInAddr a;

	if (text[0] == '\0' ||
	    sceNetInetPton(SCE_NET_AF_INET, text, &a) <= 0) {
		return false;
	}
	*ip = a.s_addr;
	return *ip != 0;
}

int vita_dns_servers(uint32_t *servers, uint16_t *port)
{
	SceNetCtlInfo info;
	int n = 0;

	*port = DNS_PORT;
	memset(&info, 0, sizeof info);
	if (sceNetCtlInetGetInfo(SCE_NETCTL_INFO_GET_PRIMARY_DNS, &info) >= 0 &&
	    parse_ip(info.primary_dns, &servers[n])) {
		n++;
	}
	memset(&info, 0, sizeof info);
	if (sceNetCtlInetGetInfo(SCE_NETCTL_INFO_GET_SECONDARY_DNS,
				 &info) >= 0 &&
	    parse_ip(info.secondary_dns, &servers[n]) &&
	    (n == 0 || servers[n] != servers[0])) {
		n++;
	}
	return n;
}
#else
static int sock_open(bool tcp)
{
	return socket(AF_INET, tcp ? SOCK_STREAM : SOCK_DGRAM, 0);
}

static void sock_close(int s)
{
	close(s);
}

static bool sock_timeout(int s, int ms)
{
	struct timeval tv;

	tv.tv_sec = ms / 1000;
	tv.tv_usec = (ms % 1000) * 1000;
	return setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv) == 0 &&
	       setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv) == 0;
}

static void sock_addr(struct sockaddr_in *sa, uint32_t ip, uint16_t port)
{
	memset(sa, 0, sizeof *sa);
	sa->sin_family = AF_INET;
	sa->sin_port = htons(port);
	sa->sin_addr.s_addr = ip;
}

static int sock_sendto(int s, const void *buf, int len, uint32_t ip,
		       uint16_t port)
{
	struct sockaddr_in sa;

	sock_addr(&sa, ip, port);
	return (int)sendto(s, buf, (size_t)len, 0,
			   (const struct sockaddr *)&sa, sizeof sa);
}

static uint32_t clock_ms(void);

static void nap(void)
{
	usleep(5 * 1000);
}

static int sock_recvfrom(int s, void *buf, int len, uint32_t *from,
			 uint32_t until)
{
	struct sockaddr_in sa;
	socklen_t sl;
	int n;

	for (;;) {
		sl = sizeof sa;
		memset(&sa, 0, sizeof sa);
		n = (int)recvfrom(s, buf, (size_t)len, MSG_DONTWAIT,
				  (struct sockaddr *)&sa, &sl);
		if (n >= 0) {
			*from = sa.sin_addr.s_addr;
			return n;
		}
		if ((errno != EAGAIN && errno != EWOULDBLOCK) ||
		    (int32_t)(until - clock_ms()) <= 0) {
			return -1;
		}
		nap();
	}
}

static int sock_connect(int s, uint32_t ip, uint16_t port)
{
	struct sockaddr_in sa;

	sock_addr(&sa, ip, port);
	return connect(s, (const struct sockaddr *)&sa, sizeof sa);
}

static int sock_send(int s, const void *buf, int len)
{
	return (int)send(s, buf, (size_t)len, 0);
}

static int sock_recv(int s, void *buf, int len, uint32_t until)
{
	int n;

	for (;;) {
		n = (int)recv(s, buf, (size_t)len, MSG_DONTWAIT);
		if (n >= 0) {
			return n;
		}
		if ((errno != EAGAIN && errno != EWOULDBLOCK) ||
		    (int32_t)(until - clock_ms()) <= 0) {
			return -1;
		}
		nap();
	}
}

static uint32_t clock_ms(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

static bool parse_ip(const char *text, uint32_t *ip)
{
	struct in_addr a;

	if (inet_pton(AF_INET, text, &a) != 1) {
		return false;
	}
	*ip = a.s_addr;
	return true;
}

/*
 * The native harness: VITASURF_DNS_SERVER ("ip[:port]") for a test's own
 * server, else the first two in /etc/resolv.conf.
 */
int vita_dns_servers(uint32_t *servers, uint16_t *port)
{
	const char *env = getenv("VITASURF_DNS_SERVER");
	char line[256], ip[64];
	FILE *f;
	int n = 0;

	*port = DNS_PORT;
	if (env != NULL && env[0] != '\0') {
		const char *colon = strchr(env, ':');
		size_t l = colon != NULL ? (size_t)(colon - env) : strlen(env);

		if (l < sizeof ip) {
			memcpy(ip, env, l);
			ip[l] = '\0';
			if (parse_ip(ip, &servers[0])) {
				n = 1;
			}
		}
		if (colon != NULL) {
			*port = (uint16_t)atoi(colon + 1);
		}
		return n;
	}
	f = fopen("/etc/resolv.conf", "r");
	if (f == NULL) {
		return 0;
	}
	while (n < VITA_DNS_MAX_SERVERS && fgets(line, sizeof line, f)) {
		if (sscanf(line, " nameserver %63s", ip) == 1 &&
		    parse_ip(ip, &servers[n])) {
			n++;
		}
	}
	fclose(f);
	return n;
}
#endif

/* ------------------------------------------------------------------------ */
/* Messages                                                                 */

/* A query id no one on the path can guess from the last one. */
static uint16_t query_id(void)
{
	static uint32_t x;
	uint32_t v = __atomic_add_fetch(&x, 0x9e3779b9u, __ATOMIC_RELAXED);

	v ^= clock_ms() * 2654435761u;
	v ^= (uint32_t)(uintptr_t)&v;
	v ^= v >> 15;
	v *= 0x2c1b3c6du;
	v ^= v >> 12;
	return (uint16_t)v;
}

/* A query for name's records of qtype, recursion desired; its length. */
static int build_query(uint8_t *q, int cap, const char *name, uint16_t id,
		       uint16_t qtype)
{
	int at = 12;
	const char *p = name;

	if (cap < 12 + 255 + 4) {
		return -1;
	}
	memset(q, 0, 12);
	q[0] = (uint8_t)(id >> 8);
	q[1] = (uint8_t)id;
	q[2] = 0x01; /* RD */
	q[5] = 1;    /* one question */
	while (*p != '\0') {
		const char *dot = strchr(p, '.');
		int l = dot != NULL ? (int)(dot - p) : (int)strlen(p);

		if (l == 0 || l > 63 || at + 1 + l > 12 + 254) {
			return -1;
		}
		q[at++] = (uint8_t)l;
		memcpy(q + at, p, (size_t)l);
		at += l;
		p += l;
		if (*p == '.') {
			p++;
		}
	}
	q[at++] = 0;
	q[at++] = (uint8_t)(qtype >> 8);
	q[at++] = (uint8_t)qtype;
	q[at++] = 0;
	q[at++] = DNS_CLASS_IN;
	return at;
}

/*
 * Read the name at off in m, following compression, into out as dotted
 * text. Returns the offset after the name where it started, or -1.
 */
static int read_name(const uint8_t *m, int len, int off, char *out, int cap)
{
	int end = -1, o = 0, hops = 0;

	while (off < len) {
		uint8_t l = m[off];

		if (l == 0) {
			if (end < 0) {
				end = off + 1;
			}
			/* "a.b." to "a.b"; the root is "" */
			if (o > 0) {
				o--;
			}
			out[o] = '\0';
			return end;
		}
		if ((l & 0xc0) == 0xc0) {
			if (off + 1 >= len || ++hops > 32) {
				return -1;
			}
			if (end < 0) {
				end = off + 2;
			}
			off = ((l & 0x3f) << 8) | m[off + 1];
			continue;
		}
		if ((l & 0xc0) != 0 || off + 1 + l > len || o + l + 1 >= cap) {
			return -1;
		}
		memcpy(out + o, m + off + 1, l);
		o += l;
		out[o++] = '.';
		off += 1 + l;
	}
	return -1;
}

static bool same_name(const char *a, const char *b)
{
	size_t la = strlen(a), lb = strlen(b);

	if (la > 0 && a[la - 1] == '.') {
		la--;
	}
	if (lb > 0 && b[lb - 1] == '.') {
		lb--;
	}
	return la == lb && strncasecmp(a, b, la) == 0;
}

/* What one answer said about the name asked */
struct answer {
	int rcode;
	bool truncated;
	bool found;          /* a record of the type asked, for the name */
	uint32_t addr;       /* its address, for A */
	char cname[256];     /* where the aliases led, if the chain ended
			      * with no record of the type asked */
	int cnames;
};

/* Read an answer to the query id for name and qtype. */
static bool parse_answer(const uint8_t *m, int len, uint16_t id,
			 const char *name, uint16_t qtype, struct answer *a)
{
	struct rr {
		char owner[256];
		uint16_t type;
		int rdata;
		int rdlen;
	};
	struct rr *rrs;
	int qd, an, off = 12, n = 0, i, hop;
	char cur[256], tmp[256];
	uint16_t flags;

	memset(a, 0, sizeof *a);
	if (len < 12 || ((m[0] << 8) | m[1]) != id) {
		return false;
	}
	flags = (uint16_t)((m[2] << 8) | m[3]);
	if ((flags & 0x8000) == 0) {
		return false; /* not an answer */
	}
	a->truncated = (flags & 0x0200) != 0;
	a->rcode = flags & 0x0f;
	if (a->truncated) {
		return true;
	}
	qd = (m[4] << 8) | m[5];
	an = (m[6] << 8) | m[7];
	for (i = 0; i < qd; i++) {
		off = read_name(m, len, off, tmp, sizeof tmp);
		if (off < 0 || off + 4 > len) {
			return false;
		}
		off += 4;
	}
	rrs = malloc(sizeof(*rrs) * DNS_MAX_RRS);
	if (rrs == NULL) {
		return false;
	}
	for (i = 0; i < an && n < DNS_MAX_RRS; i++) {
		struct rr *r = &rrs[n];

		off = read_name(m, len, off, r->owner, sizeof r->owner);
		if (off < 0 || off + 10 > len) {
			free(rrs);
			return false;
		}
		r->type = (uint16_t)((m[off] << 8) | m[off + 1]);
		r->rdlen = (m[off + 8] << 8) | m[off + 9];
		r->rdata = off + 10;
		if (r->rdata + r->rdlen > len) {
			free(rrs);
			return false;
		}
		off = r->rdata + r->rdlen;
		if ((m[r->rdata - 8] << 8 | m[r->rdata - 7]) == DNS_CLASS_IN) {
			n++;
		}
	}
	/* follow the aliases from the name asked */
	snprintf(cur, sizeof cur, "%s", name);
	for (hop = 0; hop <= DNS_MAX_CNAMES; hop++) {
		bool moved = false;

		for (i = 0; i < n; i++) {
			if (rrs[i].type == qtype && same_name(rrs[i].owner, cur)) {
				a->found = true;
				if (qtype == DNS_TYPE_A && rrs[i].rdlen == 4) {
					memcpy(&a->addr, m + rrs[i].rdata, 4);
				}
				free(rrs);
				return true;
			}
		}
		for (i = 0; i < n; i++) {
			if (rrs[i].type == DNS_TYPE_CNAME &&
			    same_name(rrs[i].owner, cur) &&
			    read_name(m, len, rrs[i].rdata, tmp,
				      sizeof tmp) > 0) {
				snprintf(cur, sizeof cur, "%s", tmp);
				a->cnames++;
				moved = true;
				break;
			}
		}
		if (!moved) {
			break;
		}
	}
	if (a->cnames > 0) {
		snprintf(a->cname, sizeof a->cname, "%s", cur);
	}
	free(rrs);
	return true;
}

/* ------------------------------------------------------------------------ */
/* Asking                                                                   */

/* Ask server over TCP, as for an answer too big for UDP. */
static int ask_tcp(uint32_t server, uint16_t port, const uint8_t *q, int qlen,
		   uint8_t **reply)
{
	uint8_t pre[2];
	uint8_t *buf = NULL;
	uint32_t until = clock_ms() + DNS_TRY_MS * 2;
	int s, got, want, n;

	s = sock_open(true);
	if (s < 0) {
		return -1;
	}
	if (!sock_timeout(s, DNS_TRY_MS * 2) ||
	    sock_connect(s, server, port) < 0) {
		sock_close(s);
		return -1;
	}
	pre[0] = (uint8_t)(qlen >> 8);
	pre[1] = (uint8_t)qlen;
	if (sock_send(s, pre, 2) != 2 || sock_send(s, q, qlen) != qlen) {
		sock_close(s);
		return -1;
	}
	for (got = 0; got < 2; got += n) {
		n = sock_recv(s, pre + got, 2 - got, until);
		if (n <= 0) {
			sock_close(s);
			return -1;
		}
	}
	want = (pre[0] << 8) | pre[1];
	buf = malloc((size_t)want + 1);
	if (buf == NULL) {
		sock_close(s);
		return -1;
	}
	for (got = 0; got < want; got += n) {
		n = sock_recv(s, buf + got, want - got, until);
		if (n <= 0) {
			free(buf);
			sock_close(s);
			return -1;
		}
	}
	sock_close(s);
	*reply = buf;
	return want;
}

/*
 * Ask the servers, in turn, for name's qtype records, until one answers.
 * Returns VITA_DNS_OK with an answer, or VITA_DNS_TIMEOUT, ERROR or
 * BADREPLY.
 */
static int ask(const char *name, uint16_t qtype, const uint32_t *servers,
	       int nservers, uint16_t port, struct answer *a,
	       struct vita_dns_result *r)
{
	uint8_t q[12 + 256 + 4];
	uint8_t buf[DNS_UDP_MAX];
	bool sent = false;
	int qlen, t;

	for (t = 0; t < DNS_TRIES; t++) {
		uint32_t server = servers[t % nservers];
		uint16_t id = query_id();
		uint32_t until;
		int s;

		qlen = build_query(q, sizeof q, name, id, qtype);
		if (qlen < 0) {
			return VITA_DNS_ERROR;
		}
		s = sock_open(false);
		if (s < 0) {
			continue;
		}
		if (!sock_timeout(s, DNS_TRY_MS) ||
		    sock_sendto(s, q, qlen, server, port) != qlen) {
			sock_close(s);
			continue;
		}
		sent = true;
		r->tries++;
		until = clock_ms() + DNS_TRY_MS;
		/* a stray packet is not the answer: wait out the try */
		while ((int32_t)(until - clock_ms()) > 0) {
			uint32_t from = 0;
			int n = sock_recvfrom(s, buf, sizeof buf, &from,
					      until);

			if (n <= 0) {
				break;
			}
			if (from != server ||
			    !parse_answer(buf, n, id, name, qtype, a)) {
				/* another's, or a late answer to a try
				 * before: this one's may yet come */
				continue;
			}
			sock_close(s);
			r->server = server;
			if (a->truncated) {
				uint8_t *big = NULL;
				int bl = ask_tcp(server, port, q, qlen, &big);

				if (bl < 0 ||
				    !parse_answer(big, bl, id, name, qtype, a)) {
					free(big);
					return VITA_DNS_BADREPLY;
				}
				free(big);
				r->tcp = true;
			}
			return VITA_DNS_OK;
		}
		sock_close(s);
	}
	return sent ? VITA_DNS_TIMEOUT : VITA_DNS_ERROR;
}

void vita_dns_lookup(const char *host, struct vita_dns_result *r)
{
	uint32_t servers[VITA_DNS_MAX_SERVERS];
	uint16_t port;
	char name[256];
	struct answer a;
	int n, st, hop;

	memset(r, 0, sizeof *r);
	n = vita_dns_servers(servers, &port);
	if (n == 0) {
		r->status = VITA_DNS_ERROR;
		return;
	}
	snprintf(name, sizeof name, "%s", host);
	for (hop = 0; hop <= DNS_MAX_CNAMES; hop++) {
		st = ask(name, DNS_TYPE_A, servers, n, port, &a, r);
		if (st != VITA_DNS_OK) {
			r->status = st;
			return;
		}
		r->rcode = a.rcode;
		r->cnames += a.cnames;
		if (a.found) {
			r->status = VITA_DNS_OK;
			r->addr = a.addr;
			return;
		}
		if (a.rcode == 3) {
			r->status = VITA_DNS_NXDOMAIN;
			return;
		}
		if (a.rcode != 0) {
			r->status = VITA_DNS_SERVFAIL;
			return;
		}
		if (a.cnames > 0 && a.cname[0] != '\0') {
			/* the server gave the alias but not where it led */
			snprintf(name, sizeof name, "%s", a.cname);
			continue;
		}
		break;
	}
	/* the name, with no IPv4 address: does it have IPv6, for the log */
	r->status = VITA_DNS_NODATA;
	if (ask(name, DNS_TYPE_AAAA, servers, n, port, &a, r) == VITA_DNS_OK &&
	    a.found) {
		r->has_ipv6 = true;
	}
}
