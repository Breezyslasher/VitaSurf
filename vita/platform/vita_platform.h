/*
 * VitaSurf platform layer: paths, logging and system initialisation.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_PLATFORM_H
#define VITASURF_PLATFORM_H

/* Screen geometry. The front touch panel reports 1920x1088 and is halved. */
#define VITASURF_SCREEN_WIDTH  960
#define VITASURF_SCREEN_HEIGHT 544

/*
 * Paths. app0: is read-only; everything writable lives under ux0:.
 *
 * NetSurf itself is compiled with drive-less resource paths (/resources),
 * which VitaSDK newlib resolves against the current drive, app0:. Keep every
 * other Vita path here so no other file needs to know about drive prefixes.
 */
#define VITASURF_RES_DIR   "app0:/resources"
#define VITASURF_DATA_DIR  "ux0:/data/VitaSurf"
#define VITASURF_LOG_PATH  VITASURF_DATA_DIR "/log.txt"
#define VITASURF_CA_BUNDLE VITASURF_RES_DIR "/cacert.pem"

/**
 * Initialise the platform: create the data directory, redirect stderr and
 * stdout to the log file, raise the clocks and initialise SceAppUtil.
 *
 * \return 0 on success, negative on failure (the log may be unavailable).
 */
int vita_platform_init(void);

/** Tear down what vita_platform_init() set up and flush the log. */
void vita_platform_fini(void);

/**
 * Append a line to the log with a millisecond timestamp.
 *
 * Never use %zu or 64-bit format specifiers: this is a 32-bit target.
 */
void vita_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/** Log free user, CDRAM and physically contiguous memory. */
void vita_log_memory(const char *what);

#endif
