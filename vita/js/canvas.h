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

struct dom_node;
struct vita_canvas;

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
 * \param rgba     the colour, 0xRRGGBBAA
 * \param evenodd  true for the even-odd rule, false for nonzero
 */
void vita_canvas_fill_path(struct vita_canvas *c, const double *pts,
			   const int *counts, int nsub, uint32_t rgba,
			   bool evenodd);

/**
 * Stroke the path, as a line of the given width.
 *
 * The subpaths are open unless the caller repeats the first point.
 */
void vita_canvas_stroke_path(struct vita_canvas *c, const double *pts,
			     const int *counts, int nsub, uint32_t rgba,
			     double line_width);

/** Tell the renderer the bitmap changed. */
void vita_canvas_finish(struct vita_canvas *c);

#endif
