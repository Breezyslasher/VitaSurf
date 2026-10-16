/*
 * VitaSurf's own DNS client (vita_dns.c).
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_DNS_H
#define VITASURF_DNS_H

#include <stdbool.h>
#include <stdint.h>

#define VITA_DNS_OK       0 /**< addr holds an IPv4 address */
#define VITA_DNS_NXDOMAIN 1 /**< the server says there is no such name */
#define VITA_DNS_NODATA   2 /**< the name exists but has no IPv4 address */
#define VITA_DNS_SERVFAIL 3 /**< every server failed or refused (rcode) */
#define VITA_DNS_TIMEOUT  4 /**< no server answered */
#define VITA_DNS_ERROR    5 /**< could not ask: no server, no socket */
#define VITA_DNS_BADREPLY 6 /**< an answer that could not be read */

#define VITA_DNS_MAX_SERVERS 2

/** What a query came to; written by the thread that asked */
struct vita_dns_result {
	int status;          /**< VITA_DNS_* */
	uint32_t addr;       /**< the address, network order, on OK */
	int rcode;           /**< the server's response code */
	bool has_ipv6;       /**< on NODATA: the name has an IPv6 address */
	bool tcp;            /**< the answer came over TCP (it was truncated) */
	int cnames;          /**< aliases followed */
	uint32_t server;     /**< the server that answered, network order */
	int tries;           /**< queries sent */
	int servers;         /**< servers the network gave */
};

/**
 * The DNS servers the network gave, as SceNetCtl reports them; natively
 * those in /etc/resolv.conf, or VITASURF_DNS_SERVER ("ip[:port]") for
 * tests.
 *
 * \param servers Receives up to VITA_DNS_MAX_SERVERS addresses
 * \param port Receives the port to ask on, 53 but for tests
 * \return how many servers
 */
int vita_dns_servers(uint32_t *servers, uint16_t *port);

/**
 * Look a name's IPv4 address up by asking the network's DNS servers
 * directly, as a browser's own resolver does: aliases are followed, a
 * truncated answer is asked again over TCP, and an answer that the name
 * has no IPv4 address is an answer, not a reason to wait. A server that
 * fails or refuses the query is not: the next try asks the next server,
 * and when every try is refused the result is VITA_DNS_SERVFAIL, for the
 * caller to ask the system resolver. Blocks; call on a thread of its
 * own.
 *
 * \param host The name, not an address literal
 * \param r Receives the result
 */
void vita_dns_lookup(const char *host, struct vita_dns_result *r);

#endif
