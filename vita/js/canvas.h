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
 * A page draws its charts into a <canvas>, and NetSurf already paints
 * whatever bitmap the canvas element carries: this fills that bitmap in.
 * The engine hands over paths a script has built, already flattened to
 * line segments and in canvas pixels, and the rasteriser here fills or
 * strokes them.
 */

#ifndef VITASURF_CANVAS_H
#define VITASURF_CANVAS_H

#include <stdbool.h>
#include <stdint.h>

struct bitmap;
struct dom_node;
struct vita_canvas;

/** What a fill or a stroke lays down. */
enum vita_canvas_paint_kind {
	CANVAS_PAINT_SOLID = 0,
	CANVAS_PAINT_LINEAR = 1,
	CANVAS_PAINT_RADIAL = 2,
	CANVAS_PAINT_CONIC = 3
};

/** One colour stop of a gradient. */
struct vita_canvas_stop {
	double offset;		/**< 0 to 1 along the gradient */
	uint32_t rgba;		/**< 0xRRGGBBAA */
};

/**
 * A colour, or a gradient of them.
 *
 * The geometry is in canvas pixels: the context applies its transform
 * to a gradient's own coordinates before handing it over, the same way
 * it does to the points of a path.
 */
struct vita_canvas_paint {
	enum vita_canvas_paint_kind kind;
	uint32_t rgba;			/**< the colour, when solid */
	double x0, y0, r0;		/**< start point, and its radius */
	double x1, y1, r1;		/**< end point, and its radius */
	double angle;			/**< where a conic gradient starts */
	const struct vita_canvas_stop *stops;
	int n_stops;
};

/**
 * Pixels to draw from: another canvas, or an image the page has loaded.
 *
 * The channel offsets say where red, green, blue and alpha sit in each
 * four byte pixel, because a bitmap's layout is a build-time choice.
 */
struct vita_canvas_image {
	const unsigned char *pixels;
	int width;
	int height;
	int stride;			/**< bytes between rows */
	int ro, go, bo, ao;		/**< channel offsets */
	bool premultiplied;		/**< colours already scaled by alpha */
};

/**
 * The drawing surface of a canvas element, made if it has none yet.
 *
 * The bitmap is attached to the node the way NetSurf's own canvas
 * binding attaches it, so the renderer finds it without being told.
 * Asking again with a different size makes a new one.
 *
 * \param node    the CANVAS element
 * \param width   its width attribute in pixels
 * \param height  its height attribute in pixels
 * \return the surface, or NULL if it could not be made
 */
struct vita_canvas *vita_canvas_get(struct dom_node *node,
				    int width, int height);

/** How much memory every canvas on the page is holding, in bytes. */
unsigned int vita_canvas_bytes(void);

/** Make a rectangle transparent again. */
void vita_canvas_clear_rect(struct vita_canvas *c,
			    double x, double y, double w, double h);

/**
 * Fill the path.
 *
 * \param pts      x and y of every point, subpath after subpath
 * \param counts   how many points each subpath has
 * \param nsub     how many subpaths there are
 * \param paint    the colour or gradient to lay down
 * \param evenodd  true for the even-odd rule, false for nonzero
 */
void vita_canvas_fill_path(struct vita_canvas *c, const double *pts,
			   const int *counts, int nsub,
			   const struct vita_canvas_paint *paint,
			   bool evenodd);

/**
 * Stroke the path, as a line of the given width.
 *
 * The subpaths are open unless the caller repeats the first point.
 */
void vita_canvas_stroke_path(struct vita_canvas *c, const double *pts,
			     const int *counts, int nsub,
			     const struct vita_canvas_paint *paint,
			     double line_width);

/**
 * Draw a run of text, as fillText does.
 *
 * The glyphs come from the frontend's own font engine, so a canvas and
 * the page around it are drawn in the same typefaces.
 *
 * \param x, y      where the text goes, before alignment is applied
 * \param utf8, len the text
 * \param size_px   the font size in pixels
 * \param family    a plot_font_generic_family_t
 * \param weight    100 to 900, as CSS counts it
 * \param italic    true for an italic or oblique face
 * \param paint     the colour or gradient to lay down
 * \param align     0 left, 1 centre, 2 right
 * \param baseline  0 alphabetic, 1 top, 2 middle, 3 bottom
 */
void vita_canvas_text(struct vita_canvas *c, double x, double y,
		      const char *utf8, unsigned int len, double size_px,
		      int family, int weight, bool italic,
		      const struct vita_canvas_paint *paint,
		      int align, int baseline);

/**
 * How wide that run of text would be, in canvas pixels.
 *
 * Returns a rough guess when there is no font engine to ask.
 */
double vita_canvas_text_width(const char *utf8, unsigned int len,
			      double size_px, int family, int weight,
			      bool italic);

/**
 * Draw an image into the canvas.
 *
 * \param img     where the pixels come from
 * \param sx, sy  the top left of the part of the image to take
 * \param sw, sh  how much of the image to take
 * \param m       maps the unit square onto the destination in canvas
 *                pixels: the context's transform with the destination
 *                rectangle folded in, so a rotated drawImage works
 * \param alpha   globalAlpha, 0 to 1
 * \param smooth  true to sample between pixels, false to take the
 *                nearest one
 */
void vita_canvas_draw_image(struct vita_canvas *c,
			    const struct vita_canvas_image *img,
			    double sx, double sy, double sw, double sh,
			    const double *m, double alpha, bool smooth);

/**
 * Copy a rectangle of the canvas out, as getImageData wants it: bytes
 * in red, green, blue, alpha order with the alpha not multiplied in.
 *
 * Pixels outside the canvas come back transparent black, which is what
 * the specification asks for.
 *
 * \param out  w * h * 4 bytes to fill
 */
void vita_canvas_read_pixels(struct vita_canvas *c, int x, int y,
			     int w, int h, unsigned char *out);

/**
 * Put a rectangle of pixels back, replacing what was there.
 *
 * \param in            the source, in_w * in_h pixels, RGBA
 * \param sx, sy        the part of the source to take
 * \param sw, sh        how much of it
 * \param dx, dy        where it goes in the canvas
 */
void vita_canvas_write_pixels(struct vita_canvas *c, const unsigned char *in,
			      int in_w, int in_h, int sx, int sy,
			      int sw, int sh, int dx, int dy);

/** The canvas as an image, so one canvas can be drawn into another. */
bool vita_canvas_as_image(struct vita_canvas *c,
			  struct vita_canvas_image *img);

/** A NetSurf bitmap as an image, for drawing a loaded picture. */
bool vita_canvas_image_of_bitmap(struct bitmap *bitmap,
				 struct vita_canvas_image *img);

/** Tell the renderer the bitmap changed. */
void vita_canvas_finish(struct vita_canvas *c);

#endif
