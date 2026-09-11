/*
 * System IME dialog for text entry.
 *
 * Follows the sequence known to work on hardware in the other Vita apps:
 * static UTF-16 buffers, sceImeDialogParamInit(), a retry after
 * sceCommonDialogSetConfigParam() if the common dialog reports it is not
 * initialised, and sceImeDialogTerm() as soon as the status is finished.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <psp2/common_dialog.h>
#include <psp2/ime_dialog.h>
#include <psp2/libime.h>

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "vita_platform.h"
#include "vita_surface.h"
#include "vita_ime.h"

/* IME buffers must outlive the dialog: keep them static. */
static SceWChar16 ime_title[64];
static SceWChar16 ime_text[VITA_IME_MAX_LENGTH + 1];
static bool ime_running;

/** Convert UTF-8 to UTF-16, stopping at the buffer limit. */
static void utf8_to_utf16(const char *in, SceWChar16 *out, size_t out_units)
{
	size_t o = 0;
	const unsigned char *p = (const unsigned char *)in;

	while (*p != 0 && o + 2 < out_units) {
		uint32_t cp;
		int extra;

		if (*p < 0x80) {
			cp = *p;
			extra = 0;
		} else if ((*p & 0xE0) == 0xC0) {
			cp = *p & 0x1F;
			extra = 1;
		} else if ((*p & 0xF0) == 0xE0) {
			cp = *p & 0x0F;
			extra = 2;
		} else if ((*p & 0xF8) == 0xF0) {
			cp = *p & 0x07;
			extra = 3;
		} else {
			p++;
			continue;
		}
		p++;
		while (extra-- > 0) {
			if ((*p & 0xC0) != 0x80) {
				cp = '?';
				break;
			}
			cp = (cp << 6) | (*p & 0x3F);
			p++;
		}
		if (cp >= 0x10000) {
			cp -= 0x10000;
			out[o++] = (SceWChar16)(0xD800 | (cp >> 10));
			out[o++] = (SceWChar16)(0xDC00 | (cp & 0x3FF));
		} else {
			out[o++] = (SceWChar16)cp;
		}
	}
	out[o] = 0;
}

/** Convert UTF-16 to UTF-8, stopping at the buffer limit. */
static void utf16_to_utf8(const SceWChar16 *in, char *out, size_t outlen)
{
	size_t o = 0;

	while (*in != 0) {
		uint32_t cp = *in++;

		if (cp >= 0xD800 && cp <= 0xDBFF && *in >= 0xDC00 && *in <= 0xDFFF) {
			cp = 0x10000 + ((cp - 0xD800) << 10) + (*in - 0xDC00);
			in++;
		}
		if (cp < 0x80) {
			if (o + 1 >= outlen) break;
			out[o++] = (char)cp;
		} else if (cp < 0x800) {
			if (o + 2 >= outlen) break;
			out[o++] = (char)(0xC0 | (cp >> 6));
			out[o++] = (char)(0x80 | (cp & 0x3F));
		} else if (cp < 0x10000) {
			if (o + 3 >= outlen) break;
			out[o++] = (char)(0xE0 | (cp >> 12));
			out[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
			out[o++] = (char)(0x80 | (cp & 0x3F));
		} else {
			if (o + 4 >= outlen) break;
			out[o++] = (char)(0xF0 | (cp >> 18));
			out[o++] = (char)(0x80 | ((cp >> 12) & 0x3F));
			out[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
			out[o++] = (char)(0x80 | (cp & 0x3F));
		}
	}
	out[o] = '\0';
}

int vita_ime_start(const char *title, const char *initial, bool multiline)
{
	SceImeDialogParam param;
	int ret;

	if (ime_running) {
		return 0;
	}

	memset(ime_title, 0, sizeof(ime_title));
	memset(ime_text, 0, sizeof(ime_text));
	utf8_to_utf16(title, ime_title, sizeof(ime_title) / sizeof(ime_title[0]));
	if (initial != NULL) {
		utf8_to_utf16(initial, ime_text,
			      sizeof(ime_text) / sizeof(ime_text[0]));
	}

	sceImeDialogParamInit(&param);
	param.supportedLanguages = 0;
	param.languagesForced = SCE_FALSE;
	param.type = SCE_IME_TYPE_DEFAULT;
	param.option = SCE_IME_OPTION_NO_AUTO_CAPITALIZATION;
	if (multiline) {
		param.option |= SCE_IME_OPTION_MULTILINE;
	}
	param.title = ime_title;
	param.maxTextLength = VITA_IME_MAX_LENGTH;
	param.initialText = ime_text;
	param.inputTextBuffer = ime_text;
	param.textBoxMode = SCE_IME_DIALOG_TEXTBOX_MODE_DEFAULT;
	param.enterLabel = SCE_IME_ENTER_LABEL_DEFAULT;
	param.inputMethod = 0;

	ret = sceImeDialogInit(&param);
	if (ret == (int)0x80100705) {
		/* common dialog not initialised: configure it and retry */
		SceCommonDialogConfigParam config;

		sceCommonDialogConfigParamInit(&config);
		sceCommonDialogSetConfigParam(&config);
		ret = sceImeDialogInit(&param);
	}
	if (ret < 0) {
		vita_log("ime: sceImeDialogInit failed: 0x%08x", (unsigned int)ret);
		return ret;
	}

	ime_running = true;
	vita_surface_set_dialog(true);
	vita_log("ime: dialog started");
	return 0;
}

enum vita_ime_status vita_ime_poll(char *out, size_t outlen)
{
	SceCommonDialogStatus status;
	SceImeDialogResult result;

	if (!ime_running) {
		return VITA_IME_IDLE;
	}

	status = sceImeDialogGetStatus();
	if (status == SCE_COMMON_DIALOG_STATUS_RUNNING) {
		return VITA_IME_RUNNING;
	}
	if (status == SCE_COMMON_DIALOG_STATUS_NONE) {
		vita_log("ime: dialog ended unexpectedly");
		ime_running = false;
		vita_surface_set_dialog(false);
		return VITA_IME_CANCELLED;
	}

	/* finished */
	memset(&result, 0, sizeof(result));
	sceImeDialogGetResult(&result);
	sceImeDialogTerm();
	ime_running = false;
	vita_surface_set_dialog(false);

	if (result.button == SCE_IME_DIALOG_BUTTON_ENTER) {
		utf16_to_utf8(ime_text, out, outlen);
		vita_log("ime: entered '%s'", out);
		return VITA_IME_DONE;
	}
	vita_log("ime: cancelled (button %d)", (int)result.button);
	return VITA_IME_CANCELLED;
}

bool vita_ime_running(void)
{
	return ime_running;
}
