/*
 * System IME dialog for text entry.
 *
 * The dialog is asynchronous: start it, then poll from the main loop. The
 * buffers it works on are static and live for the whole process, which
 * the IME requires.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_IME_H
#define VITASURF_IME_H

#include <stdbool.h>
#include <stddef.h>

/* Longest text the dialog accepts, in UTF-16 units. */
#define VITA_IME_MAX_LENGTH 1023

enum vita_ime_status {
	VITA_IME_IDLE,      /**< no dialog, nothing to report */
	VITA_IME_RUNNING,   /**< dialog on screen */
	VITA_IME_DONE,      /**< user pressed enter; text was filled in */
	VITA_IME_CANCELLED  /**< user closed the dialog */
};

/**
 * Show the IME dialog. Returns 0 on success or a negative SCE error, in
 * which case the caller should fall back to another input method.
 */
int vita_ime_start(const char *title, const char *initial, bool multiline);

/**
 * Poll the dialog. When it returns VITA_IME_DONE the entered text has been
 * written to out as UTF-8. Any other value leaves out untouched.
 */
enum vita_ime_status vita_ime_poll(char *out, size_t outlen);

/** True while the dialog is on screen. */
bool vita_ime_running(void);

#endif
