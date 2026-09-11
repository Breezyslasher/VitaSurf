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

#include <psp2/kernel/processmgr.h>

#include "vita_platform.h"

#ifndef VITASURF_HEAP_MB
#define VITASURF_HEAP_MB 128
#endif

#ifndef VITASURF_STACK_KB
#define VITASURF_STACK_KB 4096
#endif

/*
 * Phase 2 bring-up: NetSurf's verbose log (which also enables libcurl's
 * connection trace) is on in every build until HTTPS pages load on
 * hardware. Remove this once they do.
 */
#define VITASURF_ALWAYS_VERBOSE 1

/*
 * newlib heap and main thread stack. Both are read by the VitaSDK C runtime
 * before main() runs. CSS selection and layout recurse deeply, hence the
 * large stack. The heap size is a CMake option (VITASURF_HEAP_MB).
 */
int _newlib_heap_size_user = VITASURF_HEAP_MB * 1024 * 1024;
unsigned int sceUserMainThreadStackSize = VITASURF_STACK_KB * 1024;

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
#if defined(VITASURF_DEBUG) || defined(VITASURF_ALWAYS_VERBOSE)
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

	vita_log("heap %d MB, main thread stack %d KB",
		 VITASURF_HEAP_MB, VITASURF_STACK_KB);
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
