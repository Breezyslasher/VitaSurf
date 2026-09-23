/*
 * libnsfb surface for the PlayStation Vita.
 *
 * NetSurf plots into a cached shadow buffer in main memory. Each damaged
 * rectangle reported through nsfb_update() is copied into a GPU texture
 * that covers the screen, and the texture is drawn through libvita2d
 * whenever something changed. The GPU is involved only so that system
 * dialogs (the IME keyboard) can composite over the page: they refuse to
 * start unless GXM is initialised, and they render through the common
 * dialog update each frame.
 *
 * Input is polled from the controller and the front touch panel. Buttons
 * become libnsfb key events (see vita_surface.h for the codes), the right
 * stick moves the pointer, a touch tap clicks, and the sticks and touch
 * drags are exposed through vita_surface_read_input() for the input layer
 * in vita/input/ to turn into smooth scrolling. The input layer also asks
 * for a focus rectangle to be drawn over the display.
 *
 * This file is compiled by CMake against libnsfb's internal headers; it is
 * not part of the libnsfb build. It registers itself with libnsfb through
 * NSFB_SURFACE_DEF, which runs as a constructor before main().
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <psp2/ctrl.h>
#include <psp2/gxm.h>
#include <psp2/kernel/cpu.h>
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/threadmgr.h>
#include <psp2/touch.h>

#include <vita2d.h>
#ifdef __ARM_NEON
#include <arm_neon.h>
#endif

#include "libnsfb.h"
#include "libnsfb_event.h"
#include "libnsfb_plot.h"
#include "libnsfb_plot_util.h"

#include "nsfb.h"
#include "surface.h"
#include "plot.h"
#include "cursor.h"

#include "vita_platform.h"
#include "vita_surface.h"

#define SCREEN_WIDTH   VITASURF_SCREEN_WIDTH
#define SCREEN_HEIGHT  VITASURF_SCREEN_HEIGHT
#define SCREEN_BPP     32

/* During a long redraw, show progress at least this often (microseconds). */
#define PRESENT_INTERVAL_US 100000

/* Input polling period while waiting for events, in microseconds. */
#define POLL_INTERVAL_US 8000

/*
 * How long must have passed before the screen is put up again.
 *
 * The screen goes up this often whether or not the page changed, the
 * way the machine's own browser does, rather than only when something
 * moved. Presenting on change alone is less work and less power, but
 * it makes every frame land wherever the change happened to fall
 * against the refresh, which reads as motion that will not settle.
 *
 * It is one refresh less one poll, not one refresh. The loop can only
 * present when it wakes, and it wakes every POLL_INTERVAL_US: asking
 * for a full 16.6 ms meant the poll at 16 ms was turned away and the
 * one at 24 ms let through, so a still page sat at 42 frames a second
 * instead of 60. Allowing a poll that lands just short of the refresh
 * puts it back on the 16 ms one. Going up is not a risk: the swap
 * waits for the vertical blank, so 60 is the ceiling either way.
 */
#define FRAME_INTERVAL_US (16600 - POLL_INTERVAL_US)

/* Held D-pad buttons repeat after this delay, then at this rate (ms). */
#define REPEAT_DELAY_MS  400
#define REPEAT_RATE_MS   60

/* Analogue sticks: dead zone out of 0..255 around 128. */
#define STICK_DEADZONE   40

/* Right stick pointer speed at full deflection, pixels per second. */
#define POINTER_SPEED    700

/* A touch that moves further than this (pixels) is a drag, not a tap. */
#define DRAG_THRESHOLD   12

/* Focus rectangle overlay: outline thickness and colour (A8B8G8R8). */
#define FOCUS_THICKNESS  3
#define FOCUS_COLOUR     0xFFFF862Eu

#define EVENT_QUEUE_LEN  64

/*
 * The busy overlay. When the main thread has not come back to the input
 * loop for BUSY_AFTER_US -- a script, a layout or a style pass running
 * long -- a thread on another core puts the last picture of the page
 * back up every BUSY_FRAME_US with a spinner over it, and reads Circle
 * as a request to stop the running script.
 */
#define BUSY_AFTER_US    400000
#define BUSY_FRAME_US    50000
#define BUSY_STACK_SIZE  (32 * 1024)
/* a little ahead of the main thread (0x10000100), should they share */
#define BUSY_PRIORITY    (0x10000100 - 10)

/* Claims and updates logged when verbose, before going quiet. */
#define DIAG_BOXES       200

struct vita_surface {
	vita2d_texture *tex;      /**< screen-sized texture the page is copied into */
	uint32_t *display;        /**< texture pixels */
	int stride;               /**< texture row length in pixels */
	bool dirty;               /**< texture changed since the last present */
	unsigned int presents;    /**< screens put up since last counted */
	unsigned int blits;       /**< boxes copied since last counted */
	unsigned long long blit_px; /**< pixels in them */
	unsigned long long wait_us; /**< time spent letting the GPU go */
	bool gpu_reading;         /**< the GPU has not finished with the texture */
	SceUInt64 last_present_us;
	bool dialog;              /**< a system dialog is on screen */
	bool hold_progress;       /**< do not present part way through a redraw */
	bool resync_buttons;      /**< forget button state after a dialog */

	/* event queue, filled by polling and drained by vita_input() */
	nsfb_event_t queue[EVENT_QUEUE_LEN];
	int qhead;
	int qtail;

	/* controller state */
	unsigned int buttons;     /**< buttons held at the last poll */
	unsigned int repeat_mask; /**< D-pad button currently repeating */
	SceUInt64 repeat_due_us;  /**< when the next repeat fires */
	SceUInt64 last_poll_us;   /**< time of the previous poll */
	int lx, ly, rx, ry;       /**< sticks after the dead zone, -127..127 */
	int pointer_acc_x;        /**< right stick sub-pixel movement, 16.16 */
	int pointer_acc_y;

	/* touch state */
	bool touch_down;
	bool touch_dragging;
	int touch_start_x;        /**< where the touch began */
	int touch_start_y;
	int touch_x;              /**< last reported position */
	int touch_y;
	int drag_dx;              /**< drag movement since the last read */
	int drag_dy;

	/* last pointer position handed to NetSurf */
	int pointer_x;
	int pointer_y;

	SceUInt64 last_tap_us;    /**< when the last tap was queued */

	/* focus rectangle overlay, screen coordinates, valid when set */
	bool focus_valid;
	nsfb_bbox_t focus;

	/*
	 * The busy overlay (see BUSY_AFTER_US). gpu_lock is held by
	 * whichever thread is using the GPU or writing the texture; the
	 * overlay thread only ever tries for it, so it never holds the
	 * page up. beat_us is when the main thread last came round the
	 * input loop.
	 */
	SceUID gpu_lock;
	SceUID busy_thread;
	volatile uint32_t beat_ms;    /**< 32 bits: read whole on ARMv7 */
	volatile bool busy_quit;
	volatile bool busy_shown;     /**< the overlay is on screen */
	volatile bool swallow_circle; /**< Circle was the overlay's */
	volatile unsigned int busy_frames;
	volatile unsigned int busy_cancels;
	uint32_t busy_seen_frames;    /**< main thread: frames already told */
	vita2d_texture *busy_label;

	/* diagnostics: claim and update boxes are logged only when the
	 * verbose flag file exists, and only the first DIAG_BOXES of each */
	bool verbose;
	unsigned int updates;
	unsigned int claims;
};

/* Set by the overlay thread when Circle asks for the script to stop. */
static volatile int busy_cancel;

/* exported interface documented in vita_platform.h */
bool vita_busy_take_cancel(void)
{
	if (busy_cancel == 0) {
		return false;
	}
	busy_cancel = 0;
	return true;
}

static uint32_t now_ms32(void)
{
	return (uint32_t)(sceKernelGetProcessTimeWide() / 1000);
}

/* ------------------------------------------------------------------------ */
/* Event queue                                                              */

static void queue_event(struct vita_surface *vs, const nsfb_event_t *event)
{
	int next = (vs->qtail + 1) % EVENT_QUEUE_LEN;

	if (next == vs->qhead) {
		return; /* full: drop, NetSurf will catch up on the next poll */
	}
	vs->queue[vs->qtail] = *event;
	vs->qtail = next;
}

static bool dequeue_event(struct vita_surface *vs, nsfb_event_t *event)
{
	if (vs->qhead == vs->qtail) {
		return false;
	}
	*event = vs->queue[vs->qhead];
	vs->qhead = (vs->qhead + 1) % EVENT_QUEUE_LEN;
	return true;
}

static void queue_key(struct vita_surface *vs, enum nsfb_event_type_e type,
		      enum nsfb_key_code_e key)
{
	nsfb_event_t event;

	memset(&event, 0, sizeof(event));
	event.type = type;
	event.value.keycode = key;
	queue_event(vs, &event);
}

static void queue_move(struct vita_surface *vs, int x, int y)
{
	nsfb_event_t event;

	if (x < 0) x = 0;
	if (y < 0) y = 0;
	if (x >= SCREEN_WIDTH) x = SCREEN_WIDTH - 1;
	if (y >= SCREEN_HEIGHT) y = SCREEN_HEIGHT - 1;

	vs->pointer_x = x;
	vs->pointer_y = y;

	memset(&event, 0, sizeof(event));
	event.type = NSFB_EVENT_MOVE_ABSOLUTE;
	event.value.vector.x = x;
	event.value.vector.y = y;
	event.value.vector.z = 0;
	queue_event(vs, &event);
}

static void queue_control(struct vita_surface *vs, enum nsfb_control_e code)
{
	nsfb_event_t event;

	memset(&event, 0, sizeof(event));
	event.type = NSFB_EVENT_CONTROL;
	event.value.controlcode = code;
	queue_event(vs, &event);
}

/* ------------------------------------------------------------------------ */
/* Input                                                                    */

/*
 * Buttons become key events. D-pad buttons and the triggers repeat while
 * held. What each key does is decided in vita/input/vita_input.c.
 */
static const struct {
	unsigned int button;
	enum nsfb_key_code_e key;
	bool repeats;
} button_map[] = {
	{ SCE_CTRL_UP,       VITA_KEY_UP,       true  },
	{ SCE_CTRL_DOWN,     VITA_KEY_DOWN,     true  },
	{ SCE_CTRL_LEFT,     VITA_KEY_LEFT,     true  },
	{ SCE_CTRL_RIGHT,    VITA_KEY_RIGHT,    true  },
	{ SCE_CTRL_CROSS,    VITA_KEY_CROSS,    false },
	{ SCE_CTRL_CIRCLE,   VITA_KEY_CIRCLE,   false },
	{ SCE_CTRL_TRIANGLE, VITA_KEY_TRIANGLE, false },
	{ SCE_CTRL_SQUARE,   VITA_KEY_SQUARE,   false },
	{ SCE_CTRL_LTRIGGER, VITA_KEY_L,        false },
	{ SCE_CTRL_RTRIGGER, VITA_KEY_R,        false },
	{ SCE_CTRL_SELECT,   VITA_KEY_SELECT,   false },
	{ SCE_CTRL_START,    VITA_KEY_START,    false },
};

/** Map a raw 0..255 stick axis to -127..127 with a dead zone. */
static int stick_axis(unsigned int raw)
{
	int v = (int)raw - 128;

	if (v > -STICK_DEADZONE && v < STICK_DEADZONE) {
		return 0;
	}
	/* rescale so the edge of the dead zone is 0 and full deflection 127 */
	if (v < 0) {
		v = (v + STICK_DEADZONE) * 127 / (128 - STICK_DEADZONE);
		return v < -127 ? -127 : v;
	}
	v = (v - STICK_DEADZONE) * 127 / (127 - STICK_DEADZONE);
	return v > 127 ? 127 : v;
}

static void poll_buttons(struct vita_surface *vs, SceUInt64 now_us)
{
	SceCtrlData pad;
	unsigned int pressed;
	unsigned int released;
	unsigned int i;
	int elapsed_us;

	memset(&pad, 0, sizeof(pad));
	if (sceCtrlPeekBufferPositive(0, &pad, 1) < 0) {
		return;
	}
	/* a Circle press that stopped a script is not also a keypress */
	if (vs->swallow_circle) {
		if ((pad.buttons & SCE_CTRL_CIRCLE) == 0) {
			vs->swallow_circle = false;
		}
		pad.buttons &= ~(unsigned int)SCE_CTRL_CIRCLE;
	}

	elapsed_us = (int)(now_us - vs->last_poll_us);
	if (vs->last_poll_us == 0 || elapsed_us < 0 || elapsed_us > 100000) {
		elapsed_us = POLL_INTERVAL_US;
	}
	vs->last_poll_us = now_us;

	if (vs->resync_buttons) {
		/* the button that closed a dialog must not act on the page */
		vs->resync_buttons = false;
		vs->buttons = pad.buttons;
		vs->repeat_mask = 0;
		vs->touch_down = false;
		vs->touch_dragging = false;
		return;
	}

	pressed = pad.buttons & ~vs->buttons;
	released = vs->buttons & ~pad.buttons;
	vs->buttons = pad.buttons;

	/* Select and Start together quit. */
	if ((pad.buttons & (SCE_CTRL_SELECT | SCE_CTRL_START)) ==
	    (SCE_CTRL_SELECT | SCE_CTRL_START)) {
		queue_control(vs, NSFB_CONTROL_QUIT);
		return;
	}

	for (i = 0; i < sizeof(button_map) / sizeof(button_map[0]); i++) {
		if (pressed & button_map[i].button) {
			queue_key(vs, NSFB_EVENT_KEY_DOWN, button_map[i].key);
			if (button_map[i].repeats) {
				vs->repeat_mask = button_map[i].button;
				vs->repeat_due_us = now_us + REPEAT_DELAY_MS * 1000;
			}
		}
		if (released & button_map[i].button) {
			queue_key(vs, NSFB_EVENT_KEY_UP, button_map[i].key);
			if (vs->repeat_mask == button_map[i].button) {
				vs->repeat_mask = 0;
			}
		}
	}

	/* key repeat for the held D-pad button */
	if (vs->repeat_mask != 0 && (pad.buttons & vs->repeat_mask) &&
	    now_us >= vs->repeat_due_us) {
		for (i = 0; i < sizeof(button_map) / sizeof(button_map[0]); i++) {
			if (button_map[i].button == vs->repeat_mask) {
				queue_key(vs, NSFB_EVENT_KEY_DOWN, button_map[i].key);
				queue_key(vs, NSFB_EVENT_KEY_UP, button_map[i].key);
			}
		}
		vs->repeat_due_us = now_us + REPEAT_RATE_MS * 1000;
	}

	/* sticks: the left one is read by the input layer for scrolling */
	vs->lx = stick_axis(pad.lx);
	vs->ly = stick_axis(pad.ly);
	vs->rx = stick_axis(pad.rx);
	vs->ry = stick_axis(pad.ry);

	/* the right stick moves the pointer, with sub-pixel accumulation */
	if (vs->rx != 0 || vs->ry != 0) {
		int dx, dy;

		/* 16.16 fixed point pixels: speed * deflection * seconds */
		vs->pointer_acc_x += (int)((int64_t)vs->rx * POINTER_SPEED *
					   65536 / 127 * elapsed_us / 1000000);
		vs->pointer_acc_y += (int)((int64_t)vs->ry * POINTER_SPEED *
					   65536 / 127 * elapsed_us / 1000000);
		dx = vs->pointer_acc_x / 65536;
		dy = vs->pointer_acc_y / 65536;
		if (dx != 0 || dy != 0) {
			vs->pointer_acc_x -= dx * 65536;
			vs->pointer_acc_y -= dy * 65536;
			queue_move(vs, vs->pointer_x + dx, vs->pointer_y + dy);
		}
	} else {
		vs->pointer_acc_x = 0;
		vs->pointer_acc_y = 0;
	}
}

/*
 * Touch: a tap (press and release without moving) is a click at the
 * touch point; moving the finger is a drag that scrolls the page, which
 * the input layer reads as deltas. Drags never reach NetSurf as mouse
 * movement, so they do not start text selections.
 */
static void poll_touch(struct vita_surface *vs)
{
	SceTouchData touch;

	memset(&touch, 0, sizeof(touch));
	if (sceTouchPeek(SCE_TOUCH_PORT_FRONT, &touch, 1) < 0) {
		return;
	}

	if (touch.reportNum > 0) {
		/* the front panel reports at twice the screen resolution */
		int x = touch.report[0].x / 2;
		int y = touch.report[0].y / 2;

		if (!vs->touch_down) {
			vs->touch_down = true;
			vs->touch_dragging = false;
			vs->touch_start_x = x;
			vs->touch_start_y = y;
			vs->touch_x = x;
			vs->touch_y = y;
		} else if (x != vs->touch_x || y != vs->touch_y) {
			if (!vs->touch_dragging &&
			    (abs(x - vs->touch_start_x) > DRAG_THRESHOLD ||
			     abs(y - vs->touch_start_y) > DRAG_THRESHOLD)) {
				vs->touch_dragging = true;
				/* include the movement that crossed the threshold */
				vs->drag_dx += x - vs->touch_start_x;
				vs->drag_dy += y - vs->touch_start_y;
			} else if (vs->touch_dragging) {
				vs->drag_dx += x - vs->touch_x;
				vs->drag_dy += y - vs->touch_y;
			}
			vs->touch_x = x;
			vs->touch_y = y;
		}
	} else if (vs->touch_down) {
		vs->touch_down = false;
		if (!vs->touch_dragging) {
			/* a tap: move the pointer there and click */
			vs->last_tap_us = sceKernelGetProcessTimeWide();
			queue_move(vs, vs->touch_start_x, vs->touch_start_y);
			queue_key(vs, NSFB_EVENT_KEY_DOWN, NSFB_KEY_MOUSE_1);
			queue_key(vs, NSFB_EVENT_KEY_UP, NSFB_KEY_MOUSE_1);
		}
		vs->touch_dragging = false;
	}
}

static void poll_input(struct vita_surface *vs)
{
	SceUInt64 now_us = sceKernelGetProcessTimeWide();

	/* the dialog owns the controls while it is up */
	if (vs->dialog) {
		vs->resync_buttons = true;
		return;
	}
	poll_buttons(vs, now_us);
	poll_touch(vs);
}

/* ------------------------------------------------------------------------ */
/* Display                                                                  */

/* The one surface instance, for the vita_surface_* entry points. */
static nsfb_t *the_nsfb;

/**
 * Draw the part of the focus rectangle outline that falls inside area,
 * directly into the display buffer. area is already clipped to the screen.
 */
static void draw_focus_overlay(struct vita_surface *vs, const nsfb_bbox_t *area)
{
	int x, y;

	for (y = area->y0; y < area->y1; y++) {
		uint32_t *row;
		bool edge_row;

		if (y < vs->focus.y0 || y >= vs->focus.y1) {
			continue;
		}
		edge_row = (y < vs->focus.y0 + FOCUS_THICKNESS) ||
			   (y >= vs->focus.y1 - FOCUS_THICKNESS);
		row = vs->display + y * vs->stride;
		for (x = area->x0; x < area->x1; x++) {
			if (x < vs->focus.x0 || x >= vs->focus.x1) {
				continue;
			}
			if (edge_row ||
			    x < vs->focus.x0 + FOCUS_THICKNESS ||
			    x >= vs->focus.x1 - FOCUS_THICKNESS) {
				row[x] = FOCUS_COLOUR;
			}
		}
	}
}

/* The GPU and the texture, between the main thread and the overlay. */
static void gpu_lock(struct vita_surface *vs)
{
	if (vs->gpu_lock >= 0) {
		sceKernelLockMutex(vs->gpu_lock, 1, NULL);
	}
}

static void gpu_unlock(struct vita_surface *vs)
{
	if (vs->gpu_lock >= 0) {
		sceKernelUnlockMutex(vs->gpu_lock, 1);
	}
}

/**
 * Wait for the GPU to finish with the texture, if it has not already.
 *
 * Presenting used to wait here and then return, which parked the CPU for
 * whatever was left of the frame -- and on this machine that time is
 * wanted for laying out the page, running its scripts and reading the
 * network. The wait belongs where the texture is next written instead,
 * so the two run side by side and the wait is usually over before
 * anything asks for it.
 */
static void gpu_release_texture(struct vita_surface *vs)
{
	if (vs->gpu_reading) {
		/*
		 * Timed, because presenting every refresh means the GPU
		 * has more often only just started reading when the next
		 * blit wants to write, and this is where that would show.
		 */
		SceUInt64 t0 = sceKernelGetProcessTimeWide();

		vita2d_wait_rendering_done();
		vs->wait_us += sceKernelGetProcessTimeWide() - t0;
		vs->gpu_reading = false;
	}
}

/**
 * Copy one row, forcing every pixel opaque.
 *
 * libnsfb leaves the top byte of every pixel zero and vita2d draws with
 * source-alpha blending, so the alpha has to be put back or the page
 * never reaches the screen. A full screen is half a million pixels, so
 * this goes four at a time where the hardware allows it.
 */
static inline void blit_row(uint32_t *restrict d,
			    const uint32_t *restrict s, int n)
{
	int x = 0;

#ifdef __ARM_NEON
	{
		const uint32x4_t opaque = vdupq_n_u32(0xFF000000u);

		for (; x + 4 <= n; x += 4) {
			vst1q_u32(d + x, vorrq_u32(vld1q_u32(s + x), opaque));
		}
	}
#endif
	for (; x < n; x++) {
		d[x] = s[x] | 0xFF000000u;
	}
}

/** Copy a rectangle of the shadow buffer to the display buffer. */
static void blit_box(nsfb_t *nsfb, const nsfb_bbox_t *box)
{
	struct vita_surface *vs = nsfb->surface_priv;
	nsfb_bbox_t area = *box;
	nsfb_bbox_t screen;
	int y;
	int width;
	const uint8_t *src;
	uint32_t *dst;

	if (vs == NULL || vs->display == NULL || nsfb->ptr == NULL) {
		return;
	}

	screen.x0 = 0;
	screen.y0 = 0;
	screen.x1 = SCREEN_WIDTH;
	screen.y1 = SCREEN_HEIGHT;
	if (!nsfb_plot_clip(&screen, &area)) {
		return;
	}

	width = area.x1 - area.x0;
	if (width <= 0) {
		return;
	}

	vs->updates++;
	vs->blits++;
	vs->blit_px += (unsigned long long) width *
			(unsigned long long) (area.y1 - area.y0);
	if (vs->verbose && vs->updates <= DIAG_BOXES) {
		vita_log("surface: update %u box %d,%d-%d,%d (clipped %d,%d-%d,%d) pixel %08x",
			 vs->updates, box->x0, box->y0, box->x1, box->y1,
			 area.x0, area.y0, area.x1, area.y1,
			 (unsigned int)*(const uint32_t *)
				(nsfb->ptr + area.y0 * nsfb->linelen + area.x0 * 4));
	} else if (vs->verbose && vs->updates == DIAG_BOXES + 1) {
		vita_log("surface: further updates not logged");
	}

	gpu_lock(vs);
	/* the GPU may still be reading what is about to be overwritten */
	gpu_release_texture(vs);

	src = nsfb->ptr + area.y0 * nsfb->linelen + area.x0 * 4;
	dst = vs->display + area.y0 * vs->stride + area.x0;
	for (y = area.y0; y < area.y1; y++) {
		blit_row(dst, (const uint32_t *)(const void *)src, width);
		src += nsfb->linelen;
		dst += vs->stride;
	}

	if (vs->focus_valid && nsfb_plot_bbox_intersect(&area, &vs->focus)) {
		draw_focus_overlay(vs, &area);
	}
	vs->dirty = true;
	gpu_unlock(vs);
}

/**
 * Put the texture on screen.
 *
 * At once when the page changed, so a keypress is not held back, and
 * otherwise once a refresh so the picture is paced by the screen
 * rather than by whatever last happened to move. Swapping waits for
 * the vertical blank, so this is only called from the input loop and,
 * during long redraws, from vita_update() at a limited rate.
 *
 * \return true if the screen was put up.
 */
static bool present(struct vita_surface *vs)
{
	SceUInt64 now;

	if (vs->tex == NULL) {
		return false;
	}
	now = sceKernelGetProcessTimeWide();
	vs->beat_ms = (uint32_t)(now / 1000);
	if (!vs->dirty && !vs->dialog &&
	    now - vs->last_present_us < FRAME_INTERVAL_US) {
		return false;
	}
	gpu_lock(vs);
	vita2d_start_drawing();
	vita2d_draw_texture(vs->tex, 0.0f, 0.0f);
	vita2d_end_drawing();
	if (vs->dialog) {
		vita2d_common_dialog_update();
	}
	vita2d_swap_buffers();
	/* the GPU now reads the texture; the next write waits, not this */
	vs->gpu_reading = true;
	vs->dirty = false;
	vs->busy_shown = false;
	vs->presents++;
	vs->last_present_us = sceKernelGetProcessTimeWide();
	gpu_unlock(vs);

	return true;
}


/* ------------------------------------------------------------------------ */
/* Busy overlay                                                             */

/*
 * A page that runs a script for twenty seconds used to leave the screen
 * exactly as it was, with nothing moving and nothing to press: the main
 * thread runs NetSurf, its scripts and its input in turn, and was in the
 * script. This thread sits on another core and watches for the main
 * thread not coming back round the input loop. When it has been away
 * BUSY_AFTER_US, the thread puts the page's last picture up again with a
 * spinner and a label over it, drawn by the GPU on top of the texture so
 * nothing needs cleaning up afterwards: the main thread's next present
 * draws the texture alone. Circle then asks the running script to stop,
 * through the same interrupt check that enforces the time budget.
 *
 * The overlay only ever tries for the GPU lock, so the page never waits
 * on it, and it touches nothing of NetSurf's. It does not log: the log
 * is the main thread's, which says what happened once it is back.
 */

/* 5x7 glyphs for the label, a bit per pixel, top row first, MSB left */
static const struct {
	char c;
	uint8_t rows[7];
} busy_glyphs[] = {
	{ 'W', { 0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A } },
	{ 'O', { 0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E } },
	{ 'R', { 0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11 } },
	{ 'K', { 0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11 } },
	{ 'I', { 0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E } },
	{ 'N', { 0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11 } },
	{ 'G', { 0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F } },
	{ 'S', { 0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E } },
	{ 'T', { 0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04 } },
	{ 'P', { 0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10 } },
	{ 'C', { 0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E } },
	{ '.', { 0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C } },
};

/* The label, and where the circle symbol goes in it (glyph cells). */
static const char busy_text[] = "WORKING.   STOP SCRIPT";
#define BUSY_CIRCLE_CELL 10
#define BUSY_SCALE       2
#define BUSY_CELL        (6 * BUSY_SCALE)
#define BUSY_LABEL_W     ((int)(sizeof(busy_text) - 1) * BUSY_CELL)
#define BUSY_LABEL_H     (7 * BUSY_SCALE)

/** Render the label into a texture once, white on clear. */
static vita2d_texture *busy_make_label(void)
{
	vita2d_texture *t = vita2d_create_empty_texture_format(
		BUSY_LABEL_W, BUSY_LABEL_H, SCE_GXM_TEXTURE_FORMAT_A8B8G8R8);
	uint32_t *px;
	int stride, i;

	if (t == NULL) {
		return NULL;
	}
	px = vita2d_texture_get_datap(t);
	stride = (int)vita2d_texture_get_stride(t) / 4;
	memset(px, 0, (size_t)stride * BUSY_LABEL_H * 4);
	for (i = 0; busy_text[i] != '\0'; i++) {
		unsigned int g;

		for (g = 0; g < sizeof(busy_glyphs) / sizeof(busy_glyphs[0]);
		     g++) {
			int row, col;

			if (busy_glyphs[g].c != busy_text[i]) {
				continue;
			}
			for (row = 0; row < 7 * BUSY_SCALE; row++) {
				uint8_t bits = busy_glyphs[g].rows[row /
								   BUSY_SCALE];

				for (col = 0; col < 5 * BUSY_SCALE; col++) {
					if (bits & (0x10 >> (col / BUSY_SCALE))) {
						px[row * stride + i * BUSY_CELL +
						   col] = 0xFFFFFFFFu;
					}
				}
			}
			break;
		}
	}
	return t;
}

/** One frame of the overlay: the page as it was, and the panel. */
static void busy_draw(struct vita_surface *vs, uint32_t t_ms)
{
	const float pw = (float)(BUSY_LABEL_W + 64), ph = 44.0f;
	const float px = (float)SCREEN_WIDTH - pw - 12.0f;
	const float py = (float)SCREEN_HEIGHT - ph - 30.0f;
	int i, lit = (int)((t_ms / 100u) % 8u);

	vita2d_start_drawing();
	vita2d_draw_texture(vs->tex, 0.0f, 0.0f);
	vita2d_draw_rectangle(px, py, pw, ph, 0xD0202020u);
	/* spinner: eight dots, one bright, going round */
	for (i = 0; i < 8; i++) {
		static const float dx[8] = { 0, 7, 10, 7, 0, -7, -10, -7 };
		static const float dy[8] = { -10, -7, 0, 7, 10, 7, 0, -7 };
		int age = (lit - i + 8) % 8;
		unsigned int a = age == 0 ? 0xFF : age < 3 ? 0xA0 : 0x50;

		vita2d_draw_fill_circle(px + 24.0f + dx[i], py + ph / 2 + dy[i],
					2.5f, (a << 24) | 0x00FFFFFFu);
	}
	if (vs->busy_label != NULL) {
		float lx = px + 46.0f, ly = py + (ph - BUSY_LABEL_H) / 2;
		float cx = lx + (float)(BUSY_CIRCLE_CELL * BUSY_CELL) + 5.0f;

		vita2d_draw_texture(vs->busy_label, lx, ly);
		/* the Circle button's symbol, in its colour */
		vita2d_draw_fill_circle(cx, ly + BUSY_LABEL_H / 2, 8.0f,
					0xFF4040E0u);
		vita2d_draw_fill_circle(cx, ly + BUSY_LABEL_H / 2, 5.5f,
					0xFF202020u);
	}
	vita2d_end_drawing();
	vita2d_swap_buffers();
}

static int busy_thread_main(SceSize args, void *argp)
{
	struct vita_surface *vs = *(struct vita_surface **)argp;
	bool circle_was = true;	/* a press must start while we watch */

	(void)args;
	while (!vs->busy_quit) {
		uint32_t now = now_ms32();
		uint32_t away = now - vs->beat_ms;

		if (away < BUSY_AFTER_US / 1000 || vs->dialog ||
		    vs->hold_progress || vs->tex == NULL) {
			circle_was = true;
			sceKernelDelayThread(BUSY_FRAME_US);
			continue;
		}
		{
			SceCtrlData pad;
			bool circle;

			memset(&pad, 0, sizeof(pad));
			sceCtrlPeekBufferPositive(0, &pad, 1);
			circle = (pad.buttons & SCE_CTRL_CIRCLE) != 0;
			if (circle && !circle_was) {
				busy_cancel = 1;
				vs->swallow_circle = true;
				vs->busy_cancels++;
			}
			circle_was = circle;
		}
		if (sceKernelTryLockMutex(vs->gpu_lock, 1) >= 0) {
			/* the main thread may have come back meanwhile */
			if (now_ms32() - vs->beat_ms >= BUSY_AFTER_US / 1000) {
				busy_draw(vs, now);
				vs->gpu_reading = true;
				vs->busy_shown = true;
				vs->busy_frames++;
			}
			sceKernelUnlockMutex(vs->gpu_lock, 1);
		}
		sceKernelDelayThread(BUSY_FRAME_US);
	}
	return sceKernelExitDeleteThread(0);
}

/**
 * On the main thread, back in the input loop: forget a stale stop
 * request, have the page redrawn over the overlay, and say what the
 * overlay did while it was away.
 */
static void busy_resumed(struct vita_surface *vs)
{
	unsigned int frames = vs->busy_frames;

	busy_cancel = 0;
	if (vs->busy_shown) {
		vs->dirty = true;	/* the next present covers the panel */
	}
	if (frames != vs->busy_seen_frames) {
		vita_log("surface: the page held the screen; the busy overlay "
			 "put up %u frames and Circle stopped %u scripts so far",
			 frames - vs->busy_seen_frames,
			 (unsigned int)vs->busy_cancels);
		vs->busy_seen_frames = frames;
	}
}

static void busy_start(struct vita_surface *vs)
{
	static struct vita_surface *arg;
	int ret;

	vs->gpu_lock = sceKernelCreateMutex("vitasurf_gpu",
					    SCE_KERNEL_MUTEX_ATTR_RECURSIVE, 0,
					    NULL);
	if (vs->gpu_lock < 0) {
		vita_log("surface: no GPU lock (0x%08x), so no busy overlay",
			 (unsigned int)vs->gpu_lock);
		return;
	}
	vs->busy_label = busy_make_label();
	vs->beat_ms = now_ms32();
	arg = vs;
	/* its own core, and ahead of the main thread if they ever share */
	vs->busy_thread = sceKernelCreateThread("vitasurf_busy",
		busy_thread_main, BUSY_PRIORITY,
		BUSY_STACK_SIZE, 0, SCE_KERNEL_CPU_MASK_USER_2, NULL);
	if (vs->busy_thread < 0) {
		vita_log("surface: busy overlay thread not created (0x%08x)",
			 (unsigned int)vs->busy_thread);
		return;
	}
	ret = sceKernelStartThread(vs->busy_thread, sizeof(arg), &arg);
	if (ret < 0) {
		vita_log("surface: busy overlay thread not started (0x%08x)",
			 (unsigned int)ret);
		sceKernelDeleteThread(vs->busy_thread);
		vs->busy_thread = -1;
		return;
	}
	vita_log("surface: busy overlay after %u ms away, on core 2, "
		 "%u KB stack", (unsigned int)(BUSY_AFTER_US / 1000),
		 (unsigned int)(BUSY_STACK_SIZE / 1024));
}

static void busy_stop(struct vita_surface *vs)
{
	if (vs->busy_thread >= 0) {
		SceUInt timeout = 500000;

		vs->busy_quit = true;
		sceKernelWaitThreadEnd(vs->busy_thread, NULL, &timeout);
		vs->busy_thread = -1;
	}
	if (vs->busy_label != NULL) {
		vita2d_free_texture(vs->busy_label);
		vs->busy_label = NULL;
	}
	if (vs->gpu_lock >= 0) {
		sceKernelDeleteMutex(vs->gpu_lock);
		vs->gpu_lock = -1;
	}
}

/* exported interface documented in vita_surface.h */
unsigned int vita_surface_take_presents(void)
{
	struct vita_surface *vs = the_nsfb != NULL ?
			the_nsfb->surface_priv : NULL;
	unsigned int n;

	if (vs == NULL) {
		return 0;
	}
	n = vs->presents;
	vs->presents = 0;
	return n;
}

/* exported interface documented in vita_surface.h */
void vita_surface_take_blits(unsigned int *boxes, unsigned int *kpixels,
			     unsigned int *wait_ms)
{
	struct vita_surface *vs = the_nsfb != NULL ?
			the_nsfb->surface_priv : NULL;

	if (vs == NULL) {
		*boxes = 0;
		*kpixels = 0;
		*wait_ms = 0;
		return;
	}
	*boxes = vs->blits;
	*kpixels = (unsigned int) (vs->blit_px / 1000);
	*wait_ms = (unsigned int) (vs->wait_us / 1000);
	vs->blits = 0;
	vs->blit_px = 0;
	vs->wait_us = 0;
}

/* ------------------------------------------------------------------------ */
/* Surface routines                                                         */

static int vita_defaults(nsfb_t *nsfb)
{
	nsfb->width = SCREEN_WIDTH;
	nsfb->height = SCREEN_HEIGHT;
	/* SceDisplay A8B8G8R8: red in the low byte, matching XBGR8888 */
	nsfb->format = NSFB_FMT_XBGR8888;

	select_plotters(nsfb);

	return 0;
}

static int vita_set_geometry(nsfb_t *nsfb, int width, int height,
			     enum nsfb_format_e format)
{
	/*
	 * The screen is fixed and the display is always XBGR (red in the low
	 * byte, which is also how NetSurf packs its colours). NetSurf asks
	 * for XRGB because it maps 32 bpp to that; the substitution only
	 * changes which software plotters libnsfb selects.
	 */
	(void)format;
	if (width != SCREEN_WIDTH || height != SCREEN_HEIGHT) {
		vita_log("surface: ignoring geometry %dx%d, screen is fixed",
			 width, height);
	}

	nsfb->width = SCREEN_WIDTH;
	nsfb->height = SCREEN_HEIGHT;
	nsfb->format = NSFB_FMT_XBGR8888;

	select_plotters(nsfb);

	return 0;
}

static int vita_initialise(nsfb_t *nsfb)
{
	struct vita_surface *vs;
	SceSize size;
	int ret;

	if (nsfb->surface_priv != NULL) {
		return -1;
	}

	vs = calloc(1, sizeof(*vs));
	if (vs == NULL) {
		return -1;
	}
	vs->gpu_lock = -1;
	vs->busy_thread = -1;

	/* GPU: libvita2d owns the display, the page lives in a texture */
	ret = vita2d_init();
	if (ret < 0) {
		vita_log("surface: vita2d_init failed: 0x%08x", (unsigned int)ret);
		free(vs);
		return -1;
	}
	vita2d_set_clear_color(0xFF000000u);
	vs->tex = vita2d_create_empty_texture_format(SCREEN_WIDTH, SCREEN_HEIGHT,
						     SCE_GXM_TEXTURE_FORMAT_A8B8G8R8);
	if (vs->tex == NULL) {
		vita_log("surface: cannot create the %dx%d screen texture",
			 SCREEN_WIDTH, SCREEN_HEIGHT);
		vita2d_fini();
		free(vs);
		return -1;
	}
	vs->display = vita2d_texture_get_datap(vs->tex);
	vs->stride = (int)vita2d_texture_get_stride(vs->tex) / 4;
	size = (SceSize)vs->stride * SCREEN_HEIGHT * (SCREEN_BPP / 8);
	memset(vs->display, 0, size);

	/* shadow buffer NetSurf plots into */
	nsfb->linelen = SCREEN_WIDTH * (SCREEN_BPP / 8);
	nsfb->ptr = calloc((size_t)SCREEN_HEIGHT, (size_t)nsfb->linelen);
	if (nsfb->ptr == NULL) {
		vita2d_free_texture(vs->tex);
		vita2d_fini();
		free(vs);
		return -1;
	}

	/* input */
	sceCtrlSetSamplingMode(SCE_CTRL_MODE_ANALOG);
	sceTouchSetSamplingState(SCE_TOUCH_PORT_FRONT,
				 SCE_TOUCH_SAMPLING_STATE_START);

	nsfb->surface_priv = vs;
	the_nsfb = nsfb;
	vs->verbose = vita_verbose_requested() != 0;

	/* start with the pointer over the page rather than the toolbar */
	queue_move(vs, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);

	/* show the cleared screen before NetSurf draws anything */
	vs->dirty = true;
	present(vs);

	busy_start(vs);

	vita_log("surface: %dx%d, screen texture %u KB, stride %d px",
		 SCREEN_WIDTH, SCREEN_HEIGHT, (unsigned int)size / 1024, vs->stride);

	return 0;
}

static int vita_finalise(nsfb_t *nsfb)
{
	struct vita_surface *vs = nsfb->surface_priv;

	if (vs == NULL) {
		return 0;
	}

	sceTouchSetSamplingState(SCE_TOUCH_PORT_FRONT,
				 SCE_TOUCH_SAMPLING_STATE_STOP);
	busy_stop(vs);

	free(nsfb->ptr);
	nsfb->ptr = NULL;

	gpu_release_texture(vs);
	vita2d_free_texture(vs->tex);
	vita2d_fini();
	free(vs);
	nsfb->surface_priv = NULL;
	the_nsfb = NULL;

	return 0;
}

/* ------------------------------------------------------------------------ */
/* Entry points for the input layer                                         */

void vita_surface_read_input(struct vita_input_state *out)
{
	struct vita_surface *vs;

	memset(out, 0, sizeof(*out));
	if (the_nsfb == NULL || the_nsfb->surface_priv == NULL) {
		return;
	}
	vs = the_nsfb->surface_priv;

	out->lx = vs->lx;
	out->ly = vs->ly;
	out->rx = vs->rx;
	out->ry = vs->ry;
	out->drag_dx = vs->drag_dx;
	out->drag_dy = vs->drag_dy;
	out->dragging = vs->touch_dragging;
	out->last_tap_us = vs->last_tap_us;
	vs->drag_dx = 0;
	vs->drag_dy = 0;
}

void vita_surface_hold_progress(bool hold)
{
	if (the_nsfb != NULL && the_nsfb->surface_priv != NULL) {
		((struct vita_surface *)the_nsfb->surface_priv)->hold_progress = hold;
	}
}

void vita_surface_request_quit(void)
{
	if (the_nsfb != NULL && the_nsfb->surface_priv != NULL) {
		queue_control(the_nsfb->surface_priv, NSFB_CONTROL_QUIT);
	}
}

void vita_surface_set_dialog(bool active)
{
	struct vita_surface *vs;

	if (the_nsfb == NULL || the_nsfb->surface_priv == NULL) {
		return;
	}
	vs = the_nsfb->surface_priv;
	if (vs->dialog != active) {
		vs->dialog = active;
		vs->dirty = true;
	}
}

void vita_surface_set_focus_rect(const nsfb_bbox_t *rect)
{
	struct vita_surface *vs;
	nsfb_bbox_t old;
	bool had_old;

	if (the_nsfb == NULL || the_nsfb->surface_priv == NULL) {
		return;
	}
	vs = the_nsfb->surface_priv;

	had_old = vs->focus_valid;
	old = vs->focus;

	if (rect == NULL) {
		vs->focus_valid = false;
	} else {
		vs->focus = *rect;
		vs->focus_valid = true;
	}

	/* restore what was under the old outline, then draw the new one */
	if (had_old) {
		blit_box(the_nsfb, &old);
	}
	if (vs->focus_valid) {
		blit_box(the_nsfb, &vs->focus);
	}
}

static bool vita_input(nsfb_t *nsfb, nsfb_event_t *event, int timeout)
{
	struct vita_surface *vs = nsfb->surface_priv;
	SceUInt64 deadline_us = 0;

	if (vs == NULL) {
		return false;
	}

	if (timeout > 0) {
		deadline_us = sceKernelGetProcessTimeWide() +
			(SceUInt64)timeout * 1000;
	}

	busy_resumed(vs);
	for (;;) {
		SceUInt64 now_us;
		SceUInt delay_us = POLL_INTERVAL_US;

		vs->beat_ms = now_ms32();
		poll_input(vs);
		present(vs);

		if (dequeue_event(vs, event)) {
			return true;
		}

		if (timeout == 0) {
			return false;
		}

		if (timeout > 0) {
			now_us = sceKernelGetProcessTimeWide();
			if (now_us >= deadline_us) {
				memset(event, 0, sizeof(*event));
				event->type = NSFB_EVENT_CONTROL;
				event->value.controlcode = NSFB_CONTROL_TIMEOUT;
				return true;
			}
			if (deadline_us - now_us < delay_us) {
				delay_us = (SceUInt)(deadline_us - now_us);
			}
		}

		/* keep the system from sleeping while pages are on screen */
		sceKernelPowerTick(SCE_KERNEL_POWER_TICK_DEFAULT);
		sceKernelDelayThread(delay_us);
	}
}

static int vita_claim(nsfb_t *nsfb, nsfb_bbox_t *box)
{
	struct nsfb_cursor_s *cursor = nsfb->cursor;
	struct vita_surface *vs = nsfb->surface_priv;

	if (vs != NULL) {
		vs->claims++;
		if (vs->verbose && vs->claims <= DIAG_BOXES) {
			vita_log("surface: claim %u box %d,%d-%d,%d",
				 vs->claims, box->x0, box->y0, box->x1, box->y1);
		}
	}

	if ((cursor != NULL) &&
	    (cursor->plotted == true) &&
	    (nsfb_plot_bbox_intersect(box, &cursor->loc))) {
		nsfb_cursor_clear(nsfb, cursor);
	}
	return 0;
}

static int vita_update(nsfb_t *nsfb, nsfb_bbox_t *box)
{
	struct nsfb_cursor_s *cursor = nsfb->cursor;
	struct vita_surface *vs = nsfb->surface_priv;

	if ((cursor != NULL) && (cursor->plotted == false)) {
		nsfb_cursor_plot(nsfb, cursor);
	}
	/* a redraw puts up its own progress: not a stall */
	if (vs != NULL) {
		vs->beat_ms = now_ms32();
	}

	blit_box(nsfb, box);

	if (vs != NULL && !vs->dialog && !vs->hold_progress &&
	    sceKernelGetProcessTimeWide() - vs->last_present_us > PRESENT_INTERVAL_US) {
		present(vs);
	}

	return 0;
}

static int vita_cursor(nsfb_t *nsfb, struct nsfb_cursor_s *cursor)
{
	nsfb_bbox_t redraw;
	nsfb_bbox_t fbarea;

	if ((cursor != NULL) && (cursor->plotted == true)) {
		nsfb_bbox_t loc_shift = cursor->loc;

		loc_shift.x0 -= cursor->hotspot_x;
		loc_shift.y0 -= cursor->hotspot_y;
		loc_shift.x1 -= cursor->hotspot_x;
		loc_shift.y1 -= cursor->hotspot_y;

		nsfb_plot_add_rect(&cursor->savloc, &loc_shift, &redraw);

		fbarea.x0 = 0;
		fbarea.y0 = 0;
		fbarea.x1 = nsfb->width;
		fbarea.y1 = nsfb->height;
		nsfb_plot_clip(&fbarea, &redraw);

		nsfb_cursor_clear(nsfb, cursor);
		nsfb_cursor_plot(nsfb, cursor);

		blit_box(nsfb, &redraw);
	}
	return true;
}

const nsfb_surface_rtns_t vita_rtns = {
	.defaults = vita_defaults,
	.initialise = vita_initialise,
	.finalise = vita_finalise,
	.input = vita_input,
	.claim = vita_claim,
	.update = vita_update,
	.cursor = vita_cursor,
	.geometry = vita_set_geometry,
};

NSFB_SURFACE_DEF(vita, NSFB_SURFACE_VITA, &vita_rtns)
