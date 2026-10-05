/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * WAMR's platform functions, over newlib. See platform_internal.h.
 */

#include "platform_api_vmcore.h"
#include "platform_api_extension.h"

#ifdef __vita__
#include <psp2/kernel/processmgr.h>
#endif

int
bh_platform_init(void)
{
    return 0;
}

void
bh_platform_destroy(void)
{
}

void *
os_malloc(unsigned size)
{
    return malloc(size);
}

void *
os_realloc(void *ptr, unsigned size)
{
    return realloc(ptr, size);
}

void
os_free(void *ptr)
{
    free(ptr);
}

int
os_dumps_proc_mem_info(char *out, unsigned int size)
{
    (void)out;
    (void)size;
    return -1;
}

int
os_printf(const char *format, ...)
{
    va_list ap;
    int n;

    va_start(ap, format);
    n = vprintf(format, ap);
    va_end(ap);
    return n;
}

int
os_vprintf(const char *format, va_list ap)
{
    return vprintf(format, ap);
}

uint64
os_time_get_boot_us(void)
{
#ifdef __vita__
    return (uint64)sceKernelGetProcessTimeWide();
#else
    struct timespec ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64)ts.tv_sec * 1000000 + (uint64)ts.tv_nsec / 1000;
#endif
}

uint64
os_time_thread_cputime_us(void)
{
    return os_time_get_boot_us();
}

korp_tid
os_self_thread(void)
{
    return pthread_self();
}

/*
 * The native stack is not checked: the interpreter keeps wasm frames on
 * its own stack, and a call back into JavaScript is guarded by QuickJS's
 * stack limit.
 */
uint8 *
os_thread_get_stack_boundary(void)
{
    return NULL;
}

void
os_thread_jit_write_protect_np(bool enabled)
{
    (void)enabled;
}

int
os_mutex_init(korp_mutex *mutex)
{
    return pthread_mutex_init(mutex, NULL) == 0 ? BHT_OK : BHT_ERROR;
}

int
os_recursive_mutex_init(korp_mutex *mutex)
{
    pthread_mutexattr_t attr;
    int r;

    pthread_mutexattr_init(&attr);
    pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
    r = pthread_mutex_init(mutex, &attr);
    pthread_mutexattr_destroy(&attr);
    return r == 0 ? BHT_OK : BHT_ERROR;
}

int
os_mutex_destroy(korp_mutex *mutex)
{
    return pthread_mutex_destroy(mutex) == 0 ? BHT_OK : BHT_ERROR;
}

int
os_mutex_lock(korp_mutex *mutex)
{
    return pthread_mutex_lock(mutex) == 0 ? BHT_OK : BHT_ERROR;
}

int
os_mutex_unlock(korp_mutex *mutex)
{
    return pthread_mutex_unlock(mutex) == 0 ? BHT_OK : BHT_ERROR;
}

/* only WAMR's timer utility, which nothing here starts, uses these */
int
os_cond_init(korp_cond *cond)
{
    return pthread_cond_init(cond, NULL) == 0 ? BHT_OK : BHT_ERROR;
}

int
os_cond_destroy(korp_cond *cond)
{
    return pthread_cond_destroy(cond) == 0 ? BHT_OK : BHT_ERROR;
}

/*
 * Linear memory. Without hardware bounds checks WAMR maps only the pages
 * in use and grows them with os_mremap, so plain zeroed heap does. The
 * size in front of each block lets os_mremap copy and clear.
 */
#define MAP_HEADER 16

void *
os_mmap(void *hint, size_t size, int prot, int flags, os_file_handle file)
{
    uint8 *p;

    (void)hint;
    (void)prot;
    (void)flags;
    (void)file;
    if (size > SIZE_MAX - MAP_HEADER) {
        return NULL;
    }
    p = calloc(1, size + MAP_HEADER);
    if (p == NULL) {
        return NULL;
    }
    memcpy(p, &size, sizeof(size));
    return p + MAP_HEADER;
}

void
os_munmap(void *addr, size_t size)
{
    (void)size;
    if (addr != NULL) {
        free((uint8 *)addr - MAP_HEADER);
    }
}

int
os_mprotect(void *addr, size_t size, int prot)
{
    (void)addr;
    (void)size;
    (void)prot;
    return 0;
}

void *
os_mremap(void *old_addr, size_t old_size, size_t new_size)
{
    uint8 *p;

    if (old_addr == NULL) {
        return os_mmap(NULL, new_size, 0, 0, os_get_invalid_handle());
    }
    if (new_size > SIZE_MAX - MAP_HEADER) {
        return NULL;
    }
    p = realloc((uint8 *)old_addr - MAP_HEADER, new_size + MAP_HEADER);
    if (p == NULL) {
        return NULL;
    }
    if (new_size > old_size) {
        memset(p + MAP_HEADER + old_size, 0, new_size - old_size);
    }
    memcpy(p, &new_size, sizeof(new_size));
    return p + MAP_HEADER;
}

void
os_dcache_flush(void)
{
}

void
os_icache_flush(void *start, size_t len)
{
    (void)start;
    (void)len;
}

int
os_usleep(uint32 usec)
{
    (void)usec;
    return 0;
}
