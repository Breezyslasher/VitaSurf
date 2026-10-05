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
#include <stdint.h>

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
	uint64_t last_tap_us; /**< process time of the last touch tap, 0 if none */
};

/**
 * Read the analogue and touch state. Drag deltas are reset to zero by the
 * read. Fills zeros if the surface is not initialised.
 */
void vita_surface_read_input(struct vita_input_state *out);

/**
 * Tell the surface a system dialog is on screen. While it is, the surface
 * presents every frame (dialogs composite through the GPU) and ignores
 * the controls, which the dialog owns.
 */
void vita_surface_set_dialog(bool active);

/**
 * While held, the surface presents only between event polls, never part
 * way through a redraw. Overlays that repaint themselves (the menu) hold
 * it so a half-drawn window is never shown.
 */
void vita_surface_hold_progress(bool hold);

/** Ask NetSurf to quit, as Select+Start does. */
void vita_surface_request_quit(void);

/**
 * How many times the screen has been put up since this was last asked.
 *
 * The frame loop reports its own rounds, but a round that draws
 * nothing changes nothing on screen: this is the number the eye sees,
 * and reading it resets the count.
 */
unsigned int vita_surface_take_presents(void);

/**
 * How much copying the surface has done since this was last asked.
 *
 * \param boxes    Updated with the number of boxes copied.
 * \param kpixels  Updated with the pixels in them, in thousands.
 * \param wait_ms  Updated with the time spent waiting for the GPU to
 *                 let go of the texture before writing to it.
 */
void vita_surface_take_blits(unsigned int *boxes, unsigned int *kpixels,
			     unsigned int *wait_ms);

/**
 * Time spent since the last call, within redraws, copying changed boxes
 * into the screen texture and putting screens up (VitaSurf): the part
 * of a frame's drawing that is not NetSurf's.
 */
void vita_surface_take_copy_times(unsigned int *copy_ms,
				  unsigned int *present_ms);

/**
 * Draw a focus rectangle over the display at screen coordinates, or clear
 * it with NULL. The rectangle is drawn by the GPU over the page each time
 * the screen is put up: NetSurf's own rendering is never touched.
 */
void vita_surface_set_focus_rect(const nsfb_bbox_t *rect);

/**
 * The part of the screen in view is about to be moved by (dx, dy)
 * through nsfb_plot_copy() (VitaSurf). The surface moves its picture on
 * the GPU instead, by reading the view's part of the screen texture
 * from an offset, so the copy's update is not written to the texture;
 * only what is drawn afterwards is. Call vita_surface_scroll_done()
 * after the copy.
 *
 * \return false when the move cannot be done that way: the copy is
 *         then written as usual, and scroll_done need not be called.
 */
bool vita_surface_scroll(const nsfb_bbox_t *view, int dx, int dy);

/** End a move vita_surface_scroll() started. */
void vita_surface_scroll_done(void);

/**
 * Scrolls moved on the GPU since the last call, the pixels those did not
 * have to copy, in thousands, and how often the texture had to be put
 * back in order because the view changed.
 */
void vita_surface_take_moves(unsigned int *moves, unsigned int *kpixels,
			     unsigned int *resets);

#endif
