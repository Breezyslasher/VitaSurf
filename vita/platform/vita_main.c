/*
 * VitaSurf entry point.
 *
 * NetSurf's framebuffer frontend defines main() in
 * deps/netsurf/frontends/framebuffer/gui.c. Rather than patching it, the
 * final link uses -Wl,--wrap=main so the C runtime calls __wrap_main()
 * below, which sets the Vita up and then calls the real NetSurf main()
 * through __real_main() with a fixed command line.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdio.h>
#include <string.h>

#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/threadmgr.h>

#include "vita_platform.h"

#ifndef VITASURF_HEAP_MB
#define VITASURF_HEAP_MB 176
#endif

#ifndef VITASURF_STACK_KB
#define VITASURF_STACK_KB 4096
#endif

/*
 * newlib heap and main thread stack. Both are read by the VitaSDK C runtime
 * before main() runs. CSS selection and layout recurse deeply, hence the
 * large stack. The heap size is a CMake option (VITASURF_HEAP_MB).
 *
 * Both are marked used and kept as link roots (see --undefined in
 * CMakeLists.txt). The runtime reads them weakly, so --gc-sections is
 * free to drop the definition and leave the default in its place -- and
 * did: the main thread ran on the 256 KB default while the log happily
 * printed the 4096 KB that had been asked for. Nothing said otherwise
 * until a stack overflow inside the JavaScript interpreter came back as
 * a data abort.
 */
__attribute__((used))
int _newlib_heap_size_user = VITASURF_HEAP_MB * 1024 * 1024;
__attribute__((used))
unsigned int sceUserMainThreadStackSize = VITASURF_STACK_KB * 1024;

/* The stack the thread actually got, in bytes, measured at startup. */
unsigned int vita_main_stack_bytes;

/*
 * Ask the kernel what this thread's stack really is, rather than trusting
 * what was requested. Anything that sizes itself against the stack -- the
 * JavaScript interpreter's recursion guard above all -- has to work from
 * the measured number, because a guard larger than the stack it guards
 * never fires.
 */
static void vita_measure_stack(void)
{
	SceKernelThreadInfo info;

	memset(&info, 0, sizeof(info));
	info.size = sizeof(info);
	if (sceKernelGetThreadInfo(sceKernelGetThreadId(), &info) >= 0 &&
	    info.stackSize > 0) {
		vita_main_stack_bytes = (unsigned int)info.stackSize;
	}
}

int __real_main(int argc, char **argv);
int __wrap_main(int argc, char **argv);

int __wrap_main(int argc, char **argv)
{
	/*
	 * NetSurf framebuffer command line:
	 *   -f vita     libnsfb surface registered by vita/surface/vita.c
	 *   -w/-h/-b    screen geometry and depth
	 *   -v          verbose logging to stderr (debug builds only)
	 * Option overrides of the form --name=value are also accepted here
	 * and take precedence over the Choices file.
	 */
	static char *args[16];
	int nargs = 0;
	int ret;
	int i;

	(void)argc;
	(void)argv;

	vita_platform_init();

	args[nargs++] = "vitasurf";

	/*
	 * Verbose NetSurf logging: compiled into debug builds, and switched on
	 * at runtime in any build by creating the flag file
	 * ux0:data/VitaSurf/verbose. NetSurf only recognises -v as the first
	 * argument. Release builds only carry INFO and above.
	 */
#if defined(VITASURF_DEBUG)
	args[nargs++] = "-v";
#else
	if (vita_verbose_requested()) {
		args[nargs++] = "-v";
	}
#endif

	args[nargs++] = "-f";
	args[nargs++] = "vita";
	args[nargs++] = "-w";
	args[nargs++] = "960";
	args[nargs++] = "-h";
	args[nargs++] = "544";
	args[nargs++] = "-b";
	args[nargs++] = "32";
	args[nargs] = NULL;

	vita_measure_stack();
	vita_log("heap %d MB, main thread stack %u KB (asked for %d KB)",
		 VITASURF_HEAP_MB,
		 (unsigned int)(vita_main_stack_bytes / 1024),
		 VITASURF_STACK_KB);
	if (vita_main_stack_bytes < (unsigned int)VITASURF_STACK_KB * 1024) {
		vita_log("WARNING: the main thread stack is smaller than "
			 "requested; deep recursion will fault");
	}
	for (i = 0; i < nargs; i++) {
		vita_log("argv[%d] = %s", i, args[i]);
	}
	vita_log("entering NetSurf main");

	ret = __real_main(nargs, args);

	vita_log("NetSurf main returned %d", ret);
	vita_platform_fini();

	sceKernelExitProcess(ret);
	return ret;
}
