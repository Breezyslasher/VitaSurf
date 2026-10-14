/*
 * Site test (VitaSurf): load a list of websites one after another and
 * log what each cost. See vita_sitetest.c.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITA_SITETEST_H
#define VITA_SITETEST_H

#include <stdbool.h>

/** Start a run over the list in ux0:data/VitaSurf/sitetest.txt, or
 * carry on with one the browser ended in the middle of. */
void vita_sitetest_start(void);

/** Stop a run and write the results so far. */
void vita_sitetest_stop(void);

/** Whether a run ended without finishing, to be carried on. */
bool vita_sitetest_resumable(void);

/** Whether a run is going, and how far it has got. */
bool vita_sitetest_running(int *done, int *total);

/** The window has begun loading a page. */
void vita_sitetest_load_started(void);

/** The window's page has finished loading, in ms, at url (may be NULL). */
void vita_sitetest_load_finished(const char *url, unsigned int ms);

#endif
