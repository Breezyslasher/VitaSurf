/*
 * VitaSurf networking: SceNet and SceNetCtl initialisation.
 *
 * NetSurf fetches through libcurl, which uses newlib's BSD socket layer.
 * That layer initialises SceNet lazily with a pool sized for a handful of
 * sockets, so VitaSurf initialises it first with a pool sized for a
 * browser; newlib then sees SceNet already running and carries on.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <psp2/net/net.h>
#include <psp2/net/netctl.h>
#include <psp2/sysmodule.h>

#include <string.h>

#include "vita_platform.h"

/*
 * SceNet takes its socket and buffer memory from this pool. 2 MB covers
 * NetSurf's default of eight concurrent fetchers with room to spare; the
 * pool is static so it never competes with the newlib heap.
 */
#define NET_POOL_SIZE (2 * 1024 * 1024)

static char __attribute__((aligned(64))) net_pool[NET_POOL_SIZE];

/* SceNet returns these when the caller has already initialised it. */
#define VITA_NET_ERROR_EBUSY          ((int)0x80410201)
#define VITA_NETCTL_ERROR_NOT_TERMED  ((int)0x80412102)

static int net_up = 0;

int vita_net_init(void)
{
	SceNetInitParam param;
	int ret;

	ret = sceSysmoduleLoadModule(SCE_SYSMODULE_NET);
	if (ret < 0) {
		vita_log("net: sceSysmoduleLoadModule(NET) failed: 0x%08x",
			 (unsigned int)ret);
		return ret;
	}

	memset(&param, 0, sizeof(param));
	param.memory = net_pool;
	param.size = NET_POOL_SIZE;
	param.flags = 0;
	ret = sceNetInit(&param);
	if (ret < 0 && ret != VITA_NET_ERROR_EBUSY) {
		vita_log("net: sceNetInit failed: 0x%08x", (unsigned int)ret);
		return ret;
	}

	ret = sceNetCtlInit();
	if (ret < 0 && ret != VITA_NETCTL_ERROR_NOT_TERMED) {
		vita_log("net: sceNetCtlInit failed: 0x%08x", (unsigned int)ret);
		sceNetTerm();
		return ret;
	}

	net_up = 1;
	vita_log("net: SceNet initialised with a %u KB pool",
		 (unsigned int)(NET_POOL_SIZE / 1024));
	vita_net_log_state();
	return 0;
}

void vita_net_log_state(void)
{
	int state = -1;
	SceNetCtlInfo info;

	if (!net_up) {
		vita_log("net: not initialised");
		return;
	}

	if (sceNetCtlInetGetState(&state) < 0) {
		vita_log("net: sceNetCtlInetGetState failed");
		return;
	}
	if (state != SCE_NETCTL_STATE_CONNECTED) {
		vita_log("net: not connected (state %d)", state);
		return;
	}

	memset(&info, 0, sizeof(info));
	if (sceNetCtlInetGetInfo(SCE_NETCTL_INFO_GET_IP_ADDRESS, &info) < 0) {
		vita_log("net: connected, address unknown");
		return;
	}
	vita_log("net: connected, address %s", info.ip_address);
}

void vita_net_fini(void)
{
	if (!net_up) {
		return;
	}
	sceNetCtlTerm();
	sceNetTerm();
	sceSysmoduleUnloadModule(SCE_SYSMODULE_NET);
	net_up = 0;
}
