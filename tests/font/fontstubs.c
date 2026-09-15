/* The few things font_freetype.c reaches for outside itself. The font
 * paths and the cache size come from options; give it the values the
 * Vita build uses so the measurement is the one that matters. */
#include <stddef.h>
#include <string.h>
#include <stdarg.h>
#include <stdio.h>
#include "utils/nsoption.h"

char **respaths;
void *guit;
int browser_get_dpi(void) { return 90; }

struct nsoption_s *nsoptions;
static struct nsoption_s opts[NSOPTION_LISTEND];

#define FONTDIR "/home/user/VitaSurf/resources/fonts/"
void fontstubs_init(void)
{
	nsoptions = opts;
	opts[NSOPTION_fb_font_cachesize].value.i = 2048;
	opts[NSOPTION_fb_face_sans_serif].value.s = FONTDIR "DejaVuSans.ttf";
	opts[NSOPTION_fb_face_sans_serif_bold].value.s = FONTDIR "DejaVuSans-Bold.ttf";
	opts[NSOPTION_fb_face_sans_serif_italic].value.s = FONTDIR "DejaVuSans-Oblique.ttf";
	opts[NSOPTION_fb_face_sans_serif_italic_bold].value.s = FONTDIR "DejaVuSans-BoldOblique.ttf";
	opts[NSOPTION_fb_face_serif].value.s = FONTDIR "DejaVuSerif.ttf";
	opts[NSOPTION_fb_face_serif_bold].value.s = FONTDIR "DejaVuSerif-Bold.ttf";
	opts[NSOPTION_fb_face_monospace].value.s = FONTDIR "DejaVuSansMono.ttf";
	opts[NSOPTION_fb_face_monospace_bold].value.s = FONTDIR "DejaVuSansMono-Bold.ttf";
	opts[NSOPTION_fb_face_cursive].value.s = FONTDIR "DejaVuSans.ttf";
	opts[NSOPTION_fb_face_fantasy].value.s = FONTDIR "DejaVuSans.ttf";
	opts[NSOPTION_font_min_size].value.i = 85;
}

char *filepath_sfind(char **respath, char *filepath, const char *filename)
{
	(void)respath;
	if (filename == NULL) return NULL;
	strcpy(filepath, filename);
	return filepath;
}

/* nslog, reduced to nothing: this test is about widths, not logging */
struct nslog_category_s { int x; };
struct nslog_category_s __nslog_category_netsurf;
void nslog_log(const char *f, const char *fn, int l, void *c, const char *fmt, ...)
{ (void)f;(void)fn;(void)l;(void)c;(void)fmt; }
