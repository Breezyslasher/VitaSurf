/*
 * Interface between the libnsfb Vita surface (vita/surface/vita.c), which
 * polls the controller and touch panel, and the input layer
 * (vita/input/vita_input.c), which turns that into browser actions.
 *
 * Buttons are delivered to NetSurf as ordinary libnsfb key events using
 * the codes below, so the framebuffer frontend sees a keyboard. Analogue
 * sticks and touch drags are not key-shaped: the input layer reads them
 * from vita_surface_read_input() on a timer.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_SURFACE_H
#define VITASURF_SURFACE_H

#include <stdbool.h>

#include "libnsfb.h"
#include "libnsfb_event.h"

/* Button to key code mapping shared by the surface and the input layer. */
#define VITA_KEY_UP        NSFB_KEY_UP
#define VITA_KEY_DOWN      NSFB_KEY_DOWN
#define VITA_KEY_LEFT      NSFB_KEY_LEFT
#define VITA_KEY_RIGHT     NSFB_KEY_RIGHT
#define VITA_KEY_CROSS     NSFB_KEY_RETURN
#define VITA_KEY_CIRCLE    NSFB_KEY_ESCAPE
#define VITA_KEY_TRIANGLE  NSFB_KEY_F1
#define VITA_KEY_SQUARE    NSFB_KEY_F2
#define VITA_KEY_L         NSFB_KEY_F3
#define VITA_KEY_R         NSFB_KEY_F4
#define VITA_KEY_SELECT    NSFB_KEY_F5
#define VITA_KEY_START     NSFB_KEY_F6

struct vita_input_state {
	int lx;          /**< left stick, -127..127, 0 inside the dead zone */
	int ly;
	int rx;          /**< right stick */
	int ry;
	int drag_dx;     /**< touch drag movement since the last read, pixels */
	int drag_dy;
	bool dragging;   /**< a touch drag is in progress */
};

/**
 * Read the analogue and touch state. Drag deltas are reset to zero by the
 * read. Fills zeros if the surface is not initialised.
 */
void vita_surface_read_input(struct vita_input_state *out);

/**
 * Draw a focus rectangle over the display at screen coordinates, or clear
 * it with NULL. The rectangle is an overlay on the display buffer only:
 * NetSurf's own rendering is never touched, and it is re-applied whenever
 * NetSurf updates the area underneath.
 */
void vita_surface_set_focus_rect(const nsfb_bbox_t *rect);

#endif
