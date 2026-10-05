/*
 * A small-block allocator for the QuickJS runtime (VitaSurf).
 *
 * This file is part of VitaSurf, and licensed under the GNU General
 * Public License, version 2.
 */

#ifndef VITASURF_QJS_ALLOC_H
#define VITASURF_QJS_ALLOC_H

#include <stddef.h>

#include "quickjs.h"

struct qjs_pool;

/**
 * Make a pool and the allocation functions that use it, for
 * JS_NewRuntime2(). The pool must outlive the runtime.
 */
struct qjs_pool *qjs_pool_create(void);
const JSMallocFunctions *qjs_pool_functions(void);

/** Give everything back. Only once the runtime has been freed. */
void qjs_pool_destroy(struct qjs_pool *pool);

/** What the pools have done, summed over all of them, for the log. */
struct qjs_pool_stats {
	unsigned int allocs;       /**< blocks handed out from a pool */
	unsigned int large;        /**< blocks too big, taken from malloc */
	unsigned int frees;        /**< blocks given back to a pool */
	unsigned int reallocs;     /**< reallocs answered in place */
	unsigned int batches;      /**< batches held now */
	unsigned int batches_peak; /**< the most held at once */
	unsigned int batches_freed;/**< batches given back to malloc */
};
void qjs_pool_stats(struct qjs_pool_stats *out);
void qjs_pool_stats_reset(void);

#endif
