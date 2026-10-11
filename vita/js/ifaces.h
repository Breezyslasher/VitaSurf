/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * The interfaces' WebIDL shapes, done in C for the prelude (ifaces.c).
 */

#ifndef VITASURF_IFACES_H
#define VITASURF_IFACES_H

#include "quickjs.h"

/* puts the natives interfaces.js and nodes.js call on obj */
void ifaces_register(JSContext *ctx, JSValueConst obj);

#endif
