/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * WAMR's interpreter behind the interface in glue.h. This file is built
 * into libvitawamr, with WAMR's settings, and is the one place outside
 * WAMR that knows its structures.
 *
 * Imports are linked per instance through patches/0246 (WASMImportLinks):
 * each imported function calls a host callback in the wasm-c-api
 * convention, set up before the start function runs; each imported
 * memory, table and global can be another instance's, shared.
 */

#include <string.h>

#include "wasm_export.h"
#include "wasm_c_api_internal.h"
#include "wasm_runtime_common.h"
#include "../interpreter/wasm_runtime.h"

#include "glue.h"

struct vw_module {
	int refs;
	wasm_module_t module;
};

struct vw_instance {
	int refs;
	vw_module *m;
	wasm_module_inst_t inst;
	wasm_exec_env_t env;
	/* instances whose memories, tables and globals this one shares,
	   held while it lives */
	vw_instance **owners;
	uint32_t owner_count;
};

static unsigned busy;

static WASMModuleInstance *
mi(vw_instance *inst)
{
	return (WASMModuleInstance *)inst->inst;
}

static void
copy_err(char *err, uint32_t err_len, const char *msg)
{
	if (err == NULL || err_len == 0) {
		return;
	}
	strncpy(err, msg ? msg : "", err_len - 1);
	err[err_len - 1] = '\0';
}

bool
vw_init(void)
{
	RuntimeInitArgs args;

	memset(&args, 0, sizeof(args));
	args.mem_alloc_type = Alloc_With_System_Allocator;
	if (!wasm_runtime_full_init(&args)) {
		return false;
	}
	/* a page's modules are the page's business; only errors are ours */
	wasm_runtime_set_log_level(WASM_LOG_LEVEL_ERROR);
	return true;
}

vw_module *
vw_module_load(const uint8_t *bytes, uint32_t len, char *err, uint32_t err_len)
{
	LoadArgs args;
	vw_module *m;
	uint8_t *copy;

	m = wasm_runtime_malloc(sizeof(*m));
	/* the loader may keep pointers into what it is given until the
	   copy it makes is done, and it must not see the caller's buffer
	   change */
	copy = wasm_runtime_malloc(len ? len : 1);
	if (m == NULL || copy == NULL) {
		if (m) wasm_runtime_free(m);
		if (copy) wasm_runtime_free(copy);
		copy_err(err, err_len, "out of memory");
		return NULL;
	}
	memcpy(copy, bytes, len);
	memset(&args, 0, sizeof(args));
	args.name = "";
	args.wasm_binary_freeable = true;
	m->module = wasm_runtime_load_ex(copy, len, &args, err, err_len);
	wasm_runtime_free(copy);
	if (m->module == NULL) {
		wasm_runtime_free(m);
		return NULL;
	}
	m->refs = 1;
	return m;
}

void
vw_module_unref(vw_module *m)
{
	if (m != NULL && --m->refs == 0) {
		wasm_runtime_unload(m->module);
		wasm_runtime_free(m);
	}
}

/* note an instance this one shares with, to hold while it lives */
static void
hold(vw_instance *inst, vw_instance *owner)
{
	if (owner != NULL) {
		inst->owners[inst->owner_count++] = owner;
	}
}

vw_instance *
vw_instantiate(vw_module *m, const vw_links *l, uint32_t stack_size,
	       uint32_t max_pages, char *err, uint32_t err_len, bool *trapped)
{
	WASMModule *module = (WASMModule *)m->module;
	uint32_t nf = module->import_function_count;
	uint32_t ng = module->import_global_count;
	uint32_t nm = module->import_memory_count;
	uint32_t nt = module->import_table_count;
	CApiFuncImport *capi = NULL;
	WASMValue *values = NULL;
	WASMMemoryInstance **mems = NULL;
	WASMTableInstance **tabs = NULL;
	uint8 **gaddrs = NULL;
	WASMImportLinks links;
	InstantiationArgs args;
	vw_instance *inst;
	uint32_t i;

	*trapped = false;
	inst = wasm_runtime_malloc(sizeof(*inst));
	if (inst == NULL) {
		copy_err(err, err_len, "out of memory");
		return NULL;
	}
	memset(inst, 0, sizeof(*inst));
	if ((nf && !(capi = wasm_runtime_malloc(sizeof(*capi) * nf))) ||
	    (ng && !(values = wasm_runtime_malloc(sizeof(*values) * ng))) ||
	    (ng && !(gaddrs = wasm_runtime_malloc(sizeof(*gaddrs) * ng))) ||
	    (nm && !(mems = wasm_runtime_malloc(sizeof(*mems) * nm))) ||
	    (nt && !(tabs = wasm_runtime_malloc(sizeof(*tabs) * nt))) ||
	    (ng + nm + nt &&
	     !(inst->owners = wasm_runtime_malloc(sizeof(vw_instance *) *
						  (ng + nm + nt))))) {
		copy_err(err, err_len, "out of memory");
		goto fail;
	}
	for (i = 0; i < nf; i++) {
		capi[i].func_ptr_linked = (void *)l->funcs[i].cb;
		capi[i].with_env_arg = true;
		capi[i].env_arg = l->funcs[i].env;
	}
	for (i = 0; i < ng; i++) {
		vw_instance *o = l->global_owner ? l->global_owner[i] : NULL;

		memset(&values[i], 0, sizeof(values[i]));
		memcpy(&values[i], l->globals + 2 * i, 8);
		gaddrs[i] = NULL;
		if (o != NULL) {
			WASMModuleInstance *om = mi(o);
			WASMGlobalInstance *g;

			if (l->global_index[i] >= om->e->global_count) {
				copy_err(err, err_len, "unknown global");
				goto fail;
			}
			g = om->e->globals + l->global_index[i];
			gaddrs[i] = g->linked_data ? g->linked_data
					: om->global_data + g->data_offset;
		}
	}
	for (i = 0; i < nm; i++) {
		vw_instance *o = l->mem_owner ? l->mem_owner[i] : NULL;

		mems[i] = NULL;
		if (o != NULL) {
			if (l->mem_index[i] >= mi(o)->memory_count) {
				copy_err(err, err_len, "unknown memory");
				goto fail;
			}
			mems[i] = mi(o)->memories[l->mem_index[i]];
		}
	}
	for (i = 0; i < nt; i++) {
		vw_instance *o = l->table_owner ? l->table_owner[i] : NULL;

		tabs[i] = NULL;
		if (o != NULL) {
			if (l->table_index[i] >= mi(o)->table_count) {
				copy_err(err, err_len, "unknown table");
				goto fail;
			}
			tabs[i] = mi(o)->tables[l->table_index[i]];
		}
	}

	links.funcs = capi;
	links.globals = values;
	links.global_addrs = gaddrs;
	links.memories = mems;
	links.tables = tabs;
	memset(&args, 0, sizeof(args));
	args.default_stack_size = stack_size;
	args.max_memory_pages = max_pages;
	busy++;
	wasm_set_next_import_links(&links);
	inst->inst = wasm_runtime_instantiate_ex(m->module, &args, err, err_len);
	wasm_set_next_import_links(NULL);
	busy--;
	if (inst->inst == NULL) {
		/* the start function runs last; what it raises is a trap,
		   reported as "...: Exception: <what>" */
		char *x = strstr(err, "Exception: ");

		if (x != NULL) {
			*trapped = true;
			memmove(err, x + 11, strlen(x + 11) + 1);
		}
		goto fail;
	}
	/* the stack to call it on is made at its first call: a Memory, Table
	   or Global made from script is an instance that is never called */
	/* what it shares lives as long as it does */
	for (i = 0; i < ng; i++) {
		if (gaddrs[i]) hold(inst, l->global_owner[i]);
	}
	for (i = 0; i < nm; i++) {
		if (mems[i]) hold(inst, l->mem_owner[i]);
	}
	for (i = 0; i < nt; i++) {
		if (tabs[i]) hold(inst, l->table_owner[i]);
	}
	for (i = 0; i < inst->owner_count; i++) {
		vw_instance_ref(inst->owners[i]);
	}
	inst->refs = 1;
	inst->m = m;
	m->refs++;
	if (capi) wasm_runtime_free(capi);
	if (values) wasm_runtime_free(values);
	if (gaddrs) wasm_runtime_free(gaddrs);
	if (mems) wasm_runtime_free(mems);
	if (tabs) wasm_runtime_free(tabs);
	return inst;

fail:
	if (capi) wasm_runtime_free(capi);
	if (values) wasm_runtime_free(values);
	if (gaddrs) wasm_runtime_free(gaddrs);
	if (mems) wasm_runtime_free(mems);
	if (tabs) wasm_runtime_free(tabs);
	if (inst->owners) wasm_runtime_free(inst->owners);
	wasm_runtime_free(inst);
	return NULL;
}

void
vw_instance_ref(vw_instance *inst)
{
	inst->refs++;
}

void
vw_instance_unref(vw_instance *inst)
{
	uint32_t i;

	if (inst == NULL || --inst->refs > 0) {
		return;
	}
	wasm_runtime_deinstantiate(inst->inst);
	for (i = 0; i < inst->owner_count; i++) {
		vw_instance_unref(inst->owners[i]);
	}
	if (inst->owners) wasm_runtime_free(inst->owners);
	vw_module_unref(inst->m);
	wasm_runtime_free(inst);
}

bool
vw_call(vw_instance *inst, uint32_t func_index, uint32_t *cells,
	uint32_t arg_cells, char *err, uint32_t err_len)
{
	WASMModuleInstance *m = mi(inst);
	bool ok;

	if (func_index >= m->e->function_count) {
		copy_err(err, err_len, "unknown function");
		return false;
	}
	if (inst->env == NULL) {
		inst->env = wasm_runtime_get_exec_env_singleton(inst->inst);
		if (inst->env == NULL) {
			copy_err(err, err_len, "out of memory");
			return false;
		}
	}
	busy++;
	/* straight to the interpreter: wasm_runtime_call_wasm would turn
	   externref cells into WAMR's own handles */
	ok = wasm_call_function(inst->env, m->e->functions + func_index,
				arg_cells, cells);
	busy--;
	if (!ok) {
		const char *e = wasm_runtime_get_exception(inst->inst);

		if (e != NULL && strncmp(e, "Exception: ", 11) == 0) {
			e += 11;
		}
		copy_err(err, err_len, e ? e : "trap");
		wasm_runtime_clear_exception(inst->inst);
	}
	return ok;
}

bool
vw_busy(void)
{
	return busy > 0;
}

wasm_trap_t *
vw_trap_new(const char *message)
{
	wasm_trap_t *trap = wasm_runtime_malloc(sizeof(*trap));
	size_t n = strlen(message);

	if (trap == NULL) {
		return NULL;
	}
	memset(trap, 0, sizeof(*trap));
	trap->message = wasm_runtime_malloc(sizeof(*trap->message));
	if (trap->message == NULL) {
		wasm_runtime_free(trap);
		return NULL;
	}
	wasm_byte_vec_new(trap->message, n, message);
	return trap;
}

/* ------------------------------------------------------------------------ */

static WASMMemoryInstance *
memory(vw_instance *inst, uint32_t index)
{
	WASMModuleInstance *m = mi(inst);

	return index < m->memory_count ? m->memories[index] : NULL;
}

uint8_t *
vw_memory_data(vw_instance *inst, uint32_t index, uint32_t *bytes)
{
	WASMMemoryInstance *mem = memory(inst, index);

	*bytes = mem ? (uint32_t)mem->memory_data_size : 0;
	return mem ? mem->memory_data : NULL;
}

uint32_t
vw_memory_pages(vw_instance *inst, uint32_t index)
{
	WASMMemoryInstance *mem = memory(inst, index);

	return mem ? mem->cur_page_count : 0;
}

uint32_t
vw_memory_max_pages(vw_instance *inst, uint32_t index)
{
	WASMMemoryInstance *mem = memory(inst, index);

	return mem ? mem->max_page_count : 0;
}

int32_t
vw_memory_grow(vw_instance *inst, uint32_t index, uint32_t delta)
{
	WASMMemoryInstance *mem = memory(inst, index);
	uint32_t old;

	if (mem == NULL) {
		return -1;
	}
	old = mem->cur_page_count;
	if (delta == 0) {
		return (int32_t)old;
	}
	if (!wasm_memory_enlarge((wasm_memory_inst_t)mem, delta)) {
		return -1;
	}
	return (int32_t)old;
}

const void *
vw_memory_key(vw_instance *inst, uint32_t index)
{
	return memory(inst, index);
}

static WASMTableInstance *
table(vw_instance *inst, uint32_t index)
{
	WASMModuleInstance *m = mi(inst);

	return index < m->table_count ? m->tables[index] : NULL;
}

uint32_t
vw_table_size(vw_instance *inst, uint32_t index)
{
	WASMTableInstance *t = table(inst, index);

	return t ? t->cur_size : 0;
}

uint32_t
vw_table_capacity(vw_instance *inst, uint32_t index)
{
	WASMTableInstance *t = table(inst, index);

	return t ? t->max_size : 0;
}

bool
vw_table_get(vw_instance *inst, uint32_t index, uint32_t at, uint32_t *cell)
{
	WASMTableInstance *t = table(inst, index);

	if (t == NULL || at >= t->cur_size) {
		return false;
	}
	*cell = (uint32_t)t->elems[at];
	return true;
}

bool
vw_table_set(vw_instance *inst, uint32_t index, uint32_t at, uint32_t cell)
{
	WASMTableInstance *t = table(inst, index);

	if (t == NULL || at >= t->cur_size) {
		return false;
	}
	t->elems[at] = cell;
	return true;
}

int32_t
vw_table_grow(vw_instance *inst, uint32_t index, uint32_t delta,
	      uint32_t init)
{
	WASMTableInstance *t = table(inst, index);
	uint32_t old;

	if (t == NULL) {
		return -1;
	}
	old = t->cur_size;
	if (delta == 0) {
		return (int32_t)old;
	}
	if (!wasm_enlarge_table(mi(inst), index, delta, init)) {
		return -1;
	}
	return (int32_t)old;
}

bool
vw_table_is_extern(vw_instance *inst, uint32_t index)
{
	WASMTableInstance *t = table(inst, index);

	return t != NULL && t->elem_type == VALUE_TYPE_EXTERNREF;
}

const void *
vw_table_key(vw_instance *inst, uint32_t index)
{
	return table(inst, index);
}

static uint8_t *
global_addr(vw_instance *inst, uint32_t index, uint8_t *type)
{
	WASMModuleInstance *m = mi(inst);
	WASMGlobalInstance *g;

	if (index >= m->e->global_count) {
		return NULL;
	}
	g = m->e->globals + index;
	*type = g->type;
	return g->linked_data ? g->linked_data : m->global_data + g->data_offset;
}

void
vw_global_get(vw_instance *inst, uint32_t index, uint32_t cells[2])
{
	uint8_t type = 0;
	uint8_t *p = global_addr(inst, index, &type);

	cells[0] = cells[1] = 0;
	if (p != NULL) {
		memcpy(cells, p, wasm_value_type_size(type));
	}
}

void
vw_global_set(vw_instance *inst, uint32_t index, const uint32_t cells[2])
{
	uint8_t type = 0;
	uint8_t *p = global_addr(inst, index, &type);

	if (p != NULL) {
		memcpy(p, cells, wasm_value_type_size(type));
	}
}

const void *
vw_global_key(vw_instance *inst, uint32_t index)
{
	uint8_t type = 0;

	return global_addr(inst, index, &type);
}

void
vw_mark_externrefs(vw_instance *inst, void (*mark)(uint32_t, void *),
		   void *ud)
{
	WASMModuleInstance *m = mi(inst);
	uint32_t i, j;

	for (i = 0; i < m->e->global_count; i++) {
		WASMGlobalInstance *g = m->e->globals + i;

		if (g->type == VALUE_TYPE_EXTERNREF) {
			uint32_t h;

			memcpy(&h, g->linked_data ? g->linked_data
				   : m->global_data + g->data_offset, 4);
			if (h != VW_NULL_REF) {
				mark(h, ud);
			}
		}
	}
	for (i = 0; i < m->table_count; i++) {
		WASMTableInstance *t = m->tables[i];

		if (t->elem_type != VALUE_TYPE_EXTERNREF) {
			continue;
		}
		for (j = 0; j < t->cur_size; j++) {
			if ((uint32_t)t->elems[j] != VW_NULL_REF) {
				mark((uint32_t)t->elems[j], ud);
			}
		}
	}
}
