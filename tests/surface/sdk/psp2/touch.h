#ifndef G__psp2_touch_h
#define G__psp2_touch_h
#include <psp2/types.h>
enum { SCE_TOUCH_PORT_FRONT=0 }; enum { SCE_TOUCH_SAMPLING_STATE_STOP=0, SCE_TOUCH_SAMPLING_STATE_START=1 };
typedef struct { unsigned char id, force; unsigned short x, y; } SceTouchReport;
typedef struct { SceUInt64 timeStamp; unsigned int status; unsigned int reportNum; SceTouchReport report[8]; } SceTouchData;
int sceTouchPeek(SceUInt32 port, SceTouchData *pData, SceUInt32 nBufs);
int sceTouchSetSamplingState(SceUInt32 port, int state);
#endif
