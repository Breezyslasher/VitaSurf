/*
 * VitaSurf platform layer: paths, logging and system initialisation.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_PLATFORM_H
#define VITASURF_PLATFORM_H

/* Screen geometry. The front touch panel reports 1920x1088 and is halved. */
#ifndef VITASURF_BUILD_ID
#define VITASURF_BUILD_ID "local"
#endif
#ifndef VITASURF_BUILD_SHA
#define VITASURF_BUILD_SHA "unknown"
#endif

#define VITASURF_SCREEN_WIDTH  960
#define VITASURF_SCREEN_HEIGHT 544

/*
 * Paths. app0: is read-only; everything writable lives under ux0:.
 *
 * The drive:path form without a slash after the colon is what the SCE I/O
 * functions expect and what the working Vita apps use. NetSurf itself is
 * compiled with drive-less resource paths (/resources), which VitaSDK
 * newlib resolves against the current drive, app0:. Keep every other Vita
 * path here so no other file needs to know about drive prefixes.
 */
#define VITASURF_RES_DIR      "app0:resources"
#define VITASURF_DATA_DIR     "ux0:data/VitaSurf"
#define VITASURF_LOG_PATH     VITASURF_DATA_DIR "/log.txt"
#define VITASURF_STDOUT_PATH  VITASURF_DATA_DIR "/stdout.txt"
#define VITASURF_VERBOSE_FLAG VITASURF_DATA_DIR "/verbose"
#define VITASURF_CA_BUNDLE    VITASURF_RES_DIR "/cacert.pem"

/* Persistence (phase 5): everything the user accumulates lives here. */
#define VITASURF_USER_CHOICES VITASURF_DATA_DIR "/Choices"
#define VITASURF_URLS_PATH    VITASURF_DATA_DIR "/URLs"
#define VITASURF_COOKIES_PATH VITASURF_DATA_DIR "/Cookies"
#define VITASURF_BOOKMARKS_PATH VITASURF_DATA_DIR "/Bookmarks"
#define VITASURF_BOOKMARKS_PAGE VITASURF_DATA_DIR "/bookmarks.html"
#define VITASURF_HISTORY_PAGE   VITASURF_DATA_DIR "/history.html"
#define VITASURF_DOWNLOADS_DIR  VITASURF_DATA_DIR "/downloads"
#define VITASURF_DOWNLOADS_PAGE VITASURF_DATA_DIR "/downloads.html"
/* The same files as file: URLs NetSurf can open (the Vita file table maps
 * /ux0:/... back to ux0:/...). */
#define VITASURF_BOOKMARKS_URL "file:///ux0:/data/VitaSurf/bookmarks.html"
#define VITASURF_HISTORY_URL   "file:///ux0:/data/VitaSurf/history.html"
#define VITASURF_DOWNLOADS_URL "file:///ux0:/data/VitaSurf/downloads.html"

/**
 * Initialise the platform: create the data directory, open the log,
 * redirect stderr and stdout into it, raise the clocks and initialise
 * SceAppUtil. Logs a self-test of the path and clock assumptions NetSurf
 * relies on.
 *
 * \return 0 on success, negative if the log could not be opened.
 */
int vita_platform_init(void);

/** Tear down what vita_platform_init() set up and flush the log. */
void vita_platform_fini(void);

/**
 * Append a line to the log with a millisecond timestamp and flush it, so
 * the line survives a crash or a LiveArea kill.
 *
 * Never use %zu or other 64-bit format specifiers: this is a 32-bit target.
 */
void vita_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/** Log free user, CDRAM and physically contiguous memory. */
void vita_log_memory(const char *what);

/**
 * Bring up SceNet and SceNetCtl (vita_net.c). Must run before NetSurf
 * initialises libcurl. Returns 0 on success; failure leaves the browser
 * usable for local pages only.
 */
int vita_net_init(void);

/** Log the connection state and address. */
void vita_net_log_state(void);

/** Shut networking down. */
void vita_net_fini(void);

/**
 * Read a whole file into a malloc()ed buffer with a trailing NUL that is
 * not counted in len. Returns 0 on success, -1 on failure.
 */
int vita_read_file(const char *path, char **data, size_t *len);

/** True when the user created the verbose flag file in the data directory. */
int vita_verbose_requested(void);

/**
 * NetSurf file operation table with Vita path translation (vita_file.c).
 * Installed into the framebuffer frontend's netsurf_table by
 * patches/0002-netsurf-vita-gui-hooks.patch.
 */
struct gui_file_table;
extern struct gui_file_table *vita_file_table;

/** NetSurf download table (vita_download.c): saves to the downloads dir. */
struct gui_download_table;
extern struct gui_download_table *vita_download_table;

/**
 * Poll the system event queue (vita_platform.c). Returns 1 once after the
 * application resumed from suspend, 0 otherwise. Cheap enough to call a
 * few times a second.
 */
int vita_platform_poll_resume(void);

#endif
