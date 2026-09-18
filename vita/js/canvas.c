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
#include <string.h>

#include <dom/dom.h>

#include "utils/corestrings.h"
#include "utils/errors.h"
#include "utils/log.h"
#include "netsurf/bitmap.h"
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
			NSLOG(netsurf, INFO,
			      "canvas %dx%d refused, %u KB already taken",
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
			      uint32_t rgba, bool evenodd)
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
					coverage[px] += (unsigned int)
						(part * 255.0 / CANVAS_SUBS);
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
			if (cov > 255) {
				cov = 255;
			}
			canvas_blend(c->pixels + row * c->stride + i * 4,
				     rgba, cov, ro, go, bo, ao);
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
			   const int *counts, int nsub, uint32_t rgba,
			   bool evenodd)
{
	struct canvas_edges edges = { NULL, 0, 0 };
	int sub, i, at = 0;

	if (c == NULL || pts == NULL || counts == NULL || nsub <= 0) {
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
	canvas_fill_edges(c, &edges, rgba, evenodd);
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
			     const int *counts, int nsub, uint32_t rgba,
			     double line_width)
{
	struct canvas_edges edges = { NULL, 0, 0 };
	double half = line_width / 2;
	int sub, i, at = 0;

	if (c == NULL || pts == NULL || counts == NULL || nsub <= 0) {
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
	canvas_fill_edges(c, &edges, rgba, false);
}
