/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#ifndef VITASURF_WASM_H
#define VITASURF_WASM_H

#include <quickjs.h>

/**
 * Put the native half of the WebAssembly JS API on the global object, as
 * __vitaWasm, for vita/js/wasm.js to build the API on. Nothing is added
 * if the runtime could not start.
 */
void vita_wasm_register(JSContext *ctx, JSValueConst global);

#endif
