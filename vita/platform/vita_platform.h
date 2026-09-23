/*
 * VitaSurf platform layer: paths, logging and system initialisation.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_PLATFORM_H
#define VITASURF_PLATFORM_H

#include <stdbool.h>
#include <stddef.h>

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
/* drop a file of this name beside it to have each page's boxes logged */
#define VITASURF_LAYOUT_FLAG VITASURF_DATA_DIR "/dumplayout"
#define VITASURF_CA_BUNDLE    VITASURF_RES_DIR "/cacert.pem"

/* Persistence (phase 5): everything the user accumulates lives here. */
#define VITASURF_USER_CHOICES VITASURF_DATA_DIR "/Choices"

/**
 * Raise options that are too low to work, after both Choices files.
 *
 * A Choices file written by an earlier build is read after the bundled
 * one, so a value corrected in the bundle never reaches a device that
 * has been used. These are the ones where the old value stops a page
 * working rather than merely tuning it.
 */
void vita_options_floor(void);
#define VITASURF_URLS_PATH    VITASURF_DATA_DIR "/URLs"
#define VITASURF_COOKIES_PATH VITASURF_DATA_DIR "/Cookies"
#define VITASURF_BOOKMARKS_PATH VITASURF_DATA_DIR "/Bookmarks"
#define VITASURF_BOOKMARKS_PAGE VITASURF_DATA_DIR "/bookmarks.html"
#define VITASURF_HISTORY_PAGE   VITASURF_DATA_DIR "/history.html"
/* Compiled JavaScript, kept between runs. See bc_load() in vita/js/qjs.c. */
#define VITASURF_JSCACHE_DIR    VITASURF_DATA_DIR "/jscache"
/* What sites store: localStorage and IndexedDB, one file per origin. */
#define VITASURF_STORAGE_DIR    VITASURF_DATA_DIR "/storage"
/* NetSurf's disc cache: fetched pages, scripts and images, kept across
 * runs. It costs memory card space rather than heap, which is the one
 * thing this machine has plenty of. */
#define VITASURF_DISCCACHE_DIR  VITASURF_DATA_DIR "/cache"
/* Turned off from the menu, and remembered here, so a raw load can be
 * timed against a cached one without reinstalling anything. */
#define VITASURF_NOCACHE_FLAG   VITASURF_DATA_DIR "/nocache"
#define VITASURF_DOWNLOADS_DIR  VITASURF_DATA_DIR "/downloads"
#define VITASURF_DOWNLOADS_PAGE VITASURF_DATA_DIR "/downloads.html"
/* The Log screen: the last page load's waterfall, and the log's tail. */
#define VITASURF_LOG_PAGE       VITASURF_DATA_DIR "/log.html"
/* holds the URL of a FlareSolverr server, e.g. http://192.168.1.20:8191/v1 */
#define VITASURF_FLARESOLVERR_PATH VITASURF_DATA_DIR "/flaresolverr"
/* The same files as file: URLs NetSurf can open (the Vita file table maps
 * /ux0:/... back to ux0:/...). */
#define VITASURF_BOOKMARKS_URL "file:///ux0:/data/VitaSurf/bookmarks.html"
#define VITASURF_HISTORY_URL   "file:///ux0:/data/VitaSurf/history.html"
#define VITASURF_DOWNLOADS_URL "file:///ux0:/data/VitaSurf/downloads.html"
#define VITASURF_LOG_URL       "file:///ux0:/data/VitaSurf/log.html"

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

/**
 * Push what has been logged out to the memory card.
 *
 * The log is buffered, because a write to the card costs about nine
 * milliseconds and logging every line straight through left nothing
 * for the frame. Anything that is about to stop the program calls
 * this, so what it logged on the way down is on the card.
 */
void vita_log_flush(void);

/** Microseconds since the process started, for measuring a frame. */
unsigned long long vita_now_us(void);

/**
 * Whether Circle was pressed to stop the running script, clearing the
 * request. The surface's busy overlay (vita/surface/vita.c) sets it from
 * its own thread while the page has not given the screen back; the
 * script engine's interrupt check asks here.
 */
bool vita_busy_take_cancel(void);

/**
 * The script binding running now, by its C function name, or NULL when
 * none is (VitaSurf). Set on entry to every binding in vita/js/qjs.c and
 * cleared whenever script runs; the busy overlay reads it from its own
 * thread to say what a stall was spent in. Defined in the surface.
 */
extern const char *volatile vita_c_where;

/** Log free user, CDRAM and physically contiguous memory. */
void vita_log_memory(const char *what);

/**
 * Log which image formats registered a content handler. Call after
 * netsurf_init(), which is what registers them.
 */
void vita_log_image_decoders(void);

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
 * Whether the layout dump flag file is present.
 *
 * A page that comes out wrong on the device cannot be opened in a
 * debugger, so with this flag the boxes of each page it loads are
 * written to the log and can be read later.
 *
 * \return non-zero if the flag file is there
 */
int vita_layout_dump_requested(void);

/**
 * Whether every fetch should ignore the caches.
 *
 * NetSurf reads this for each retrieval, so it takes effect on the next
 * page rather than the next run.
 */
bool vitasurf_cache_disabled(void);

/** Turn the caches off or on, and remember which across runs. */
void vitasurf_set_cache_disabled(bool off);

/**
 * The main thread's stack size in bytes, as the kernel reports it, or 0
 * before it has been measured. Not what was requested: --gc-sections can
 * drop the request and leave the runtime's own default behind, so
 * anything sized against the stack must use this.
 */
extern unsigned int vita_main_stack_bytes;

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

/**
 * FlareSolverr client (vita_flaresolverr.c). The endpoint is NULL unless
 * the user created the flaresolverr file. vita_flaresolverr_solve() asks
 * the server to pass the Cloudflare check for url, stores the cookies it
 * returns and switches to its user agent; it blocks while the solver
 * works. Returns true when the page can be reloaded.
 */
struct nsurl;
const char *vita_flaresolverr_endpoint(void);
bool vita_flaresolverr_solve(struct nsurl *url);

#endif
