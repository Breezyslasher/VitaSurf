/*
 * VitaSurf platform layer: paths, logging and system initialisation.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include <psp2/apputil.h>
#include <psp2/io/stat.h>
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/sysmem.h>
#include <psp2/power.h>

#include "vita_platform.h"

static int log_ready = 0;
static SceUInt64 start_time_us = 0;

void vita_log(const char *fmt, ...)
{
	va_list ap;
	SceUInt64 now = sceKernelGetProcessTimeWide();
	unsigned int ms = (unsigned int)((now - start_time_us) / 1000);

	fprintf(stderr, "[%6u.%03u] ", ms / 1000, ms % 1000);
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
}

void vita_log_memory(const char *what)
{
	SceKernelFreeMemorySizeInfo info;

	memset(&info, 0, sizeof(info));
	info.size = sizeof(info);
	if (sceKernelGetFreeMemorySize(&info) < 0) {
		vita_log("memory (%s): sceKernelGetFreeMemorySize failed", what);
		return;
	}

	vita_log("memory (%s): free user %u KB, cdram %u KB, phycont %u KB",
		 what,
		 (unsigned int)info.size_user / 1024,
		 (unsigned int)info.size_cdram / 1024,
		 (unsigned int)info.size_phycont / 1024);
}

int vita_platform_init(void)
{
	SceAppUtilInitParam init_param;
	SceAppUtilBootParam boot_param;
	int ret;

	start_time_us = sceKernelGetProcessTimeWide();

	/* Writable data directory. 0x80010011 is "already exists". */
	ret = sceIoMkdir(VITASURF_DATA_DIR, 0777);
	if (ret < 0 && ret != (int)0x80010011) {
		return ret;
	}

	/*
	 * NetSurf logs to stderr and its die() messages go there too. The
	 * log stream is left unbuffered by the framebuffer frontend, so
	 * keep logging sparse in release builds.
	 */
	if (freopen(VITASURF_LOG_PATH, "w", stderr) != NULL) {
		log_ready = 1;
	}
	freopen(VITASURF_DATA_DIR "/stdout.txt", "w", stdout);

	vita_log("VitaSurf starting");

	memset(&init_param, 0, sizeof(init_param));
	memset(&boot_param, 0, sizeof(boot_param));
	ret = sceAppUtilInit(&init_param, &boot_param);
	if (ret < 0) {
		vita_log("sceAppUtilInit failed: 0x%08x", (unsigned int)ret);
	}

	/* Layout and CSS are CPU bound; run at the maximum clocks. */
	scePowerSetArmClockFrequency(444);
	scePowerSetBusClockFrequency(222);
	scePowerSetGpuClockFrequency(222);
	scePowerSetGpuXbarClockFrequency(166);

	vita_log_memory("startup");

	return log_ready ? 0 : -1;
}

void vita_platform_fini(void)
{
	vita_log_memory("shutdown");
	vita_log("VitaSurf exiting");
	fflush(stderr);
	fflush(stdout);
	sceAppUtilShutdown();
}
