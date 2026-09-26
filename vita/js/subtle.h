/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_SUBTLE_H
#define VITASURF_SUBTLE_H

#include <quickjs.h>

/**
 * Put the native half of crypto.subtle on the global object, as
 * __vitaSubtle, for vita/js/subtle.js to build the API on.
 */
void vita_subtle_register(JSContext *ctx, JSValueConst global);

#endif
