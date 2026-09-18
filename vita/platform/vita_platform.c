/*
 * VitaSurf platform layer: paths, logging and system initialisation.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <psp2/appmgr.h>
#include <psp2/apputil.h>
#include <psp2/common_dialog.h>
#include <psp2/io/dirent.h>
#include <psp2/io/stat.h>
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/sysmem.h>
#include <psp2/power.h>
#include <psp2/sysmodule.h>
#include <psp2/system_param.h>

/* After the SCE headers: <sys/stat.h> defines st_ctime as a macro, which
 * would otherwise mangle the SceIoStat field of the same name. */
#include <errno.h>
#include <iconv.h>
#include <malloc.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>

#include "utils/nsoption.h"
#include "content/content_factory.h"
#include "netsurf/content_type.h"

#include <mbedtls/error.h>
#include <mbedtls/version.h>
#include <mbedtls/x509_crt.h>

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

/* exported interface documented in vita_platform.h */
void vita_options_floor(void)
{
	/*
	 * Two fetches per host was set to keep memory down, before there
	 * was anything to measure it against. It is far too few for a page
	 * that loads its code in pieces: GitHub asks for thirteen chunks
	 * at once and a bundler gives up on one after about two seconds,
	 * which two at a time cannot meet. Six matches what a browser
	 * uses, and the fetchers themselves are small next to the
	 * documents they fetch.
	 */
	if (nsoption_int(max_fetchers_per_host) < 6) {
		nsoption_set_int(max_fetchers_per_host, 6);
	}
	if (nsoption_int(max_fetchers) < 12) {
		nsoption_set_int(max_fetchers, 12);
	}
	vita_log("options: %d fetchers, %d per host",
		 nsoption_int(max_fetchers),
		 nsoption_int(max_fetchers_per_host));
}

/*
 * Which image formats this build can actually decode.
 *
 * The answer is not a compile-time constant here: the WebP and JPEG XL
 * handlers are built only if pkg-config finds libwebp and libjxl in the
 * toolchain, and the flags that decide it belong to NetSurf's build, not
 * to this file's. So ask the content factory, which knows what actually
 * registered, and log it once at startup. A page that arrives as a grey
 * box is then one line away from an explanation.
 */
void vita_log_image_decoders(void)
{
	static const struct {
		const char *mime;
		const char *name;
	} types[] = {
		{ "image/png",		"png" },
		{ "image/jpeg",		"jpeg" },
		{ "image/gif",		"gif" },
		{ "image/bmp",		"bmp" },
		{ "image/x-icon",	"ico" },
		{ "image/svg+xml",	"svg" },
		{ "image/webp",		"webp" },
		{ "image/jxl",		"jxl" },
	};
	char have[256];
	char missing[256];
	unsigned int nhave = 0;
	unsigned int nmissing = 0;
	unsigned int i;

	have[0] = '\0';
	missing[0] = '\0';

	for (i = 0; i < sizeof(types) / sizeof(types[0]); i++) {
		lwc_string *mime;
		content_type type = CONTENT_NONE;

		if (lwc_intern_string(types[i].mime, strlen(types[i].mime),
				      &mime) != lwc_error_ok) {
			continue;
		}
		type = content_factory_type_from_mime_type(mime);
		lwc_string_unref(mime);

		if (type != CONTENT_NONE) {
			snprintf(have + strlen(have),
				 sizeof(have) - strlen(have),
				 "%s%s", nhave++ ? " " : "", types[i].name);
		} else {
			snprintf(missing + strlen(missing),
				 sizeof(missing) - strlen(missing),
				 "%s%s", nmissing++ ? " " : "", types[i].name);
		}
	}

	vita_log("image decoders: %s", nhave ? have : "none");
	if (nmissing > 0) {
		vita_log("image decoders missing: %s", missing);
	}
}

void vita_log_memory(const char *what)
{
	SceKernelFreeMemorySizeInfo info;
	struct mallinfo mi;

	memset(&info, 0, sizeof(info));
	info.size = sizeof(info);
	if (sceKernelGetFreeMemorySize(&info) < 0) {
		vita_log("memory (%s): sceKernelGetFreeMemorySize failed", what);
		return;
	}

	/*
	 * The newlib heap is one block taken at startup, so the kernel's
	 * free figure never moves; mallinfo() shows what is used inside it.
	 */
	mi = mallinfo();
	vita_log("memory (%s): heap used %u KB of %u KB, free user %u KB, cdram %u KB, phycont %u KB",
		 what,
		 (unsigned int)mi.uordblks / 1024,
		 (unsigned int)mi.arena / 1024,
		 (unsigned int)info.size_user / 1024,
		 (unsigned int)info.size_cdram / 1024,
		 (unsigned int)info.size_phycont / 1024);
}

int vita_platform_poll_resume(void)
{
	SceAppMgrSystemEvent ev;
	int resumed = 0;

	/* drain the queue; several events can be pending after a long sleep */
	while (sceAppMgrReceiveSystemEvent(&ev) >= 0) {
		if (ev.systemEvent == SCE_APPMGR_SYSTEMEVENT_ON_RESUME) {
			resumed = 1;
		}
	}
	return resumed;
}

int vita_read_file(const char *path, char **data, size_t *len)
{
	FILE *f = fopen(path, "rb");
	long size;
	char *buf;

	if (f == NULL) {
		return -1;
	}
	if (fseek(f, 0, SEEK_END) != 0 || (size = ftell(f)) < 0 ||
	    fseek(f, 0, SEEK_SET) != 0) {
		fclose(f);
		return -1;
	}
	buf = malloc((size_t)size + 1);
	if (buf == NULL) {
		fclose(f);
		return -1;
	}
	if (fread(buf, 1, (size_t)size, f) != (size_t)size) {
		free(buf);
		fclose(f);
		return -1;
	}
	fclose(f);
	buf[size] = '\0';
	*data = buf;
	*len = (size_t)size;
	return 0;
}

/**
 * Whether a flag file of this name is present.
 *
 * Either with or without a .txt on the end, and through the SCE call
 * or the C library, since which of them sees a file the user dropped
 * on the memory card from a PC depends on how it got there.
 */
static int vita_flag_present(const char *name)
{
	char with_txt[256];
	const char *names[2];
	SceIoStat st;
	unsigned int i;

	snprintf(with_txt, sizeof(with_txt), "%s.txt", name);
	names[0] = name;
	names[1] = with_txt;

	for (i = 0; i < 2; i++) {
		FILE *f;

		if (sceIoGetstat(names[i], &st) >= 0) {
			return 1;
		}
		f = fopen(names[i], "r");
		if (f != NULL) {
			fclose(f);
			return 1;
		}
	}
	return 0;
}


int vita_verbose_requested(void)
{
	return vita_flag_present(VITASURF_VERBOSE_FLAG);
}


int vita_layout_dump_requested(void)
{
	return vita_flag_present(VITASURF_LAYOUT_FLAG);
}

/** Log the contents of the data directory so flag files can be checked. */
static void log_data_dir(void)
{
	SceUID dfd = sceIoDopen(VITASURF_DATA_DIR);
	SceIoDirent ent;
	int count = 0;

	if (dfd < 0) {
		vita_log("sceIoDopen(%s) failed: 0x%08x", VITASURF_DATA_DIR,
			 (unsigned int)dfd);
		return;
	}
	memset(&ent, 0, sizeof(ent));
	while (sceIoDread(dfd, &ent) > 0 && count < 32) {
		vita_log("data dir: '%s' %s %u bytes", ent.d_name,
			 SCE_S_ISDIR(ent.d_stat.st_mode) ? "dir" : "file",
			 (unsigned int)ent.d_stat.st_size);
		memset(&ent, 0, sizeof(ent));
		count++;
	}
	sceIoDclose(dfd);
}

/**
 * libparserutils converts every page to UTF-8 through iconv, and NetSurf's
 * utils/utf8.c does the same for form data and text/plain. Log which
 * conversions the C library actually offers.
 */
static void log_iconv_selftest(void)
{
	static const char *const from[] = {
		"UTF-8", "utf-8", "ISO-8859-1", "WINDOWS-1252", "UTF-16",
		"UTF-16BE", "UTF-16LE", "US-ASCII",
	};
	unsigned int i;

	for (i = 0; i < sizeof(from) / sizeof(from[0]); i++) {
		iconv_t cd = iconv_open("UTF-8", from[i]);

		if (cd == (iconv_t)-1) {
			vita_log("selftest: iconv_open(UTF-8 <- %s) failed, errno %d",
				 from[i], errno);
			continue;
		}
		{
			char in[] = "Vita";
			char out[16];
			char *inp = in;
			char *outp = out;
			size_t inleft = 4;
			size_t outleft = sizeof(out);
			size_t r = iconv(cd, &inp, &inleft, &outp, &outleft);

			vita_log("selftest: iconv_open(UTF-8 <- %s) ok, convert %s (%u bytes out)",
				 from[i], r == (size_t)-1 ? "failed" : "ok",
				 (unsigned int)(sizeof(out) - outleft));
		}
		iconv_close(cd);
	}
}

/**
 * Parse the bundled CA file through mbedTLS the way libcurl does and log
 * the result, so a TLS failure can be traced to the bundle or the library.
 */
static void log_tls_selftest(void)
{
	char *pem = NULL;
	size_t len = 0;
	mbedtls_x509_crt chain;
	const mbedtls_x509_crt *c;
	char version[16];
	char buf[160];
	int ret;
	int count = 0;

	if (vita_read_file(VITASURF_CA_BUNDLE, &pem, &len) != 0) {
		vita_log("selftest: cannot read %s", VITASURF_CA_BUNDLE);
		return;
	}

	mbedtls_version_get_string(version);
	mbedtls_x509_crt_init(&chain);
	/* PEM input must include the terminating NUL, which vita_read_file adds */
	ret = mbedtls_x509_crt_parse(&chain, (const unsigned char *)pem, len + 1);
	for (c = &chain; c != NULL && c->version != 0; c = c->next) {
		count++;
	}
	if (ret < 0) {
		mbedtls_strerror(ret, buf, sizeof(buf));
		vita_log("selftest: mbedTLS %s failed to parse the CA bundle: -0x%04x %s",
			 version, (unsigned int)-ret, buf);
	} else {
		vita_log("selftest: mbedTLS %s parsed %d certificates from the bundle (%d rejected)",
			 version, count, ret);
	}
	if (count > 0) {
		buf[0] = '\0';
		mbedtls_x509_dn_gets(buf, sizeof(buf), &chain.subject);
		vita_log("selftest: first certificate: %s", buf);
	}
	mbedtls_x509_crt_free(&chain);
	free(pem);
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

	log_iconv_selftest();
	log_tls_selftest();
}

int vita_platform_init(void)
{
	SceAppUtilInitParam init_param;
	SceAppUtilBootParam boot_param;
	SceCommonDialogConfigParam dialog_config;
	int lang = 0, enter = 0;
	int mkdir_ret;
	int ret;

	start_time_us = sceKernelGetProcessTimeWide();

	/* Writable data directory. 0x80010011 is "already exists". */
	mkdir_ret = sceIoMkdir(VITASURF_DATA_DIR, 0777);
	/*
	 * Made here rather than on first use: the JavaScript glue is built
	 * for the native test harness too and has no Sce calls in it, so it
	 * only ever opens files inside this directory. If the directory is
	 * missing the cache misses, which costs speed and nothing else.
	 */
	sceIoMkdir(VITASURF_JSCACHE_DIR, 0777);
	sceIoMkdir(VITASURF_STORAGE_DIR, 0777);

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
	vita_log("VitaSurf starting, build %s (%s), JavaScript engine %s",
		 VITASURF_BUILD_ID, VITASURF_BUILD_SHA, VITASURF_JS_ENGINE);
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

	/*
	 * Common dialogs (the IME for URL entry) must be configured before
	 * one is shown; the other Vita apps load the IME module too.
	 */
	ret = sceSysmoduleLoadModule(SCE_SYSMODULE_IME);
	if (ret < 0) {
		vita_log("sceSysmoduleLoadModule(IME) failed: 0x%08x",
			 (unsigned int)ret);
	}
	sceCommonDialogConfigParamInit(&dialog_config);
	sceAppUtilSystemParamGetInt(SCE_SYSTEM_PARAM_ID_LANG, &lang);
	sceAppUtilSystemParamGetInt(SCE_SYSTEM_PARAM_ID_ENTER_BUTTON, &enter);
	dialog_config.language = (SceSystemParamLang)lang;
	dialog_config.enterButtonAssign = (SceSystemParamEnterButtonAssign)enter;
	ret = sceCommonDialogSetConfigParam(&dialog_config);
	if (ret < 0) {
		vita_log("sceCommonDialogSetConfigParam failed: 0x%08x",
			 (unsigned int)ret);
	}

	/* Layout and CSS are CPU bound; run at the maximum clocks. */
	scePowerSetArmClockFrequency(444);
	scePowerSetBusClockFrequency(222);
	scePowerSetGpuClockFrequency(222);
	scePowerSetGpuXbarClockFrequency(166);

	/* Networking must be up before NetSurf registers the curl fetcher. */
	vita_net_init();

	log_selftest();
	log_data_dir();
	vita_log("verbose flag file %s: %s", VITASURF_VERBOSE_FLAG,
		 vita_verbose_requested() ? "present" : "absent");
	vita_log("layout dump flag file %s: %s (the Start menu dumps "
		 "a page's layout without it)", VITASURF_LAYOUT_FLAG,
		 vita_layout_dump_requested() ? "present" : "absent");
	vita_log_memory("startup");

	return logf != NULL ? 0 : -1;
}

void vita_platform_fini(void)
{
	vita_log_memory("shutdown");
	vita_net_fini();
	vita_log("VitaSurf exiting");
	fflush(stderr);
	fflush(stdout);
	sceAppUtilShutdown();
}
