/*
 * VitaSurf platform layer: paths, logging and system initialisation.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <psp2/apputil.h>
#include <psp2/io/dirent.h>
#include <psp2/io/stat.h>
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/sysmem.h>
#include <psp2/power.h>

/* After the SCE headers: <sys/stat.h> defines st_ctime as a macro, which
 * would otherwise mangle the SceIoStat field of the same name. */
#include <errno.h>
#include <iconv.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/x509.h>

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

int vita_verbose_requested(void)
{
	static const char *const names[] = {
		VITASURF_VERBOSE_FLAG,
		VITASURF_VERBOSE_FLAG ".txt",
	};
	SceIoStat st;
	unsigned int i;

	/* Accept either name, through the SCE call or the C library. */
	for (i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
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
 * Parse the bundled CA file through OpenSSL the way libcurl does and log
 * what happens, so a TLS failure can be traced to OpenSSL itself.
 */
/**
 * Mirror curl's load_cacert_from_memory(): read the bundle with
 * PEM_X509_INFO_read_bio() and add every certificate to a fresh
 * X509_STORE. curl returns CURLE_SSL_CACERT_BADFILE when either step
 * fails, so this shows which one does on the Vita.
 */
static void log_openssl_store_selftest(const char *pem, size_t len)
{
	BIO *bio;
	STACK_OF(X509_INFO) *infos;
	X509_STORE *store;
	int i, n, added = 0, skipped = 0;
	unsigned long err;
	char errbuf[256];

	bio = BIO_new_mem_buf(pem, (int)len);
	if (bio == NULL) {
		vita_log("selftest: store: BIO_new_mem_buf failed");
		return;
	}

	ERR_clear_error();
	infos = PEM_X509_INFO_read_bio(bio, NULL, NULL, NULL);
	BIO_free(bio);
	if (infos == NULL) {
		err = ERR_peek_last_error();
		ERR_error_string_n(err, errbuf, sizeof(errbuf));
		vita_log("selftest: store: PEM_X509_INFO_read_bio failed: %08lx %s",
			 err, errbuf);
		ERR_clear_error();
		return;
	}
	n = sk_X509_INFO_num(infos);
	vita_log("selftest: store: PEM_X509_INFO_read_bio returned %d entries", n);

	store = X509_STORE_new();
	if (store == NULL) {
		err = ERR_peek_last_error();
		ERR_error_string_n(err, errbuf, sizeof(errbuf));
		vita_log("selftest: store: X509_STORE_new failed: %08lx %s",
			 err, errbuf);
		sk_X509_INFO_pop_free(infos, X509_INFO_free);
		ERR_clear_error();
		return;
	}

	for (i = 0; i < n; i++) {
		X509_INFO *info = sk_X509_INFO_value(infos, i);

		if (info->x509 == NULL) {
			skipped++;
			continue;
		}
		if (!X509_STORE_add_cert(store, info->x509)) {
			err = ERR_peek_last_error();
			ERR_error_string_n(err, errbuf, sizeof(errbuf));
			vita_log("selftest: store: X509_STORE_add_cert #%d failed: %08lx %s",
				 i, err, errbuf);
			ERR_clear_error();
			break;
		}
		added++;
	}
	vita_log("selftest: store: added %d certificates (%d entries without a certificate)",
		 added, skipped);

	X509_STORE_free(store);
	sk_X509_INFO_pop_free(infos, X509_INFO_free);
	ERR_clear_error();
}

static void log_openssl_selftest(void)
{
	char *pem = NULL;
	size_t len = 0;
	BIO *bio;
	X509 *cert;
	int count = 0;
	unsigned long err;
	char errbuf[256];

	if (vita_read_file(VITASURF_CA_BUNDLE, &pem, &len) != 0) {
		vita_log("selftest: cannot read %s", VITASURF_CA_BUNDLE);
		return;
	}

	bio = BIO_new_mem_buf(pem, (int)len);
	if (bio == NULL) {
		vita_log("selftest: BIO_new_mem_buf failed");
		free(pem);
		return;
	}

	ERR_clear_error();
	while ((cert = PEM_read_bio_X509(bio, NULL, NULL, NULL)) != NULL) {
		if (count == 0) {
			char name[128];

			name[0] = '\0';
			X509_NAME_oneline(X509_get_subject_name(cert), name,
					  sizeof(name));
			vita_log("selftest: first certificate: %s", name);
		}
		X509_free(cert);
		count++;
	}
	err = ERR_peek_last_error();
	ERR_error_string_n(err, errbuf, sizeof(errbuf));
	vita_log("selftest: OpenSSL %s parsed %d certificates from the bundle, last error %08lx %s",
		 OpenSSL_version(OPENSSL_VERSION), count, err, errbuf);
	ERR_clear_error();
	BIO_free(bio);

	log_openssl_store_selftest(pem, len);
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
	log_openssl_selftest();
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
	vita_log("VitaSurf starting, build %s (%s)", VITASURF_BUILD_ID,
		 VITASURF_BUILD_SHA);
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

	/* Networking must be up before NetSurf registers the curl fetcher. */
	vita_net_init();

	log_selftest();
	log_data_dir();
	vita_log("verbose flag file %s: %s", VITASURF_VERBOSE_FLAG,
		 vita_verbose_requested() ? "present" : "absent");
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
