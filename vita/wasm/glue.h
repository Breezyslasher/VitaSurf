/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * A small C interface to WAMR's interpreter for the WebAssembly JS API
 * (vita/js/wasm.c). glue.c is built into libvitawamr with WAMR's own
 * settings, because it reaches into structures whose layout depends on
 * them; this header uses none of WAMR's internal types, so the binding
 * can be built without them.
 *
 * Functions, tables, memories and globals are named by their index in an
 * instance, as the binary format numbers them (imports first). A value
 * travels as 32-bit cells, the interpreter's own form: i32, f32, funcref
 * and externref take one, i64 and f64 two. A funcref is a function index
 * of the instance it belongs to and an externref is a handle the binding
 * hands out; VW_NULL_REF is null for both.
 */

#ifndef VITASURF_WASM_GLUE_H
#define VITASURF_WASM_GLUE_H

#include <stdbool.h>
#include <stdint.h>

#include "wasm_c_api.h"

#define VW_NULL_REF 0xffffffffu

typedef struct vw_module vw_module;
typedef struct vw_instance vw_instance;

/** Start the runtime; false if it could not. */
bool vw_init(void);

/**
 * Compile a module. The bytes are copied as needed and may be freed
 * after. NULL with the reason in err on failure.
 */
vw_module *vw_module_load(const uint8_t *bytes, uint32_t len, char *err,
			  uint32_t err_len);
void vw_module_unref(vw_module *m);

/** What the host supplies for one imported function. */
typedef struct vw_func_link {
	wasm_func_callback_with_env_t cb;
	void *env;
} vw_func_link;

/**
 * What a new instance's imports link to, one entry per import of each
 * kind in the order the module imports them:
 *   funcs: the host function each imported function calls.
 *   globals: each imported global's value as two cells.
 *   global_owner, global_index: an instance and global to share, or NULL
 *     for a global of its own holding the value given.
 *   mem_owner, mem_index and table_owner, table_index: the same for
 *     memories and tables; NULL makes a new one.
 * Any array may be NULL when the module imports nothing of its kind.
 */
typedef struct vw_links {
	const vw_func_link *funcs;
	const uint32_t *globals;
	vw_instance *const *global_owner;
	const uint32_t *global_index;
	vw_instance *const *mem_owner;
	const uint32_t *mem_index;
	vw_instance *const *table_owner;
	const uint32_t *table_index;
} vw_links;

/**
 * Instantiate a module and run its start function. The instances it
 * shares with are held while it lives. max_pages caps any memory's
 * growth. NULL on failure, with the reason in err and *trapped true when
 * the failure was a trap (including one a host function raised) rather
 * than a problem instantiating.
 */
vw_instance *vw_instantiate(vw_module *m, const vw_links *links,
			    uint32_t stack_size, uint32_t max_pages,
			    char *err, uint32_t err_len, bool *trapped);
void vw_instance_ref(vw_instance *inst);
void vw_instance_unref(vw_instance *inst);

/**
 * Call function func_index of an instance. cells holds the arguments and
 * receives the results. False on a trap, with its message in err.
 */
bool vw_call(vw_instance *inst, uint32_t func_index, uint32_t *cells,
	     uint32_t arg_cells, char *err, uint32_t err_len);

/** Whether any wasm code is running (the host is inside a call). */
bool vw_busy(void);

/** A trap with a message, for a host function to return. */
wasm_trap_t *vw_trap_new(const char *message);

/*
 * Memory. The data pointer moves when a memory grows, so it is only good
 * until the next wasm call or grow. vw_memory_key names the memory
 * itself, the same for every instance that shares it.
 */
uint8_t *vw_memory_data(vw_instance *inst, uint32_t index, uint32_t *bytes);
uint32_t vw_memory_pages(vw_instance *inst, uint32_t index);
uint32_t vw_memory_max_pages(vw_instance *inst, uint32_t index);
/** The old size in pages, or -1 if the memory cannot grow that far. */
int32_t vw_memory_grow(vw_instance *inst, uint32_t index, uint32_t delta);
const void *vw_memory_key(vw_instance *inst, uint32_t index);

/* Tables hold cells: function indexes of the instance, or handles. */
uint32_t vw_table_size(vw_instance *inst, uint32_t index);
/** How far the table can grow: its maximum, or what was set aside. */
uint32_t vw_table_capacity(vw_instance *inst, uint32_t index);
bool vw_table_get(vw_instance *inst, uint32_t index, uint32_t at,
		  uint32_t *cell);
bool vw_table_set(vw_instance *inst, uint32_t index, uint32_t at,
		  uint32_t cell);
/** The old size, or -1. */
int32_t vw_table_grow(vw_instance *inst, uint32_t index, uint32_t delta,
		      uint32_t init);
/** Whether the table holds externrefs rather than functions. */
bool vw_table_is_extern(vw_instance *inst, uint32_t index);
const void *vw_table_key(vw_instance *inst, uint32_t index);

/* Globals: two cells either way. */
void vw_global_get(vw_instance *inst, uint32_t index, uint32_t cells[2]);
void vw_global_set(vw_instance *inst, uint32_t index, const uint32_t cells[2]);
const void *vw_global_key(vw_instance *inst, uint32_t index);

/** Call mark for every externref handle held in globals and tables. */
void vw_mark_externrefs(vw_instance *inst, void (*mark)(uint32_t, void *),
			void *ud);

#endif
