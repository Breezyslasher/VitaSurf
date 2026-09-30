/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_INTL_H
#define VITASURF_INTL_H

#include <quickjs.h>

/**
 * Put the native half of Intl.DateTimeFormat on the global object, as
 * __vitaIntl, for vita/js/intl.js to build the API on: the time zone
 * database, the locale data and the formatter.
 */
void vita_intl_register(JSContext *ctx, JSValueConst global);

#endif
