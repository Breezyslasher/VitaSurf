/*
 * Downloads: NetSurf hands content it cannot display (archives, PDFs,
 * anything served as an attachment) to the download table. Each download
 * is written straight to ux0:data/VitaSurf/downloads/ under the name the
 * server suggested, with a counter appended when that name is taken. The
 * status bar shows progress; the log records start, end and failures.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <psp2/io/stat.h>
#include <sys/stat.h>

#include "utils/errors.h"
#include "utils/nsurl.h"
#include "netsurf/download.h"
#include "netsurf/window.h"
#include "desktop/download.h"
#include "desktop/gui_internal.h"

#include "vita_platform.h"

struct gui_download_window {
	FILE *f;
	char path[256];
	char name[128];
	struct gui_window *parent;
	unsigned long long written;
	unsigned long long total;      /**< 0 when unknown */
	unsigned long long last_shown; /**< bytes at the last status update */
};

/* Update the status bar at most every this many bytes. */
#define STATUS_STEP (256 * 1024)

static void set_status(struct gui_download_window *dw, const char *fmt)
{
	char text[200];

	if (dw->parent == NULL || guit->window->set_status == NULL) {
		return;
	}
	if (dw->total > 0) {
		snprintf(text, sizeof(text), fmt, dw->name,
			 (unsigned)(dw->written / 1024), (unsigned)(dw->total / 1024));
	} else {
		snprintf(text, sizeof(text), fmt, dw->name,
			 (unsigned)(dw->written / 1024), 0u);
	}
	guit->window->set_status(dw->parent, text);
}

/** Make a server-supplied filename safe for a Vita path. */
static void safe_name(const char *in, char *out, size_t len)
{
	size_t n = 0;

	if (in == NULL || *in == '\0') {
		in = "download";
	}
	while (*in != '\0' && n < len - 1) {
		unsigned char c = (unsigned char)*in++;
		if (c < 0x20 || c > 0x7e || strchr("/\\:*?\"<>|", c) != NULL) {
			c = '_';
		}
		out[n++] = (char)c;
	}
	out[n] = '\0';
	if (n == 0 || strcmp(out, ".") == 0 || strcmp(out, "..") == 0) {
		strncpy(out, "download", len);
	}
}

static struct gui_download_window *
download_create(download_context *ctx, struct gui_window *parent)
{
	struct gui_download_window *dw = calloc(1, sizeof(*dw));
	struct stat st;
	int n;

	if (dw == NULL) {
		return NULL;
	}
	sceIoMkdir(VITASURF_DOWNLOADS_DIR, 0777);
	safe_name(download_context_get_filename(ctx), dw->name, sizeof(dw->name));
	snprintf(dw->path, sizeof(dw->path), "%s/%s", VITASURF_DOWNLOADS_DIR, dw->name);
	for (n = 1; stat(dw->path, &st) == 0 && n < 1000; n++) {
		char base[128];
		const char *dot;

		strncpy(base, dw->name, sizeof(base));
		base[sizeof(base) - 1] = '\0';
		dot = strrchr(base, '.');
		if (dot != NULL && dot != base) {
			snprintf(dw->path, sizeof(dw->path), "%s/%.*s (%d)%s",
				 VITASURF_DOWNLOADS_DIR, (int)(dot - base), base,
				 n, dot);
		} else {
			snprintf(dw->path, sizeof(dw->path), "%s/%s (%d)",
				 VITASURF_DOWNLOADS_DIR, base, n);
		}
	}
	dw->f = fopen(dw->path, "wb");
	if (dw->f == NULL) {
		vita_log("download: cannot create %s", dw->path);
		free(dw);
		return NULL;
	}
	dw->parent = parent;
	dw->total = download_context_get_total_length(ctx);
	vita_log("download: %s -> %s (%s, %u KB)",
		 nsurl_access(download_context_get_url(ctx)), dw->path,
		 download_context_get_mime_type(ctx),
		 (unsigned)(dw->total / 1024));
	set_status(dw, "Downloading %s: %u of %u KB");
	return dw;
}

static nserror download_data(struct gui_download_window *dw,
			     const char *data, unsigned int size)
{
	if (fwrite(data, 1, size, dw->f) != size) {
		vita_log("download: write failed for %s", dw->path);
		return NSERROR_SAVE_FAILED;
	}
	dw->written += size;
	if (dw->written - dw->last_shown >= STATUS_STEP) {
		dw->last_shown = dw->written;
		set_status(dw, "Downloading %s: %u of %u KB");
	}
	return NSERROR_OK;
}

static void download_error(struct gui_download_window *dw, const char *error_msg)
{
	vita_log("download: %s failed after %u KB: %s", dw->path,
		 (unsigned)(dw->written / 1024), error_msg != NULL ? error_msg : "");
	fclose(dw->f);
	remove(dw->path);
	set_status(dw, "Download of %s failed (%u KB of %u KB)");
	free(dw);
}

static void download_done(struct gui_download_window *dw)
{
	fclose(dw->f);
	vita_log("download: saved %s (%u KB)", dw->path, (unsigned)(dw->written / 1024));
	set_status(dw, "Saved %s (%u KB) to ux0:data/VitaSurf/downloads");
	free(dw);
}

static struct gui_download_table download_table = {
	.create = download_create,
	.data = download_data,
	.error = download_error,
	.done = download_done,
};

struct gui_download_table *vita_download_table = &download_table;
