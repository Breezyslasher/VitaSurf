/*
 * NetSurf file table for the Vita: path and URL translation.
 *
 * NetSurf's POSIX file table is used for everything except the conversion
 * from a file: URL back to a path. Resource lookups pass through realpath(),
 * which on VitaSDK newlib yields drive-qualified paths such as
 * app0:/resources/default.css. NetSurf turns that into
 * file:///app0%3A/resources/default.css and the POSIX conversion back gives
 * /app0:/resources/default.css, which newlib resolves against the current
 * drive as app0:/app0:/resources/default.css. Dropping the leading slash in
 * front of a drive prefix restores the path newlib understands.
 *
 * This is the one place in VitaSurf that knows about drive prefixes inside
 * URLs; every other path rule lives in vita_platform.h. It also holds the
 * devices the file browser (about:files, patch 0321) starts from.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <dirent.h>
#include <stdarg.h>
#include <stddef.h>
#include <string.h>

#include "utils/errors.h"
#include "utils/file.h"

#include "vita_platform.h"

/**
 * True when path looks like /drive:/rest, where drive is letters and digits.
 */
static int has_slashed_drive(const char *path, size_t *drive_len)
{
	size_t i = 1;

	if (path[0] != '/') {
		return 0;
	}
	while ((path[i] >= 'a' && path[i] <= 'z') ||
	       (path[i] >= 'A' && path[i] <= 'Z') ||
	       (path[i] >= '0' && path[i] <= '9')) {
		i++;
	}
	if (i == 1 || path[i] != ':') {
		return 0;
	}
	*drive_len = i;
	return 1;
}

static nserror vita_nsurl_to_path(struct nsurl *url, char **path_out)
{
	nserror res;
	char *path;
	size_t drive_len;

	res = default_file_table->nsurl_to_path(url, &path);
	if (res != NSERROR_OK) {
		return res;
	}

	if (has_slashed_drive(path, &drive_len)) {
		memmove(path, path + 1, strlen(path));
	}

	*path_out = path;
	return NSERROR_OK;
}

static nserror vita_path_to_nsurl(const char *path, struct nsurl **url_out)
{
	return default_file_table->path_to_nsurl(path, url_out);
}

static nserror vita_mkpath(char **str, size_t *size, size_t nelm, va_list ap)
{
	return default_file_table->mkpath(str, size, nelm, ap);
}

static nserror vita_basename(const char *path, char **str, size_t *size)
{
	return default_file_table->basename(path, str, size);
}

static nserror vita_mkdir_all(const char *fname)
{
	return default_file_table->mkdir_all(fname);
}

static struct gui_file_table file_table = {
	.mkpath = vita_mkpath,
	.basename = vita_basename,
	.nsurl_to_path = vita_nsurl_to_path,
	.path_to_nsurl = vita_path_to_nsurl,
	.mkdir_all = vita_mkdir_all,
};

struct gui_file_table *vita_file_table = &file_table;

/*
 * Where the file browser starts: VitaSurf's own folders, then the
 * devices, each listed only if it can be opened. Which are there depends
 * on the model (imc0: is a PS TV's and a later model's internal memory),
 * what is plugged in (uma0:, gro0:) and the plugins a console runs
 * (StorageMgr moves an SD2Vita card to ux0:).
 */
static const struct vita_file_root vita_roots[] = {
	{ "ux0:/data/VitaSurf/", "VitaSurf's data" },
	{ "app0:/", "VitaSurf itself (read only)" },
	{ "ux0:/", "Main storage" },
	{ "uma0:/", "USB or second card" },
	{ "imc0:/", "Internal memory" },
	{ "xmc0:/", "Memory card" },
	{ "grw0:/", "Game card storage" },
	{ "gro0:/", "Game card (read only)" },
	{ "ur0:/", "System user data" },
	{ "ud0:/", "System update data" },
	{ "sa0:/", "System data (read only)" },
	{ "pd0:/", "Preinstalled data (read only)" },
	{ "vs0:/", "System (read only)" },
	{ "os0:/", "System (read only)" },
	{ "vd0:/", "System registry" },
	{ "tm0:/", "System" },
};

/* exported interface documented in vita_platform.h */
int vita_file_roots(struct vita_file_root *roots, int max)
{
	int i, n = 0;

	for (i = 0; i < (int)(sizeof(vita_roots) / sizeof(vita_roots[0])) &&
		    n < max; i++) {
		DIR *d = opendir(vita_roots[i].path);

		if (d == NULL) {
			continue;
		}
		closedir(d);
		roots[n++] = vita_roots[i];
	}
	return n;
}
