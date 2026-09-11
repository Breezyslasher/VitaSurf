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
 * URLs; every other path rule lives in vita_platform.h.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

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
