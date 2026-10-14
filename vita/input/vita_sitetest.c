/*
 * Site test (VitaSurf): load a list of websites one after another and
 * write what each cost, so a run on the device gives real figures from
 * many sites at once instead of one page at a time.
 *
 * The list is ux0:data/VitaSurf/sitetest.txt, one URL a line, # for a
 * comment; the first run writes the default list there to be edited.
 * Each site is given until it has loaded and then a few seconds more,
 * so that what it does just after loading shows in the log as well,
 * or until a time limit if it never finishes. Every site's figures go
 * to the log as one "sitetest:" line beside the usual page report, and
 * the run ends on a page that lists them all.
 *
 * A site that crashes the browser ends the run with it, so the run is
 * kept in ux0:data/VitaSurf/sitetest.state as it goes: each site as it
 * starts and each one's figures as it ends. Starting the test again
 * finds the site that started and never ended, marks it as crashed and
 * carries on from the next, with the figures of those before it.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libnsfb.h>
#include <libnsfb_event.h>
#include <nsutils/time.h>

#include "utils/errors.h"
#include "utils/nsoption.h"
#include "utils/utils.h"
#include "utils/nsurl.h"
#include "netsurf/types.h"
#include "netsurf/browser_window.h"
#include "framebuffer/gui.h"
#include "framebuffer/fbtk.h"
#include "framebuffer/schedule.h"

#include "vita_platform.h"
#include "vita_input.h"
#include "vita_sitetest.h"

#define SITETEST_LIST   VITASURF_SITETEST_LIST
#define SITETEST_PAGE   VITASURF_SITETEST_PAGE
#define SITETEST_URL    VITASURF_SITETEST_URL
#define SITETEST_STATE  VITASURF_DATA_DIR "/sitetest.state"

#define MAX_SITES       64
/* how long a site has to finish loading */
#define SITE_LIMIT_MS   60000
/* how long it is watched after it has loaded */
#define SITE_SETTLE_MS  8000

/* a spread of what people open: light and heavy, news, search, shops,
 * video, reference, apps; each public and without a sign-in */
static const char *const default_sites[] = {
	"https://en.m.wikipedia.org/wiki/PlayStation_Vita",
	"https://www.wikipedia.org/",
	"https://www.google.com/",
	"https://duckduckgo.com/",
	"https://www.bing.com/",
	"https://news.ycombinator.com/",
	"https://old.reddit.com/r/vita/",
	"https://www.reddit.com/r/vita/",
	"https://www.bbc.com/news",
	"https://lite.cnn.com/",
	"https://www.cnn.com/",
	"https://www.theguardian.com/international",
	"https://www.nytimes.com/",
	"https://www.npr.org/",
	"https://github.com/vitasdk",
	"https://stackoverflow.com/questions",
	"https://developer.mozilla.org/en-US/",
	"https://www.amazon.com/",
	"https://www.ebay.com/",
	"https://www.imdb.com/",
	"https://www.youtube.com/",
	"https://archive.org/",
	"https://www.weather.gov/",
	"https://www.espn.com/",
	"https://www.apple.com/",
	"https://www.craigslist.org/",
	"https://www.w3.org/",
};

struct site {
	char *url;
	bool done;
	bool timed_out;
	bool crashed;		/* the browser ended while it was loading */
	unsigned int load_ms;
	unsigned int parse_ms, css_ms, image_ms, boxes_ms, layout_ms;
	unsigned int script_ms, draw_ms, prelude_ms;
	unsigned int free_kb;
	char *final_url;
};

static struct site sites[MAX_SITES];
static int nsites;
static int current = -1;	/* the site being loaded, -1 when not running */
static bool waiting;		/* for the current site to finish loading */
/* whether a load began after the site was asked for: going to it stops
 * the page before, and that load's end is not this site's */
static bool started;
static uint64_t site_started_ms;
static uint64_t run_started_ms;

static void next_site(void *p);
static void site_limit(void *p);

static uint64_t now_ms(void)
{
	uint64_t t = 0;

	nsu_getmonotonic_ms(&t);
	return t;
}

/* one line of the run's state, written through at once so that it is
 * there if the browser dies before the next */
static void state_line(const char *line)
{
	FILE *f = fopen(SITETEST_STATE, "a");

	if (f != NULL) {
		fputs(line, f);
		fclose(f);
	}
}

static void state_result(int i)
{
	const struct site *s = &sites[i];
	char line[160];

	snprintf(line, sizeof(line), "%d %c %u %u %u %u %u %u %u %u %u %u\n",
		 i, s->crashed ? 'c' : s->timed_out ? 't' : 'd', s->load_ms,
		 s->script_ms, s->layout_ms, s->boxes_ms, s->parse_ms,
		 s->css_ms, s->image_ms, s->draw_ms, s->prelude_ms, s->free_kb);
	state_line(line);
}

/*
 * The state a run left, if it was for this list: the site to carry on
 * from, with what the sites before it gave, or 0 to start afresh.
 */
static int state_resume(void)
{
	FILE *f = fopen(SITETEST_STATE, "r");
	char line[160];
	int n = -1, last_at = -1, next = 0;

	if (f == NULL) {
		return 0;
	}
	if (fgets(line, sizeof(line), f) == NULL ||
	    sscanf(line, "run %d", &n) != 1 || n != nsites) {
		fclose(f);
		return 0;
	}
	while (fgets(line, sizeof(line), f) != NULL) {
		int i;
		char c;
		unsigned int v[10];

		if (sscanf(line, "at %d", &i) == 1) {
			if (i >= 0 && i < nsites) {
				last_at = i;
			}
			continue;
		}
		if (sscanf(line, "%d %c %u %u %u %u %u %u %u %u %u %u", &i, &c,
			   &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6],
			   &v[7], &v[8], &v[9]) != 12 || i < 0 || i >= nsites) {
			continue;
		}
		sites[i].done = c == 'd';
		sites[i].timed_out = c == 't';
		sites[i].crashed = c == 'c';
		sites[i].load_ms = v[0];
		sites[i].script_ms = v[1];
		sites[i].layout_ms = v[2];
		sites[i].boxes_ms = v[3];
		sites[i].parse_ms = v[4];
		sites[i].css_ms = v[5];
		sites[i].image_ms = v[6];
		sites[i].draw_ms = v[7];
		sites[i].prelude_ms = v[8];
		sites[i].free_kb = v[9];
		if (i + 1 > next) {
			next = i + 1;
		}
	}
	fclose(f);
	if (last_at >= 0 && !sites[last_at].done &&
	    !sites[last_at].timed_out && !sites[last_at].crashed) {
		sites[last_at].crashed = true;
		vita_log("sitetest: the last run ended while %d/%d %s was "
			 "loading: counted as a crash", last_at + 1, nsites,
			 sites[last_at].url);
		state_result(last_at);
	}
	if (last_at + 1 > next) {
		next = last_at + 1;
	}
	return next;
}

static void sites_free(void)
{
	int i;

	for (i = 0; i < nsites; i++) {
		free(sites[i].url);
		free(sites[i].final_url);
	}
	memset(sites, 0, sizeof(sites));
	nsites = 0;
}

static void add_site(const char *url)
{
	if (nsites >= MAX_SITES || url[0] == '\0') {
		return;
	}
	sites[nsites].url = strdup(url);
	if (sites[nsites].url != NULL) {
		nsites++;
	}
}

/* the list file, written with the defaults the first time */
static void load_list(void)
{
	FILE *f = fopen(SITETEST_LIST, "r");
	char line[512];
	size_t i;

	if (f == NULL) {
		f = fopen(SITETEST_LIST, "w");
		if (f != NULL) {
			fputs("# VitaSurf site test: one URL a line, # for a "
			      "comment. Start menu, \"Site test\".\n", f);
			for (i = 0; i < sizeof(default_sites) /
				     sizeof(default_sites[0]); i++) {
				fprintf(f, "%s\n", default_sites[i]);
			}
			fclose(f);
		}
		for (i = 0; i < sizeof(default_sites) /
			     sizeof(default_sites[0]); i++) {
			add_site(default_sites[i]);
		}
		return;
	}
	while (fgets(line, sizeof(line), f) != NULL) {
		char *s = line, *e;

		while (*s == ' ' || *s == '\t') {
			s++;
		}
		e = s + strlen(s);
		while (e > s && (e[-1] == '\n' || e[-1] == '\r' ||
				 e[-1] == ' ' || e[-1] == '\t')) {
			*--e = '\0';
		}
		if (*s == '#' || *s == '\0') {
			continue;
		}
		add_site(s);
	}
	fclose(f);
}

static void navigate(const char *url_text)
{
	struct gui_window *gw = vita_input_window();
	nsurl *url;

	if (gw == NULL || nsurl_create(url_text, &url) != NSERROR_OK) {
		vita_log("sitetest: cannot open %s", url_text);
		return;
	}
	browser_window_navigate(gw->bw, url, NULL, BW_NAVIGATE_HISTORY,
				NULL, NULL, NULL);
	nsurl_unref(url);
}

static void html_text(FILE *f, const char *s)
{
	for (; s != NULL && *s != '\0'; s++) {
		switch (*s) {
		case '<': fputs("&lt;", f); break;
		case '>': fputs("&gt;", f); break;
		case '&': fputs("&amp;", f); break;
		case '"': fputs("&quot;", f); break;
		default: fputc(*s, f); break;
		}
	}
}

static int cmp_uint(const void *a, const void *b)
{
	unsigned int x = *(const unsigned int *)a;
	unsigned int y = *(const unsigned int *)b;

	return x < y ? -1 : x > y;
}

/* the run's end: a summary in the log and a page of every site */
static void finish(void)
{
	unsigned int times[MAX_SITES];
	int i, loaded = 0, timed_out = 0, under_goal = 0, crashed = 0;
	unsigned int median = 0;
	FILE *f;

	for (i = 0; i < nsites; i++) {
		if (sites[i].crashed) {
			crashed++;
		} else if (sites[i].timed_out) {
			timed_out++;
		} else if (sites[i].done) {
			times[loaded++] = sites[i].load_ms;
			if (sites[i].load_ms <= 20000) {
				under_goal++;
			}
		}
	}
	if (loaded > 0) {
		qsort(times, (size_t)loaded, sizeof(times[0]), cmp_uint);
		median = times[loaded / 2];
	}
	vita_log("sitetest: finished %d sites in %u s: %d loaded (median %u "
		 "ms, %d within 20 s), %d did not finish within %u s, %d "
		 "crashed the browser",
		 nsites, (unsigned int)((now_ms() - run_started_ms) / 1000),
		 loaded, median, under_goal, timed_out,
		 (unsigned int)(SITE_LIMIT_MS / 1000), crashed);

	f = fopen(SITETEST_PAGE, "w");
	if (f != NULL) {
		fputs("<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
		      "<title>Site test</title><style>"
		      "body{font-family:sans-serif;margin:12px}"
		      "table{border-collapse:collapse;font-size:13px}"
		      "td,th{padding:3px 6px;border-bottom:1px solid #ccc;"
		      "text-align:right}td.u,th.u{text-align:left;"
		      "word-break:break-all;max-width:330px}"
		      ".bad{color:#b00}"
		      "@media (prefers-color-scheme: dark){body{background:#1b1b1b;"
		      "color:#e8e8e8}td,th{border-color:#444}.bad{color:#f77}}"
		      "</style></head><body><h1>Site test</h1>", f);
		fprintf(f, "<p>%d sites: %d loaded, median %u ms, %d within "
			"20 s; %d did not finish within %u s; %d crashed the "
			"browser. Cache %s. The "
			"full figures for each are in log.txt (\"sitetest:\" "
			"and the page report after each).</p>",
			nsites, loaded, median, under_goal, timed_out,
			(unsigned int)(SITE_LIMIT_MS / 1000), crashed,
			vitasurf_cache_disabled() ? "off" : "on");
		fputs("<table><tr><th class=\"u\">site</th><th>load ms</th>"
		      "<th>script</th><th>layout</th><th>styles</th>"
		      "<th>parse</th><th>free KB</th></tr>", f);
		for (i = 0; i < nsites; i++) {
			struct site *s = &sites[i];

			fputs("<tr><td class=\"u\">", f);
			html_text(f, s->url);
			fputs("</td>", f);
			if (s->crashed) {
				fputs("<td class=\"bad\">crashed</td><td></td>"
				      "<td></td><td></td><td></td><td></td>", f);
			} else if (s->timed_out) {
				fprintf(f, "<td class=\"bad\">over %u s</td>"
					"<td></td><td></td><td></td><td></td>"
					"<td>%u</td>",
					(unsigned int)(SITE_LIMIT_MS / 1000),
					s->free_kb);
			} else if (s->done) {
				fprintf(f, "<td%s>%u</td><td>%u</td><td>%u</td>"
					"<td>%u</td><td>%u</td><td>%u</td>",
					s->load_ms > 20000 ? " class=\"bad\"" : "",
					s->load_ms, s->script_ms, s->layout_ms,
					s->boxes_ms, s->parse_ms, s->free_kb);
			} else {
				fputs("<td>not run</td><td></td><td></td><td></td>"
				      "<td></td><td></td>", f);
			}
			fputs("</tr>", f);
		}
		fputs("</table></body></html>\n", f);
		fclose(f);
		navigate(SITETEST_URL);
	} else {
		vita_log("sitetest: cannot write %s", SITETEST_PAGE);
	}
	current = -1;
	waiting = false;
	remove(SITETEST_STATE);
}

static void start_site(void)
{
	if (current >= nsites) {
		finish();
		return;
	}
	vita_log("sitetest: %d/%d %s", current + 1, nsites,
		 sites[current].url);
	{
		char line[32];

		snprintf(line, sizeof(line), "at %d\n", current);
		state_line(line);
	}
	waiting = true;
	started = false;
	site_started_ms = now_ms();
	framebuffer_schedule(SITE_LIMIT_MS, site_limit, NULL);
	navigate(sites[current].url);
}

static void next_site(void *p)
{
	(void)p;
	if (current < 0) {
		return;
	}
	current++;
	start_site();
}

/* a site that has not finished loading in time */
static void site_limit(void *p)
{
	struct gui_window *gw = vita_input_window();

	(void)p;
	if (current < 0 || !waiting) {
		return;
	}
	waiting = false;
	sites[current].timed_out = true;
	sites[current].free_kb = vita_heap_free_kb();
	vita_log("sitetest: %d/%d %s did not finish within %u s",
		 current + 1, nsites, sites[current].url,
		 (unsigned int)(SITE_LIMIT_MS / 1000));
	state_result(current);
	if (gw != NULL) {
		browser_window_stop(gw->bw);
	}
	framebuffer_schedule(1000, next_site, NULL);
}

void vita_sitetest_start(void)
{
	int from;

	if (current >= 0) {
		return;
	}
	sites_free();
	load_list();
	if (nsites == 0) {
		vita_log("sitetest: %s lists no sites", SITETEST_LIST);
		return;
	}
	from = state_resume();
	if (from >= nsites) {
		run_started_ms = now_ms();
		finish();
		return;
	}
	if (from > 0) {
		vita_log("sitetest: carrying on at %d/%d, with the figures of "
			 "the %d before it from the last run", from + 1, nsites,
			 from);
	} else {
		char line[32];

		remove(SITETEST_STATE);
		snprintf(line, sizeof(line), "run %d\n", nsites);
		state_line(line);
	}
	vita_log("sitetest: starting %d sites from %s, each given %u s to "
		 "load and watched %u s after; cache %s, JavaScript %s",
		 nsites, SITETEST_LIST, (unsigned int)(SITE_LIMIT_MS / 1000),
		 (unsigned int)(SITE_SETTLE_MS / 1000),
		 vitasurf_cache_disabled() ? "off" : "on",
		 nsoption_bool(enable_javascript) ? "on" : "off");
	run_started_ms = now_ms();
	current = from;
	start_site();
}

void vita_sitetest_stop(void)
{
	if (current < 0) {
		return;
	}
	vita_log("sitetest: stopped at %d of %d", current + 1, nsites);
	framebuffer_schedule(-1, site_limit, NULL);
	framebuffer_schedule(-1, next_site, NULL);
	finish();
}

bool vita_sitetest_resumable(void)
{
	FILE *f;

	if (current >= 0) {
		return false;
	}
	f = fopen(SITETEST_STATE, "r");
	if (f == NULL) {
		return false;
	}
	fclose(f);
	return true;
}

bool vita_sitetest_running(int *done, int *total)
{
	if (done != NULL) {
		*done = current < 0 ? 0 : current;
	}
	if (total != NULL) {
		*total = nsites;
	}
	return current >= 0;
}

void vita_sitetest_load_started(void)
{
	if (current >= 0 && waiting) {
		started = true;
	}
}

void vita_sitetest_load_finished(const char *url, unsigned int ms)
{
	struct site *s;

	if (current < 0 || !waiting || !started) {
		return;
	}
	waiting = false;
	framebuffer_schedule(-1, site_limit, NULL);
	s = &sites[current];
	s->done = true;
	s->load_ms = ms;
	s->parse_ms = vitasurf_ms_html_parse;
	s->css_ms = vitasurf_ms_css;
	s->image_ms = vitasurf_ms_image;
	s->boxes_ms = vitasurf_ms_boxes;
	s->layout_ms = vitasurf_ms_layout;
	s->script_ms = vitasurf_ms_script;
	s->draw_ms = vitasurf_ms_draw;
	s->prelude_ms = vitasurf_ms_prelude;
	s->free_kb = vita_heap_free_kb();
	free(s->final_url);
	s->final_url = url != NULL ? strdup(url) : NULL;
	vita_log("sitetest: %d/%d %s loaded in %u ms (%u ms since asked): "
		 "script %u, layout %u, styles %u, parse %u, css %u, images "
		 "%u, drawing %u, prelude %u; %u KB free; ended at %s",
		 current + 1, nsites, s->url, ms,
		 (unsigned int)(now_ms() - site_started_ms), s->script_ms,
		 s->layout_ms, s->boxes_ms, s->parse_ms, s->css_ms,
		 s->image_ms, s->draw_ms, s->prelude_ms, s->free_kb,
		 url != NULL ? url : "?");
	state_result(current);
	framebuffer_schedule(SITE_SETTLE_MS, next_site, NULL);
}
