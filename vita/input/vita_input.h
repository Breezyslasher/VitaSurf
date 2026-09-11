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

#endif
