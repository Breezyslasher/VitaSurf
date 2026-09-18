/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/**
 * \file
 * Drawing for the 2D canvas context (VitaSurf).
 *
 * Every chart on a dashboard is a canvas, and with nothing behind the
 * context the page drew nothing at all: openmediavault's processor and
 * memory gauges were empty cards. The context in the engine keeps the
 * state and flattens curves, and hands the paths here in canvas pixels;
 * this file owns the bitmap and turns paths into pixels.
 *
 * The rasteriser is a scanline filler with four sub-scanlines a row, so
 * an edge gets a few steps of coverage rather than a hard staircase,
 * which matters at the size a gauge is drawn on a 960 by 544 screen.
 */

#include <math.h>
#include <stdlib.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#include <string.h>

#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_GLYPH_H

#include <dom/dom.h>

#include "utils/corestrings.h"
#include "utils/errors.h"
#include "utils/utils.h"
#include "netsurf/bitmap.h"
#include "netsurf/browser.h"
#include "netsurf/plot_style.h"
#include "utils/utf8.h"
#include "desktop/gui_internal.h"
#include "desktop/bitmap.h"

#include "canvas.h"

/** Total canvas bitmap memory allowed, to keep a page off the heap. */
#define CANVAS_BYTES_MAX (6 * 1024 * 1024)

/** The largest canvas taken, in pixels each way. */
#define CANVAS_SIDE_MAX 2048

/** Sub-scanlines per row, for the edges. */
#define CANVAS_SUBS 4

struct vita_canvas {
	struct bitmap *bitmap;
	int width;
	int height;
	int stride;		/**< bytes between rows */
	unsigned char *pixels;
};

static unsigned int canvas_bytes;

/* An edge of the path being filled, in sub-scanline space. */
struct canvas_edge {
	double x;		/**< x where the edge meets sub-scanline y0 */
	double dxdy;		/**< how x moves per sub-scanline */
	int y0;			/**< first sub-scanline the edge covers */
	int y1;			/**< one past the last */
	int dir;		/**< 1 downwards, -1 upwards, for nonzero */
};

struct canvas_edges {
	struct canvas_edge *data;
	unsigned int count;
	unsigned int allocated;
};

/* A crossing of one sub-scanline, sorted by x before the spans are cut. */
struct canvas_cross {
	double x;
	int dir;
};


/* exported function documented in canvas.h */
unsigned int vita_canvas_bytes(void)
{
	return canvas_bytes;
}


/**
 * Let go of a canvas bitmap the document no longer has a node for.
 */
static void canvas_user_data_handler(dom_node_operation op, dom_string *key,
				     void *data, struct dom_node *src,
				     struct dom_node *dst)
{
	struct bitmap *bitmap = data;

	(void) src;
	(void) dst;

	if (dom_string_isequal(key,
			corestring_dom___ns_key_canvas_node_data) == false ||
			bitmap == NULL) {
		return;
	}

	switch (op) {
	case DOM_NODE_DELETED:
		canvas_bytes -= (unsigned int)
				(guit->bitmap->get_rowstride(bitmap) *
				 guit->bitmap->get_height(bitmap));
		guit->bitmap->destroy(bitmap);
		break;

	case DOM_NODE_CLONED:
	case DOM_NODE_IMPORTED:
	case DOM_NODE_RENAMED:
	case DOM_NODE_ADOPTED:
	default:
		break;
	}
}


/* exported function documented in canvas.h */
struct vita_canvas *vita_canvas_get(struct dom_node *node,
				    int width, int height)
{
	static struct vita_canvas canvas;
	struct bitmap *bitmap = NULL;
	struct bitmap *old = NULL;
	unsigned int bytes;

	if (node == NULL || width <= 0 || height <= 0 ||
	    width > CANVAS_SIDE_MAX || height > CANVAS_SIDE_MAX) {
		return NULL;
	}

	if (dom_node_get_user_data(node,
			corestring_dom___ns_key_canvas_node_data,
			&bitmap) != DOM_NO_ERR) {
		bitmap = NULL;
	}

	if (bitmap != NULL &&
	    (guit->bitmap->get_width(bitmap) != width ||
	     guit->bitmap->get_height(bitmap) != height)) {
		/* the page resized its canvas: it starts again, blank,
		 * as it does in a browser */
		bitmap = NULL;
	}

	if (bitmap == NULL) {
		bytes = (unsigned int) (width * height * 4);
		if (canvas_bytes + bytes > CANVAS_BYTES_MAX) {
			vita_log("canvas %dx%d refused, %u KB already taken",
				 width, height, canvas_bytes / 1024);
			return NULL;
		}

		bitmap = guit->bitmap->create(width, height, BITMAP_NONE);
		if (bitmap == NULL) {
			return NULL;
		}
		memset(guit->bitmap->get_buffer(bitmap), 0,
		       (size_t) (guit->bitmap->get_rowstride(bitmap) *
				 height));
		guit->bitmap->modified(bitmap);

		if (dom_node_set_user_data(node,
				corestring_dom___ns_key_canvas_node_data,
				bitmap, canvas_user_data_handler,
				&old) != DOM_NO_ERR) {
			guit->bitmap->destroy(bitmap);
			return NULL;
		}
		if (old != NULL) {
			canvas_bytes -= (unsigned int)
					(guit->bitmap->get_rowstride(old) *
					 guit->bitmap->get_height(old));
			guit->bitmap->destroy(old);
		}
		canvas_bytes += (unsigned int)
				(guit->bitmap->get_rowstride(bitmap) * height);
	}

	canvas.bitmap = bitmap;
	canvas.width = width;
	canvas.height = height;
	canvas.stride = guit->bitmap->get_rowstride(bitmap);
	canvas.pixels = guit->bitmap->get_buffer(bitmap);

	return canvas.pixels != NULL ? &canvas : NULL;
}


/* exported function documented in canvas.h */
void vita_canvas_finish(struct vita_canvas *c)
{
	if (c != NULL && c->bitmap != NULL) {
		guit->bitmap->modified(c->bitmap);
	}
}


/**
 * Where each channel sits in a pixel, for the layout this build uses.
 */
static void canvas_channel_shifts(int *r, int *g, int *b, int *a)
{
	switch (bitmap_fmt.layout) {
	case BITMAP_LAYOUT_B8G8R8A8:
		*b = 0; *g = 1; *r = 2; *a = 3;
		break;
	case BITMAP_LAYOUT_A8R8G8B8:
		*a = 0; *r = 1; *g = 2; *b = 3;
		break;
	case BITMAP_LAYOUT_A8B8G8R8:
		*a = 0; *b = 1; *g = 2; *r = 3;
		break;
	case BITMAP_LAYOUT_R8G8B8A8:
	default:
		*r = 0; *g = 1; *b = 2; *a = 3;
		break;
	}
}


/**
 * Lay a colour over one pixel, by how much of it the shape covers.
 *
 * \param px        the pixel, four bytes
 * \param rgba      the colour, 0xRRGGBBAA
 * \param coverage  0 to 255
 */
static inline void canvas_blend(unsigned char *px, uint32_t rgba,
				unsigned int coverage,
				int ro, int go, int bo, int ao)
{
	unsigned int sa = ((rgba & 0xff) * coverage) / 255;
	unsigned int da, out_a;
	unsigned int sr, sg, sb;

	if (sa == 0) {
		return;
	}

	sr = (rgba >> 24) & 0xff;
	sg = (rgba >> 16) & 0xff;
	sb = (rgba >> 8) & 0xff;

	if (sa == 255) {
		px[ro] = (unsigned char) sr;
		px[go] = (unsigned char) sg;
		px[bo] = (unsigned char) sb;
		px[ao] = 255;
		return;
	}

	da = px[ao];
	out_a = sa + (da * (255 - sa)) / 255;
	if (out_a == 0) {
		px[ro] = px[go] = px[bo] = px[ao] = 0;
		return;
	}

	px[ro] = (unsigned char) ((sr * sa + px[ro] * da * (255 - sa) / 255) /
			out_a);
	px[go] = (unsigned char) ((sg * sa + px[go] * da * (255 - sa) / 255) /
			out_a);
	px[bo] = (unsigned char) ((sb * sa + px[bo] * da * (255 - sa) / 255) /
			out_a);
	px[ao] = (unsigned char) out_a;
}


/**
 * The colour a gradient shows at a position along it.
 *
 * Before the first stop and after the last one a gradient holds that
 * stop's colour, and between two stops it mixes them evenly, which is
 * what the specification asks for and what a gauge's arc needs.
 */
static uint32_t canvas_stop_colour(const struct vita_canvas_paint *paint,
				   double t)
{
	const struct vita_canvas_stop *a, *b;
	unsigned int ca[4], cb[4], out[4];
	double span, f;
	int i;

	if (paint->n_stops == 0) {
		return 0;
	}
	if (t <= paint->stops[0].offset || paint->n_stops == 1) {
		return paint->stops[0].rgba;
	}
	if (t >= paint->stops[paint->n_stops - 1].offset) {
		return paint->stops[paint->n_stops - 1].rgba;
	}

	for (i = 1; i < paint->n_stops; i++) {
		if (t <= paint->stops[i].offset) {
			break;
		}
	}
	if (i >= paint->n_stops) {
		i = paint->n_stops - 1;
	}
	a = &paint->stops[i - 1];
	b = &paint->stops[i];

	span = b->offset - a->offset;
	f = span <= 0 ? 1.0 : (t - a->offset) / span;

	for (i = 0; i < 4; i++) {
		int shift = 24 - i * 8;

		ca[i] = (a->rgba >> shift) & 0xff;
		cb[i] = (b->rgba >> shift) & 0xff;
		out[i] = (unsigned int) (ca[i] + (cb[i] - (double) ca[i]) * f);
		if (out[i] > 255) {
			out[i] = 255;
		}
	}

	return ((uint32_t) out[0] << 24) | ((uint32_t) out[1] << 16) |
	       ((uint32_t) out[2] << 8) | (uint32_t) out[3];
}


/**
 * How far along a radial gradient a point is.
 *
 * A radial gradient is a cone of circles between the two the page gave,
 * so the position is the largest t whose circle still has a radius and
 * passes through the point. Outside the cone there is no colour at all,
 * which is the transparent the caller gets back as false.
 */
static bool canvas_radial_at(const struct vita_canvas_paint *paint,
			     double px, double py, double *t_out)
{
	double cdx = paint->x1 - paint->x0;
	double cdy = paint->y1 - paint->y0;
	double dr = paint->r1 - paint->r0;
	double pdx = px - paint->x0;
	double pdy = py - paint->y0;
	double a = cdx * cdx + cdy * cdy - dr * dr;
	double b = 2 * (pdx * cdx + pdy * cdy + paint->r0 * dr);
	double c = pdx * pdx + pdy * pdy - paint->r0 * paint->r0;
	double t;

	if (fabs(a) < 1e-9) {
		if (fabs(b) < 1e-9) {
			return false;
		}
		t = c / b;
		if (paint->r0 + t * dr < 0) {
			return false;
		}
	} else {
		double disc = b * b - 4 * a * c;
		double root, t1, t2;

		if (disc < 0) {
			return false;
		}
		root = sqrt(disc);
		t1 = (b + root) / (2 * a);
		t2 = (b - root) / (2 * a);
		t = t1 > t2 ? t1 : t2;
		if (paint->r0 + t * dr < 0) {
			t = t1 > t2 ? t2 : t1;
			if (paint->r0 + t * dr < 0) {
				return false;
			}
		}
	}

	*t_out = t;

	return true;
}


/**
 * The colour a paint puts at one pixel, taken at its centre.
 */
static uint32_t canvas_paint_at(const struct vita_canvas_paint *paint,
				int x, int y)
{
	double px = x + 0.5, py = y + 0.5;
	double t = 0;

	switch (paint->kind) {
	case CANVAS_PAINT_LINEAR: {
		double dx = paint->x1 - paint->x0;
		double dy = paint->y1 - paint->y0;
		double len2 = dx * dx + dy * dy;

		if (len2 < 1e-9) {
			/* zero length: the whole shape is the last stop */
			return paint->n_stops == 0 ? 0 :
				paint->stops[paint->n_stops - 1].rgba;
		}
		t = ((px - paint->x0) * dx + (py - paint->y0) * dy) / len2;
		break;
	}

	case CANVAS_PAINT_RADIAL:
		if (canvas_radial_at(paint, px, py, &t) == false) {
			return 0;
		}
		break;

	case CANVAS_PAINT_CONIC: {
		double ang = atan2(py - paint->y0, px - paint->x0) -
				paint->angle;

		t = ang / (2 * M_PI);
		t = t - floor(t);
		break;
	}

	case CANVAS_PAINT_SOLID:
	default:
		return paint->rgba;
	}

	if (t < 0) t = 0;
	if (t > 1) t = 1;

	return canvas_stop_colour(paint, t);
}


/* exported function documented in canvas.h */
void vita_canvas_clear_rect(struct vita_canvas *c,
			    double x, double y, double w, double h)
{
	int x0, y0, x1, y1, row;

	if (c == NULL || w <= 0 || h <= 0) {
		return;
	}

	x0 = (int) floor(x);
	y0 = (int) floor(y);
	x1 = (int) ceil(x + w);
	y1 = (int) ceil(y + h);

	if (x0 < 0) x0 = 0;
	if (y0 < 0) y0 = 0;
	if (x1 > c->width) x1 = c->width;
	if (y1 > c->height) y1 = c->height;

	for (row = y0; row < y1; row++) {
		memset(c->pixels + row * c->stride + x0 * 4, 0,
		       (size_t) ((x1 - x0) * 4));
	}
}


/**
 * Add one edge of the path, in sub-scanlines.
 */
static bool canvas_add_edge(struct canvas_edges *edges, double x0, double y0,
			    double x1, double y1, int height)
{
	struct canvas_edge *e;
	int dir = 1;
	int top, bottom;
	double t;

	if (y0 == y1) {
		return true;	/* a horizontal edge crosses nothing */
	}
	if (y0 > y1) {
		t = y0; y0 = y1; y1 = t;
		t = x0; x0 = x1; x1 = t;
		dir = -1;
	}

	/* the sub-scanlines whose centres the edge spans */
	top = (int) ceil(y0 * CANVAS_SUBS - 0.5);
	bottom = (int) ceil(y1 * CANVAS_SUBS - 0.5);
	if (top < 0) top = 0;
	if (bottom > height * CANVAS_SUBS) bottom = height * CANVAS_SUBS;
	if (top >= bottom) {
		return true;
	}

	if (edges->count == edges->allocated) {
		unsigned int want = edges->allocated == 0 ?
				64 : edges->allocated * 2;
		struct canvas_edge *grown = realloc(edges->data,
				want * sizeof(*grown));

		if (grown == NULL) {
			return false;
		}
		edges->data = grown;
		edges->allocated = want;
	}

	e = &edges->data[edges->count++];
	e->dxdy = (x1 - x0) / ((y1 - y0) * CANVAS_SUBS);
	e->x = x0 + ((top + 0.5) / CANVAS_SUBS - y0) * (x1 - x0) / (y1 - y0);
	e->y0 = top;
	e->y1 = bottom;
	e->dir = dir;

	return true;
}


static int canvas_cross_cmp(const void *a, const void *b)
{
	const struct canvas_cross *ca = a;
	const struct canvas_cross *cb = b;

	if (ca->x < cb->x) return -1;
	if (ca->x > cb->x) return 1;

	return 0;
}


/**
 * Fill the edges gathered so far, and let them go.
 */
static void canvas_fill_edges(struct vita_canvas *c, struct canvas_edges *edges,
			      const struct vita_canvas_paint *paint,
			      bool evenodd)
{
	struct canvas_cross *crossings = NULL;
	unsigned int *coverage = NULL;
	unsigned int i;
	int ro = 0, go = 1, bo = 2, ao = 3;
	int y, sub, row;
	int ytop = c->height * CANVAS_SUBS, ybottom = 0;

	if (edges->count == 0) {
		goto out;
	}

	crossings = malloc(edges->count * sizeof(*crossings));
	coverage = calloc((size_t) c->width, sizeof(*coverage));
	if (crossings == NULL || coverage == NULL) {
		goto out;
	}

	canvas_channel_shifts(&ro, &go, &bo, &ao);

	for (i = 0; i < edges->count; i++) {
		if (edges->data[i].y0 < ytop) ytop = edges->data[i].y0;
		if (edges->data[i].y1 > ybottom) ybottom = edges->data[i].y1;
	}
	if (ytop < 0) ytop = 0;
	if (ybottom > c->height * CANVAS_SUBS) {
		ybottom = c->height * CANVAS_SUBS;
	}

	for (row = ytop / CANVAS_SUBS; row <= (ybottom - 1) / CANVAS_SUBS &&
			row < c->height; row++) {
		bool any = false;

		memset(coverage, 0, (size_t) c->width * sizeof(*coverage));

		for (sub = 0; sub < CANVAS_SUBS; sub++) {
			unsigned int n = 0;
			int winding = 0;
			unsigned int k;

			y = row * CANVAS_SUBS + sub;
			if (y < ytop || y >= ybottom) {
				continue;
			}

			for (i = 0; i < edges->count; i++) {
				const struct canvas_edge *e = &edges->data[i];

				if (y < e->y0 || y >= e->y1) {
					continue;
				}
				crossings[n].x = e->x + e->dxdy * (y - e->y0);
				crossings[n].dir = e->dir;
				n++;
			}
			if (n < 2) {
				continue;
			}
			qsort(crossings, n, sizeof(*crossings),
			      canvas_cross_cmp);

			for (k = 0; k + 1 <= n - 1; k++) {
				bool inside;
				double xa, xb;
				int px, from, to;

				winding += evenodd ? 1 : crossings[k].dir;
				inside = evenodd ? (winding & 1) != 0 :
						winding != 0;
				if (inside == false) {
					continue;
				}

				xa = crossings[k].x;
				xb = crossings[k + 1].x;
				if (xb <= 0 || xa >= c->width || xb <= xa) {
					continue;
				}
				if (xa < 0) xa = 0;
				if (xb > c->width) xb = c->width;

				from = (int) floor(xa);
				to = (int) ceil(xb);
				if (to > c->width) to = c->width;

				for (px = from; px < to; px++) {
					double left = xa > px ? xa : px;
					double right = xb < px + 1 ?
							xb : px + 1;
					double part = right - left;

					if (part <= 0) {
						continue;
					}
					/* in 1/65535ths, because 255/4 a
					 * sub-scanline truncates to 63 and
					 * leaves a solid fill at 252 */
					coverage[px] += (unsigned int)
						(part * 65535.0 / CANVAS_SUBS);
					any = true;
				}
			}
		}

		if (any == false) {
			continue;
		}

		for (i = 0; i < (unsigned int) c->width; i++) {
			unsigned int cov = coverage[i];

			if (cov == 0) {
				continue;
			}
			cov = (cov * 255 + 32767) / 65535;
			if (cov > 255) {
				cov = 255;
			}
			if (cov == 0) {
				continue;
			}
			canvas_blend(c->pixels + row * c->stride + i * 4,
				     paint->kind == CANVAS_PAINT_SOLID ?
					paint->rgba :
					canvas_paint_at(paint, (int) i, row),
				     cov, ro, go, bo, ao);
		}
	}

out:
	free(crossings);
	free(coverage);
	free(edges->data);
	edges->data = NULL;
	edges->count = edges->allocated = 0;
}


/* exported function documented in canvas.h */
void vita_canvas_fill_path(struct vita_canvas *c, const double *pts,
			   const int *counts, int nsub,
			   const struct vita_canvas_paint *paint,
			   bool evenodd)
{
	struct canvas_edges edges = { NULL, 0, 0 };
	int sub, i, at = 0;

	if (c == NULL || pts == NULL || counts == NULL || nsub <= 0 ||
			paint == NULL) {
		return;
	}

	for (sub = 0; sub < nsub; sub++) {
		int n = counts[sub];

		for (i = 0; i + 1 < n; i++) {
			if (canvas_add_edge(&edges,
					pts[(at + i) * 2],
					pts[(at + i) * 2 + 1],
					pts[(at + i + 1) * 2],
					pts[(at + i + 1) * 2 + 1],
					c->height) == false) {
				goto done;
			}
		}
		/* a filled subpath is closed whether the page closed it
		 * or not */
		if (n > 1) {
			if (canvas_add_edge(&edges,
					pts[(at + n - 1) * 2],
					pts[(at + n - 1) * 2 + 1],
					pts[at * 2],
					pts[at * 2 + 1],
					c->height) == false) {
				goto done;
			}
		}
		at += n;
	}

done:
	canvas_fill_edges(c, &edges, paint, evenodd);
}


/**
 * Add the quadrilateral one segment of a stroke covers.
 */
static bool canvas_stroke_segment(struct canvas_edges *edges, double x0,
				  double y0, double x1, double y1,
				  double half, int height)
{
	double dx = x1 - x0, dy = y1 - y0;
	double len = sqrt(dx * dx + dy * dy);
	double nx, ny;
	double qx[4], qy[4];
	int i;

	if (len < 1e-6) {
		return true;
	}

	nx = -dy / len * half;
	ny = dx / len * half;

	qx[0] = x0 + nx; qy[0] = y0 + ny;
	qx[1] = x1 + nx; qy[1] = y1 + ny;
	qx[2] = x1 - nx; qy[2] = y1 - ny;
	qx[3] = x0 - nx; qy[3] = y0 - ny;

	for (i = 0; i < 4; i++) {
		int j = (i + 1) & 3;

		if (canvas_add_edge(edges, qx[i], qy[i], qx[j], qy[j],
				height) == false) {
			return false;
		}
	}

	return true;
}


/**
 * Add a square at a joint, so a corner is not left with a notch in it.
 */
static bool canvas_stroke_joint(struct canvas_edges *edges, double x,
				double y, double half, int height)
{
	double qx[4], qy[4];
	int i;

	if (half < 0.5) {
		return true;
	}

	qx[0] = x - half; qy[0] = y - half;
	qx[1] = x + half; qy[1] = y - half;
	qx[2] = x + half; qy[2] = y + half;
	qx[3] = x - half; qy[3] = y + half;

	for (i = 0; i < 4; i++) {
		int j = (i + 1) & 3;

		if (canvas_add_edge(edges, qx[i], qy[i], qx[j], qy[j],
				height) == false) {
			return false;
		}
	}

	return true;
}


/* exported function documented in canvas.h */
void vita_canvas_stroke_path(struct vita_canvas *c, const double *pts,
			     const int *counts, int nsub,
			     const struct vita_canvas_paint *paint,
			     double line_width)
{
	struct canvas_edges edges = { NULL, 0, 0 };
	double half = line_width / 2;
	int sub, i, at = 0;

	if (c == NULL || pts == NULL || counts == NULL || nsub <= 0 ||
			paint == NULL) {
		return;
	}
	if (half < 0.35) {
		/* a hairline still has to be seen */
		half = 0.35;
	}

	for (sub = 0; sub < nsub; sub++) {
		int n = counts[sub];

		for (i = 0; i + 1 < n; i++) {
			if (canvas_stroke_segment(&edges,
					pts[(at + i) * 2],
					pts[(at + i) * 2 + 1],
					pts[(at + i + 1) * 2],
					pts[(at + i + 1) * 2 + 1],
					half, c->height) == false) {
				goto done;
			}
			if (i > 0 && half > 0.7) {
				if (canvas_stroke_joint(&edges,
						pts[(at + i) * 2],
						pts[(at + i) * 2 + 1],
						half, c->height) == false) {
					goto done;
				}
			}
		}
		at += n;
	}

done:
	/* the quads overlap at every joint, and the nonzero rule paints
	 * the overlap once rather than darkening it */
	canvas_fill_edges(c, &edges, paint, false);
}


/*
 * Text is drawn with the glyphs the frontend's font engine has, so a
 * chart's labels look like the rest of the page. A build with no such
 * engine -- the test harness is one -- leaves the symbol undefined and
 * simply draws no text.
 */
extern FT_Glyph fb_getglyph(const plot_font_style_t *fstyle, uint32_t ucs4)
		__attribute__((weak));


/**
 * The style the frontend's font engine wants for a canvas font.
 */
static void canvas_font_style(plot_font_style_t *fstyle, double size_px,
			      int family, int weight, bool italic)
{
	int dpi = browser_get_dpi();

	if (dpi <= 0) {
		dpi = 90;
	}
	if (size_px < 1) {
		size_px = 1;
	}
	if (size_px > 400) {
		size_px = 400;
	}

	memset(fstyle, 0, sizeof(*fstyle));
	fstyle->family = (plot_font_generic_family_t) family;
	/* the engine takes a size in points at the screen's resolution */
	fstyle->size = (plot_style_fixed) (size_px * 72.0 * PLOT_STYLE_SCALE /
			dpi);
	fstyle->weight = weight < 100 ? 400 : weight;
	fstyle->flags = italic ? FONTF_ITALIC : FONTF_NONE;
	fstyle->foreground = 0;
	fstyle->background = 0xffffff;
}


/* exported function documented in canvas.h */
double vita_canvas_text_width(const char *utf8, unsigned int len,
			      double size_px, int family, int weight,
			      bool italic)
{
	plot_font_style_t fstyle;
	size_t at = 0;
	double width = 0;

	if (utf8 == NULL || len == 0) {
		return 0;
	}
	if (fb_getglyph == NULL) {
		/* no font engine: half an em a character is the guess the
		 * engine used to make on its own */
		return (double) len * size_px * 0.5;
	}

	canvas_font_style(&fstyle, size_px, family, weight, italic);

	while (at < len) {
		uint32_t ucs4 = utf8_to_ucs4(utf8 + at, len - at);
		FT_Glyph glyph;

		at = utf8_next(utf8, len, at);
		glyph = fb_getglyph(&fstyle, ucs4);
		if (glyph != NULL) {
			width += (double) (glyph->advance.x >> 16);
		}
	}

	return width;
}


/* exported function documented in canvas.h */
void vita_canvas_text(struct vita_canvas *c, double x, double y,
		      const char *utf8, unsigned int len, double size_px,
		      int family, int weight, bool italic,
		      const struct vita_canvas_paint *paint,
		      int align, int baseline)
{
	plot_font_style_t fstyle;
	size_t at = 0;
	double pen;
	int ro = 0, go = 1, bo = 2, ao = 3;

	if (c == NULL || utf8 == NULL || len == 0 || paint == NULL ||
			fb_getglyph == NULL) {
		return;
	}

	canvas_font_style(&fstyle, size_px, family, weight, italic);
	canvas_channel_shifts(&ro, &go, &bo, &ao);

	switch (align) {
	case 1:
		x -= vita_canvas_text_width(utf8, len, size_px, family,
					    weight, italic) / 2;
		break;
	case 2:
		x -= vita_canvas_text_width(utf8, len, size_px, family,
					    weight, italic);
		break;
	default:
		break;
	}

	/* the engine draws from the baseline; the other baselines are
	 * taken from the size, which is what a font's own metrics come to
	 * within a pixel or two at the sizes a chart uses */
	switch (baseline) {
	case 1:
		y += size_px * 0.8;
		break;
	case 2:
		y += size_px * 0.3;
		break;
	case 3:
		y -= size_px * 0.2;
		break;
	default:
		break;
	}

	pen = x;
	while (at < len) {
		uint32_t ucs4 = utf8_to_ucs4(utf8 + at, len - at);
		FT_BitmapGlyph bg;
		FT_Glyph glyph;
		int gx, gy, row, col;

		at = utf8_next(utf8, len, at);
		glyph = fb_getglyph(&fstyle, ucs4);
		if (glyph == NULL) {
			continue;
		}
		if (glyph->format != FT_GLYPH_FORMAT_BITMAP) {
			pen += (double) (glyph->advance.x >> 16);
			continue;
		}

		bg = (FT_BitmapGlyph) glyph;
		gx = (int) lround(pen) + bg->left;
		gy = (int) lround(y) - bg->top;

		for (row = 0; row < (int) bg->bitmap.rows; row++) {
			int py = gy + row;

			if (py < 0 || py >= c->height) {
				continue;
			}
			for (col = 0; col < (int) bg->bitmap.width; col++) {
				int px = gx + col;
				unsigned int cov;

				if (px < 0 || px >= c->width) {
					continue;
				}
				if (bg->bitmap.pixel_mode ==
						FT_PIXEL_MODE_MONO) {
					unsigned char byte = bg->bitmap.buffer[
						row * bg->bitmap.pitch +
						col / 8];

					cov = (byte & (0x80 >> (col % 8))) ?
							255 : 0;
				} else {
					cov = bg->bitmap.buffer[
						row * bg->bitmap.pitch + col];
				}
				if (cov == 0) {
					continue;
				}
				canvas_blend(c->pixels + py * c->stride +
						px * 4,
					     paint->kind ==
							CANVAS_PAINT_SOLID ?
						paint->rgba :
						canvas_paint_at(paint, px, py),
					     cov, ro, go, bo, ao);
			}
		}

		pen += (double) (glyph->advance.x >> 16);
	}
}


/* exported function documented in canvas.h */
bool vita_canvas_as_image(struct vita_canvas *c, struct vita_canvas_image *img)
{
	if (c == NULL || img == NULL || c->pixels == NULL) {
		return false;
	}

	img->pixels = c->pixels;
	img->width = c->width;
	img->height = c->height;
	img->stride = c->stride;
	canvas_channel_shifts(&img->ro, &img->go, &img->bo, &img->ao);
	img->premultiplied = bitmap_fmt.pma;

	return true;
}


/* exported function documented in canvas.h */
bool vita_canvas_image_of_bitmap(struct bitmap *bitmap,
				 struct vita_canvas_image *img)
{
	if (bitmap == NULL || img == NULL) {
		return false;
	}

	img->pixels = guit->bitmap->get_buffer(bitmap);
	img->width = guit->bitmap->get_width(bitmap);
	img->height = guit->bitmap->get_height(bitmap);
	img->stride = guit->bitmap->get_rowstride(bitmap);
	img->premultiplied = bitmap_fmt.pma;
	canvas_channel_shifts(&img->ro, &img->go, &img->bo, &img->ao);

	return img->pixels != NULL && img->width > 0 && img->height > 0;
}


/**
 * One pixel of a source image, as straight red, green, blue and alpha.
 *
 * Pixels off the edge come back transparent, so sampling between two
 * pixels at the border does not wrap round to the other side.
 */
static void canvas_sample(const struct vita_canvas_image *img, int x, int y,
			  unsigned int *out)
{
	const unsigned char *px;

	if (x < 0 || y < 0 || x >= img->width || y >= img->height) {
		out[0] = out[1] = out[2] = out[3] = 0;
		return;
	}

	px = img->pixels + y * img->stride + x * 4;
	out[0] = px[img->ro];
	out[1] = px[img->go];
	out[2] = px[img->bo];
	out[3] = px[img->ao];

	if (img->premultiplied && out[3] != 0 && out[3] != 255) {
		out[0] = out[0] * 255 / out[3];
		out[1] = out[1] * 255 / out[3];
		out[2] = out[2] * 255 / out[3];
		if (out[0] > 255) out[0] = 255;
		if (out[1] > 255) out[1] = 255;
		if (out[2] > 255) out[2] = 255;
	}
}


/**
 * The colour an image shows at a point, in image pixels.
 *
 * Sampling between pixels is what keeps a logo scaled down to a corner
 * from breaking up; taking the nearest is what a page asks for when it
 * turns smoothing off to draw a sprite sheet.
 */
static uint32_t canvas_image_at(const struct vita_canvas_image *img,
				double u, double v, bool smooth)
{
	unsigned int c00[4], c10[4], c01[4], c11[4];
	unsigned int out[4];
	double fx, fy;
	int x, y, i;

	if (smooth == false) {
		unsigned int c[4];

		canvas_sample(img, (int) floor(u), (int) floor(v), c);
		return ((uint32_t) c[0] << 24) | ((uint32_t) c[1] << 16) |
		       ((uint32_t) c[2] << 8) | (uint32_t) c[3];
	}

	u -= 0.5;
	v -= 0.5;
	x = (int) floor(u);
	y = (int) floor(v);
	fx = u - x;
	fy = v - y;

	canvas_sample(img, x, y, c00);
	canvas_sample(img, x + 1, y, c10);
	canvas_sample(img, x, y + 1, c01);
	canvas_sample(img, x + 1, y + 1, c11);

	for (i = 0; i < 4; i++) {
		double top = c00[i] + (c10[i] - (double) c00[i]) * fx;
		double bottom = c01[i] + (c11[i] - (double) c01[i]) * fx;
		double val = top + (bottom - top) * fy;

		if (val < 0) val = 0;
		if (val > 255) val = 255;
		out[i] = (unsigned int) (val + 0.5);
	}

	return ((uint32_t) out[0] << 24) | ((uint32_t) out[1] << 16) |
	       ((uint32_t) out[2] << 8) | (uint32_t) out[3];
}


/* exported function documented in canvas.h */
void vita_canvas_draw_image(struct vita_canvas *c,
			    const struct vita_canvas_image *img,
			    double sx, double sy, double sw, double sh,
			    const double *m, double alpha, bool smooth)
{
	double corner_x[4], corner_y[4];
	double det, ia, ib, ic, id, ie, iff;
	int x0, y0, x1, y1, x, y, i;
	int ro = 0, go = 1, bo = 2, ao = 3;

	if (c == NULL || img == NULL || img->pixels == NULL || m == NULL ||
			sw <= 0 || sh <= 0 || alpha <= 0) {
		return;
	}

	/*
	 * m maps the unit square of the destination to canvas pixels, so
	 * the four corners of that square bound the pixels to visit and
	 * the inverse says which part of the image each one shows.
	 */
	for (i = 0; i < 4; i++) {
		double u = (i == 1 || i == 2) ? 1.0 : 0.0;
		double v = (i >= 2) ? 1.0 : 0.0;

		corner_x[i] = m[0] * u + m[2] * v + m[4];
		corner_y[i] = m[1] * u + m[3] * v + m[5];
	}

	x0 = c->width; y0 = c->height; x1 = 0; y1 = 0;
	for (i = 0; i < 4; i++) {
		if ((int) floor(corner_x[i]) < x0) x0 = (int) floor(corner_x[i]);
		if ((int) floor(corner_y[i]) < y0) y0 = (int) floor(corner_y[i]);
		if ((int) ceil(corner_x[i]) > x1) x1 = (int) ceil(corner_x[i]);
		if ((int) ceil(corner_y[i]) > y1) y1 = (int) ceil(corner_y[i]);
	}
	if (x0 < 0) x0 = 0;
	if (y0 < 0) y0 = 0;
	if (x1 > c->width) x1 = c->width;
	if (y1 > c->height) y1 = c->height;
	if (x0 >= x1 || y0 >= y1) {
		return;
	}

	det = m[0] * m[3] - m[1] * m[2];
	if (fabs(det) < 1e-12) {
		return;		/* flattened to nothing */
	}
	ia = m[3] / det;
	ib = -m[1] / det;
	ic = -m[2] / det;
	id = m[0] / det;
	ie = (m[2] * m[5] - m[3] * m[4]) / det;
	iff = (m[1] * m[4] - m[0] * m[5]) / det;

	canvas_channel_shifts(&ro, &go, &bo, &ao);

	for (y = y0; y < y1; y++) {
		for (x = x0; x < x1; x++) {
			double px = x + 0.5, py = y + 0.5;
			double u = ia * px + ic * py + ie;
			double v = ib * px + id * py + iff;
			uint32_t rgba;
			unsigned int cov;

			if (u < 0 || u >= 1 || v < 0 || v >= 1) {
				continue;	/* outside the rectangle */
			}

			rgba = canvas_image_at(img, sx + u * sw, sy + v * sh,
					       smooth);
			cov = (unsigned int) (alpha * 255 + 0.5);
			if (cov > 255) {
				cov = 255;
			}
			canvas_blend(c->pixels + y * c->stride + x * 4,
				     rgba, cov, ro, go, bo, ao);
		}
	}
}


/* exported function documented in canvas.h */
void vita_canvas_read_pixels(struct vita_canvas *c, int x, int y,
			     int w, int h, unsigned char *out)
{
	struct vita_canvas_image img;
	int row, col;

	if (out == NULL || w <= 0 || h <= 0) {
		return;
	}

	memset(out, 0, (size_t) (w * h * 4));
	if (vita_canvas_as_image(c, &img) == false) {
		return;
	}

	for (row = 0; row < h; row++) {
		for (col = 0; col < w; col++) {
			unsigned int px[4];
			unsigned char *dst = out + (row * w + col) * 4;

			canvas_sample(&img, x + col, y + row, px);
			dst[0] = (unsigned char) px[0];
			dst[1] = (unsigned char) px[1];
			dst[2] = (unsigned char) px[2];
			dst[3] = (unsigned char) px[3];
		}
	}
}


/* exported function documented in canvas.h */
void vita_canvas_write_pixels(struct vita_canvas *c, const unsigned char *in,
			      int in_w, int in_h, int sx, int sy,
			      int sw, int sh, int dx, int dy)
{
	int ro = 0, go = 1, bo = 2, ao = 3;
	int row, col;

	if (c == NULL || in == NULL || in_w <= 0 || in_h <= 0) {
		return;
	}

	canvas_channel_shifts(&ro, &go, &bo, &ao);

	for (row = 0; row < sh; row++) {
		int src_y = sy + row;
		int dst_y = dy + row;

		if (src_y < 0 || src_y >= in_h ||
		    dst_y < 0 || dst_y >= c->height) {
			continue;
		}
		for (col = 0; col < sw; col++) {
			int src_x = sx + col;
			int dst_x = dx + col;
			const unsigned char *src;
			unsigned char *dst;

			if (src_x < 0 || src_x >= in_w ||
			    dst_x < 0 || dst_x >= c->width) {
				continue;
			}
			src = in + (src_y * in_w + src_x) * 4;
			dst = c->pixels + dst_y * c->stride + dst_x * 4;

			/* putImageData replaces, it does not blend */
			if (bitmap_fmt.pma) {
				unsigned int a = src[3];

				dst[ro] = (unsigned char) (src[0] * a / 255);
				dst[go] = (unsigned char) (src[1] * a / 255);
				dst[bo] = (unsigned char) (src[2] * a / 255);
			} else {
				dst[ro] = src[0];
				dst[go] = src[1];
				dst[bo] = src[2];
			}
			dst[ao] = src[3];
		}
	}
}
