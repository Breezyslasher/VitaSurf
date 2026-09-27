/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * The newlib heap, sized from the memory the system actually gives us.
 *
 * VitaSDK's newlib takes its heap in _start, before main() and before any
 * constructor, as one memory block of _newlib_heap_size_user bytes; if the
 * block cannot be had there is no heap at all and the app dies before it
 * can log why. A fixed size therefore has to fit the smallest budget the
 * app could be given, and the rest of the budget sat unused: a build 472
 * log ran the heap to 178 of 180 MB on claude.ai with 60 MB of the app's
 * memory never touched.
 *
 * This file replaces newlib's sys/vita/sbrk.c (the same four functions, so
 * the linker never takes that object from libc.a). The heap is what is
 * free when the app starts, less a reserve for what is allocated outside
 * it later -- the screen's texture, the GPU's buffers, the network stack
 * and the system's dialogs. Asked for the extended memory budget
 * (ATTRIBUTE2=12 in the SFO), the same build takes the larger heap that
 * gives; not given it, it takes the ordinary one rather than failing.
 * _newlib_heap_size_user (vita_main.c) is still the size used if the free
 * memory cannot be read or the larger block cannot be had.
 */

#include <errno.h>
#include <reent.h>
#include <stddef.h>
#include <string.h>

#include <psp2/kernel/sysmem.h>
#include <psp2/kernel/threadmgr.h>

#include "vita_platform.h"

#ifndef VITASURF_HEAP_RESERVE_MB
#define VITASURF_HEAP_RESERVE_MB 32
#endif

#define MB (1024u * 1024u)

extern int _newlib_heap_size_user;

/* newlib's names for these, which its _start calls; they have no public
   header */
void _init_vita_heap(void);
void _free_vita_heap(void);
unsigned int _get_vita_heap_size(void);

static int heap_block;
static unsigned int heap_size;
static unsigned int heap_free_at_start;	/* bytes, before the heap */
static char *heap_base, *heap_end, *heap_cur;
static SceKernelLwMutexWork sbrk_mutex;

void *_sbrk_r(struct _reent *reent, ptrdiff_t incr)
{
	char *prev;

	if (sceKernelLockLwMutex(&sbrk_mutex, 1, 0) < 0) {
		goto fail;
	}
	if (heap_base == NULL || heap_cur + incr >= heap_end) {
		sceKernelUnlockLwMutex(&sbrk_mutex, 1);
fail:
		reent->_errno = ENOMEM;
		return (void *)-1;
	}
	prev = heap_cur;
	heap_cur += incr;
	sceKernelUnlockLwMutex(&sbrk_mutex, 1);
	return prev;
}

/* What is free now, less the reserve, in whole MB; 0 if it cannot tell. */
static unsigned int heap_from_free_memory(void)
{
	SceKernelFreeMemorySizeInfo info;
	unsigned int reserve = VITASURF_HEAP_RESERVE_MB * MB;

	memset(&info, 0, sizeof(info));
	info.size = sizeof(info);
	if (sceKernelGetFreeMemorySize(&info) < 0) {
		return 0;
	}
	heap_free_at_start = (unsigned int)info.size_user;
	if (heap_free_at_start <= reserve + 16 * MB) {
		return 0;
	}
	return (heap_free_at_start - reserve) & ~(MB - 1);
}

static int heap_take(unsigned int size)
{
	heap_block = sceKernelAllocMemBlock("Newlib heap", 0x0c20d060, size, 0);
	if (heap_block < 0) {
		heap_block = 0;
		return -1;
	}
	if (sceKernelGetMemBlockBase(heap_block, (void **)&heap_base) < 0) {
		sceKernelFreeMemBlock(heap_block);
		heap_block = 0;
		heap_base = NULL;
		return -1;
	}
	heap_size = size;
	heap_end = heap_base + size;
	heap_cur = heap_base;
	return 0;
}

void _init_vita_heap(void)
{
	unsigned int fallback = (unsigned int)_newlib_heap_size_user;
	unsigned int size;

	if (sceKernelCreateLwMutex(&sbrk_mutex, "sbrk mutex", 0, 0, 0) < 0) {
		return;
	}
	size = heap_from_free_memory();
	if (size != 0 && heap_take(size) == 0) {
		return;
	}
	(void)heap_take(fallback);
}

void _free_vita_heap(void)
{
	sceKernelDeleteLwMutex(&sbrk_mutex);
	if (heap_block != 0) {
		sceKernelFreeMemBlock(heap_block);
	}
	heap_block = 0;
	heap_base = heap_cur = heap_end = NULL;
}

unsigned int _get_vita_heap_size(void)
{
	return heap_size;
}

unsigned int vita_heap_size_kb(void)
{
	return heap_size / 1024;
}

unsigned int vita_heap_free_at_start_kb(void)
{
	return heap_free_at_start / 1024;
}
