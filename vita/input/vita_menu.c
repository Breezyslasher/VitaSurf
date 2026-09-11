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

#include <psp2/kernel/processmgr.h>

#include <libnsfb.h>
#include <libnsfb_event.h>

#include "utils/errors.h"
#include "utils/nsoption.h"
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
#define MENU_ROW_HEIGHT  34
#define MENU_HEADER      40
#define MENU_PAD         8

#define COLOUR_BG        0xFF303030
#define COLOUR_ROW       0xFFF0F0F0
#define COLOUR_ROW_TEXT  0xFF202020
#define COLOUR_HEAD_TEXT 0xFFFFFFFF

#define MAX_BOOKMARKS    200
#define MAX_HISTORY      300

/* Autosave cookies and the URL database at most this often (us). */
#define AUTOSAVE_INTERVAL_US 30000000ull

enum item {
	ITEM_BOOKMARKS,
	ITEM_TOGGLE_BOOKMARK,
	ITEM_HISTORY,
	ITEM_HOME,
	ITEM_JAVASCRIPT,
	ITEM_IMAGES,
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
	fprintf(f, "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">\n"
		"<title>%s</title>\n<style>\n"
		"body{font-family:sans-serif;margin:16px;background:#f4f4f4;color:#222}\n"
		"h1{font-size:22px}\nli{margin:6px 0}\n"
		".u{color:#777;font-size:13px}\n.t{color:#777;font-size:13px}\n"
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
	case ITEM_HOME:
		vita_menu_close();
		go(nsoption_charp(homepage_url) != NULL ?
		   nsoption_charp(homepage_url) : "file:///resources/vitasurf.html");
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
	case ITEM_HOME:
		snprintf(buf, len, "Home page");
		break;
	case ITEM_JAVASCRIPT:
		snprintf(buf, len, "JavaScript: %s (new pages)",
			 nsoption_bool(enable_javascript) ? "on" : "off");
		break;
	case ITEM_IMAGES:
		snprintf(buf, len, "Images: %s (new pages)",
			 nsoption_bool(foreground_images) ? "on" : "off");
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

	menu = fbtk_create_window(fbtk, x, y, MENU_WIDTH, height, COLOUR_BG);
	if (menu == NULL) {
		return false;
	}

	w = fbtk_create_text(menu, MENU_PAD, MENU_PAD, MENU_WIDTH - 2 * MENU_PAD,
			     MENU_HEADER - MENU_PAD, COLOUR_BG, COLOUR_HEAD_TEXT,
			     false);
	fbtk_set_text(w, "VitaSurf   (D-pad, Cross, Circle closes)");

	for (i = 0; i < ITEM_COUNT; i++) {
		rows[i] = fbtk_create_text_button(menu, MENU_PAD,
						  MENU_HEADER + i * MENU_ROW_HEIGHT,
						  MENU_WIDTH - 2 * MENU_PAD,
						  MENU_ROW_HEIGHT - 4,
						  COLOUR_ROW, COLOUR_ROW_TEXT,
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
