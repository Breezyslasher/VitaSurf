/*
 * Start menu: bookmarks, history, settings, quit.
 *
 * Bookmarks are kept in a plain text file (one "url<TAB>title" per line)
 * under ux0:data/VitaSurf and shown as a generated HTML page, as is the
 * history from NetSurf's URL database. Settings changes are written to a
 * user Choices file that the frontend reads after the bundled one.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>

#include <psp2/kernel/processmgr.h>

#include <libnsfb.h>
#include <libnsfb_event.h>

#include "utils/errors.h"
#include "utils/nsoption.h"
/* the load timeline the Log screen draws its waterfall from */
#include "utils/utils.h"
#include "utils/nsurl.h"
#include "netsurf/types.h"
#include "netsurf/browser_window.h"
#include "netsurf/url_db.h"
#include "netsurf/cookie_db.h"
#include "framebuffer/gui.h"
#include "framebuffer/fbtk.h"

#include "vita_platform.h"
#include "vita_surface.h"
#include "vita_input.h"
#include "vita_menu.h"

extern fbtk_widget_t *fbtk;

#define MENU_WIDTH       420
#define MENU_ROW_HEIGHT  30
#define MENU_HEADER      40
#define MENU_PAD         8

#define COLOUR_BG        0xFF303030
#define COLOUR_ROW       0xFFF0F0F0
#define COLOUR_ROW_TEXT  0xFF202020
#define COLOUR_HEAD_TEXT 0xFFFFFFFF
/* the same menu with the dark mode option on: it stayed light rows on
 * a grey window when every page had gone dark */
#define COLOUR_DARK_BG       0xFF1B1B1B
#define COLOUR_DARK_ROW      0xFF2C2C2C
#define COLOUR_DARK_ROW_TEXT 0xFFE8E8E8

#define MAX_BOOKMARKS    200
#define MAX_HISTORY      300

/* Autosave cookies and the URL database at most this often (us). */
#define AUTOSAVE_INTERVAL_US 30000000ull

enum item {
	ITEM_BOOKMARKS,
	ITEM_TOGGLE_BOOKMARK,
	ITEM_HISTORY,
	ITEM_DOWNLOADS,
	ITEM_HOME,
	ITEM_WIFI_LOGIN,
	ITEM_ZOOM_IN,
	ITEM_ZOOM_OUT,
	ITEM_ZOOM_RESET,
	ITEM_JAVASCRIPT,
	ITEM_IMAGES,
	ITEM_DARK_MODE,
	ITEM_LOG,
	ITEM_DUMP_LAYOUT,
	ITEM_QUIT,
	ITEM_CLOSE,
	ITEM_COUNT
};

struct bookmark {
	char *url;
	char *title;
};

static fbtk_widget_t *menu;
static int selected;

static struct bookmark bookmarks[MAX_BOOKMARKS];
static int nbookmarks;
static bool bookmarks_loaded;

static uint64_t last_autosave_us;

static void update_labels(void);
static bool build(void);
static void save_choices(void);

/* ------------------------------------------------------------------------ */
/* Bookmarks file                                                           */

static void bookmarks_free(void)
{
	int i;

	for (i = 0; i < nbookmarks; i++) {
		free(bookmarks[i].url);
		free(bookmarks[i].title);
	}
	nbookmarks = 0;
}

static void bookmarks_load(void)
{
	char *data = NULL;
	size_t len = 0;
	char *line, *next;

	if (bookmarks_loaded) {
		return;
	}
	bookmarks_loaded = true;
	bookmarks_free();

	if (vita_read_file(VITASURF_BOOKMARKS_PATH, &data, &len) != 0) {
		return;
	}
	for (line = data; line != NULL && *line != '\0'; line = next) {
		char *tab;

		next = strchr(line, '\n');
		if (next != NULL) {
			*next++ = '\0';
		}
		if (*line == '\0' || *line == '#' || nbookmarks >= MAX_BOOKMARKS) {
			continue;
		}
		tab = strchr(line, '\t');
		if (tab != NULL) {
			*tab++ = '\0';
		}
		bookmarks[nbookmarks].url = strdup(line);
		bookmarks[nbookmarks].title = strdup(tab != NULL && *tab ? tab : line);
		if (bookmarks[nbookmarks].url != NULL &&
		    bookmarks[nbookmarks].title != NULL) {
			nbookmarks++;
		}
	}
	free(data);
	vita_log("menu: %d bookmarks loaded", nbookmarks);
}

static void bookmarks_save(void)
{
	FILE *f = fopen(VITASURF_BOOKMARKS_PATH, "w");
	int i;

	if (f == NULL) {
		vita_log("menu: cannot write %s", VITASURF_BOOKMARKS_PATH);
		return;
	}
	fputs("# VitaSurf bookmarks: url<TAB>title\n", f);
	for (i = 0; i < nbookmarks; i++) {
		fprintf(f, "%s\t%s\n", bookmarks[i].url, bookmarks[i].title);
	}
	fclose(f);
}

static int bookmark_find(const char *url)
{
	int i;

	bookmarks_load();
	for (i = 0; i < nbookmarks; i++) {
		if (strcmp(bookmarks[i].url, url) == 0) {
			return i;
		}
	}
	return -1;
}

/* ------------------------------------------------------------------------ */
/* Generated pages                                                          */

static void html_escape(FILE *f, const char *s)
{
	for (; *s != '\0'; s++) {
		switch (*s) {
		case '&': fputs("&amp;", f); break;
		case '<': fputs("&lt;", f); break;
		case '>': fputs("&gt;", f); break;
		case '"': fputs("&quot;", f); break;
		default: fputc(*s, f); break;
		}
	}
}

static void page_head(FILE *f, const char *title)
{
	/*
	 * The bookmarks, history and downloads pages are written by the
	 * browser, so they follow its own dark mode setting rather than
	 * waiting for a site to be asked (VitaSurf). They stayed light
	 * when everything else went dark.
	 */
	fprintf(f, "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">\n"
		"<title>%s</title>\n<style>\n"
		"body{font-family:sans-serif;margin:16px;background:#f4f4f4;color:#222}\n"
		"h1{font-size:22px}\nli{margin:6px 0}\n"
		".u{color:#777;font-size:13px}\n.t{color:#777;font-size:13px}\n"
		"@media (prefers-color-scheme: dark){\n"
		"body{background:#1b1b1b;color:#e8e8e8}\n"
		"a{color:#79b8ff}\na:visited{color:#c8a2ff}\n"
		".u,.t{color:#a0a0a0}\n}\n"
		"</style></head><body>\n<h1>%s</h1>\n", title, title);
}

static void page_foot(FILE *f)
{
	fputs("<p><a href=\"file:///resources/vitasurf.html\">Home page</a></p>\n"
	      "</body></html>\n", f);
}

static bool write_bookmarks_page(void)
{
	FILE *f;
	int i;

	bookmarks_load();
	f = fopen(VITASURF_BOOKMARKS_PAGE, "w");
	if (f == NULL) {
		vita_log("menu: cannot write %s", VITASURF_BOOKMARKS_PAGE);
		return false;
	}
	page_head(f, "Bookmarks");
	if (nbookmarks == 0) {
		fputs("<p>No bookmarks yet. Open a page, press Start and choose "
		      "Add bookmark.</p>\n", f);
	}
	fputs("<ul>\n", f);
	for (i = 0; i < nbookmarks; i++) {
		fputs("<li><a href=\"", f);
		html_escape(f, bookmarks[i].url);
		fputs("\">", f);
		html_escape(f, bookmarks[i].title);
		fputs("</a><br><span class=\"u\">", f);
		html_escape(f, bookmarks[i].url);
		fputs("</span></li>\n", f);
	}
	fputs("</ul>\n", f);
	page_foot(f);
	fclose(f);
	return true;
}

struct history_entry {
	nsurl *url;
	const char *title;
	time_t last_visit;
	unsigned int visits;
};

static struct history_entry history[MAX_HISTORY];
static int nhistory;

/** urldb iteration callback: keep the most recently visited entries. */
static bool history_collect(nsurl *url, const struct url_data *data)
{
	int i, slot;

	if (data == NULL || data->visits == 0) {
		return true;
	}
	if (nhistory < MAX_HISTORY) {
		slot = nhistory++;
	} else {
		/* replace the oldest if this one is newer */
		slot = 0;
		for (i = 1; i < nhistory; i++) {
			if (history[i].last_visit < history[slot].last_visit) {
				slot = i;
			}
		}
		if (history[slot].last_visit >= data->last_visit) {
			return true;
		}
		nsurl_unref(history[slot].url);
	}
	history[slot].url = nsurl_ref(url);
	history[slot].title = data->title;
	history[slot].last_visit = data->last_visit;
	history[slot].visits = data->visits;
	return true;
}

static int history_compare(const void *a, const void *b)
{
	const struct history_entry *ha = a, *hb = b;

	if (ha->last_visit == hb->last_visit) return 0;
	return (ha->last_visit < hb->last_visit) ? 1 : -1;
}

static bool write_history_page(void)
{
	FILE *f;
	int i;

	nhistory = 0;
	urldb_iterate_entries(history_collect);
	qsort(history, (size_t)nhistory, sizeof(history[0]), history_compare);

	f = fopen(VITASURF_HISTORY_PAGE, "w");
	if (f == NULL) {
		vita_log("menu: cannot write %s", VITASURF_HISTORY_PAGE);
		for (i = 0; i < nhistory; i++) nsurl_unref(history[i].url);
		nhistory = 0;
		return false;
	}
	page_head(f, "History");
	if (nhistory == 0) {
		fputs("<p>No pages visited yet.</p>\n", f);
	}
	fputs("<ul>\n", f);
	for (i = 0; i < nhistory; i++) {
		const char *u = nsurl_access(history[i].url);
		struct tm *tm = localtime(&history[i].last_visit);
		char when[32] = "";

		if (strncmp(u, "file:", 5) == 0) {
			continue; /* generated and bundled pages */
		}
		if (tm != NULL) {
			strftime(when, sizeof(when), "%Y-%m-%d %H:%M", tm);
		}
		fputs("<li><a href=\"", f);
		html_escape(f, u);
		fputs("\">", f);
		html_escape(f, (history[i].title != NULL && history[i].title[0])
			    ? history[i].title : u);
		fprintf(f, "</a><br><span class=\"t\">%s, %u visit%s</span> "
			"<span class=\"u\">", when, history[i].visits,
			history[i].visits == 1 ? "" : "s");
		html_escape(f, u);
		fputs("</span></li>\n", f);
	}
	fputs("</ul>\n", f);
	page_foot(f);
	fclose(f);
	for (i = 0; i < nhistory; i++) {
		nsurl_unref(history[i].url);
	}
	nhistory = 0;
	return true;
}

/* ------------------------------------------------------------------------ */
/* Actions                                                                  */

/* ------------------------------------------------------------------------ */
/* Downloads page                                                           */

/* ------------------------------------------------------------------------ */
/* The Log screen                                                            */

/** How much of the log's tail the page shows. */
#define LOG_TAIL_BYTES 24000

/** The colour of a waterfall bar, by what the fetch came to. */
static const char *fetch_colour(const struct vitasurf_fetch *f, bool pale)
{
	switch (f->state) {
	case VITASURF_FETCH_ERROR:
		return pale ? "#e7a49c" : "#c0392b";
	case VITASURF_FETCH_ABORTED:
		return pale ? "#c9c9c9" : "#8a8a8a";
	case VITASURF_FETCH_RUNNING:
		return pale ? "#f0cf94" : "#d98a00";
	case VITASURF_FETCH_DONE:
	default:
		if (f->status >= 400) {
			return pale ? "#e7a49c" : "#c0392b";
		}
		return pale ? "#a9c4ea" : "#2f6fd0";
	}
}


/**
 * Draw the last page load as a waterfall.
 *
 * One row a fetch: the url, then a track in which the bar starts where
 * the request went out and ends where the last byte arrived, so the
 * shape of the load is the shape of the picture. The pale part of a bar
 * is the wait before the first header, which is the part a slow server
 * owns; the solid part is the transfer, which is the part the network
 * owns.
 *
 * The bars are spacer and bar elements side by side rather than boxes
 * positioned over a track, because plain inline-blocks are the thing
 * most certain to lay out the same here as anywhere.
 */
static void write_waterfall(FILE *f)
{
	unsigned int count = vitasurf_timeline_count();
	unsigned int seen = vitasurf_timeline_seen();
	unsigned int span = vitasurf_timeline_span();
	unsigned int total_bytes = 0;
	unsigned int i;

	fputs("<h2>Last page load</h2>\n", f);
	{
		/*
		 * Which page these figures belong to: the one that was on
		 * screen when the Log screen was asked for, since opening
		 * it starts a load of its own that clears the timeline.
		 */
		struct gui_window *gw = vita_input_window();
		nsurl *url = NULL;

		if (gw != NULL && browser_window_get_url(gw->bw, false,
				&url) == NSERROR_OK && url != NULL) {
			fputs("<p class=\"n\">", f);
			html_escape(f, nsurl_access(url));
			fputs("</p>\n", f);
			nsurl_unref(url);
		}
	}
	if (count == 0) {
		fputs("<p class=\"u\">No fetches recorded yet. Load a page, "
		      "then open this screen again.</p>\n", f);
		return;
	}

	for (i = 0; i < count; i++) {
		total_bytes += vitasurf_timeline_get(i)->bytes;
	}
	if (span == 0) {
		span = 1;
	}

	fprintf(f, "<p class=\"u\">%u fetches%s, %u KB, %u.%01u s from the "
		"first request to the last byte.</p>\n",
		seen,
		seen > count ? " (only the first are timed)" : "",
		total_bytes / 1024, span / 1000, (span % 1000) / 100);

	fputs("<div class=\"wf\">\n", f);
	for (i = 0; i < count; i++) {
		const struct vitasurf_fetch *fe = vitasurf_timeline_get(i);
		/* a fetch still running is drawn as far as the load got */
		unsigned int end = fe->state != VITASURF_FETCH_RUNNING ?
				fe->end_ms : span;
		unsigned int head = fe->had_header ? fe->header_ms : end;
		unsigned int lead, wait, body;

		if (end < fe->start_ms) {
			end = fe->start_ms;
		}
		if (head < fe->start_ms || head > end) {
			head = end;
		}

		/* in hundredths of the track, so a short fetch still shows */
		lead = fe->start_ms * 100 / span;
		wait = (head - fe->start_ms) * 100 / span;
		body = (end - head) * 100 / span;
		if (wait + body == 0) {
			body = 1;
		}
		if (lead > 99) {
			lead = 99;
		}

		fputs("<div class=\"r\"><div class=\"n\">", f);
		/*
		 * Not everything the engine fetches is a request over the
		 * network: an inline <style> and a bundled file go through
		 * the same path and would otherwise be a row of scheme
		 * noise in a list meant to be read at a glance.
		 */
		if (strncmp(fe->url, "x-ns-css:", 9) == 0) {
			fprintf(f, "inline stylesheet %s", fe->url + 9);
		} else if (strncmp(fe->url, "resource:", 9) == 0) {
			fprintf(f, "bundled %s", fe->url + 9);
		} else {
			html_escape(f, fe->url);
		}
		fputs("</div><div class=\"t\">", f);
		fprintf(f, "<span style=\"width:%u%%\"></span>", lead);
		if (wait > 0) {
			fprintf(f, "<span style=\"width:%u%%;background:%s\">"
				"</span>", wait, fetch_colour(fe, true));
		}
		if (body > 0) {
			fprintf(f, "<span style=\"width:%u%%;background:%s\">"
				"</span>", body, fetch_colour(fe, false));
		}
		fputs("</div><div class=\"m\">", f);
		fprintf(f, "%u ms", end - fe->start_ms);
		if (fe->bytes >= 1024) {
			fprintf(f, " &middot; %u KB", fe->bytes / 1024);
		} else if (fe->bytes > 0) {
			fprintf(f, " &middot; %u B", fe->bytes);
		}
		if (fe->status > 0) {
			fprintf(f, " &middot; %d", fe->status);
		}
		switch (fe->state) {
		case VITASURF_FETCH_ERROR:
			fputs(" &middot; failed", f);
			break;
		case VITASURF_FETCH_ABORTED:
			fputs(" &middot; abandoned", f);
			break;
		case VITASURF_FETCH_RUNNING:
			fputs(" &middot; still running", f);
			break;
		default:
			break;
		}
		fputs("</div></div>\n", f);
	}
	fputs("</div>\n", f);
}


/**
 * Copy the tail of the log file into the page.
 *
 * The whole log is too much to lay out on a handheld, and the end is
 * the part worth reading, so the last few thousand bytes go in from the
 * first line break after the cut.
 */
static void write_log_tail(FILE *f)
{
	FILE *in;
	long size, from;
	char *buf;
	size_t got;

	fputs("<h2>Log</h2>\n", f);
	in = fopen(VITASURF_LOG_PATH, "rb");
	if (in == NULL) {
		fputs("<p class=\"u\">The log could not be opened.</p>\n", f);
		return;
	}
	if (fseek(in, 0, SEEK_END) != 0 || (size = ftell(in)) < 0) {
		fclose(in);
		fputs("<p class=\"u\">The log could not be read.</p>\n", f);
		return;
	}

	from = size > LOG_TAIL_BYTES ? size - LOG_TAIL_BYTES : 0;
	if (fseek(in, from, SEEK_SET) != 0) {
		fclose(in);
		fputs("<p class=\"u\">The log could not be read.</p>\n", f);
		return;
	}

	buf = malloc(LOG_TAIL_BYTES + 1);
	if (buf == NULL) {
		fclose(in);
		fputs("<p class=\"u\">No room to read the log.</p>\n", f);
		return;
	}
	got = fread(buf, 1, LOG_TAIL_BYTES, in);
	fclose(in);
	buf[got] = '\0';

	fprintf(f, "<p class=\"u\">%s of ux0:data/VitaSurf/log.txt "
		"(%u KB in all).</p>\n",
		from > 0 ? "The tail" : "All", (unsigned) (size / 1024));

	fputs("<pre>", f);
	{
		const char *p = buf;

		if (from > 0) {
			const char *nl = strchr(buf, '\n');

			/* start at a whole line, not mid-word */
			if (nl != NULL) {
				p = nl + 1;
			}
		}
		html_escape(f, p);
	}
	fputs("</pre>\n", f);
	free(buf);
}


/**
 * Write the Log screen: what the last page load spent its time on, and
 * what the log has to say about it.
 *
 * A report from the device used to mean copying log.txt off the memory
 * card, and nothing at all showed where a slow page's seconds went.
 */
static bool write_log_page(void)
{
	FILE *f = fopen(VITASURF_LOG_PAGE, "w");

	if (f == NULL) {
		vita_log("menu: cannot write %s", VITASURF_LOG_PAGE);
		return false;
	}

	page_head(f, "Log");
	fputs("<style>\n"
	      ".wf{font-size:12px}\n"
	      ".r{margin:0 0 6px 0}\n"
	      ".n{word-break:break-all;color:#333}\n"
	      ".t{height:10px;background:#e3e3e3;font-size:0;line-height:0}\n"
	      ".t span{display:inline-block;height:10px;vertical-align:top}\n"
	      ".m{color:#777;font-size:12px}\n"
	      "pre{white-space:pre-wrap;word-break:break-all;font-size:12px;"
	      "background:#fff;padding:8px}\n"
	      "@media (prefers-color-scheme: dark){\n"
	      ".n{color:#ddd}\n.t{background:#3a3a3a}\n"
	      ".m{color:#a0a0a0}\npre{background:#111}\n}\n"
	      "</style>\n", f);

	write_waterfall(f);
	write_log_tail(f);

	page_foot(f);
	fclose(f);

	return true;
}


static bool write_downloads_page(void)
{
	FILE *f;
	DIR *d;
	struct dirent *e;
	int n = 0;

	f = fopen(VITASURF_DOWNLOADS_PAGE, "w");
	if (f == NULL) {
		vita_log("menu: cannot write %s", VITASURF_DOWNLOADS_PAGE);
		return false;
	}
	page_head(f, "Downloads");
	fputs("<p>Files saved under <b>ux0:data/VitaSurf/downloads</b>. "
	      "Copy them off with VitaShell or FTP.</p>\n<ul>\n", f);
	d = opendir(VITASURF_DOWNLOADS_DIR);
	if (d != NULL) {
		while ((e = readdir(d)) != NULL) {
			char path[300];
			struct stat st;

			if (e->d_name[0] == '.') {
				continue;
			}
			snprintf(path, sizeof(path), "%s/%s", VITASURF_DOWNLOADS_DIR,
				 e->d_name);
			if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
				continue;
			}
			fputs("<li>", f);
			html_escape(f, e->d_name);
			fprintf(f, " <span class=\"u\">%u KB</span></li>\n",
				(unsigned)(st.st_size / 1024));
			n++;
		}
		closedir(d);
	}
	if (n == 0) {
		fputs("<li>No downloads yet. Links to files the browser cannot "
		      "display (archives, PDFs) are saved here.</li>\n", f);
	}
	fputs("</ul>\n", f);
	page_foot(f);
	fclose(f);
	return true;
}

/* ------------------------------------------------------------------------ */
/* Zoom                                                                     */

static int zoom_percent(void)
{
	struct gui_window *gw = vita_input_window();

	if (gw == NULL) {
		return nsoption_int(scale);
	}
	return (int)(browser_window_get_scale(gw->bw) * 100.0f + 0.5f);
}

/** Change the page scale by delta percent (0 resets to 100). */
static void zoom(int delta)
{
	struct gui_window *gw = vita_input_window();
	int pct;

	if (gw == NULL) {
		return;
	}
	if (delta == 0) {
		browser_window_set_scale(gw->bw, 1.0f, true);
	} else {
		pct = zoom_percent() + delta;
		if (pct < 50) pct = 50;
		if (pct > 300) pct = 300;
		browser_window_set_scale(gw->bw, (float)pct / 100.0f, true);
	}
	/* new windows and the next start use the same scale */
	nsoption_set_int(scale, zoom_percent());
	save_choices();
	vita_log("menu: zoom %d%%", nsoption_int(scale));
	update_labels();
}

static void go(const char *url_text)
{
	struct gui_window *gw = vita_input_window();
	nsurl *url;

	if (gw == NULL) {
		return;
	}
	if (nsurl_create(url_text, &url) != NSERROR_OK) {
		vita_log("menu: bad url %s", url_text);
		return;
	}
	browser_window_navigate(gw->bw, url, NULL, BW_NAVIGATE_HISTORY,
				NULL, NULL, NULL);
	nsurl_unref(url);
}

/** The current page's URL as a string, or NULL for local pages. */
static char *current_url(void)
{
	struct gui_window *gw = vita_input_window();
	nsurl *url = NULL;
	char *out = NULL;

	if (gw == NULL) {
		return NULL;
	}
	if (browser_window_get_url(gw->bw, false, &url) != NSERROR_OK || url == NULL) {
		return NULL;
	}
	if (strncmp(nsurl_access(url), "file:", 5) != 0 &&
	    strncmp(nsurl_access(url), "about:", 6) != 0) {
		out = strdup(nsurl_access(url));
	}
	nsurl_unref(url);
	return out;
}

static void save_choices(void)
{
	nserror err = nsoption_write(VITASURF_USER_CHOICES, nsoptions,
				     nsoptions_default);

	vita_log("menu: wrote %s (%d)", VITASURF_USER_CHOICES, (int)err);
}

static void toggle_bookmark(void)
{
	struct gui_window *gw = vita_input_window();
	char *url = current_url();
	int i;

	if (url == NULL || gw == NULL) {
		free(url);
		return;
	}
	i = bookmark_find(url);
	if (i >= 0) {
		free(bookmarks[i].url);
		free(bookmarks[i].title);
		memmove(&bookmarks[i], &bookmarks[i + 1],
			sizeof(bookmarks[0]) * (size_t)(nbookmarks - i - 1));
		nbookmarks--;
		vita_log("menu: removed bookmark %s", url);
	} else if (nbookmarks < MAX_BOOKMARKS) {
		const char *title = browser_window_get_title(gw->bw);

		bookmarks[nbookmarks].url = strdup(url);
		bookmarks[nbookmarks].title =
			strdup((title != NULL && title[0]) ? title : url);
		if (bookmarks[nbookmarks].url != NULL &&
		    bookmarks[nbookmarks].title != NULL) {
			nbookmarks++;
		}
		vita_log("menu: added bookmark %s", url);
	}
	bookmarks_save();
	free(url);
}

static void activate(enum item item)
{
	switch (item) {
	case ITEM_BOOKMARKS:
		vita_menu_close();
		if (write_bookmarks_page()) {
			go(VITASURF_BOOKMARKS_URL);
		}
		break;
	case ITEM_TOGGLE_BOOKMARK:
		toggle_bookmark();
		vita_menu_close();
		break;
	case ITEM_HISTORY:
		vita_menu_close();
		if (write_history_page()) {
			go(VITASURF_HISTORY_URL);
		}
		break;
	case ITEM_DOWNLOADS:
		vita_menu_close();
		if (write_downloads_page()) {
			go(VITASURF_DOWNLOADS_URL);
		}
		break;
	case ITEM_HOME:
		vita_menu_close();
		go(nsoption_charp(homepage_url) != NULL ?
		   nsoption_charp(homepage_url) : "file:///resources/vitasurf.html");
		break;
	case ITEM_WIFI_LOGIN:
		/*
		 * A captive portal can only take over a plain HTTP page:
		 * an HTTPS one fails its certificate check instead, which
		 * is what every https:// home page does on a hotel
		 * network until the sign-in is done. This page is fetched
		 * over HTTP and answers "Success" when the network is
		 * open, so the portal's redirect, if any, lands here.
		 */
		vita_menu_close();
		go("http://captive.apple.com/hotspot-detect.html");
		break;
	case ITEM_ZOOM_IN:
		zoom(10);
		break;
	case ITEM_ZOOM_OUT:
		zoom(-10);
		break;
	case ITEM_ZOOM_RESET:
		zoom(0);
		break;
	case ITEM_JAVASCRIPT:
		nsoption_set_bool(enable_javascript,
				  !nsoption_bool(enable_javascript));
		save_choices();
		update_labels();
		break;
	case ITEM_IMAGES:
		nsoption_set_bool(foreground_images,
				  !nsoption_bool(foreground_images));
		nsoption_set_bool(background_images,
				  nsoption_bool(foreground_images));
		save_choices();
		update_labels();
		break;
	case ITEM_DARK_MODE:
		/*
		 * What prefers-color-scheme answers, to the stylesheets
		 * and to matchMedia alike. Both read it when a page is
		 * created, so it takes effect on the next page rather
		 * than on this one.
		 */
		nsoption_set_bool(prefer_dark_mode,
				  !nsoption_bool(prefer_dark_mode));
		save_choices();
		/* the menu itself follows the option: rebuilt in the new
		 * colours, and shown again where it was */
		fbtk_destroy_widget(menu);
		menu = NULL;
		if (build()) {
			fbtk_set_mapping(menu, true);
			fbtk_request_redraw(fbtk);
		}
		update_labels();
		break;
	case ITEM_LOG:
		vita_menu_close();
		if (write_log_page()) {
			go(VITASURF_LOG_URL);
		}
		break;
	case ITEM_DUMP_LAYOUT:
		/* the log is the only way a page that comes out wrong on
		 * the device can be read here, so close first and let the
		 * dump describe the page rather than the menu over it */
		vita_menu_close();
		vita_input_dump_layout_now();
		break;
	case ITEM_QUIT:
		vita_menu_close();
		vita_menu_autosave(true);
		vita_surface_request_quit();
		break;
	case ITEM_CLOSE:
	default:
		vita_menu_close();
		break;
	}
}

/* ------------------------------------------------------------------------ */
/* Widgets                                                                  */

/*
 * The widgets are created once and only ever mapped and unmapped, like
 * NetSurf's on-screen keyboard. fbtk remembers the widget under the
 * pointer and the one with input focus, so destroying widgets while they
 * may still be referenced crashes on the next pointer move.
 */
static fbtk_widget_t *rows[ITEM_COUNT];

static int row_click(fbtk_widget_t *widget, fbtk_callback_info *cbi)
{
	(void)widget;
	if (cbi->event->type != NSFB_EVENT_KEY_UP) {
		return 0;
	}
	activate((enum item)(intptr_t)cbi->context);
	return 1;
}

static void item_label(enum item item, char *buf, size_t len)
{
	char *url;

	switch (item) {
	case ITEM_BOOKMARKS:
		snprintf(buf, len, "Bookmarks");
		break;
	case ITEM_TOGGLE_BOOKMARK:
		url = current_url();
		if (url == NULL) {
			snprintf(buf, len, "Add bookmark (not for this page)");
		} else if (bookmark_find(url) >= 0) {
			snprintf(buf, len, "Remove bookmark for this page");
		} else {
			snprintf(buf, len, "Add bookmark for this page");
		}
		free(url);
		break;
	case ITEM_HISTORY:
		snprintf(buf, len, "History");
		break;
	case ITEM_DOWNLOADS:
		snprintf(buf, len, "Downloads");
		break;
	case ITEM_HOME:
		snprintf(buf, len, "Home page");
		break;
	case ITEM_WIFI_LOGIN:
		snprintf(buf, len, "Sign in to Wi-Fi (hotel, cafe)");
		break;
	case ITEM_ZOOM_IN:
		snprintf(buf, len, "Zoom in (now %d%%)", zoom_percent());
		break;
	case ITEM_ZOOM_OUT:
		snprintf(buf, len, "Zoom out (now %d%%)", zoom_percent());
		break;
	case ITEM_ZOOM_RESET:
		snprintf(buf, len, "Reset zoom to 100%%");
		break;
	case ITEM_JAVASCRIPT:
		snprintf(buf, len, "JavaScript: %s (new pages)",
			 nsoption_bool(enable_javascript) ? "on" : "off");
		break;
	case ITEM_IMAGES:
		snprintf(buf, len, "Images: %s (new pages)",
			 nsoption_bool(foreground_images) ? "on" : "off");
		break;
	case ITEM_DARK_MODE:
		snprintf(buf, len, "Dark mode: %s (new pages)",
			 nsoption_bool(prefer_dark_mode) ? "on" : "off");
		break;
	case ITEM_LOG:
		snprintf(buf, len, "Log: where the last page load went");
		break;
	case ITEM_DUMP_LAYOUT:
		snprintf(buf, len, "Write this page's layout to the log");
		break;
	case ITEM_QUIT:
		snprintf(buf, len, "Quit VitaSurf");
		break;
	case ITEM_CLOSE:
	default:
		snprintf(buf, len, "Close menu");
		break;
	}
}

/** Refresh every row's text; the selected row carries a marker. */
static void update_labels(void)
{
	int i;
	char label[96];
	char text[104];

	for (i = 0; i < ITEM_COUNT; i++) {
		item_label((enum item)i, label, sizeof(label));
		snprintf(text, sizeof(text), "%s %s", (i == selected) ? ">" : " ", label);
		fbtk_set_text(rows[i], text);
	}
}

static bool build(void)
{
	int rw = fbtk_get_width(fbtk);
	int rh = fbtk_get_height(fbtk);
	int height = MENU_HEADER + ITEM_COUNT * MENU_ROW_HEIGHT + MENU_PAD;
	int x = (rw - MENU_WIDTH) / 2;
	int y = (rh - height) / 2;
	fbtk_widget_t *w;
	int i;

	if (menu != NULL) {
		return true;
	}

	bool dark = nsoption_bool(prefer_dark_mode);
	colour bg = dark ? COLOUR_DARK_BG : COLOUR_BG;
	colour row = dark ? COLOUR_DARK_ROW : COLOUR_ROW;
	colour row_text = dark ? COLOUR_DARK_ROW_TEXT : COLOUR_ROW_TEXT;

	menu = fbtk_create_window(fbtk, x, y, MENU_WIDTH, height, bg);
	if (menu == NULL) {
		return false;
	}

	w = fbtk_create_text(menu, MENU_PAD, MENU_PAD, MENU_WIDTH - 2 * MENU_PAD,
			     MENU_HEADER - MENU_PAD, bg, COLOUR_HEAD_TEXT,
			     false);
	fbtk_set_text(w, "VitaSurf   (D-pad, Cross, Circle closes)");

	for (i = 0; i < ITEM_COUNT; i++) {
		rows[i] = fbtk_create_text_button(menu, MENU_PAD,
						  MENU_HEADER + i * MENU_ROW_HEIGHT,
						  MENU_WIDTH - 2 * MENU_PAD,
						  MENU_ROW_HEIGHT - 4,
						  row, row_text,
						  row_click, (void *)(intptr_t)i);
	}

	fbtk_set_zorder(menu, INT_MIN);
	fbtk_set_mapping(menu, false);
	return true;
}

/* ------------------------------------------------------------------------ */
/* Entry points                                                             */

static bool menu_open;

bool vita_menu_is_open(void)
{
	return menu_open;
}

void vita_menu_refresh(void)
{
	if (menu_open && menu != NULL) {
		fbtk_request_redraw(menu);
	}
}

void vita_menu_close(void)
{
	if (menu_open) {
		menu_open = false;
		vita_surface_hold_progress(false);
		fbtk_set_mapping(menu, false);
		fbtk_request_redraw(fbtk);
	}
}

void vita_menu_toggle(void)
{
	if (menu_open) {
		vita_menu_close();
		return;
	}
	if (!build()) {
		return;
	}
	selected = 0;
	update_labels();
	menu_open = true;
	vita_surface_hold_progress(true);
	fbtk_set_zorder(menu, INT_MIN);
	fbtk_set_mapping(menu, true);
}

bool vita_menu_key(enum nsfb_key_code_e key, bool down)
{
	if (!menu_open) {
		return false;
	}
	if (!down) {
		return true;
	}
	switch (key) {
	case VITA_KEY_UP:
		selected = (selected + ITEM_COUNT - 1) % ITEM_COUNT;
		update_labels();
		return true;
	case VITA_KEY_DOWN:
		selected = (selected + 1) % ITEM_COUNT;
		update_labels();
		return true;
	case VITA_KEY_CROSS:
		activate((enum item)selected);
		return true;
	case VITA_KEY_CIRCLE:
	case VITA_KEY_START:
		vita_menu_close();
		return true;
	default:
		return true;
	}
}

void vita_menu_autosave(bool force)
{
	uint64_t now = sceKernelGetProcessTimeWide();

	if (!force && last_autosave_us != 0 &&
	    now - last_autosave_us < AUTOSAVE_INTERVAL_US) {
		return;
	}
	last_autosave_us = now;
	urldb_save_cookies(VITASURF_COOKIES_PATH);
	urldb_save(VITASURF_URLS_PATH);
}
