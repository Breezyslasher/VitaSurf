/*
 * Minimal iconv for VitaSurf.
 *
 * VitaSDK's newlib is built with iconv enabled but iconv_open() fails for
 * every charset, including UTF-8 to UTF-8 (verified on hardware). NetSurf
 * needs iconv in utils/utf8.c for form submission and for the internal
 * bitmap font, which converts every text run to CP1252. This file provides
 * the conversions those paths use and takes precedence over newlib's
 * because it is linked as an object file ahead of libc.
 *
 * Supported: UTF-8, ISO-8859-1, CP1252 (Windows-1252), US-ASCII, UTF-16
 * (BE, LE, and BOM-detected). The //TRANSLIT suffix replaces unmappable
 * characters with '?', //IGNORE drops them; otherwise they are EILSEQ.
 *
 * Page decoding does not come through here: libparserutils is built with
 * WITHOUT_ICONV_FILTER and uses its own, more complete, charset codecs.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

#include <ctype.h>
#include <errno.h>
#include <iconv.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum charset {
	CS_UTF8,
	CS_LATIN1,
	CS_CP1252,
	CS_ASCII,
	CS_UTF16,    /**< byte order from BOM when decoding, BE when encoding */
	CS_UTF16BE,
	CS_UTF16LE,
};

struct vita_iconv {
	enum charset from;
	enum charset to;
	int translit;
	int ignore;
	int in_le;       /**< decoding UTF-16: little endian selected */
	int in_bom_done; /**< decoding UTF-16: BOM check performed */
};

/* decode() result for input that produced no character (a BOM) */
#define NO_CHARACTER 0xFFFFFFFFu

/* CP1252 0x80..0x9F, 0 marks an undefined byte */
static const uint16_t cp1252_high[32] = {
	0x20AC, 0,      0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
	0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0,      0x017D, 0,
	0,      0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
	0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0,      0x017E, 0x0178,
};

static int parse_charset(const char *name, enum charset *out,
			 int *translit, int *ignore)
{
	char buf[32];
	size_t n = 0;
	const char *suffix = strstr(name, "//");

	*translit = 0;
	*ignore = 0;
	if (suffix != NULL) {
		const char *s = suffix;

		while ((s = strstr(s, "//")) != NULL) {
			s += 2;
			if (strncasecmp(s, "TRANSLIT", 8) == 0) {
				*translit = 1;
			} else if (strncasecmp(s, "IGNORE", 6) == 0) {
				*ignore = 1;
			}
		}
	}

	while (name[n] != '\0' && name[n] != '/' && n < sizeof(buf) - 1) {
		buf[n] = (char)toupper((unsigned char)name[n]);
		n++;
	}
	buf[n] = '\0';

	if (strcmp(buf, "UTF-8") == 0 || strcmp(buf, "UTF8") == 0) {
		*out = CS_UTF8;
	} else if (strcmp(buf, "ISO-8859-1") == 0 ||
		   strcmp(buf, "ISO8859-1") == 0 ||
		   strcmp(buf, "ISO_8859-1") == 0 ||
		   strcmp(buf, "ISO-8859-1:1987") == 0 ||
		   strcmp(buf, "LATIN1") == 0 ||
		   strcmp(buf, "L1") == 0) {
		*out = CS_LATIN1;
	} else if (strcmp(buf, "CP1252") == 0 ||
		   strcmp(buf, "WINDOWS-1252") == 0 ||
		   strcmp(buf, "MS-ANSI") == 0) {
		*out = CS_CP1252;
	} else if (strcmp(buf, "US-ASCII") == 0 ||
		   strcmp(buf, "ASCII") == 0 ||
		   strcmp(buf, "ANSI_X3.4-1968") == 0 ||
		   strcmp(buf, "646") == 0) {
		*out = CS_ASCII;
	} else if (strcmp(buf, "UTF-16") == 0 || strcmp(buf, "UTF16") == 0) {
		*out = CS_UTF16;
	} else if (strcmp(buf, "UTF-16BE") == 0 || strcmp(buf, "UCS-2BE") == 0 ||
		   strcmp(buf, "UCS-2") == 0) {
		*out = CS_UTF16BE;
	} else if (strcmp(buf, "UTF-16LE") == 0 || strcmp(buf, "UCS-2LE") == 0) {
		*out = CS_UTF16LE;
	} else {
		return -1;
	}
	return 0;
}

iconv_t iconv_open(const char *tocode, const char *fromcode)
{
	struct vita_iconv *cd;
	enum charset from;
	enum charset to;
	int translit;
	int ignore;
	int unused_t;
	int unused_i;

	if (tocode == NULL || fromcode == NULL ||
	    parse_charset(fromcode, &from, &unused_t, &unused_i) != 0 ||
	    parse_charset(tocode, &to, &translit, &ignore) != 0) {
		errno = EINVAL;
		return (iconv_t)-1;
	}

	cd = calloc(1, sizeof(*cd));
	if (cd == NULL) {
		errno = ENOMEM;
		return (iconv_t)-1;
	}
	cd->from = from;
	cd->to = to;
	cd->translit = translit;
	cd->ignore = ignore;
	return (iconv_t)cd;
}

int iconv_close(iconv_t cd)
{
	if (cd == (iconv_t)-1 || cd == NULL) {
		errno = EBADF;
		return -1;
	}
	free(cd);
	return 0;
}

/**
 * Decode one character. Returns the number of bytes consumed, 0 with
 * errno EINVAL for a truncated sequence, or 0 with errno EILSEQ for an
 * invalid one.
 */
static size_t decode(struct vita_iconv *cd, const unsigned char *in,
		     size_t inleft, uint32_t *cp)
{
	unsigned char c = in[0];

	switch (cd->from) {
	case CS_UTF8: {
		size_t need;
		uint32_t v;
		size_t i;

		if (c < 0x80) {
			*cp = c;
			return 1;
		} else if ((c & 0xE0) == 0xC0) {
			need = 2;
			v = c & 0x1F;
		} else if ((c & 0xF0) == 0xE0) {
			need = 3;
			v = c & 0x0F;
		} else if ((c & 0xF8) == 0xF0) {
			need = 4;
			v = c & 0x07;
		} else {
			errno = EILSEQ;
			return 0;
		}
		if (inleft < need) {
			errno = EINVAL;
			return 0;
		}
		for (i = 1; i < need; i++) {
			if ((in[i] & 0xC0) != 0x80) {
				errno = EILSEQ;
				return 0;
			}
			v = (v << 6) | (in[i] & 0x3F);
		}
		*cp = v;
		return need;
	}

	case CS_LATIN1:
		*cp = c;
		return 1;

	case CS_CP1252:
		if (c >= 0x80 && c <= 0x9F) {
			if (cp1252_high[c - 0x80] == 0) {
				errno = EILSEQ;
				return 0;
			}
			*cp = cp1252_high[c - 0x80];
		} else {
			*cp = c;
		}
		return 1;

	case CS_ASCII:
		if (c >= 0x80) {
			errno = EILSEQ;
			return 0;
		}
		*cp = c;
		return 1;

	case CS_UTF16:
	case CS_UTF16BE:
	case CS_UTF16LE: {
		uint32_t u;
		size_t used = 0;

		if (inleft < 2) {
			errno = EINVAL;
			return 0;
		}
		if (cd->from == CS_UTF16 && !cd->in_bom_done) {
			cd->in_bom_done = 1;
			if (in[0] == 0xFF && in[1] == 0xFE) {
				cd->in_le = 1;
				*cp = NO_CHARACTER; /* BOM consumed */
				return 2;
			} else if (in[0] == 0xFE && in[1] == 0xFF) {
				cd->in_le = 0;
				*cp = NO_CHARACTER;
				return 2;
			}
		}
		if (cd->from == CS_UTF16LE || (cd->from == CS_UTF16 && cd->in_le)) {
			u = (uint32_t)in[0] | ((uint32_t)in[1] << 8);
		} else {
			u = ((uint32_t)in[0] << 8) | (uint32_t)in[1];
		}
		used = 2;
		if (u >= 0xD800 && u <= 0xDBFF) {
			uint32_t lo;

			if (inleft < 4) {
				errno = EINVAL;
				return 0;
			}
			if (cd->from == CS_UTF16LE ||
			    (cd->from == CS_UTF16 && cd->in_le)) {
				lo = (uint32_t)in[2] | ((uint32_t)in[3] << 8);
			} else {
				lo = ((uint32_t)in[2] << 8) | (uint32_t)in[3];
			}
			if (lo < 0xDC00 || lo > 0xDFFF) {
				errno = EILSEQ;
				return 0;
			}
			u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
			used = 4;
		} else if (u >= 0xDC00 && u <= 0xDFFF) {
			errno = EILSEQ;
			return 0;
		}
		*cp = u;
		return used;
	}
	}
	errno = EILSEQ;
	return 0;
}

/**
 * Encode one character. Returns bytes written, 0 with errno E2BIG when
 * the output is full, or 0 with errno EILSEQ when unmappable.
 */
static size_t encode(struct vita_iconv *cd, uint32_t cp, unsigned char *out,
		     size_t outleft)
{
	switch (cd->to) {
	case CS_UTF8: {
		size_t need = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;

		if (cp > 0x10FFFF) {
			errno = EILSEQ;
			return 0;
		}
		if (outleft < need) {
			errno = E2BIG;
			return 0;
		}
		switch (need) {
		case 1:
			out[0] = (unsigned char)cp;
			break;
		case 2:
			out[0] = (unsigned char)(0xC0 | (cp >> 6));
			out[1] = (unsigned char)(0x80 | (cp & 0x3F));
			break;
		case 3:
			out[0] = (unsigned char)(0xE0 | (cp >> 12));
			out[1] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
			out[2] = (unsigned char)(0x80 | (cp & 0x3F));
			break;
		default:
			out[0] = (unsigned char)(0xF0 | (cp >> 18));
			out[1] = (unsigned char)(0x80 | ((cp >> 12) & 0x3F));
			out[2] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
			out[3] = (unsigned char)(0x80 | (cp & 0x3F));
			break;
		}
		return need;
	}

	case CS_LATIN1:
	case CS_ASCII:
		if (cp > (cd->to == CS_ASCII ? 0x7Fu : 0xFFu)) {
			errno = EILSEQ;
			return 0;
		}
		if (outleft < 1) {
			errno = E2BIG;
			return 0;
		}
		out[0] = (unsigned char)cp;
		return 1;

	case CS_CP1252: {
		unsigned char b;

		if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) {
			b = (unsigned char)cp;
		} else {
			int i;

			for (i = 0; i < 32; i++) {
				if (cp1252_high[i] == cp) {
					break;
				}
			}
			if (i == 32) {
				errno = EILSEQ;
				return 0;
			}
			b = (unsigned char)(0x80 + i);
		}
		if (outleft < 1) {
			errno = E2BIG;
			return 0;
		}
		out[0] = b;
		return 1;
	}

	case CS_UTF16:
	case CS_UTF16BE:
	case CS_UTF16LE: {
		int le = cd->to == CS_UTF16LE;
		uint32_t units[2];
		size_t nunits;
		size_t i;

		if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
			errno = EILSEQ;
			return 0;
		}
		if (cp >= 0x10000) {
			units[0] = 0xD800 + ((cp - 0x10000) >> 10);
			units[1] = 0xDC00 + ((cp - 0x10000) & 0x3FF);
			nunits = 2;
		} else {
			units[0] = cp;
			nunits = 1;
		}
		if (outleft < nunits * 2) {
			errno = E2BIG;
			return 0;
		}
		for (i = 0; i < nunits; i++) {
			if (le) {
				out[i * 2] = (unsigned char)(units[i] & 0xFF);
				out[i * 2 + 1] = (unsigned char)(units[i] >> 8);
			} else {
				out[i * 2] = (unsigned char)(units[i] >> 8);
				out[i * 2 + 1] = (unsigned char)(units[i] & 0xFF);
			}
		}
		return nunits * 2;
	}
	}
	errno = EILSEQ;
	return 0;
}

size_t iconv(iconv_t cdp, char **restrict inbuf, size_t *restrict inleft,
	     char **restrict outbuf, size_t *restrict outleft)
{
	struct vita_iconv *cd = (struct vita_iconv *)cdp;
	size_t irreversible = 0;

	if (cd == NULL || cd == (struct vita_iconv *)-1) {
		errno = EBADF;
		return (size_t)-1;
	}

	/* reset request */
	if (inbuf == NULL || *inbuf == NULL) {
		cd->in_bom_done = 0;
		cd->in_le = 0;
		return 0;
	}

	while (*inleft > 0) {
		uint32_t cp = 0;
		size_t used;
		size_t written;

		used = decode(cd, (const unsigned char *)*inbuf, *inleft, &cp);
		if (used == 0) {
			return (size_t)-1; /* errno set by decode */
		}
		if (cp == NO_CHARACTER) {
			/* a consumed byte order mark */
			*inbuf += used;
			*inleft -= used;
			continue;
		}

		written = encode(cd, cp, (unsigned char *)*outbuf, *outleft);
		if (written == 0) {
			if (errno == E2BIG) {
				return (size_t)-1;
			}
			/* unmappable in the target charset */
			if (cd->ignore) {
				irreversible++;
			} else if (cd->translit) {
				written = encode(cd, '?', (unsigned char *)*outbuf,
						 *outleft);
				if (written == 0) {
					return (size_t)-1; /* E2BIG */
				}
				irreversible++;
			} else {
				errno = EILSEQ;
				return (size_t)-1;
			}
		}

		*inbuf += used;
		*inleft -= used;
		*outbuf += written;
		*outleft -= written;
	}

	return irreversible;
}
