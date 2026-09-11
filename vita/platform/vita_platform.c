/*
 * VitaSurf platform layer: paths, logging and system initialisation.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <psp2/apputil.h>
#include <psp2/io/stat.h>
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/sysmem.h>
#include <psp2/power.h>

/* After the SCE headers: <sys/stat.h> defines st_ctime as a macro, which
 * would otherwise mangle the SceIoStat field of the same name. */
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>

#include "vita_platform.h"

/* Where vita_log() writes. stderr once it is redirected, else a plain file. */
static FILE *logf = NULL;
static SceUInt64 start_time_us = 0;

void vita_log(const char *fmt, ...)
{
	va_list ap;
	SceUInt64 now = sceKernelGetProcessTimeWide();
	unsigned int ms = (unsigned int)((now - start_time_us) / 1000);

	if (logf == NULL) {
		return;
	}

	fprintf(logf, "[%6u.%03u] ", ms / 1000, ms % 1000);
	va_start(ap, fmt);
	vfprintf(logf, fmt, ap);
	va_end(ap);
	fputc('\n', logf);
	fflush(logf);
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

int vita_verbose_requested(void)
{
	SceIoStat st;

	/* VitaShell tends to append .txt when creating a file, accept both. */
	return sceIoGetstat(VITASURF_VERBOSE_FLAG, &st) >= 0 ||
	       sceIoGetstat(VITASURF_VERBOSE_FLAG ".txt", &st) >= 0;
}

/**
 * Log whether the assumptions the NetSurf build relies on hold: drive-less
 * paths resolve to app0:, the resources are readable, and the clocks the
 * scheduler and libnsutils use advance.
 */
static void log_selftest(void)
{
	static const char *const paths[] = {
		"/resources/Messages",
		"app0:resources/Messages",
		"app0:/resources/Messages",
		"/resources/vitasurf.html",
		VITASURF_DATA_DIR,
	};
	char cwd[256];
	struct stat st;
	struct timeval tv;
	struct timespec ts;
	unsigned int i;
	FILE *f;

	cwd[0] = '\0';
	if (getcwd(cwd, sizeof(cwd)) == NULL) {
		strcpy(cwd, "(getcwd failed)");
	}
	vita_log("selftest: cwd is '%s'", cwd);

	for (i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
		if (stat(paths[i], &st) == 0) {
			vita_log("selftest: stat '%s' ok, %s, %lu bytes",
				 paths[i],
				 S_ISDIR(st.st_mode) ? "directory" : "file",
				 (unsigned long)st.st_size);
		} else {
			vita_log("selftest: stat '%s' failed", paths[i]);
		}
	}

	f = fopen("/resources/vitasurf.html", "rb");
	if (f != NULL) {
		char buf[64];
		size_t n = fread(buf, 1, sizeof(buf) - 1, f);

		buf[n] = '\0';
		fclose(f);
		vita_log("selftest: fopen '/resources/vitasurf.html' ok, read %u bytes: %.20s",
			 (unsigned int)n, buf);
	} else {
		vita_log("selftest: fopen '/resources/vitasurf.html' failed");
	}

	if (gettimeofday(&tv, NULL) == 0) {
		vita_log("selftest: gettimeofday %lu.%06lu",
			 (unsigned long)tv.tv_sec, (unsigned long)tv.tv_usec);
	} else {
		vita_log("selftest: gettimeofday failed");
	}

	if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0) {
		vita_log("selftest: clock_gettime(MONOTONIC) %lu.%09lu",
			 (unsigned long)ts.tv_sec, (unsigned long)ts.tv_nsec);
	} else {
		vita_log("selftest: clock_gettime(MONOTONIC) failed");
	}
}

int vita_platform_init(void)
{
	SceAppUtilInitParam init_param;
	SceAppUtilBootParam boot_param;
	int mkdir_ret;
	int ret;

	start_time_us = sceKernelGetProcessTimeWide();

	/* Writable data directory. 0x80010011 is "already exists". */
	mkdir_ret = sceIoMkdir(VITASURF_DATA_DIR, 0777);

	/*
	 * Open the log with a plain fopen first so vita_log() works even if
	 * the stderr redirection below fails. NetSurf logs to stderr, so
	 * stderr is then pointed at the same file, unbuffered, and vita_log()
	 * switches to it to keep the two in order.
	 */
	logf = fopen(VITASURF_LOG_PATH, "w");
	if (logf == NULL) {
		return -1;
	}
	setvbuf(logf, NULL, _IONBF, 0);
	vita_log("VitaSurf starting");
	if (mkdir_ret < 0 && mkdir_ret != (int)0x80010011) {
		vita_log("sceIoMkdir(%s) returned 0x%08x", VITASURF_DATA_DIR,
			 (unsigned int)mkdir_ret);
	}

	fclose(logf);
	logf = NULL;
	if (freopen(VITASURF_LOG_PATH, "a", stderr) != NULL) {
		setvbuf(stderr, NULL, _IONBF, 0);
		logf = stderr;
		vita_log("stderr redirected to the log");
	} else {
		logf = fopen(VITASURF_LOG_PATH, "a");
		if (logf != NULL) {
			setvbuf(logf, NULL, _IONBF, 0);
		}
		vita_log("freopen(stderr) failed; NetSurf messages are lost");
	}
	if (freopen(VITASURF_STDOUT_PATH, "w", stdout) != NULL) {
		setvbuf(stdout, NULL, _IOLBF, 0);
	}

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

	log_selftest();
	vita_log("verbose flag file %s: %s", VITASURF_VERBOSE_FLAG,
		 vita_verbose_requested() ? "present" : "absent");
	vita_log_memory("startup");

	return logf != NULL ? 0 : -1;
}

void vita_platform_fini(void)
{
	vita_log_memory("shutdown");
	vita_log("VitaSurf exiting");
	fflush(stderr);
	fflush(stdout);
	sceAppUtilShutdown();
}
