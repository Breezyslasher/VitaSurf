/*
 * The system clipboard (VitaSurf).
 *
 * Whatever is copied in the browser -- a selection in a page, or text a
 * page writes with navigator.clipboard -- goes to the console's own
 * clipboard as well as NetSurf's, so that it can be pasted outside the
 * browser: the system's paste is hidden, and a plugin such as
 * PasteUnlock brings it out in the IME and system software.
 *
 * SceClipboard has no header in VitaSDK; its stub library is generated
 * from the NID database (db/360/SceClipboard.yml) and the module is
 * loaded by its sysmodule id. If it cannot be loaded, copying stays
 * inside the browser.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <stdbool.h>
#include <stddef.h>

#include <psp2/types.h>
#include <psp2/sysmodule.h>

#include "vita_platform.h"

int sceClipboardSetText(const char *text, SceSize length);

static int clipboard_state;	/* 0 not tried, 1 loaded, -1 unavailable */

static bool clipboard_ready(void)
{
	int ret;

	if (clipboard_state == 0) {
		ret = sceSysmoduleLoadModule(SCE_SYSMODULE_CLIPBOARD);
		if (ret < 0) {
			vita_log("clipboard: the system clipboard module did not "
				 "load (0x%08x); copying stays in the browser",
				 (unsigned int)ret);
			clipboard_state = -1;
		} else {
			clipboard_state = 1;
		}
	}
	return clipboard_state > 0;
}

void vita_clipboard_set(const char *text, size_t length)
{
	int ret;

	if (text == NULL || !clipboard_ready()) {
		return;
	}
	ret = sceClipboardSetText(text, (SceSize)length);
	if (ret < 0) {
		vita_log("clipboard: the system clipboard refused %u bytes "
			 "(0x%08x)", (unsigned int)length, (unsigned int)ret);
	}
}
