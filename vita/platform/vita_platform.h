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
/* drop a file of this name to keep image decoding on the main thread */
#define VITASURF_NO_DECODE_THREAD_FLAG VITASURF_DATA_DIR "/nodecodethread"
#define VITASURF_NO_PUMP_FLAG VITASURF_DATA_DIR "/nopump"
#define VITASURF_CA_BUNDLE    VITASURF_RES_DIR "/cacert.pem"
/* Intl.NumberFormat's locale data, from scripts/gen-intl-numbers.mjs */
#define VITASURF_INTL_PAK     VITASURF_RES_DIR "/intl.pak"

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
/* What NetSurf or the script runner is doing when no binding is named:
 * layout, box building, a style sheet, drawing, script, promise jobs
 * (VitaSurf). Defined in NetSurf's utils/utils.c. */
extern const char *volatile vitasurf_phase __attribute__((weak));

/** Log free user, CDRAM and physically contiguous memory. */
void vita_log_memory(const char *what);

/**
 * KB left in the newlib heap (VitaSurf). The heap is one block taken at
 * startup, so this is what every allocation still has to share: a new
 * JavaScript realm is refused when it is low rather than left half made.
 */
unsigned int vita_heap_free_kb(void);

/*
 * The newlib heap's size, and the user memory that was free when it was
 * taken (vita_heap.c): the heap is sized from that at startup, so a log
 * shows what the system gave and whether extended memory was granted.
 */
unsigned int vita_heap_size_kb(void);
unsigned int vita_heap_free_at_start_kb(void);

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

/**
 * The CA bundle parsed once and shared by every TLS connection (VitaSurf).
 *
 * libcurl's mbedTLS backend parses whatever CA bundle it is given inside
 * every connect, and the 121 certificates of ours take about 170 ms to
 * parse on the Vita: each HTTPS connection paid that before its
 * handshake began. The fetcher now gives libcurl a single certificate,
 * which costs nothing to parse, and puts this chain in its place from
 * CURLOPT_SSL_CTX_FUNCTION, which runs after libcurl has set its own.
 *
 * \param path       the bundle to share; loaded on the first call
 * \param first_pem  updated to the bundle's first certificate, PEM with
 *                   its NUL, for CURLOPT_CAINFO_BLOB
 * \param first_len  its length, the NUL included
 * \return 1 when the chain is ready, 0 when the bundle could not be
 *         read or parsed, or is not the one already loaded
 */
int vita_tls_ca_shared(const char *path, const char **first_pem,
		       size_t *first_len);

/**
 * Put the shared chain into an mbedtls_ssl_config, as the trust anchors
 * the peer's certificate is verified against.
 */
void vita_tls_ca_attach(void *mbedtls_ssl_config);

/**
 * Offer TLS 1.3's ChaCha20-Poly1305 and AES-128-GCM and not its other
 * suites, the TLS 1.2 ones as mbedTLS lists them (VitaSurf).
 *
 * The Vita's Cortex-A9 has no AES instructions, and in mbedTLS's C
 * ChaCha20-Poly1305 runs about 2.7 times as fast as AES-GCM: at Vita
 * speed AES-GCM holds an HTTPS download to a few MB/s on a link that
 * gives 12. mbedTLS offers ChaCha20 first, but a server built on
 * OpenSSL takes its own order, AES-256-GCM first, then ChaCha20; left
 * out of the offer, AES-256 cannot be chosen and ChaCha20 is. Every
 * TLS 1.3 server has AES-128-GCM. A server that refuses the offer
 * anyway gets mbedTLS's whole list on a second try (the fetcher keeps
 * which hosts need it).
 */
void vita_tls_lean_suites(void *mbedtls_ssl_config);

/**
 * Which cipher a TLS connection agreed (ssl, an mbedtls_ssl_context): 0 for
 * ChaCha20-Poly1305, 1 for AES, 2 for anything else; for the page
 * summary, which counts how many still end on AES (see
 * vita_tls_lean_suites()).
 */
int vita_tls_cipher_kind(const void *ssl);

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
 * Whether images should be decoded on a thread of their own: yes unless
 * the nodecodethread flag file is there, so the two can be timed
 * against each other on the device without a rebuild.
 */
bool vita_decode_thread_wanted(void);

/**
 * Whether transfers are kept moving while a script runs (VitaSurf; see
 * fetch_curl_pump): yes unless the nopump flag file is there, read once,
 * so a page can be timed with and without on the device.
 */
bool vita_curl_pump_wanted(void);

/**
 * Called on each decode thread as it starts: the first goes on the
 * second core, the second on the third, both a little below the main
 * thread's priority. It must not log; the log is the main thread's.
 *
 * \param index Which decode thread, from 0.
 */
void vita_decode_thread_started(int index);

/**
 * Whether every fetch should ignore the caches.
 *
 * NetSurf reads this for each retrieval, so it takes effect on the next
 * page rather than the next run.
 */
bool vitasurf_cache_disabled(void);

/* The system language's tags, best first: "fr-FR,fr" (utils/utils.h) */
const char *vitasurf_languages(void);

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

/** A place the file browser (about:files) starts from. */
struct vita_file_root {
	const char *path;  /**< a folder, ending in a slash: "ux0:/" */
	const char *label; /**< what is there */
};

/**
 * The places the file browser lists first (vita_file.c): VitaSurf's own
 * folders, then each storage device that can be read now.
 *
 * 
eturn How many were written to roots, at most max.
 */
int vita_file_roots(struct vita_file_root *roots, int max);

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
