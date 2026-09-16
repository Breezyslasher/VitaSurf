/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, https://github.com/Breezyslasher/VitaSurf
 *
 * VitaSurf is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; version 2 of the License.
 *
 * VitaSurf is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * \file
 * Say which assertion failed before the process dies.
 *
 * NetSurf and the libraries under it assert liberally and are built
 * without NDEBUG, so a failed assertion is a real way for this browser to
 * stop. What it leaves behind is not obvious from the outside: newlib's
 * assert calls abort(), abort() raises SIGABRT, and newlib's _kill_r has
 * nowhere to send a signal that is not SIGINT or SIGTERM, so it runs into
 * a "udf" instruction. The Vita reports that as an undefined instruction
 * at an address inside the C library, which says nothing at all about the
 * assertion that failed -- build 233's dump took a disassembly of the
 * crashing binary to read that far, and still could not name it.
 *
 * newlib leaves both of its assert entry points overridable, so the last
 * thing to reach the log is now the expression, the file and the line.
 */

#include <stdlib.h>

#include "vita_platform.h"

/*
 * newlib's own prototypes, rather than <assert.h>, so that this file also
 * compiles on a host whose C library spells __assert differently. Both are
 * noreturn there, and both are here.
 */
void __assert_func(const char *file, int line, const char *func,
		   const char *expr) __attribute__((noreturn));
void __assert(const char *file, int line, const char *expr)
		__attribute__((noreturn));

static void vita_assert_report(const char *file, int line, const char *func,
			       const char *expr)
{
	vita_log("ASSERT %s:%d%s%s: %s",
		 (file != NULL) ? file : "?", line,
		 (func != NULL) ? " in " : "", (func != NULL) ? func : "",
		 (expr != NULL) ? expr : "?");
	/*
	 * An assertion that fires under memory pressure is a different
	 * bug from one that fires with room to spare, and the dump cannot
	 * tell them apart afterwards.
	 */
	vita_log_memory("at assertion");
}

/**
 * newlib's assert() with __ASSERT_FUNC available, which is the usual one.
 */
void __assert_func(const char *file, int line, const char *func,
		   const char *expr)
{
	vita_assert_report(file, line, func, expr);
	abort();
}

/**
 * newlib's assert() without the enclosing function's name.
 */
void __assert(const char *file, int line, const char *expr)
{
	vita_assert_report(file, line, NULL, expr);
	abort();
}
