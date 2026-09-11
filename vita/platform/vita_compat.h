/*
 * Compatibility definitions for building NetSurf against VitaSDK newlib.
 *
 * NetSurf's Makefile.config for the Vita force-includes this header into
 * every NetSurf compilation unit (-include). Keep it to definitions that
 * the toolchain's C library lacks; anything behavioural belongs in a patch
 * under patches/.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_COMPAT_H
#define VITASURF_COMPAT_H

#include <limits.h>

/* The installed newlib only defines PATH_MAX under BSD visibility. */
#ifndef PATH_MAX
#define PATH_MAX 1024
#endif

#endif
