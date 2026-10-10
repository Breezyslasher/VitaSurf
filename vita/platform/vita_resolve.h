/*
 * VitaSurf host name lookups away from the main thread (vita_resolve.c).
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_RESOLVE_H
#define VITASURF_RESOLVE_H

#include <stddef.h>

#define VITA_RESOLVE_PENDING 0 /**< asked; ask again later */
#define VITA_RESOLVE_OK      1 /**< addrs holds the address */
#define VITA_RESOLVE_FAILED  2 /**< no address; why says why */

/**
 * Look a host name up without waiting. The first call for a host starts
 * a lookup on a thread of its own and returns VITA_RESOLVE_PENDING; call
 * again until it says otherwise. An answer is kept for a minute, as
 * long as curl keeps one, and a failure for five seconds, so every fetch
 * waiting on a host hears the same answer. Main thread only.
 *
 * \param host  Host name, not an address literal.
 * \param addrs Receives the address as text on VITA_RESOLVE_OK.
 * \param len   Size of addrs; 16 holds any IPv4 address.
 * \param why   Receives what went wrong on VITA_RESOLVE_FAILED.
 * \param why_len Size of why.
 * \return VITA_RESOLVE_PENDING, VITA_RESOLVE_OK or VITA_RESOLVE_FAILED.
 */
int vita_resolve(const char *host, char *addrs, size_t len,
		 char *why, size_t why_len);

/** Abandon the lookups still running, before networking shuts down. */
void vita_resolve_fini(void);

#endif
