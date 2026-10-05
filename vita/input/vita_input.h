/*
 * VitaSurf input layer: turns Vita buttons, sticks and touch into
 * NetSurf actions. Called from small hooks in the framebuffer frontend
 * (patches/0005-netsurf-vita-input-hooks.patch).
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_INPUT_H
#define VITASURF_INPUT_H

#include <stdbool.h>

struct gui_window;
struct nsfb_event_s;

/**
 * Attach the input layer to the browser window once the frontend has
 * created it. Starts the timer that applies stick and touch scrolling.
 */
void vita_input_attach(struct gui_window *gw);

/**
 * Handle a key event that reached the browser widget: D-pad link focus
 * and Cross activation. Returns true if the event was consumed.
 */
bool vita_input_key(struct gui_window *gw, const struct nsfb_event_s *event);

/**
 * Handle a key event before the toolkit dispatches it to the focused
 * widget: the buttons that act on the whole browser (back, forward,
 * reload, URL entry, pointer mode, menu, Circle). Returns true if the
 * event was consumed.
 */
bool vita_input_global_key(const struct nsfb_event_s *event);

/**
 * NetSurf placed the text caret in the page (a form field has focus).
 * x, y are content coordinates. If this follows a tap or an activation,
 * the system keyboard is opened for that field.
 */
void vita_input_caret(struct gui_window *gw, int x, int y, int height);

/** NetSurf removed the caret from the page. */
void vita_input_caret_removed(struct gui_window *gw);

/** The browser window the input layer is attached to, or NULL. */
struct gui_window *vita_input_window(void);

/** The window started loading (throbber on). */
void vita_input_load_started(struct gui_window *gw);

/** The window finished loading: logs the URL, elapsed time and heap. */
void vita_input_load_finished(struct gui_window *gw);

/**
 * Write the page's figures. Called when it finishes loading, and again
 * if it keeps working afterwards, which a page that renders itself does.
 */
void vita_input_report_page(struct gui_window *gw, unsigned int ms);

/**
 * How busy the scheduler was over the last span, once a second from the
 * frame loop, so a page that builds itself after it has loaded is
 * reported once it settles.
 */
void vita_input_settled(unsigned int sched_ms, unsigned int span_ms);

/**
 * Write the boxes of the page on screen to the log (VitaSurf).
 *
 * Does nothing unless the dumplayout flag file is there. The scripts
 * on an application page build most of it after the load, so the
 * boxes worth reading are the ones a rebuild leaves behind.
 */
void vita_input_dump_layout(void);

/**
 * Write the boxes of the page on screen to the log, flag or not (VitaSurf).
 *
 * What the Start menu's entry calls, so a page that comes out wrong can
 * be reported without creating a file on the memory card first.
 */
void vita_input_dump_layout_now(void);

#endif
