/*
 * libnsfb surface for the PlayStation Vita.
 *
 * NetSurf plots into a cached shadow buffer in main memory. Each damaged
 * rectangle reported through nsfb_update() is copied into a CDRAM display
 * buffer that SceDisplay scans out, so the screen is never uploaded whole
 * when nothing changed.
 *
 * Input is polled from the controller and the front touch panel and turned
 * into libnsfb events. The mapping here is the phase 1 minimum needed to
 * scroll, tap and quit; the full control scheme lives in vita/input/ from
 * phase 3 onwards.
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
#include <psp2/display.h>
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/sysmem.h>
#include <psp2/kernel/threadmgr.h>
#include <psp2/touch.h>

#include "libnsfb.h"
#include "libnsfb_event.h"
#include "libnsfb_plot.h"
#include "libnsfb_plot_util.h"

#include "nsfb.h"
#include "surface.h"
#include "plot.h"
#include "cursor.h"

#include "vita_platform.h"

#define SCREEN_WIDTH   VITASURF_SCREEN_WIDTH
#define SCREEN_HEIGHT  VITASURF_SCREEN_HEIGHT
#define SCREEN_STRIDE  960          /* pixels; must be a multiple of 64 */
#define SCREEN_BPP     32

/* CDRAM allocations are made in 256 KB units. */
#define CDRAM_ALIGN    (256 * 1024)

/* Input polling period while waiting for events, in microseconds. */
#define POLL_INTERVAL_US 8000

/* Held D-pad buttons repeat after this delay, then at this rate (ms). */
#define REPEAT_DELAY_MS  400
#define REPEAT_RATE_MS   60

/* Left stick: dead zone out of 0..255 around 128, and scroll step period. */
#define STICK_DEADZONE   40
#define STICK_PERIOD_MS  50

#define EVENT_QUEUE_LEN  64

/* Claims and updates logged unconditionally before going quiet. */
#define DIAG_BOXES       120

struct vita_surface {
	SceUID memblock;          /**< CDRAM block holding the display buffer */
	uint32_t *display;        /**< display buffer base */

	/* event queue, filled by polling and drained by vita_input() */
	nsfb_event_t queue[EVENT_QUEUE_LEN];
	int qhead;
	int qtail;

	/* controller state */
	unsigned int buttons;     /**< buttons held at the last poll */
	unsigned int repeat_mask; /**< D-pad button currently repeating */
	SceUInt64 repeat_due_us;  /**< when the next repeat fires */
	SceUInt64 stick_due_us;   /**< when the next stick scroll step fires */

	/* touch state */
	bool touch_down;
	int touch_x;
	int touch_y;

	/* last pointer position handed to NetSurf */
	int pointer_x;
	int pointer_y;

	/* diagnostics: the first claims and updates are always logged, the
	 * rest only when the verbose flag file exists */
	bool verbose;
	unsigned int updates;
	unsigned int claims;
};

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
 * Phase 1 button mapping. The framebuffer frontend scrolls on the arrow
 * and page keys, activates on return and closes with escape.
 */
static const struct {
	unsigned int button;
	enum nsfb_key_code_e key;
	bool repeats;
} button_map[] = {
	{ SCE_CTRL_UP,       NSFB_KEY_UP,       true  },
	{ SCE_CTRL_DOWN,     NSFB_KEY_DOWN,     true  },
	{ SCE_CTRL_LEFT,     NSFB_KEY_LEFT,     true  },
	{ SCE_CTRL_RIGHT,    NSFB_KEY_RIGHT,    true  },
	{ SCE_CTRL_CROSS,    NSFB_KEY_RETURN,   false },
	{ SCE_CTRL_CIRCLE,   NSFB_KEY_ESCAPE,   false },
	{ SCE_CTRL_LTRIGGER, NSFB_KEY_PAGEUP,   true  },
	{ SCE_CTRL_RTRIGGER, NSFB_KEY_PAGEDOWN, true  },
};

static void poll_buttons(struct vita_surface *vs, SceUInt64 now_us)
{
	SceCtrlData pad;
	unsigned int pressed;
	unsigned int released;
	unsigned int i;

	memset(&pad, 0, sizeof(pad));
	if (sceCtrlPeekBufferPositive(0, &pad, 1) < 0) {
		return;
	}

	pressed = pad.buttons & ~vs->buttons;
	released = vs->buttons & ~pad.buttons;
	vs->buttons = pad.buttons;

	/* Select and Start together quit; there is no other way out yet. */
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

	/* key repeat for the held D-pad button or trigger */
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

	/*
	 * Left stick scrolls like a mouse wheel. Wheel events are delivered
	 * to the widget under the pointer, so keep the pointer where the
	 * page is.
	 */
	if (now_us >= vs->stick_due_us) {
		int dy = (int)pad.ly - 128;

		if (dy < -STICK_DEADZONE || dy > STICK_DEADZONE) {
			enum nsfb_key_code_e key =
				(dy < 0) ? NSFB_KEY_MOUSE_4 : NSFB_KEY_MOUSE_5;

			queue_move(vs, vs->pointer_x, vs->pointer_y);
			queue_key(vs, NSFB_EVENT_KEY_DOWN, key);
			queue_key(vs, NSFB_EVENT_KEY_UP, key);
			vs->stick_due_us = now_us + STICK_PERIOD_MS * 1000;
		}
	}
}

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
			vs->touch_x = x;
			vs->touch_y = y;
			queue_move(vs, x, y);
			queue_key(vs, NSFB_EVENT_KEY_DOWN, NSFB_KEY_MOUSE_1);
		} else if (x != vs->touch_x || y != vs->touch_y) {
			vs->touch_x = x;
			vs->touch_y = y;
			queue_move(vs, x, y);
		}
	} else if (vs->touch_down) {
		vs->touch_down = false;
		queue_key(vs, NSFB_EVENT_KEY_UP, NSFB_KEY_MOUSE_1);
	}
}

static void poll_input(struct vita_surface *vs)
{
	SceUInt64 now_us = sceKernelGetProcessTimeWide();

	poll_buttons(vs, now_us);
	poll_touch(vs);
}

/* ------------------------------------------------------------------------ */
/* Display                                                                  */

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
	if (vs->updates <= DIAG_BOXES || vs->verbose) {
		vita_log("surface: update %u box %d,%d-%d,%d (clipped %d,%d-%d,%d) pixel %08x",
			 vs->updates, box->x0, box->y0, box->x1, box->y1,
			 area.x0, area.y0, area.x1, area.y1,
			 (unsigned int)*(const uint32_t *)
				(nsfb->ptr + area.y0 * nsfb->linelen + area.x0 * 4));
	} else if (vs->updates == DIAG_BOXES + 1) {
		vita_log("surface: further updates not logged");
	}

	src = nsfb->ptr + area.y0 * nsfb->linelen + area.x0 * 4;
	dst = vs->display + area.y0 * SCREEN_STRIDE + area.x0;
	for (y = area.y0; y < area.y1; y++) {
		memcpy(dst, src, (size_t)width * 4);
		src += nsfb->linelen;
		dst += SCREEN_STRIDE;
	}
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
	SceDisplayFrameBuf fb;
	SceSize size;
	void *base = NULL;
	int ret;

	if (nsfb->surface_priv != NULL) {
		return -1;
	}

	vs = calloc(1, sizeof(*vs));
	if (vs == NULL) {
		return -1;
	}

	/* display buffer in CDRAM */
	size = SCREEN_STRIDE * SCREEN_HEIGHT * (SCREEN_BPP / 8);
	size = (size + CDRAM_ALIGN - 1) & ~(SceSize)(CDRAM_ALIGN - 1);
	vs->memblock = sceKernelAllocMemBlock("vitasurf_display",
					      SCE_KERNEL_MEMBLOCK_TYPE_USER_CDRAM_RW,
					      size, NULL);
	if (vs->memblock < 0) {
		vita_log("surface: sceKernelAllocMemBlock failed: 0x%08x",
			 (unsigned int)vs->memblock);
		free(vs);
		return -1;
	}
	ret = sceKernelGetMemBlockBase(vs->memblock, &base);
	if (ret < 0 || base == NULL) {
		vita_log("surface: sceKernelGetMemBlockBase failed: 0x%08x",
			 (unsigned int)ret);
		sceKernelFreeMemBlock(vs->memblock);
		free(vs);
		return -1;
	}
	vs->display = base;
	memset(vs->display, 0, size);

	/* shadow buffer NetSurf plots into */
	nsfb->linelen = SCREEN_WIDTH * (SCREEN_BPP / 8);
	nsfb->ptr = calloc((size_t)SCREEN_HEIGHT, (size_t)nsfb->linelen);
	if (nsfb->ptr == NULL) {
		sceKernelFreeMemBlock(vs->memblock);
		free(vs);
		return -1;
	}

	memset(&fb, 0, sizeof(fb));
	fb.size = sizeof(fb);
	fb.base = vs->display;
	fb.pitch = SCREEN_STRIDE;
	fb.pixelformat = SCE_DISPLAY_PIXELFORMAT_A8B8G8R8;
	fb.width = SCREEN_WIDTH;
	fb.height = SCREEN_HEIGHT;
	ret = sceDisplaySetFrameBuf(&fb, SCE_DISPLAY_SETBUF_NEXTFRAME);
	if (ret < 0) {
		vita_log("surface: sceDisplaySetFrameBuf failed: 0x%08x",
			 (unsigned int)ret);
		free(nsfb->ptr);
		nsfb->ptr = NULL;
		sceKernelFreeMemBlock(vs->memblock);
		free(vs);
		return -1;
	}

	/* input */
	sceCtrlSetSamplingMode(SCE_CTRL_MODE_ANALOG);
	sceTouchSetSamplingState(SCE_TOUCH_PORT_FRONT,
				 SCE_TOUCH_SAMPLING_STATE_START);

	nsfb->surface_priv = vs;
	vs->verbose = vita_verbose_requested() != 0;

	/* start with the pointer over the page rather than the toolbar */
	queue_move(vs, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);

	vita_log("surface: %dx%d, display buffer %u KB in CDRAM",
		 SCREEN_WIDTH, SCREEN_HEIGHT, (unsigned int)size / 1024);

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

	free(nsfb->ptr);
	nsfb->ptr = NULL;

	sceKernelFreeMemBlock(vs->memblock);
	free(vs);
	nsfb->surface_priv = NULL;

	return 0;
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

	for (;;) {
		SceUInt64 now_us;
		SceUInt delay_us = POLL_INTERVAL_US;

		poll_input(vs);

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
		if (vs->claims <= DIAG_BOXES || vs->verbose) {
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

	if ((cursor != NULL) && (cursor->plotted == false)) {
		nsfb_cursor_plot(nsfb, cursor);
	}

	blit_box(nsfb, box);

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
