/*
 * VitaSurf input layer.
 *
 * The libnsfb surface delivers buttons as key events and exposes the
 * sticks and touch drags as state. This file decides what they mean:
 *
 *   D-pad        move a focus rectangle between links and form fields,
 *                or nudge the pointer in pointer mode
 *   Cross        activate the focused element, or click at the pointer
 *   Circle       stop loading, drop focus, return input to the page
 *   L / R        history back / forward
 *   Triangle     enter a URL or search terms (system IME, or NetSurf's
 *                on-screen keyboard if the IME cannot start)
 *   text field   tapping or activating a form field opens the system
 *                keyboard for it and types the result into the field
 *   Square       reload
 *   Select       toggle pointer mode
 *   Start        menu (later phase)
 *   Left stick   scroll, speed follows deflection
 *   Right stick  move the pointer (handled in the surface)
 *   Touch        tap to click, drag to scroll
 *
 * Link focus walks the HTML box tree of the current page, so it needs
 * the html handler's headers; nothing here modifies the tree.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <ctype.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <psp2/kernel/processmgr.h>

#include <libnsfb.h>
#include <libnsfb_event.h>
#include <libnsfb_plot.h>
#include <libnsfb_plot_util.h>

#include <dom/dom.h>

#include "utils/errors.h"
#include "utils/nsurl.h"
#include "netsurf/types.h"
#include "netsurf/browser_window.h"
#include "netsurf/content.h"
#include "netsurf/content_type.h"
#include "netsurf/keypress.h"
#include "netsurf/mouse.h"
#include "netsurf/window.h"
#include "desktop/browser_history.h"
#include "desktop/gui_internal.h"
#include "content/handlers/html/box.h"
#include "content/handlers/html/box_inspect.h"
#include "content/handlers/html/html_save.h"
#include "content/handlers/html/form_internal.h"
#include "framebuffer/gui.h"
#include "framebuffer/fbtk.h"
#include "framebuffer/schedule.h"

#include "vita_platform.h"
#include "vita_surface.h"
#include "vita_input.h"
#include "vita_ime.h"

/* root toolkit widget, defined in the framebuffer frontend's gui.c */
extern fbtk_widget_t *fbtk;
/* on-screen keyboard, fbtk/osk.c (unmap_osk added by the input patch) */
void unmap_osk(void);

/* Scrolling timer period and the fastest stick scroll, pixels per tick. */
#define TICK_MS          16
#define SCROLL_MAX       18

/* How far D-pad presses nudge the pointer in pointer mode. */
#define POINTER_STEP     24

/* Keep this much space around a newly focused element when scrolling. */
#define REVEAL_MARGIN    40

/* Padding drawn around a focused element. */
#define FOCUS_PAD        2

/* Upper bound on focusable elements considered per page. */
#define MAX_TARGETS      4096

#define SEARCH_URL "https://lite.duckduckgo.com/lite/?q="

enum direction { DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT };

/* A caret placed within this long after a tap or Cross opens the keyboard. */
#define ACTIVATION_WINDOW_US 500000

/** A focusable element: its bounds in content coordinates and identity. */
struct target {
	struct rect r;
	const void *key;   /**< href or gadget pointer; boxes of one link share it */
	struct form_control *gadget; /**< set for form controls */
};

/** What the open IME dialog is for. */
enum ime_target { IME_NONE, IME_URL, IME_FIELD };

static struct gui_window *the_gw;
static bool pointer_mode;
static bool tick_running;

/* current focus, in content coordinates of focus_content */
static struct {
	bool valid;
	struct hlcache_handle *content;
	const void *key;
	struct rect r;
} focus;

/* what is currently drawn on the display */
static bool overlay_shown;
static nsfb_bbox_t overlay;

static struct target *targets;
static int ntargets;

static enum ime_target ime_for = IME_NONE;
static bool ime_field_multiline;
static bool caret_active;          /**< a page text field has the caret */
static uint64_t last_activation_us; /**< last Cross click or pointer click */

/* ------------------------------------------------------------------------ */
/* Box tree walk                                                            */

static void add_target(struct box *b, const void *key, struct form_control *gadget)
{
	struct target *t;
	int x, y, w, h;

	if (ntargets >= MAX_TARGETS) {
		return;
	}
	box_coords(b, &x, &y);
	w = b->padding[LEFT] + b->width + b->padding[RIGHT];
	h = b->padding[TOP] + b->height + b->padding[BOTTOM];
	if (w <= 0 || h <= 0) {
		return;
	}
	t = &targets[ntargets++];
	t->r.x0 = x;
	t->r.y0 = y;
	t->r.x1 = x + w;
	t->r.y1 = y + h;
	t->key = key;
	t->gadget = gadget;
}

/**
 * Collect links and form controls. NetSurf builds inline elements as
 * siblings in an inline container, so the text of a link is a run of
 * leaf boxes that each carry the link's href; images inside links are
 * inline boxes with an object. Block-level links are found through their
 * descendants the same way.
 */
static void collect_targets(struct box *b)
{
	for (; b != NULL; b = b->next) {
		if (b->type == BOX_INLINE_END) {
			continue;
		}
		if (b->gadget != NULL && b->gadget->type != GADGET_HIDDEN) {
			add_target(b, b->gadget, b->gadget);
		} else if (b->href != NULL &&
			   (b->children == NULL || b->object != NULL)) {
			add_target(b, b->href, NULL);
		}
		if (b->children != NULL) {
			collect_targets(b->children);
		}
		if (b->float_children != NULL) {
			collect_targets(b->float_children);
		}
	}
}

/** Rebuild the target list for the current page. Returns false if none. */
static bool gather_targets(struct hlcache_handle **content_out)
{
	struct hlcache_handle *h;
	struct box *root;

	ntargets = 0;
	if (the_gw == NULL || the_gw->bw == NULL) {
		return false;
	}
	h = browser_window_get_content(the_gw->bw);
	if (h == NULL || content_get_type(h) != CONTENT_HTML) {
		return false;
	}
	root = html_get_box_tree(h);
	if (root == NULL) {
		return false;
	}
	if (targets == NULL) {
		targets = malloc(sizeof(*targets) * MAX_TARGETS);
		if (targets == NULL) {
			return false;
		}
	}
	collect_targets(root);
	*content_out = h;
	return ntargets > 0;
}

/* ------------------------------------------------------------------------ */
/* Geometry helpers                                                         */

static void viewport(int *sx, int *sy, int *vw, int *vh)
{
	*sx = *sy = 0;
	*vw = *vh = 0;
	guit->window->get_scroll(the_gw, sx, sy);
	guit->window->get_dimensions(the_gw, vw, vh);
}

static float page_scale(void)
{
	float s = browser_window_get_scale(the_gw->bw);

	return (s > 0.0f) ? s : 1.0f;
}

/** Gap between two intervals, 0 if they overlap. */
static int gap(int a0, int a1, int b0, int b1)
{
	if (b1 <= a0) return a0 - b1;
	if (b0 >= a1) return b0 - a1;
	return 0;
}

/**
 * Score a candidate for movement in a direction from a rectangle. Lower is
 * better; -1 means the candidate is not in that direction.
 */
static int score(enum direction dir, const struct rect *from, const struct rect *c)
{
	int primary, secondary;

	switch (dir) {
	case DIR_DOWN:
		if (c->y0 < from->y1 - 2) return -1;
		primary = c->y0 - from->y1;
		secondary = gap(from->x0, from->x1, c->x0, c->x1);
		break;
	case DIR_UP:
		if (c->y1 > from->y0 + 2) return -1;
		primary = from->y0 - c->y1;
		secondary = gap(from->x0, from->x1, c->x0, c->x1);
		break;
	case DIR_RIGHT:
		if (c->x0 < from->x1 - 2) return -1;
		primary = c->x0 - from->x1;
		secondary = gap(from->y0, from->y1, c->y0, c->y1);
		break;
	case DIR_LEFT:
	default:
		if (c->x1 > from->x0 + 2) return -1;
		primary = from->x0 - c->x1;
		secondary = gap(from->y0, from->y1, c->y0, c->y1);
		break;
	}
	if (primary < 0) primary = 0;
	return primary + 2 * secondary;
}

/* ------------------------------------------------------------------------ */
/* Focus                                                                    */

static void clear_overlay(void)
{
	if (overlay_shown) {
		vita_surface_set_focus_rect(NULL);
		overlay_shown = false;
	}
}

/** Recompute where the focus rectangle sits on screen and redraw it. */
static void refresh_overlay(void)
{
	int sx, sy, vw, vh;
	int bx, by;
	float scale;
	nsfb_bbox_t o, clip;

	if (!focus.valid || the_gw == NULL) {
		clear_overlay();
		return;
	}

	viewport(&sx, &sy, &vw, &vh);
	scale = page_scale();
	bx = fbtk_get_absx(the_gw->browser);
	by = fbtk_get_absy(the_gw->browser);

	o.x0 = bx + (int)(focus.r.x0 * scale) - sx - FOCUS_PAD;
	o.y0 = by + (int)(focus.r.y0 * scale) - sy - FOCUS_PAD;
	o.x1 = bx + (int)(focus.r.x1 * scale) - sx + FOCUS_PAD;
	o.y1 = by + (int)(focus.r.y1 * scale) - sy + FOCUS_PAD;

	clip.x0 = bx;
	clip.y0 = by;
	clip.x1 = bx + vw;
	clip.y1 = by + vh;
	if (!nsfb_plot_clip(&clip, &o)) {
		clear_overlay();
		return;
	}

	if (!overlay_shown || memcmp(&o, &overlay, sizeof(o)) != 0) {
		overlay = o;
		overlay_shown = true;
		vita_surface_set_focus_rect(&o);
	}
}

/** Scroll so the focused element is on screen with a margin. */
static void reveal_focus(void)
{
	int sx, sy, vw, vh;
	int nsx, nsy;
	float scale;
	struct rect r;

	viewport(&sx, &sy, &vw, &vh);
	scale = page_scale();
	r.x0 = (int)(focus.r.x0 * scale);
	r.y0 = (int)(focus.r.y0 * scale);
	r.x1 = (int)(focus.r.x1 * scale);
	r.y1 = (int)(focus.r.y1 * scale);

	nsx = sx;
	nsy = sy;
	if (r.y0 < sy + REVEAL_MARGIN) {
		nsy = r.y0 - REVEAL_MARGIN;
	} else if (r.y1 > sy + vh - REVEAL_MARGIN) {
		nsy = r.y1 - vh + REVEAL_MARGIN;
	}
	if (r.x0 < sx + REVEAL_MARGIN) {
		nsx = r.x0 - REVEAL_MARGIN;
	} else if (r.x1 > sx + vw - REVEAL_MARGIN) {
		nsx = r.x1 - vw + REVEAL_MARGIN;
	}
	if (nsx < 0) nsx = 0;
	if (nsy < 0) nsy = 0;

	if (nsx != sx || nsy != sy) {
		struct rect want;

		want.x0 = nsx;
		want.y0 = nsy;
		want.x1 = nsx;
		want.y1 = nsy;
		guit->window->set_scroll(the_gw, &want);
	}
}

/** Union every box of the chosen element into the focus rectangle. */
static void set_focus_to(int index, struct hlcache_handle *content)
{
	int i;

	focus.valid = true;
	focus.content = content;
	focus.key = targets[index].key;
	focus.r = targets[index].r;
	for (i = 0; i < ntargets; i++) {
		if (targets[i].key != focus.key) {
			continue;
		}
		if (targets[i].r.x0 < focus.r.x0) focus.r.x0 = targets[i].r.x0;
		if (targets[i].r.y0 < focus.r.y0) focus.r.y0 = targets[i].r.y0;
		if (targets[i].r.x1 > focus.r.x1) focus.r.x1 = targets[i].r.x1;
		if (targets[i].r.y1 > focus.r.y1) focus.r.y1 = targets[i].r.y1;
	}
}

static void drop_focus(void)
{
	focus.valid = false;
	focus.key = NULL;
	clear_overlay();
}

/** Move the focus in a direction; picks a first element if none. */
static void move_focus(enum direction dir)
{
	struct hlcache_handle *content = NULL;
	struct rect from;
	const void *from_key = NULL;
	int sx, sy, vw, vh;
	float scale;
	int best = -1;
	int best_score = 0;
	int best_visible = -1;
	int best_visible_score = 0;
	int i;

	if (!gather_targets(&content)) {
		drop_focus();
		return;
	}

	viewport(&sx, &sy, &vw, &vh);
	scale = page_scale();

	if (focus.valid && focus.content == content) {
		from = focus.r;
		from_key = focus.key;
	} else {
		/* start from the edge of the viewport opposite the direction */
		int vx0 = (int)(sx / scale), vy0 = (int)(sy / scale);
		int vx1 = (int)((sx + vw) / scale), vy1 = (int)((sy + vh) / scale);

		switch (dir) {
		case DIR_DOWN:  from.x0 = vx0; from.x1 = vx1; from.y0 = from.y1 = vy0; break;
		case DIR_UP:    from.x0 = vx0; from.x1 = vx1; from.y0 = from.y1 = vy1; break;
		case DIR_RIGHT: from.y0 = vy0; from.y1 = vy1; from.x0 = from.x1 = vx0; break;
		case DIR_LEFT:
		default:        from.y0 = vy0; from.y1 = vy1; from.x0 = from.x1 = vx1; break;
		}
	}

	for (i = 0; i < ntargets; i++) {
		int s;
		bool visible;

		if (targets[i].key == from_key) {
			continue;
		}
		s = score(dir, &from, &targets[i].r);
		if (s < 0) {
			continue;
		}
		visible = (int)(targets[i].r.y1 * scale) > sy &&
			  (int)(targets[i].r.y0 * scale) < sy + vh;
		if (visible && (best_visible < 0 || s < best_visible_score)) {
			best_visible = i;
			best_visible_score = s;
		}
		if (best < 0 || s < best_score) {
			best = i;
			best_score = s;
		}
	}

	/* prefer something already on screen unless the best is much nearer */
	if (best_visible >= 0 && (best < 0 || best_visible_score <= best_score * 2)) {
		best = best_visible;
	}
	if (best < 0) {
		/* nothing further that way: scroll a little instead */
		struct rect want;

		want.x0 = sx;
		want.y0 = sy;
		if (dir == DIR_DOWN) want.y0 = sy + vh / 2;
		if (dir == DIR_UP) want.y0 = sy - vh / 2;
		if (dir == DIR_RIGHT) want.x0 = sx + vw / 2;
		if (dir == DIR_LEFT) want.x0 = sx - vw / 2;
		if (want.x0 < 0) want.x0 = 0;
		if (want.y0 < 0) want.y0 = 0;
		want.x1 = want.x0;
		want.y1 = want.y0;
		guit->window->set_scroll(the_gw, &want);
		return;
	}

	set_focus_to(best, content);
	reveal_focus();
	refresh_overlay();
}

/** Click the focused element: hover the pointer over it, then click. */
static void activate_focus(void)
{
	int sx, sy, vw, vh;
	int cx, cy;
	float scale;

	if (!focus.valid) {
		return;
	}
	viewport(&sx, &sy, &vw, &vh);
	scale = page_scale();
	cx = (int)((focus.r.x0 + focus.r.x1) / 2 * scale);
	cy = (int)((focus.r.y0 + focus.r.y1) / 2 * scale);

	fbtk_warp_pointer(the_gw->browser,
			  fbtk_get_absx(the_gw->browser) + cx - sx,
			  fbtk_get_absy(the_gw->browser) + cy - sy, false);
	last_activation_us = sceKernelGetProcessTimeWide();
	browser_window_mouse_click(the_gw->bw, BROWSER_MOUSE_PRESS_1, cx, cy);
	browser_window_mouse_click(the_gw->bw, BROWSER_MOUSE_CLICK_1, cx, cy);
}

/** Click whatever is under the pointer, toolbar included. */
static void click_at_pointer(void)
{
	nsfb_event_t ev;

	memset(&ev, 0, sizeof(ev));
	ev.value.keycode = NSFB_KEY_MOUSE_1;
	ev.type = NSFB_EVENT_KEY_DOWN;
	last_activation_us = sceKernelGetProcessTimeWide();
	fbtk_click(fbtk, &ev);
	ev.type = NSFB_EVENT_KEY_UP;
	fbtk_click(fbtk, &ev);
}

/* ------------------------------------------------------------------------ */
/* URL entry                                                                */

static void url_encode(const char *in, char *out, size_t outlen)
{
	static const char hex[] = "0123456789ABCDEF";
	size_t o = 0;

	for (; *in != '\0' && o + 4 < outlen; in++) {
		unsigned char c = (unsigned char)*in;

		if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
			out[o++] = (char)c;
		} else if (c == ' ') {
			out[o++] = '+';
		} else {
			out[o++] = '%';
			out[o++] = hex[c >> 4];
			out[o++] = hex[c & 15];
		}
	}
	out[o] = '\0';
}

/** Go to what the user typed: a URL, or a search if it does not look like one. */
static void navigate_text(const char *text)
{
	char buf[2048];
	nsurl *url;
	nserror err;
	const char *p = text;
	bool has_space = false, has_dot = false, has_scheme = false;

	while (*p == ' ') p++;
	if (*p == '\0') {
		return;
	}
	for (const char *q = p; *q != '\0'; q++) {
		if (*q == ' ') has_space = true;
		if (*q == '.') has_dot = true;
	}
	has_scheme = strstr(p, "://") != NULL ||
		     strncmp(p, "about:", 6) == 0 ||
		     strncmp(p, "file:", 5) == 0 ||
		     strncmp(p, "data:", 5) == 0;

	if (has_scheme) {
		snprintf(buf, sizeof(buf), "%s", p);
	} else if (has_space || !has_dot) {
		char enc[1536];

		url_encode(p, enc, sizeof(enc));
		snprintf(buf, sizeof(buf), "%s%s", SEARCH_URL, enc);
	} else {
		snprintf(buf, sizeof(buf), "https://%s", p);
	}
	/* trailing spaces */
	for (size_t n = strlen(buf); n > 0 && buf[n - 1] == ' '; n--) {
		buf[n - 1] = '\0';
	}

	err = nsurl_create(buf, &url);
	if (err != NSERROR_OK) {
		vita_log("input: bad url '%s'", buf);
		return;
	}
	vita_log("input: go to %s", buf);
	drop_focus();
	browser_window_navigate(the_gw->bw, url, NULL, BW_NAVIGATE_HISTORY,
				NULL, NULL, NULL);
	nsurl_unref(url);
}

static void start_url_entry(void)
{
	nsurl *url = NULL;
	const char *initial = "";

	if (browser_window_get_url(the_gw->bw, true, &url) == NSERROR_OK &&
	    url != NULL) {
		initial = nsurl_access(url);
		/* the bundled home page is not a useful starting point */
		if (strncmp(initial, "file:", 5) == 0) {
			initial = "";
		}
	}

	if (vita_ime_start("Web address or search", initial, false) == 0) {
		ime_for = IME_URL;
	} else {
		/* NetSurf's own keyboard on the URL bar */
		vita_log("input: IME unavailable, using the on-screen keyboard");
		fbtk_set_focus(the_gw->url);
		map_osk();
	}
	if (url != NULL) {
		nsurl_unref(url);
	}
}

/* ------------------------------------------------------------------------ */
/* Form field text entry                                                    */

/** Type text into the focused form field, replacing what it holds. */
static void type_into_field(const char *text)
{
	const unsigned char *p = (const unsigned char *)text;

	if (the_gw == NULL) {
		return;
	}
	browser_window_key_press(the_gw->bw, NS_KEY_SELECT_ALL);
	if (*p == '\0') {
		browser_window_key_press(the_gw->bw, NS_KEY_DELETE_LEFT);
		return;
	}
	while (*p != '\0') {
		uint32_t cp;
		int extra;

		if (*p < 0x80) {
			cp = *p;
			extra = 0;
		} else if ((*p & 0xE0) == 0xC0) {
			cp = *p & 0x1F;
			extra = 1;
		} else if ((*p & 0xF0) == 0xE0) {
			cp = *p & 0x0F;
			extra = 2;
		} else if ((*p & 0xF8) == 0xF0) {
			cp = *p & 0x07;
			extra = 3;
		} else {
			p++;
			continue;
		}
		p++;
		while (extra-- > 0 && (*p & 0xC0) == 0x80) {
			cp = (cp << 6) | (*p & 0x3F);
			p++;
		}
		if (cp == '\r') {
			continue;
		}
		if (cp == '\n') {
			cp = ime_field_multiline ? NS_KEY_NL : ' ';
		}
		browser_window_key_press(the_gw->bw, cp);
	}
}

/** Find the form control whose box contains a content point. */
static struct form_control *gadget_at(int x, int y)
{
	struct hlcache_handle *content = NULL;
	int i;

	if (!gather_targets(&content)) {
		return NULL;
	}
	for (i = 0; i < ntargets; i++) {
		if (targets[i].gadget != NULL &&
		    x >= targets[i].r.x0 && x < targets[i].r.x1 &&
		    y >= targets[i].r.y0 && y < targets[i].r.y1) {
			return targets[i].gadget;
		}
	}
	return NULL;
}

void vita_input_caret(struct gui_window *gw, int x, int y, int height)
{
	struct vita_input_state st;
	struct form_control *gadget;
	uint64_t now = sceKernelGetProcessTimeWide();
	bool activated;
	const char *initial = "";
	const char *title = "Enter text";
	float scale;

	(void)height;
	if (gw != the_gw || vita_ime_running()) {
		return;
	}

	/*
	 * The caret is re-placed on every keystroke and caret move, so only
	 * a caret that follows a tap or an activation means the user wants
	 * to type; a field that merely kept focus stays quiet.
	 */
	vita_surface_read_input(&st);
	activated = (now - last_activation_us < ACTIVATION_WINDOW_US) ||
		    (st.last_tap_us != 0 && now - st.last_tap_us < ACTIVATION_WINDOW_US);
	if (caret_active && !activated) {
		return;
	}
	caret_active = true;
	if (!activated) {
		return;
	}

	scale = page_scale();
	gadget = gadget_at((int)(x / scale), (int)(y / scale));
	ime_field_multiline = false;
	if (gadget != NULL) {
		switch (gadget->type) {
		case GADGET_TEXTAREA:
			ime_field_multiline = true;
			break;
		case GADGET_PASSWORD:
			title = "Enter password";
			break;
		default:
			break;
		}
		if (gadget->value != NULL && gadget->type != GADGET_PASSWORD) {
			initial = gadget->value;
		}
	}

	/* the tap and its caret land in the same poll; consume the tap */
	last_activation_us = 0;
	if (vita_ime_start(title, initial, ime_field_multiline) == 0) {
		ime_for = IME_FIELD;
	} else {
		vita_log("input: IME unavailable for the form field");
	}
}

void vita_input_caret_removed(struct gui_window *gw)
{
	if (gw == the_gw) {
		caret_active = false;
	}
}

/* ------------------------------------------------------------------------ */
/* Timer                                                                    */

static void tick(void *p)
{
	struct vita_input_state st;
	int dx = 0, dy = 0;
	char text[2048];

	(void)p;
	if (the_gw == NULL) {
		tick_running = false;
		return;
	}

	vita_surface_read_input(&st);

	/* stick: quadratic response so small deflections crawl */
	if (st.lx != 0) {
		dx += st.lx * abs(st.lx) * SCROLL_MAX / (127 * 127);
		if (dx == 0) dx = st.lx > 0 ? 1 : -1;
	}
	if (st.ly != 0) {
		dy += st.ly * abs(st.ly) * SCROLL_MAX / (127 * 127);
		if (dy == 0) dy = st.ly > 0 ? 1 : -1;
	}
	/* touch drag: the page follows the finger */
	dx -= st.drag_dx;
	dy -= st.drag_dy;

	if (dx != 0 || dy != 0) {
		struct rect want;
		int sx, sy, vw, vh;

		viewport(&sx, &sy, &vw, &vh);
		want.x0 = sx + dx;
		want.y0 = sy + dy;
		if (want.x0 < 0) want.x0 = 0;
		if (want.y0 < 0) want.y0 = 0;
		want.x1 = want.x0;
		want.y1 = want.y0;
		guit->window->set_scroll(the_gw, &want);
	}

	switch (vita_ime_poll(text, sizeof(text))) {
	case VITA_IME_DONE:
		if (ime_for == IME_FIELD) {
			type_into_field(text);
		} else {
			navigate_text(text);
		}
		ime_for = IME_NONE;
		break;
	case VITA_IME_CANCELLED:
		ime_for = IME_NONE;
		break;
	default:
		break;
	}

	/* a new page invalidates the focus */
	if (focus.valid &&
	    browser_window_get_content(the_gw->bw) != focus.content) {
		drop_focus();
	}
	refresh_overlay();

	framebuffer_schedule(TICK_MS, tick, NULL);
}

/* ------------------------------------------------------------------------ */
/* Entry points                                                             */

void vita_input_attach(struct gui_window *gw)
{
	the_gw = gw;
	vita_log("input: attached to window, pointer mode %s",
		 pointer_mode ? "on" : "off");
	if (!tick_running) {
		tick_running = true;
		framebuffer_schedule(TICK_MS, tick, NULL);
	}
}

bool vita_input_key(struct gui_window *gw, const nsfb_event_t *event)
{
	enum nsfb_key_code_e key;

	if (gw == NULL || the_gw != gw) {
		return false;
	}
	if (event->type != NSFB_EVENT_KEY_DOWN &&
	    event->type != NSFB_EVENT_KEY_UP) {
		return false;
	}
	key = event->value.keycode;

	switch (key) {
	case VITA_KEY_UP:
	case VITA_KEY_DOWN:
	case VITA_KEY_LEFT:
	case VITA_KEY_RIGHT:
		if (event->type != NSFB_EVENT_KEY_DOWN) {
			return true;
		}
		if (pointer_mode) {
			int dx = (key == VITA_KEY_LEFT) ? -POINTER_STEP :
				 (key == VITA_KEY_RIGHT) ? POINTER_STEP : 0;
			int dy = (key == VITA_KEY_UP) ? -POINTER_STEP :
				 (key == VITA_KEY_DOWN) ? POINTER_STEP : 0;

			fbtk_warp_pointer(fbtk, dx, dy, true);
			return true;
		}
		/* a text field with the caret takes left and right first */
		if ((key == VITA_KEY_LEFT || key == VITA_KEY_RIGHT) &&
		    browser_window_key_press(gw->bw, key == VITA_KEY_LEFT ?
					     NS_KEY_LEFT : NS_KEY_RIGHT)) {
			return true;
		}
		move_focus(key == VITA_KEY_UP ? DIR_UP :
			   key == VITA_KEY_DOWN ? DIR_DOWN :
			   key == VITA_KEY_LEFT ? DIR_LEFT : DIR_RIGHT);
		return true;

	case VITA_KEY_CROSS:
		if (event->type != NSFB_EVENT_KEY_DOWN) {
			return true;
		}
		if (focus.valid && !pointer_mode) {
			activate_focus();
		} else {
			click_at_pointer();
		}
		return true;

	default:
		return false;
	}
}

bool vita_input_global_key(const nsfb_event_t *event)
{
	enum nsfb_key_code_e key;
	bool down;

	if (the_gw == NULL) {
		return false;
	}
	if (event->type != NSFB_EVENT_KEY_DOWN &&
	    event->type != NSFB_EVENT_KEY_UP) {
		return false;
	}
	key = event->value.keycode;
	down = event->type == NSFB_EVENT_KEY_DOWN;

	switch (key) {
	case VITA_KEY_L:
		if (down && browser_window_history_back_available(the_gw->bw)) {
			drop_focus();
			browser_window_history_back(the_gw->bw, false);
		}
		return true;

	case VITA_KEY_R:
		if (down && browser_window_history_forward_available(the_gw->bw)) {
			drop_focus();
			browser_window_history_forward(the_gw->bw, false);
		}
		return true;

	case VITA_KEY_SQUARE:
		if (down) {
			drop_focus();
			browser_window_reload(the_gw->bw, false);
		}
		return true;

	case VITA_KEY_TRIANGLE:
		if (down) {
			start_url_entry();
		}
		return true;

	case VITA_KEY_SELECT:
		if (down) {
			pointer_mode = !pointer_mode;
			drop_focus();
			vita_log("input: pointer mode %s", pointer_mode ? "on" : "off");
		}
		return true;

	case VITA_KEY_START:
		if (down) {
			vita_log("input: menu not implemented yet");
		}
		return true;

	case VITA_KEY_CIRCLE:
		if (down) {
			if (browser_window_stop_available(the_gw->bw)) {
				browser_window_stop(the_gw->bw);
			}
			drop_focus();
			unmap_osk();
			fbtk_set_focus(the_gw->browser);
		}
		return true;

	default:
		return false;
	}
}
