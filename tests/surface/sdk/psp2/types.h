#ifndef G__psp2_types_h
#define G__psp2_types_h
#include <stdint.h>
typedef int SceUID; typedef unsigned int SceSize; typedef unsigned int SceUInt;
typedef uint64_t SceUInt64; typedef int SceInt32; typedef unsigned int SceUInt32;
typedef int SceKernelMemBlockType;
typedef int (*SceKernelThreadEntry)(SceSize, void *);
#endif
