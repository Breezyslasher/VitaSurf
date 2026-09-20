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
 *   Start        menu: bookmarks, history, settings, quit (vita_menu.c)
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
#include "utils/utils.h"
#include "content/hlcache.h"
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
#include "vita_menu.h"

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

static uint64_t load_started_us;   /**< when the current load began, 0 if idle */

static enum ime_target ime_for = IME_NONE;
static bool ime_field_multiline;
static bool caret_active;          /**< a page text field has the caret */
static uint64_t last_activation_us; /**< last Cross click or pointer click */

/* ------------------------------------------------------------------------ */
/* Box tree walk                                                            */

/** The computed style that applies to a box, looking up for text boxes. */
static const css_computed_style *box_style(struct box *b)
{
	while (b != NULL && b->style == NULL) {
		b = b->parent;
	}
	return b != NULL ? b->style : NULL;
}

/**
 * Whether an element can actually be seen: not visibility:hidden, not
 * positioned off the page, and not clipped away by an overflow:hidden
 * ancestor (collapsed navigation menus are the usual case). Focusing an
 * invisible link looks like the focus vanished.
 */
static bool target_visible(struct box *b, int x, int y, int w, int h)
{
	const css_computed_style *style = box_style(b);
	struct box *a;

	if (x + w <= 0 || y + h <= 0) {
		return false;
	}
	if (style != NULL &&
	    css_computed_visibility(style) == CSS_VISIBILITY_HIDDEN) {
		return false;
	}
	for (a = b->parent; a != NULL; a = a->parent) {
		int ax, ay, aw, ah;

		if (a->style == NULL) {
			continue;
		}
		if (css_computed_overflow_x(a->style) != CSS_OVERFLOW_HIDDEN &&
		    css_computed_overflow_y(a->style) != CSS_OVERFLOW_HIDDEN) {
			continue;
		}
		box_coords(a, &ax, &ay);
		aw = a->padding[LEFT] + a->width + a->padding[RIGHT];
		ah = a->padding[TOP] + a->height + a->padding[BOTTOM];
		if (css_computed_overflow_x(a->style) == CSS_OVERFLOW_HIDDEN &&
		    (x >= ax + aw || x + w <= ax)) {
			return false;
		}
		if (css_computed_overflow_y(a->style) == CSS_OVERFLOW_HIDDEN &&
		    (y >= ay + ah || y + h <= ay)) {
			return false;
		}
	}
	return true;
}

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
	if (w <= 0 || h <= 0 || !target_visible(b, x, y, w, h)) {
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
/* Page load timing                                                         */

void vita_input_load_started(struct gui_window *gw)
{
	if (gw == the_gw) {
		load_started_us = sceKernelGetProcessTimeWide();
		vitasurf_profile_reset();
	}
}

/* One FlareSolverr attempt per URL per minute, so a failure cannot loop. */
static char flaresolverr_last[512];
static uint64_t flaresolverr_last_us;

static bool flaresolverr_should_try(struct gui_window *gw)
{
	nsurl *url = NULL;
	uint64_t now = sceKernelGetProcessTimeWide();
	bool ok = false;

	if (browser_window_get_url(gw->bw, false, &url) != NSERROR_OK || url == NULL) {
		return false;
	}
	if (strcmp(nsurl_access(url), flaresolverr_last) != 0 ||
	    now - flaresolverr_last_us > 60000000ull) {
		strncpy(flaresolverr_last, nsurl_access(url), sizeof(flaresolverr_last) - 1);
		flaresolverr_last[sizeof(flaresolverr_last) - 1] = '\0';
		flaresolverr_last_us = now;
		ok = true;
	}
	nsurl_unref(url);
	return ok;
}

static void flaresolverr_run(void *p)
{
	struct gui_window *gw = p;
	nsurl *url = NULL;

	if (gw != the_gw || gw->bw == NULL) {
		return;
	}
	if (browser_window_get_url(gw->bw, false, &url) != NSERROR_OK || url == NULL) {
		return;
	}
	if (vita_flaresolverr_solve(url)) {
		if (guit->window->set_status != NULL) {
			guit->window->set_status(gw, "Cloudflare check passed by FlareSolverr, reloading");
		}
		browser_window_navigate(gw->bw, url, NULL, BW_NAVIGATE_HISTORY,
					NULL, NULL, NULL);
	} else if (guit->window->set_status != NULL) {
		guit->window->set_status(gw, "FlareSolverr could not pass the Cloudflare check (see log)");
	}
	nsurl_unref(url);
}

/**
 * The name to print for a box in the layout dump (VitaSurf).
 */
static const char *dump_box_type(box_type type)
{
	switch (type) {
	case BOX_BLOCK:            return "block";
	case BOX_INLINE_CONTAINER: return "line";
	case BOX_INLINE:           return "inline";
	case BOX_TABLE:            return "table";
	case BOX_TABLE_ROW:        return "row";
	case BOX_TABLE_CELL:       return "cell";
	case BOX_TABLE_ROW_GROUP:  return "rowgroup";
	case BOX_FLOAT_LEFT:       return "floatleft";
	case BOX_FLOAT_RIGHT:      return "floatright";
	case BOX_INLINE_BLOCK:     return "inlineblock";
	case BOX_BR:               return "br";
	case BOX_TEXT:             return "text";
	case BOX_INLINE_END:       return "inlineend";
	case BOX_FLEX:             return "flex";
	case BOX_INLINE_FLEX:      return "inlineflex";
	default:                   return "box";
	}
}


/**
 * Write one box and everything in it to the log (VitaSurf).
 *
 * A page that comes out wrong on the device cannot be opened in a
 * debugger and cannot be reproduced here without the site, so the
 * shape of the page goes in the log instead: what each box is, where
 * it ended up and how big it is. The count is capped, since a page of
 * any size has thousands of boxes and the log is read by a person.
 */
static void dump_box(struct box *box, unsigned int depth, unsigned int *left)
{
	char what[96];
	char text[41];
	struct box *child;
	int x = 0, y = 0;
	size_t n = 0;

	if (box == NULL || *left == 0) {
		return;
	}
	(*left)--;

	what[0] = '\0';
	if (box->node != NULL) {
		dom_string *name = NULL;

		if (dom_node_get_node_name(box->node, &name) == DOM_NO_ERR &&
		    name != NULL) {
			snprintf(what, sizeof(what), " <%.*s>",
				 (int)dom_string_byte_length(name),
				 dom_string_data(name));
			dom_string_unref(name);
		}
	}

	text[0] = '\0';
	if (box->text != NULL && box->length > 0) {
		n = box->length < sizeof(text) - 1 ?
				box->length : sizeof(text) - 1;
		memcpy(text, box->text, n);
		text[n] = '\0';
	}

	box_coords(box, &x, &y);
	vita_log("layout: %*s%s%s %dx%d at %d,%d%s%s",
		 (int)(depth * 2), "", dump_box_type(box->type), what,
		 box->width, box->height, x, y,
		 n > 0 ? " " : "", text);

	for (child = box->children; child != NULL; child = child->next) {
		dump_box(child, depth + 1, left);
	}
	for (child = box->float_children; child != NULL;
	     child = child->next_float) {
		dump_box(child, depth + 1, left);
	}
}


/**
 * Log the boxes of the page in the window, if the flag file asks.
 */
/*
 * The tally of Web APIs the page asked for that this build does not
 * have. It lives in the QuickJS bindings, which the duktape build does
 * not compile, so the symbol is weak and the call is skipped there.
 */
extern void vita_js_report_gaps(void) __attribute__((weak));

/**
 * Write the fetches of the page now on screen to the log.
 *
 * The Log screen draws the same figures, but a picture has to be read
 * off a photograph of a handheld; these lines go into the file that a
 * report is made of. A page that is still waiting on something is
 * exactly the case where that matters, and it is the case where the
 * page cannot be navigated away from to see the waterfall either.
 */
static void dump_timeline(void)
{
	unsigned int count = vitasurf_timeline_count();
	unsigned int i;

	vita_log("fetches: %u of %u recorded, %u ms from the first request "
		 "to the last byte", count, vitasurf_timeline_seen(),
		 vitasurf_timeline_span());

	for (i = 0; i < count; i++) {
		const struct vitasurf_fetch *f = vitasurf_timeline_get(i);
		const char *how = "done";

		switch (f->state) {
		case VITASURF_FETCH_ERROR:   how = "failed"; break;
		case VITASURF_FETCH_ABORTED: how = "abandoned"; break;
		case VITASURF_FETCH_RUNNING: how = "still running"; break;
		default: break;
		}
		vita_log("fetches: %4u %6u ms + %6u ms  %7u B  %3d  %-13s %s",
			 i, f->start_ms,
			 (f->state != VITASURF_FETCH_RUNNING ?
				f->end_ms : vitasurf_timeline_span()) -
				f->start_ms,
			 f->bytes, f->status, how, f->url);
	}
}


static void dump_layout(struct gui_window *gw, bool force)
{
	struct hlcache_handle *h;
	struct box *root;
	unsigned int left = 400;

	if (gw == NULL) {
		return;
	}
	if (force == false && vita_layout_dump_requested() == 0) {
		return;
	}
	h = browser_window_get_content(gw->bw);
	if (h == NULL || content_get_type(h) != CONTENT_HTML) {
		return;
	}
	root = html_get_box_tree(h);
	if (root == NULL) {
		return;
	}
	dump_timeline();
	if (vita_js_report_gaps != NULL) {
		vita_js_report_gaps();
	}
	vita_log("layout: the first %u boxes of the page, "
		 "size then position", left);
	dump_box(root, 0, &left);
	vita_log("layout: end of the boxes%s",
		 left == 0 ? " (there are more)" : "");
}


/* Exported: the scripts on a page build most of it after the load, so
 * the boxes worth reading are the ones the rebuild leaves behind. */
void vita_input_dump_layout(void)
{
	dump_layout(the_gw, false);
}


/* Exported: the same dump on demand, from the menu, with no flag file
 * to create first. */
void vita_input_dump_layout_now(void)
{
	dump_layout(the_gw, true);
}


void vita_input_load_finished(struct gui_window *gw)
{
	nsurl *url = NULL;
	unsigned int ms;

	if (gw != the_gw || load_started_us == 0) {
		return;
	}
	ms = (unsigned int)((sceKernelGetProcessTimeWide() - load_started_us) / 1000);
	load_started_us = 0;
	/* a LiveArea close never reaches gui_quit, so save as we go */
	vita_menu_autosave(false);
	if (browser_window_get_url(gw->bw, false, &url) == NSERROR_OK && url != NULL) {
		vita_log("page: %s loaded in %u ms", nsurl_access(url), ms);
		dump_layout(gw, false);
		{
			/*
			 * Say what is left over as well as what was
			 * measured. A load of ninety-six seconds once
			 * reported half a second of work, all of it in
			 * the parse and the layout, and there was no way
			 * to tell from the log whether the rest went on
			 * the network, on script run from a timer, or
			 * somewhere nobody had thought to look. An
			 * unaccounted figure cannot hide.
			 *
			 * The figures overlap: a script run by a <script>
			 * element runs during the parse and is counted in
			 * both, so what is left over is a floor, not an
			 * exact number.
			 */
			unsigned int seen = vitasurf_ms_html_parse +
				vitasurf_ms_css + vitasurf_ms_image +
				vitasurf_ms_boxes + vitasurf_ms_layout +
				vitasurf_ms_script + vitasurf_ms_draw +
				vitasurf_ms_teardown + vitasurf_ms_prelude;

			vita_log("page: of that, html parse %u ms, css %u ms, "
				 "images %u ms, boxes and styles %u ms, "
				 "layout %u ms, script %u ms",
				 vitasurf_ms_html_parse, vitasurf_ms_css,
				 vitasurf_ms_image, vitasurf_ms_boxes,
				 vitasurf_ms_layout, vitasurf_ms_script);
			vita_log("page: script %u ms is %u ms in script "
				 "elements (%u ms compiling or reading them, "
				 "%u ms running them, %u ms after, of which "
				 "%u ms freeing the result), "
				 "%u ms in %u timers, %u ms in %u "
				 "events, %u ms in %u fetch callbacks",
				 vitasurf_ms_script, vitasurf_ms_js_page,
				 vitasurf_ms_js_compile, vitasurf_ms_js_run,
				 vitasurf_ms_js_after, vitasurf_ms_js_free,
				 vitasurf_ms_js_timer, vitasurf_js_timers,
				 vitasurf_ms_js_event, vitasurf_js_events,
				 vitasurf_ms_js_xhr, vitasurf_js_xhrs);
			vita_log("page: and %u promise jobs after those, "
				 "costing %u ms, the longest %u ms, which "
				 "the script figure does not include; %u of "
				 "them took 5 ms or more and account for "
				 "%u ms",
				 vitasurf_js_jobs, vitasurf_ms_js_jobs,
				 vitasurf_ms_js_job_max,
				 vitasurf_js_jobs_slow,
				 vitasurf_ms_js_jobs_slow);
			vita_log("page: the page asked the tree for elements "
				 "%u times, costing %u ms",
				 vitasurf_js_finds, vitasurf_ms_js_finds);
			vita_log("page: boxes and styles %u ms covered %u "
				 "elements, %u ms of it selecting their "
				 "styles and %u ms parsing the style "
				 "attribute on %u of them",
				 vitasurf_ms_boxes, vitasurf_box_elements,
				 vitasurf_ms_select,
				 vitasurf_ms_inline_style,
				 vitasurf_inline_styles);
			{
				extern unsigned int css_select_calls;
				extern unsigned int css_select_sheets_seen;
				extern unsigned int
					css_select_selectors_considered;
				extern unsigned int css_select_from_element;
				extern unsigned int css_select_from_class;
				extern unsigned int css_select_from_id;
				extern unsigned int css_select_from_universal;
				extern unsigned int css_hash_in_element;
				extern unsigned int css_hash_in_class;
				extern unsigned int css_hash_in_id;
				extern unsigned int css_hash_in_universal;
				extern unsigned int
					css_select_cand_details_failed;
				extern unsigned int
					css_select_cand_comb_failed;
				extern unsigned int css_select_cand_matched;
				extern unsigned int
					css_select_refused_by_attribute;
				extern unsigned int
					css_select_refused_by_pseudo_class;
				extern unsigned int
					css_select_refused_by_pseudo_element;
				extern unsigned int
					css_select_refused_by_other;

				vita_log("page: building those boxes was %u ms in "
				 "the elements and %u ms in %u text nodes, "
				 "with %u ms of the elements in %u special "
				 "ones",
				 vitasurf_ms_box_element, vitasurf_ms_box_text,
				 vitasurf_box_texts, vitasurf_ms_box_special,
				 vitasurf_box_specials);
			vita_log("page: the %u layout passes took %u ms, the "
				 "longest %u ms; %u of them ran 100 ms or "
				 "more and account for %u ms",
				 vitasurf_layout_runs, vitasurf_ms_layout,
				 vitasurf_ms_layout_max, vitasurf_layout_slow,
				 vitasurf_ms_layout_slow);
			vita_log("page: %u objects became ready and %u of "
				 "them laid the page out again",
				 vitasurf_object_ready,
				 vitasurf_object_reformats);
			vita_log("page: %u images converted for %u ms, the "
				 "dearest %u ms, %u kpixels decoded in all",
				 vitasurf_images_converted, vitasurf_ms_image,
				 vitasurf_ms_image_max,
				 vitasurf_image_kpixels);
			vita_log("page: selection ran %u times, "
					 "looked in %u sheets and considered "
					 "%u selectors",
					 css_select_calls,
					 css_select_sheets_seen,
					 css_select_selectors_considered);
				vita_log("page: those came from %u element, "
					 "%u class, %u id and %u universal "
					 "rules",
					 css_select_from_element,
					 css_select_from_class,
					 css_select_from_id,
					 css_select_from_universal);
				vita_log("page: the sheets filed %u rules by "
					 "element, %u by class, %u by id and "
					 "%u as universal",
					 css_hash_in_element, css_hash_in_class,
					 css_hash_in_id, css_hash_in_universal);
				vita_log("page: of those candidates %u were "
					 "refused on their own compound, %u "
					 "walking their combinators, and %u "
					 "matched",
					 css_select_cand_details_failed,
					 css_select_cand_comb_failed,
					 css_select_cand_matched);
				vita_log("page: the compound ones were "
					 "refused by %u attribute, %u "
					 "pseudo-class, %u pseudo-element and "
					 "%u other details",
					 css_select_refused_by_attribute,
					 css_select_refused_by_pseudo_class,
					 css_select_refused_by_pseudo_element,
					 css_select_refused_by_other);
			}
			vita_log("page: attribute selectors asked for a name "
				 "%u times, interning it %u of them",
				 vitasurf_attr_interned_hits +
					vitasurf_attr_interned_misses,
				 vitasurf_attr_interned_misses);
			vita_log("page: the scheduler ran %u callbacks for "
				 "%u ms, the longest %u ms",
				 vitasurf_sched_calls, vitasurf_ms_sched,
				 vitasurf_ms_sched_max);
			vita_log("page: laid out %u times, measuring text "
				 "%u times over %u characters, %u ms of it "
				 "inside the font engine",
				 vitasurf_layout_runs, vitasurf_font_calls,
				 vitasurf_font_chars,
				 vitasurf_us_font / 1000);
			vita_log("page: %u of those characters reached "
				 "FreeType, costing %u ms; the other %u ms "
				 "is our own code around it",
				 vitasurf_font_lookups,
				 vitasurf_us_lookup / 1000,
				 (vitasurf_us_font - vitasurf_us_lookup) /
					1000);
			vita_log("page: and drawing %u ms, tearing the last "
				 "page's script down %u ms, our own "
				 "JavaScript %u ms",
				 vitasurf_ms_draw, vitasurf_ms_teardown,
				 vitasurf_ms_prelude);
			if (seen > ms) {
				vita_log("page: the figures above overlap, so "
					 "nothing is left to account for");
			} else {
				vita_log("page: at least %u ms unaccounted "
					 "(network waits, and work nothing "
					 "measures yet)", ms - seen);
			}
		}
		vita_log("page: images %u asked for, %u decoded, %u failed",
			 vitasurf_images_asked, vitasurf_images_done,
			 vitasurf_images_failed);
		{
			struct hlcache_size_report r;

			hlcache_size_report(&r);
			vita_log("cache: %u contents, %u KB (css %u in %u, "
				 "html %u in %u, image %u in %u, other %u in %u)",
				 r.count, r.total_bytes / 1024,
				 r.css_bytes / 1024, r.css_count,
				 r.html_bytes / 1024, r.html_count,
				 r.image_bytes / 1024, r.image_count,
				 r.other_bytes / 1024, r.other_count);
			vita_log("cache: %u of those have no users, %u KB",
				 r.unused_count, r.unused_bytes / 1024);
		}
		nsurl_unref(url);
	} else {
		vita_log("page: loaded in %u ms", ms);
	}

	/*
	 * Cloudflare's browser check ("Just a moment...") runs a script that
	 * fingerprints a full desktop browser and never passes here. With a
	 * FlareSolverr server configured the check is handed to it and the
	 * page reloaded with its cookies; otherwise say so in the status bar
	 * rather than leaving a page that looks stuck.
	 */
	{
		const char *title = browser_window_get_title(gw->bw);

		if (title != NULL && strncmp(title, "Just a moment", 13) == 0) {
			if (vita_flaresolverr_endpoint() != NULL &&
			    flaresolverr_should_try(gw)) {
				if (guit->window->set_status != NULL) {
					guit->window->set_status(gw,
						"Cloudflare check: asking FlareSolverr, please wait...");
				}
				/* let that status reach the screen first */
				framebuffer_schedule(300, flaresolverr_run, gw);
			} else if (guit->window->set_status != NULL) {
				vita_log("page: Cloudflare browser check; it cannot be passed by this browser");
				guit->window->set_status(gw,
					"This site's Cloudflare browser check cannot be passed by VitaSurf");
			}
		}
	}
}

/*
 * After a suspend the network connections are gone. Stop the fetches that
 * were in flight so they fail now instead of waiting for a timeout, and
 * log the network state; Square reloads the page.
 */
static void check_resume(void)
{
	static uint64_t last_poll_us;
	uint64_t now = sceKernelGetProcessTimeWide();

	if (now - last_poll_us < 500000) {
		return;
	}
	last_poll_us = now;
	if (!vita_platform_poll_resume()) {
		return;
	}
	vita_log("resume: application resumed from suspend");
	vita_net_log_state();
	if (the_gw != NULL && the_gw->bw != NULL) {
		browser_window_stop(the_gw->bw);
		if (guit->window->set_status != NULL) {
			guit->window->set_status(the_gw,
				"Resumed: press Square to reload if the page did not finish");
		}
	}
	vita_log_memory("resume");
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
	check_resume();

	/*
	 * While the menu is open the page must not move under it: scrolling
	 * pans the page with a screen copy that would carry the menu away,
	 * and fbtk never repaints a window over a sibling that redrew.
	 */
	if (vita_menu_is_open()) {
		static uint64_t last_menu_redraw_us;
		uint64_t now = sceKernelGetProcessTimeWide();

		if (now - last_menu_redraw_us > 250000) {
			last_menu_redraw_us = now;
			vita_menu_refresh();
		}
		st.lx = st.ly = 0;
		st.drag_dx = st.drag_dy = 0;
	}

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

struct gui_window *vita_input_window(void)
{
	return the_gw;
}

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

	/* the menu takes every button while it is open */
	if (vita_menu_is_open()) {
		return vita_menu_key(key, down);
	}

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
		if (down && !vita_ime_running()) {
			drop_focus();
			vita_menu_toggle();
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
