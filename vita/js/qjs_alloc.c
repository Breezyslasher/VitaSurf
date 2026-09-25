/*
 * A small-block allocator for the QuickJS runtime (VitaSurf).
 *
 * This file is part of VitaSurf, and licensed under the GNU General
 * Public License, version 2.
 *
 * Why: newlib's malloc takes a lock on every call, and on the Vita a
 * small allocation costs about 0.7 us and a free about 0.6 us however
 * short the free list is -- the probe in vita_platform.c measures it at
 * startup. QuickJS allocates for nearly every object, string, closure
 * and property table it makes, all of it on the one thread script runs
 * on, so none of that locking buys anything.
 *
 * How: blocks of up to 512 bytes come from 16 KB pages, each page
 * serving one size class, with its own free list and a bump pointer for
 * the part never yet used. Pages come eight at a time in 128 KB
 * batches taken from malloc -- one page more than that, since newlib on
 * the Vita has no aligned allocation and the pages are aligned by
 * rounding up inside it -- and a page nothing uses any more goes to a
 * pool any size class can take from; once a whole batch is unused and
 * the pool holds more than a couple of batches' worth, the batch goes
 * back to malloc, so what is held follows what script is using.
 * Anything bigger goes to malloc as before.
 *
 * QuickJS asks the size of a block with nothing but its address, so
 * the pages are found from an address through one small hash table
 * for the whole program, and every runtime shares one set of pools.
 * Script only ever runs on the main thread.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#ifdef __GLIBC__
#include <malloc.h>
#endif

#include "qjs_alloc.h"

#define PAGE_SHIFT 14
#define PAGE_SIZE ((uintptr_t) 1 << PAGE_SHIFT)
#define BATCH_SHIFT 17
#define BATCH_SIZE ((uintptr_t) 1 << BATCH_SHIFT)
#define PAGES_PER_BATCH (1u << (BATCH_SHIFT - PAGE_SHIFT))

/* the largest block the pools serve */
#define MAX_SMALL 512

/* empty pages kept for reuse before whole batches go back */
#define KEEP_EMPTY_PAGES (2 * PAGES_PER_BATCH)

/* blocks are aligned to twice a pointer: 8 bytes here, 16 on a host */
#define GRAN (2 * sizeof(void *))

#define NO_CLASS 0xffffu

struct pa_batch {
	void *raw;                 /**< what malloc gave */
	char *base;                /**< the first page, aligned */
	unsigned int empty;        /**< pages of this batch in the pool */
};

struct pa_page {
	struct pa_page *prev;      /**< in a class's list, or the pool */
	struct pa_page *next;
	void *free;                /**< blocks given back */
	char *bump;                /**< the part never handed out */
	char *end;
	struct pa_batch *batch;
	uint16_t cls;              /**< size class, or NO_CLASS in the pool */
	uint16_t live;             /**< blocks handed out */
	uint8_t listed;            /**< in its class's list of pages with room */
};

#define ROUND_UP(x, a) (((x) + ((a) - 1)) & ~((uintptr_t) (a) - 1))
#define PAGE_HDR ROUND_UP(sizeof(struct pa_page), 16)

struct pa_class {
	struct pa_page *avail;     /**< pages with room, most recent first */
	uint32_t size;
};

#define MAX_CLASSES 32

static struct {
	bool ready;
	unsigned int users;
	unsigned int n_classes;
	struct pa_class classes[MAX_CLASSES];
	uint8_t class_of[MAX_SMALL / 8 + 1];

	struct pa_page *empty;     /**< the pool of pages no class holds */
	unsigned int n_empty;

	uintptr_t *table;          /**< page addresses, 0 for a free slot */
	unsigned int table_bits;
	unsigned int table_count;

	struct qjs_pool_stats stats;
} pa;

/* --- the page table --------------------------------------------------- */

static inline unsigned int table_slot(uintptr_t base, unsigned int bits)
{
	uint32_t k = (uint32_t) (base >> PAGE_SHIFT);

	return (unsigned int) ((k * 0x9e3779b1u) >> (32 - bits));
}

/** Whether p is in one of the pools' pages, rather than from malloc. */
static inline bool ours(const void *p)
{
	uintptr_t base = (uintptr_t) p & ~(PAGE_SIZE - 1);
	unsigned int mask, i;

	if (pa.table == NULL)
		return false;
	mask = (1u << pa.table_bits) - 1;
	for (i = table_slot(base, pa.table_bits);; i = (i + 1) & mask) {
		uintptr_t k = pa.table[i];

		if (k == base)
			return true;
		if (k == 0)
			return false;
	}
}

static bool table_insert_raw(uintptr_t *table, unsigned int bits,
		uintptr_t base)
{
	unsigned int mask = (1u << bits) - 1, i;

	for (i = table_slot(base, bits); table[i] != 0; i = (i + 1) & mask)
		;
	table[i] = base;
	return true;
}

static bool table_insert(uintptr_t base)
{
	if (pa.table == NULL || (pa.table_count + 1) * 2 >
			(1u << pa.table_bits)) {
		unsigned int bits = (pa.table == NULL) ? 6 : pa.table_bits + 1;
		uintptr_t *t = calloc((size_t) 1 << bits, sizeof(*t));
		unsigned int i;

		if (t == NULL)
			return false;
		if (pa.table != NULL) {
			for (i = 0; i < (1u << pa.table_bits); i++) {
				if (pa.table[i] != 0)
					table_insert_raw(t, bits, pa.table[i]);
			}
			free(pa.table);
		}
		pa.table = t;
		pa.table_bits = bits;
	}
	table_insert_raw(pa.table, pa.table_bits, base);
	pa.table_count++;
	return true;
}

/* Linear probing, so a removal shifts back what follows it. */
static void table_remove(uintptr_t base)
{
	unsigned int mask = (1u << pa.table_bits) - 1;
	unsigned int i = table_slot(base, pa.table_bits), j;

	while (pa.table[i] != base)
		i = (i + 1) & mask;
	pa.table[i] = 0;
	pa.table_count--;

	for (j = (i + 1) & mask; pa.table[j] != 0; j = (j + 1) & mask) {
		uintptr_t k = pa.table[j];
		unsigned int home = table_slot(k, pa.table_bits);

		/* move k back into the hole if its home is not in (i, j] */
		if (((j - home) & mask) >= ((j - i) & mask)) {
			pa.table[i] = k;
			pa.table[j] = 0;
			i = j;
		}
	}
}

/* --- pages -------------------------------------------------------------- */

static inline struct pa_page *page_of(const void *p)
{
	return (struct pa_page *) ((uintptr_t) p & ~(PAGE_SIZE - 1));
}

static inline void list_unlink(struct pa_page **head, struct pa_page *p)
{
	if (p->prev != NULL)
		p->prev->next = p->next;
	else
		*head = p->next;
	if (p->next != NULL)
		p->next->prev = p->prev;
	p->prev = p->next = NULL;
}

static inline void list_push(struct pa_page **head, struct pa_page *p)
{
	p->prev = NULL;
	p->next = *head;
	if (*head != NULL)
		(*head)->prev = p;
	*head = p;
}

static bool batch_new(void)
{
	struct pa_batch *b = malloc(sizeof(*b));
	unsigned int i;

	if (b == NULL)
		return false;
	/* one page over, so that eight aligned pages fit whatever the start */
	b->raw = malloc(BATCH_SIZE + PAGE_SIZE);
	if (b->raw == NULL) {
		free(b);
		return false;
	}
	b->base = (char *) ROUND_UP((uintptr_t) b->raw, PAGE_SIZE);
	for (i = 0; i < PAGES_PER_BATCH; i++) {
		if (!table_insert((uintptr_t) (b->base + i * PAGE_SIZE))) {
			while (i-- > 0)
				table_remove((uintptr_t) (b->base +
						i * PAGE_SIZE));
			free(b->raw);
			free(b);
			return false;
		}
	}
	b->empty = PAGES_PER_BATCH;
	for (i = 0; i < PAGES_PER_BATCH; i++) {
		struct pa_page *p = page_of(b->base + i * PAGE_SIZE);

		memset(p, 0, sizeof(*p));
		p->batch = b;
		p->cls = NO_CLASS;
		list_push(&pa.empty, p);
		pa.n_empty++;
	}
	pa.stats.batches++;
	if (pa.stats.batches > pa.stats.batches_peak)
		pa.stats.batches_peak = pa.stats.batches;
	return true;
}

static void batch_free(struct pa_batch *b)
{
	unsigned int i;

	for (i = 0; i < PAGES_PER_BATCH; i++) {
		struct pa_page *p = page_of(b->base + i * PAGE_SIZE);

		list_unlink(&pa.empty, p);
		pa.n_empty--;
		table_remove((uintptr_t) p);
	}
	free(b->raw);
	free(b);
	pa.stats.batches--;
	pa.stats.batches_freed++;
}

/** A page for class c, from the pool or a new batch. */
static struct pa_page *page_get(unsigned int c)
{
	struct pa_page *p;
	uintptr_t start, base;
	uint32_t size = pa.classes[c].size;

	if (pa.empty == NULL && !batch_new())
		return NULL;
	p = pa.empty;
	list_unlink(&pa.empty, p);
	pa.n_empty--;
	p->batch->empty--;

	base = (uintptr_t) p & ~(PAGE_SIZE - 1);
	start = ROUND_UP((uintptr_t) p + PAGE_HDR, GRAN);
	p->cls = (uint16_t) c;
	p->live = 0;
	p->free = NULL;
	p->bump = (char *) start;
	p->end = (char *) (start + ((base + PAGE_SIZE - start) / size) * size);
	p->listed = 1;
	list_push(&pa.classes[c].avail, p);
	return p;
}

/** A page nothing uses: to the pool, unless its class has no other. */
static void page_release(struct pa_page *p)
{
	struct pa_class *k = &pa.classes[p->cls];
	struct pa_batch *b = p->batch;

	if (p->listed && k->avail == p && p->next == NULL)
		return;
	if (p->listed)
		list_unlink(&k->avail, p);
	p->listed = 0;
	p->cls = NO_CLASS;
	list_push(&pa.empty, p);
	pa.n_empty++;
	b->empty++;

	if (b->empty == PAGES_PER_BATCH && pa.n_empty > KEEP_EMPTY_PAGES)
		batch_free(b);
}

/* --- set up ------------------------------------------------------------ */

static void pa_init(void)
{
	uint32_t s;
	unsigned int n = 0, i;

	/* every GRAN to 128, then steps of 32 to 256 and 64 to 512 */
	for (s = GRAN; s <= 128; s += GRAN)
		pa.classes[n++].size = s;
	for (s = 160; s <= 256; s += 32)
		pa.classes[n++].size = s;
	for (s = 320; s <= MAX_SMALL; s += 64)
		pa.classes[n++].size = s;
	pa.n_classes = n;

	for (i = 0; i <= MAX_SMALL / 8; i++) {
		uint32_t want = (i == 0) ? 1 : i * 8;
		unsigned int c = 0;

		while (pa.classes[c].size < want)
			c++;
		pa.class_of[i] = (uint8_t) c;
	}
	pa.ready = true;
}

/* --- the functions QuickJS calls ----------------------------------------- */

static void *pa_malloc(void *opaque, size_t size)
{
	unsigned int c;
	struct pa_page *p;
	void *obj;
	uint32_t cs;

	(void) opaque;
	if (size > MAX_SMALL) {
		pa.stats.large++;
		return malloc(size);
	}
	c = pa.class_of[(size + 7) >> 3];
	p = pa.classes[c].avail;
	if (p == NULL) {
		p = page_get(c);
		if (p == NULL)
			return NULL;
	}
	cs = pa.classes[c].size;
	obj = p->free;
	if (obj != NULL) {
		p->free = *(void **) obj;
	} else {
		obj = p->bump;
		p->bump += cs;
	}
	p->live++;
	if (p->free == NULL && p->bump + cs > p->end) {
		list_unlink(&pa.classes[c].avail, p);
		p->listed = 0;
	}
	pa.stats.allocs++;
	return obj;
}

static void pa_free(void *opaque, void *ptr)
{
	struct pa_page *p;

	(void) opaque;
	if (ptr == NULL)
		return;
	if (!ours(ptr)) {
		free(ptr);
		return;
	}
	p = page_of(ptr);
	*(void **) ptr = p->free;
	p->free = ptr;
	p->live--;
	pa.stats.frees++;
	if (!p->listed) {
		list_push(&pa.classes[p->cls].avail, p);
		p->listed = 1;
	}
	if (p->live == 0)
		page_release(p);
}

static void *pa_calloc(void *opaque, size_t count, size_t size)
{
	size_t n = count * size;
	void *p;

	if (n > MAX_SMALL) {
		pa.stats.large++;
		return calloc(count, size);
	}
	p = pa_malloc(opaque, n);
	if (p != NULL)
		memset(p, 0, n);
	return p;
}

static size_t pa_usable_size(const void *ptr)
{
	if (ptr == NULL)
		return 0;
	if (ours(ptr))
		return pa.classes[page_of(ptr)->cls].size;
	/* what QuickJS's own functions say for a block from malloc */
#ifdef __GLIBC__
	return malloc_usable_size((void *) ptr);
#else
	return 0;
#endif
}

static void *pa_realloc(void *opaque, void *ptr, size_t size)
{
	void *n;

	if (ptr == NULL)
		return pa_malloc(opaque, size);
	if (size == 0) {
		pa_free(opaque, ptr);
		return NULL;
	}
	if (ours(ptr)) {
		uint32_t cs = pa.classes[page_of(ptr)->cls].size;

		/* it still fits, and would not fit a class half the size */
		if (size <= cs && (size > cs / 2 || cs <= 2 * GRAN)) {
			pa.stats.reallocs++;
			return ptr;
		}
		n = pa_malloc(opaque, size);
		if (n == NULL)
			return NULL;
		memcpy(n, ptr, size < cs ? size : cs);
		pa_free(opaque, ptr);
		return n;
	}
	/*
	 * From malloc, so bigger than any class: it stays with malloc
	 * unless it now fits one, when only the first size bytes matter.
	 */
	if (size > MAX_SMALL)
		return realloc(ptr, size);
	n = pa_malloc(opaque, size);
	if (n == NULL)
		return NULL;
	memcpy(n, ptr, size);
	free(ptr);
	return n;
}

static const JSMallocFunctions pa_functions = {
	pa_calloc,
	pa_malloc,
	pa_free,
	pa_realloc,
	pa_usable_size,
};

/* --- the interface ------------------------------------------------------- */

struct qjs_pool *qjs_pool_create(void)
{
	if (!pa.ready)
		pa_init();
	pa.users++;
	return (struct qjs_pool *) &pa;
}

const JSMallocFunctions *qjs_pool_functions(void)
{
	return &pa_functions;
}

void qjs_pool_destroy(struct qjs_pool *pool)
{
	(void) pool;
	if (pa.users == 0)
		return;
	pa.users--;
	if (pa.users != 0)
		return;

	/*
	 * No runtime left, so every page should be empty but the one each
	 * class kept: put those back too, and give back every batch.
	 */
	{
		unsigned int c;

		for (c = 0; c < pa.n_classes; c++) {
			struct pa_page *p = pa.classes[c].avail;

			while (p != NULL) {
				struct pa_page *next = p->next;

				if (p->live == 0) {
					list_unlink(&pa.classes[c].avail, p);
					p->listed = 0;
					p->cls = NO_CLASS;
					list_push(&pa.empty, p);
					pa.n_empty++;
					p->batch->empty++;
				}
				p = next;
			}
		}
	}
	{
		struct pa_page *p = pa.empty;

		while (p != NULL) {
			struct pa_page *next = p->next;
			struct pa_batch *b = p->batch;

			if (b->empty == PAGES_PER_BATCH) {
				/* skip this batch's other pages in the list */
				while (next != NULL && next->batch == b)
					next = next->next;
				batch_free(b);
			}
			p = next;
		}
	}
}

void qjs_pool_stats(struct qjs_pool_stats *out)
{
	*out = pa.stats;
}

void qjs_pool_stats_reset(void)
{
	pa.stats.allocs = 0;
	pa.stats.large = 0;
	pa.stats.frees = 0;
	pa.stats.reallocs = 0;
	pa.stats.batches_peak = pa.stats.batches;
	pa.stats.batches_freed = 0;
}
