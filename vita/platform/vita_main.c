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
	static char *args[] = {
		"vitasurf",
		"-f", "vita",
		"-w", "960",
		"-h", "544",
		"-b", "32",
#ifdef VITASURF_DEBUG
		"-v",
#endif
		NULL,
	};
	int nargs = (int)(sizeof(args) / sizeof(args[0])) - 1;
	int ret;

	(void)argc;
	(void)argv;

	vita_platform_init();

	ret = __real_main(nargs, args);

	vita_log("NetSurf main returned %d", ret);
	vita_platform_fini();

	sceKernelExitProcess(ret);
	return ret;
}
