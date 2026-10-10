/*
 * VitaSurf host name lookups, away from the main thread.
 *
 * curl is built without its threaded resolver, as vdpm's is
 * (scripts/build-curl-http2.sh copies its options), so it looked each
 * new host up inside curl_multi_perform and the whole browser waited for
 * the answer. On claude.ai the lookup of a Cloudflare host that never
 * answered held the screen for 32 s from inside clearTimeout, where
 * script keeps transfers moving, and the script budget then stopped
 * Cloudflare's challenge for having run that long. Here each lookup runs
 * on a thread of its own; the fetcher holds its transfer back until the
 * address is known and gives it to curl with CURLOPT_RESOLVE, so curl
 * never looks a name up itself and nothing waits.
 *
 * Every slot is owned by the main thread except while its lookup runs,
 * when only the lookup's thread writes it; the state is the hand-over.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifdef __vita__
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/threadmgr.h>
#include <psp2/net/net.h>
#else
#include <netdb.h>
#include <pthread.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#endif

#include "vita_resolve.h"
#include "vita_dns.h"

#ifdef __vita__
#include "vita_platform.h"
#else
void vita_log(const char *fmt, ...);
#endif

#define SLOT_EMPTY   0
#define SLOT_QUEUED  1 /* asked for, waiting for a thread */
#define SLOT_RUNNING 2 /* its thread's until the state changes */
#define SLOT_OK      3
#define SLOT_FAILED  4

/* hosts remembered; a page rarely talks to more than a dozen */
#define RESOLVE_SLOTS 32
/* lookups at once: one that never answers must not hold up the rest */
#define RESOLVE_THREADS 4
/* curl keeps an answer this long (CURLOPT_DNS_CACHE_TIMEOUT's default) */
#define RESOLVE_KEEP_MS 60000
/* long enough for every fetch waiting on the host to hear it */
#define RESOLVE_FAIL_KEEP_MS 5000
/* a lookup taking this long is said in the log */
#define RESOLVE_SLOW_MS 1000

#ifdef __vita__
/* the resolver's own work is a DNS packet or two; what SceNet needs of
 * the caller's stack is not written down, so generous all the same */
#define RESOLVE_STACK_SIZE (64 * 1024)
#define RESOLVE_PRIORITY   0x10000100
#endif

/* where a lookup failed; the thread leaves the words to the main one */
#define FAIL_CREATE 1 /* no resolver */
#define FAIL_LOOKUP 2 /* the lookup said no */
#define FAIL_THREAD 3 /* no thread to run it on */
#define FAIL_TEST   4 /* the native harness was told to fail it */
#define FAIL_DNS    5 /* a DNS server answered: no such name, no IPv4 */

struct slot {
	char host[256];
	int state;          /* SLOT_*, read and written atomically */
	int rid;            /* the lookup's SceNet resolver, or 0 */
	/* written by the lookup's thread, read once the state says so */
	uint32_t addr;      /* the address, in network order */
	int fail;           /* FAIL_*, or 0 */
	int err;            /* what the call that failed returned */
	uint32_t took_ms;   /* how long the lookup itself took */
	struct vita_dns_result dns; /* what VitaSurf's own query found */
	bool asked_dns;     /* the own query was made */
	bool fell_back;     /* it had no answer: the system resolver asked */
	uint32_t dns_ms;    /* how long the own query took */
	uint32_t done_ms;   /* when it answered */
	/* the main thread's */
	uint32_t asked_ms;  /* when the lookup was asked for */
	uint32_t used_ms;   /* when a fetch last asked, for eviction */
	bool told;          /* its answer is in the log already */
};

static struct slot slots[RESOLVE_SLOTS];

static uint32_t now_ms(void)
{
#ifdef __vita__
	return (uint32_t)(sceKernelGetProcessTimeWide() / 1000);
#else
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
#endif
}

static int slot_state(struct slot *s)
{
	return __atomic_load_n(&s->state, __ATOMIC_ACQUIRE);
}

static void slot_set_state(struct slot *s, int state)
{
	__atomic_store_n(&s->state, state, __ATOMIC_RELEASE);
}

/*
 * Ask the network's DNS servers directly (vita_dns.c). True when that
 * settled the lookup, with an address or with a server's answer that
 * there is none; false to ask the system resolver, as for a name with
 * no dot, which only it may know (a LAN name, a search domain), or when
 * no server answered.
 */
static bool lookup_own(struct slot *s)
{
	uint32_t t0;

	if (strchr(s->host, '.') == NULL) {
		return false;
	}
	t0 = now_ms();
	s->asked_dns = true;
	vita_dns_lookup(s->host, &s->dns);
	s->dns_ms = now_ms() - t0;
	switch (s->dns.status) {
	case VITA_DNS_OK:
		s->addr = s->dns.addr;
		return true;
	case VITA_DNS_NXDOMAIN:
	case VITA_DNS_NODATA:
	case VITA_DNS_SERVFAIL:
		s->fail = FAIL_DNS;
		return true;
	default:
		s->fell_back = true;
		return false;
	}
}

#ifdef __vita__
/* SceNet resolver errors are 0x804101xx, the low byte saying which */
static const char *resolver_error(int err)
{
	if (((unsigned int)err & 0xffffff00u) != 0x80410100u) {
		return NULL;
	}
	switch ((unsigned int)err & 0xffu) {
	case 220: return "internal error";
	case 221: return "busy";
	case 222: return "out of space";
	case 223: return "bad packet";
	case 225: return "no DNS server";
	case 226: return "timed out";
	case 227: return "not supported";
	case 228: return "format error";
	case 229: return "server failure";
	case 230: return "no such host";
	case 231: return "not implemented";
	case 232: return "server refused";
	case 233: return "no record";
	case 234: return "alignment";
	default: return NULL;
	}
}

/* On the lookup's thread: SceNet calls and plain stores, nothing else. */
static void lookup(struct slot *s)
{
	SceNetInAddr addr;
	int rid, ret;

	if (lookup_own(s)) {
		return;
	}
	rid = sceNetResolverCreate("vitasurf_dns", NULL, 0);
	if (rid < 0) {
		s->fail = FAIL_CREATE;
		s->err = rid;
		return;
	}
	__atomic_store_n(&s->rid, rid, __ATOMIC_RELEASE);
	memset(&addr, 0, sizeof addr);
	/* no timeout or retry of our own: the system's, as newlib asks */
	ret = sceNetResolverStartNtoa(rid, s->host, &addr, 0, 0, 0);
	__atomic_store_n(&s->rid, 0, __ATOMIC_RELEASE);
	sceNetResolverDestroy(rid);
	if (ret < 0) {
		s->fail = FAIL_LOOKUP;
		s->err = ret;
		return;
	}
	s->addr = addr.s_addr;
}

static int lookup_thread(SceSize args, void *argp)
{
	struct slot *s = *(struct slot **)argp;
	uint32_t t0 = now_ms();

	(void)args;
	lookup(s);
	s->took_ms = now_ms() - t0;
	s->done_ms = now_ms();
	slot_set_state(s, s->fail == 0 ? SLOT_OK : SLOT_FAILED);
	return sceKernelExitDeleteThread(0);
}

static bool lookup_start(struct slot *s)
{
	SceUID thid;
	int ret;

	thid = sceKernelCreateThread("vitasurf_dns", lookup_thread,
				     RESOLVE_PRIORITY, RESOLVE_STACK_SIZE, 0,
				     0, NULL);
	if (thid < 0) {
		s->fail = FAIL_THREAD;
		s->err = thid;
		return false;
	}
	slot_set_state(s, SLOT_RUNNING);
	ret = sceKernelStartThread(thid, sizeof s, &s);
	if (ret < 0) {
		sceKernelDeleteThread(thid);
		s->fail = FAIL_THREAD;
		s->err = ret;
		return false;
	}
	return true;
}
#else
/*
 * The native harness: getaddrinfo on a pthread. VITASURF_RESOLVE_DELAY
 * (ms) holds every lookup back and VITASURF_RESOLVE_FAIL names a host
 * that fails after it, so a test can see fetches wait without blocking.
 */
static void lookup(struct slot *s)
{
	struct addrinfo hints, *res = NULL;
	const char *delay = getenv("VITASURF_RESOLVE_DELAY");
	const char *fail = getenv("VITASURF_RESOLVE_FAIL");
	int ret;

	if (delay != NULL) {
		usleep((useconds_t)atoi(delay) * 1000);
	}
	if (fail != NULL && strcmp(fail, s->host) == 0) {
		s->fail = FAIL_TEST;
		return;
	}
	/* the own client against a test's DNS server */
	if (getenv("VITASURF_DNS_SERVER") != NULL && lookup_own(s)) {
		return;
	}
	memset(&hints, 0, sizeof hints);
	hints.ai_family = AF_INET;
	hints.ai_socktype = SOCK_STREAM;
	ret = getaddrinfo(s->host, NULL, &hints, &res);
	if (ret != 0 || res == NULL) {
		s->fail = FAIL_LOOKUP;
		s->err = ret;
		return;
	}
	s->addr = ((struct sockaddr_in *)(void *)res->ai_addr)->sin_addr.s_addr;
	freeaddrinfo(res);
}

static void *lookup_thread(void *arg)
{
	struct slot *s = arg;
	uint32_t t0 = now_ms();

	lookup(s);
	s->took_ms = now_ms() - t0;
	s->done_ms = now_ms();
	slot_set_state(s, s->fail == 0 ? SLOT_OK : SLOT_FAILED);
	return NULL;
}

static bool lookup_start(struct slot *s)
{
	pthread_t t;
	pthread_attr_t attr;
	int ret;

	pthread_attr_init(&attr);
	pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
	slot_set_state(s, SLOT_RUNNING);
	ret = pthread_create(&t, &attr, lookup_thread, s);
	pthread_attr_destroy(&attr);
	if (ret != 0) {
		s->fail = FAIL_THREAD;
		s->err = ret;
		return false;
	}
	return true;
}
#endif

/* Start queued lookups, oldest first, while threads are free. */
static void start_queued(void)
{
	int running = 0, i;

	for (i = 0; i < RESOLVE_SLOTS; i++) {
		if (slot_state(&slots[i]) == SLOT_RUNNING) {
			running++;
		}
	}
	while (running < RESOLVE_THREADS) {
		struct slot *oldest = NULL;

		for (i = 0; i < RESOLVE_SLOTS; i++) {
			struct slot *s = &slots[i];

			if (slot_state(s) == SLOT_QUEUED &&
			    (oldest == NULL ||
			     (int32_t)(s->asked_ms - oldest->asked_ms) < 0)) {
				oldest = s;
			}
		}
		if (oldest == NULL) {
			return;
		}
		if (!lookup_start(oldest)) {
			oldest->done_ms = now_ms();
			oldest->took_ms = 0;
			slot_set_state(oldest, SLOT_FAILED);
			continue;
		}
		running++;
	}
}

/* Ask for a lookup of host in s, from scratch. */
static void slot_ask(struct slot *s, const char *host, uint32_t now)
{
	if (s->host != host) {
		snprintf(s->host, sizeof s->host, "%s", host);
	}
	s->addr = 0;
	s->fail = 0;
	s->err = 0;
	s->rid = 0;
	memset(&s->dns, 0, sizeof s->dns);
	s->asked_dns = false;
	s->fell_back = false;
	s->dns_ms = 0;
	s->asked_ms = now;
	s->used_ms = now;
	s->told = false;
	slot_set_state(s, SLOT_QUEUED);
}

/* The slot for host, or a free or reusable one, or NULL. */
static struct slot *slot_for(const char *host)
{
	struct slot *spare = NULL;
	int i;

	for (i = 0; i < RESOLVE_SLOTS; i++) {
		struct slot *s = &slots[i];
		int state = slot_state(s);

		if (state != SLOT_EMPTY && strcmp(s->host, host) == 0) {
			return s;
		}
		if (state == SLOT_EMPTY) {
			if (spare == NULL || slot_state(spare) != SLOT_EMPTY) {
				spare = s;
			}
		} else if ((state == SLOT_OK || state == SLOT_FAILED) &&
			   (spare == NULL ||
			    (slot_state(spare) != SLOT_EMPTY &&
			     (int32_t)(s->used_ms - spare->used_ms) < 0))) {
			spare = s;
		}
	}
	if (spare != NULL) {
		slot_set_state(spare, SLOT_EMPTY);
		spare->host[0] = '\0';
	}
	return spare;
}

/* What a failed lookup came to, in words. */
static void slot_why(struct slot *s, char *why, size_t len)
{
	const char *name = NULL;

	switch (s->fail) {
	case FAIL_CREATE:
		snprintf(why, len, "no resolver (0x%08x)",
			 (unsigned int)s->err);
		return;
	case FAIL_THREAD:
		snprintf(why, len, "no thread to look it up on (0x%08x)",
			 (unsigned int)s->err);
		return;
	case FAIL_TEST:
		snprintf(why, len, "no such host (test)");
		return;
	case FAIL_DNS: {
		const unsigned char *b = (const unsigned char *)&s->dns.server;
		const char *what;

		switch (s->dns.status) {
		case VITA_DNS_NXDOMAIN:
			what = "no such name";
			break;
		case VITA_DNS_NODATA:
			what = s->dns.has_ipv6 ?
				"no IPv4 address, only IPv6, which the Vita "
				"has no route for" : "no IPv4 address";
			break;
		default:
			what = "the DNS server failed";
			break;
		}
		snprintf(why, len, "%s (rcode %d from %u.%u.%u.%u%s%s)", what,
			 s->dns.rcode, b[0], b[1], b[2], b[3],
			 s->dns.cnames > 0 ? ", after an alias" : "",
			 s->dns.tcp ? ", over TCP" : "");
		return;
	}
	default:
		break;
	}
#ifdef __vita__
	name = resolver_error(s->err);
	if (name != NULL) {
		snprintf(why, len, "%s (0x%08x)", name, (unsigned int)s->err);
	} else {
		snprintf(why, len, "error 0x%08x", (unsigned int)s->err);
	}
#else
	name = gai_strerror(s->err);
	snprintf(why, len, "%s", name);
#endif
}

/* Say what a lookup came to, once, when it is first collected. */
static void slot_report(struct slot *s, int state)
{
	uint32_t waited = s->done_ms - s->asked_ms;

	if (s->fell_back) {
		vita_log("dns: %s: VitaSurf's own query %s after %u ms (%d "
			 "sent), so the system resolver was asked", s->host,
			 s->dns.status == VITA_DNS_TIMEOUT ? "had no answer" :
			 s->dns.status == VITA_DNS_ERROR ? "could not be sent" :
			 "had an answer it could not read",
			 (unsigned int)s->dns_ms, s->dns.tries);
	}
	if (state == SLOT_FAILED) {
		char why[128];

		slot_why(s, why, sizeof why);
		vita_log("dns: %s failed after %u ms: %s", s->host,
			 (unsigned int)s->took_ms, why);
	} else if (waited >= RESOLVE_SLOW_MS) {
		vita_log("dns: %s took %u ms (%u of them waiting for a "
			 "thread)", s->host, (unsigned int)waited,
			 (unsigned int)(waited - s->took_ms));
	}
}

int vita_resolve(const char *host, char *addrs, size_t len,
		 char *why, size_t why_len)
{
	uint32_t now = now_ms();
	struct slot *s;
	int state;

	if (host == NULL || host[0] == '\0' || strlen(host) >= 256) {
		snprintf(why, why_len, "bad host name");
		return VITA_RESOLVE_FAILED;
	}
	s = slot_for(host);
	if (s == NULL) {
		/* every slot is a lookup in progress: ask again later */
		start_queued();
		return VITA_RESOLVE_PENDING;
	}
	state = slot_state(s);
	if (state == SLOT_EMPTY ||
	    (state == SLOT_OK && now - s->done_ms >= RESOLVE_KEEP_MS) ||
	    (state == SLOT_FAILED && now - s->done_ms >= RESOLVE_FAIL_KEEP_MS)) {
		slot_ask(s, host, now);
		state = SLOT_QUEUED;
	}
	s->used_ms = now;
	if (state == SLOT_QUEUED || state == SLOT_RUNNING) {
		start_queued();
		state = slot_state(s);
		if (state == SLOT_QUEUED || state == SLOT_RUNNING) {
			return VITA_RESOLVE_PENDING;
		}
	}
	/* the first to collect an answer reports it */
	if (!s->told) {
		slot_report(s, state);
		s->told = true;
	}
	if (state == SLOT_OK) {
		const unsigned char *b = (const unsigned char *)&s->addr;

		snprintf(addrs, len, "%u.%u.%u.%u", b[0], b[1], b[2], b[3]);
		return VITA_RESOLVE_OK;
	}
	slot_why(s, why, why_len);
	return VITA_RESOLVE_FAILED;
}

void vita_resolve_fini(void)
{
	uint32_t until = now_ms() + 500;
	bool running;
	int i;

	/* nothing new starts; abandon what is queued */
	for (i = 0; i < RESOLVE_SLOTS; i++) {
		if (slot_state(&slots[i]) == SLOT_QUEUED) {
			slot_set_state(&slots[i], SLOT_EMPTY);
		}
	}
#ifdef __vita__
	for (i = 0; i < RESOLVE_SLOTS; i++) {
		int rid = __atomic_load_n(&slots[i].rid, __ATOMIC_ACQUIRE);

		if (slot_state(&slots[i]) == SLOT_RUNNING && rid > 0) {
			sceNetResolverAbort(rid, 0);
		}
	}
#endif
	/* the threads use SceNet until they end: let them, briefly */
	do {
		running = false;
		for (i = 0; i < RESOLVE_SLOTS; i++) {
			if (slot_state(&slots[i]) == SLOT_RUNNING) {
				running = true;
			}
		}
		if (running) {
#ifdef __vita__
			sceKernelDelayThread(10 * 1000);
#else
			usleep(10 * 1000);
#endif
		}
	} while (running && (int32_t)(now_ms() - until) < 0);
}
