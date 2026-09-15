/*
 * Drives the real fb_font_width / fb_font_position / fb_font_split from
 * frontends/framebuffer/font_freetype.c: correctness against the
 * uncached lookup, and the hang that a missing glyph used to cause.
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <stdbool.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include "utils/errors.h"
#include "netsurf/plot_style.h"
#include "netsurf/layout.h"
#include "frontends/framebuffer/font.h"
#include "frontends/framebuffer/font_freetype.h"

extern struct gui_layout_table *framebuffer_layout_table;
void fontstubs_init(void);

static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);
 return t.tv_sec*1000.0+t.tv_nsec/1e6;}

/* the uncached width, exactly as the code read before the change */
#include "utils/utf8.h"
static int width_uncached(const plot_font_style_t *f, const char *s, size_t n)
{
	size_t nxt = 0; int w = 0;
	while (nxt < n) {
		uint32_t u = utf8_to_ucs4(s + nxt, n - nxt);
		FT_Glyph g;
		nxt = utf8_next(s, n, nxt);
		g = fb_getglyph(f, u);
		if (g == NULL) continue;
		w += g->advance.x >> 16;
	}
	return w;
}

/* The two functions exactly as they read before the change, as the
   reference to compare against. */
static void ref_position(const plot_font_style_t *f, const char *string,
			 size_t length, int x, size_t *char_offset, int *actual_x)
{
	uint32_t ucs4; size_t nxtchr = 0; FT_Glyph glyph; int prev_x = 0;
	*actual_x = 0;
	while (nxtchr < length) {
		ucs4 = utf8_to_ucs4(string + nxtchr, length - nxtchr);
		glyph = fb_getglyph(f, ucs4);
		if (glyph == NULL) { nxtchr = utf8_next(string, length, nxtchr); continue; }
		*actual_x += glyph->advance.x >> 16;
		if (*actual_x > x) break;
		prev_x = *actual_x;
		nxtchr = utf8_next(string, length, nxtchr);
	}
	if (abs(*actual_x - x) > abs(prev_x - x)) *actual_x = prev_x;
	*char_offset = nxtchr;
}
static void ref_split(const plot_font_style_t *f, const char *string,
		      size_t length, int x, size_t *char_offset, int *actual_x)
{
	uint32_t ucs4; size_t nxtchr = 0; FT_Glyph glyph;
	int last_space_x = 0, last_space_idx = 0;
	*actual_x = 0;
	while (nxtchr < length) {
		ucs4 = utf8_to_ucs4(string + nxtchr, length - nxtchr);
		glyph = fb_getglyph(f, ucs4);
		if (glyph == NULL) { nxtchr = utf8_next(string, length, nxtchr); continue; }
		if (ucs4 == 0x20) { last_space_x = *actual_x; last_space_idx = nxtchr; }
		*actual_x += glyph->advance.x >> 16;
		if (*actual_x > x && last_space_idx != 0) {
			*actual_x = last_space_x;
			*char_offset = last_space_idx;
			return;
		}
		nxtchr = utf8_next(string, length, nxtchr);
	}
	*char_offset = nxtchr;
}

static const char *corpus[] = {
 "The quick brown fox jumps over the lazy dog",
 "0123456789 !@#$%^&*()_+-=[]{}|;':\",./<>?",
 "a", "  ", "iiiiiiiiii", "WWWWWWWWWW",
 "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do",
 "caf\xc3\xa9 na\xc3\xafve \xc3\xa9l\xc3\xa8ve",              /* Latin-1 accents */
 "\xe2\x80\x9cquoted\xe2\x80\x9d \xe2\x80\x94 dashed",        /* punctuation */
 "\xd0\x9f\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82",          /* Cyrillic */
 "\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e",                      /* CJK, likely no glyph */
 "mixed \xe6\x97\xa5 and ascii",
 "", "x",
};
#define NCORPUS (sizeof(corpus)/sizeof(corpus[0]))

int main(void)
{
	plot_font_style_t f;
	int sizes[] = {8, 10, 12, 14, 16, 20, 24};
	unsigned i, si;
	int bad = 0;

	fontstubs_init();
	if (!fb_font_init()) { printf("font init failed\n"); return 1; }

	memset(&f, 0, sizeof f);
	f.family = PLOT_FONT_FAMILY_SANS_SERIF;
	f.weight = 400;
	f.flags = FONTF_NONE;

	printf("1. cached width equals the uncached width\n");
	for (si = 0; si < sizeof(sizes)/sizeof(sizes[0]); si++) {
		f.size = sizes[si] * PLOT_STYLE_SCALE;
		for (i = 0; i < NCORPUS; i++) {
			int a = 0, b;
			size_t n = strlen(corpus[i]);
			framebuffer_layout_table->width(&f, corpus[i], n, &a);
			b = width_uncached(&f, corpus[i], n);
			if (a != b) {
				printf("   FAIL size %d string %u: cached %d uncached %d\n",
				       sizes[si], i, a, b);
				bad = 1;
			}
		}
	}
	/* bold and italic pick different faces: the cache must not mix them */
	{
		int plain = 0, bold = 0, italic = 0;
		const char *s = "Handgloves"; size_t n = strlen(s);
		f.size = 12 * PLOT_STYLE_SCALE;
		f.weight = 400; f.flags = FONTF_NONE;
		framebuffer_layout_table->width(&f, s, n, &plain);
		f.weight = 700;
		framebuffer_layout_table->width(&f, s, n, &bold);
		f.weight = 400; f.flags = FONTF_ITALIC;
		framebuffer_layout_table->width(&f, s, n, &italic);
		printf("   plain %d, bold %d, italic %d\n", plain, bold, italic);
		if (plain == bold) { printf("   FAIL bold measured as plain\n"); bad = 1; }
		f.flags = FONTF_NONE; f.weight = 400;
	}
	/* more styles than the cache holds, then back to the first */
	{
		int first = 0, again = 0;
		const char *s = "round trip"; size_t n = strlen(s);
		f.size = 11 * PLOT_STYLE_SCALE;
		framebuffer_layout_table->width(&f, s, n, &first);
		for (i = 0; i < 20; i++) {
			int junk; f.size = (30 + i) * PLOT_STYLE_SCALE;
			framebuffer_layout_table->width(&f, s, n, &junk);
		}
		f.size = 11 * PLOT_STYLE_SCALE;
		framebuffer_layout_table->width(&f, s, n, &again);
		printf("   after evicting the row: %d, was %d\n", again, first);
		if (first != again) { printf("   FAIL eviction changed a width\n"); bad = 1; }
	}
	printf("%s\n\n", bad ? "   -> FAILURES" : "   all widths identical");

	printf("2. position and split return exactly what they used to\n");
	for (si = 0; si < sizeof(sizes)/sizeof(sizes[0]); si++) {
		int xs[] = {0, 1, 5, 20, 40, 80, 200, 1000};
		unsigned xi;
		f.size = sizes[si] * PLOT_STYLE_SCALE;
		for (i = 0; i < NCORPUS; i++) {
			size_t n = strlen(corpus[i]);
			for (xi = 0; xi < sizeof(xs)/sizeof(xs[0]); xi++) {
				size_t o1 = 0, o2 = 0; int a1 = 0, a2 = 0;
				framebuffer_layout_table->position(&f, corpus[i], n,
								   xs[xi], &o1, &a1);
				ref_position(&f, corpus[i], n, xs[xi], &o2, &a2);
				if (o1 != o2 || a1 != a2) {
					printf("   FAIL position size %d str %u x %d: "
					       "(%d,%d) was (%d,%d)\n", sizes[si], i,
					       xs[xi], (int)o1, a1, (int)o2, a2);
					bad = 1;
				}
				o1 = o2 = 0; a1 = a2 = 0;
				framebuffer_layout_table->split(&f, corpus[i], n,
								xs[xi], &o1, &a1);
				ref_split(&f, corpus[i], n, xs[xi], &o2, &a2);
				if (o1 != o2 || a1 != a2) {
					printf("   FAIL split size %d str %u x %d: "
					       "(%d,%d) was (%d,%d)\n", sizes[si], i,
					       xs[xi], (int)o1, a1, (int)o2, a2);
					bad = 1;
				}
			}
		}
	}
	printf("%s\n\n", bad ? "   -> FAILURES" : "   identical offsets and widths");

	printf("2b. position and split terminate on every string\n");
	f.size = 12 * PLOT_STYLE_SCALE;
	for (i = 0; i < NCORPUS; i++) {
		size_t n = strlen(corpus[i]), off = 0; int ax = 0;
		framebuffer_layout_table->position(&f, corpus[i], n, 40, &off, &ax);
		framebuffer_layout_table->split(&f, corpus[i], n, 40, &off, &ax);
	}
	printf("   returned from every call (a hang would not reach here)\n\n");

	printf("3. speed, measuring a paragraph 20000 times\n");
	{
		const char *s = corpus[6]; size_t n = strlen(s);
		double t0, t1, tc, tu; int w, reps = 20000;
		f.size = 12 * PLOT_STYLE_SCALE;
		framebuffer_layout_table->width(&f, s, n, &w);  /* warm */
		t0 = now();
		for (i = 0; i < (unsigned)reps; i++)
			framebuffer_layout_table->width(&f, s, n, &w);
		t1 = now(); tc = t1 - t0;
		t0 = now();
		for (i = 0; i < (unsigned)reps; i++) w = width_uncached(&f, s, n);
		t1 = now(); tu = t1 - t0;
		printf("   through the cache manager  %7.0f ms\n", tu);
		printf("   through the advance cache  %7.0f ms   %.1fx faster\n", tc, tu/tc);
	}
	return bad;
}
