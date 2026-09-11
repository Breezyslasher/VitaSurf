/*
 * Start menu: bookmarks, history, settings, quit.
 *
 * The menu is a small fbtk window drawn over the page. Bookmarks and
 * history are shown as generated HTML pages under ux0:data/VitaSurf so the
 * normal page controls (touch, D-pad focus, Cross) work on them.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_MENU_H
#define VITASURF_MENU_H

#include <stdbool.h>

#include "libnsfb_event.h"

/** Open the menu if closed, close it if open. */
void vita_menu_toggle(void);

/** Close the menu if it is open. */
void vita_menu_close(void);

/** True while the menu is on screen. */
bool vita_menu_is_open(void);

/**
 * Handle a button while the menu is open: D-pad moves the selection,
 * Cross activates it, Circle and Start close the menu. Returns true if
 * the key was consumed.
 */
bool vita_menu_key(enum nsfb_key_code_e key, bool down);

/**
 * Save what must survive a LiveArea kill: cookies and the URL database.
 * Cheap enough to call after every page load; it rate-limits itself.
 */
void vita_menu_autosave(bool force);

#endif
