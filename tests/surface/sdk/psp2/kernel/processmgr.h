#ifndef G__psp2_kernel_processmgr_h
#define G__psp2_kernel_processmgr_h
#include <psp2/types.h>
SceUInt64 sceKernelGetProcessTimeWide(void);
enum { SCE_KERNEL_POWER_TICK_DEFAULT=0 };
int sceKernelPowerTick(int type);
#endif
