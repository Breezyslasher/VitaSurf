#ifndef G__psp2_kernel_sysmem_h
#define G__psp2_kernel_sysmem_h
#include <psp2/types.h>
#define SCE_KERNEL_MEMBLOCK_TYPE_USER_CDRAM_RW 0x09408060
#define SCE_KERNEL_MEMBLOCK_TYPE_USER_MAIN_NC_RW 0x0C208060
#define SCE_KERNEL_MEMBLOCK_TYPE_USER_MAIN_RW 0x0C20D060
SceUID sceKernelAllocMemBlock(const char *name, SceKernelMemBlockType type, SceSize size, void *opt);
int sceKernelFreeMemBlock(SceUID uid);
int sceKernelGetMemBlockBase(SceUID uid, void **base);
#endif
