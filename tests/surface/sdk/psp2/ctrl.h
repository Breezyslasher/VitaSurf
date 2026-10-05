#ifndef G__psp2_ctrl_h
#define G__psp2_ctrl_h
#include <psp2/types.h>
enum { SCE_CTRL_SELECT=1, SCE_CTRL_START=8, SCE_CTRL_UP=16, SCE_CTRL_RIGHT=32, SCE_CTRL_DOWN=64, SCE_CTRL_LEFT=128, SCE_CTRL_LTRIGGER=0x100, SCE_CTRL_RTRIGGER=0x200, SCE_CTRL_TRIANGLE=0x1000, SCE_CTRL_CIRCLE=0x2000, SCE_CTRL_CROSS=0x4000, SCE_CTRL_SQUARE=0x8000 };
enum { SCE_CTRL_MODE_ANALOG=1 };
typedef struct { SceUInt64 timeStamp; unsigned int buttons; unsigned char lx, ly, rx, ry; } SceCtrlData;
int sceCtrlPeekBufferPositive(int port, SceCtrlData *pad, int count);
int sceCtrlSetSamplingMode(int mode);
#endif
