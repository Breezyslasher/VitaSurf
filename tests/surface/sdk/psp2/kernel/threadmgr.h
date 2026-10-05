#ifndef G__psp2_kernel_threadmgr_h
#define G__psp2_kernel_threadmgr_h
#include <psp2/types.h>
#define SCE_KERNEL_MUTEX_ATTR_RECURSIVE 2
SceUID sceKernelCreateMutex(const char *name, SceUInt attr, int initCount, void *option);
int sceKernelDeleteMutex(SceUID id);
int sceKernelLockMutex(SceUID id, int count, unsigned int *timeout);
int sceKernelTryLockMutex(SceUID id, int count);
int sceKernelUnlockMutex(SceUID id, int count);
SceUID sceKernelCreateThread(const char *name, SceKernelThreadEntry entry, int prio, SceSize stack, SceUInt attr, int cpuAffinityMask, const void *option);
int sceKernelStartThread(SceUID thid, SceSize arglen, void *argp);
int sceKernelDeleteThread(SceUID thid);
int sceKernelExitDeleteThread(int status);
int sceKernelWaitThreadEnd(SceUID thid, int *stat, SceUInt *timeout);
int sceKernelDelayThread(SceUInt delay);
#endif
