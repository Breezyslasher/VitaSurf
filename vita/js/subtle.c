/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/**
 * \file
 * The primitives behind crypto.subtle and crypto.getRandomValues
 * (VitaSurf).
 *
 * crypto.subtle was an empty object, and crypto.getRandomValues was
 * Math.random(), which is no source for a key or a nonce. The Web
 * Cryptography API is built here on mbedTLS, which the build already
 * links for TLS: every browser a site supports has the API, and a page
 * that cannot hash, sign or derive a key has to stop.
 *
 * This file does the arithmetic only, synchronously, on ArrayBuffers.
 * vita/js/subtle.js holds the API: CryptoKey, algorithm names, usages,
 * key formats and the errors the specification asks for. A function
 * here that cannot do what it was asked returns null, which the script
 * side turns into OperationError or DataError as the operation needs;
 * a wrong argument type is a TypeError.
 *
 * Elliptic curve keys travel as the private scalar and the uncompressed
 * public point; RSA keys as DER, PKCS#8 for a private key and
 * SubjectPublicKeyInfo for a public one, parsed again for each use.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <quickjs.h>

#include <mbedtls/aes.h>
#include <mbedtls/asn1write.h>
#include <mbedtls/bignum.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/ecdh.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/ecp.h>
#include <mbedtls/entropy.h>
#include <mbedtls/gcm.h>
#include <mbedtls/hkdf.h>
#include <mbedtls/md.h>
#include <mbedtls/nist_kw.h>
#include <mbedtls/pk.h>
#include <mbedtls/pkcs5.h>
#include <mbedtls/rsa.h>

#include "monocypher.h"
#include "monocypher-ed25519.h"

#include "subtle.h"

/* ------------------------------------------------------------------------ */
/* Randomness                                                               */

static mbedtls_entropy_context entropy;
static mbedtls_ctr_drbg_context drbg;
static bool drbg_ready;

/** The generator, seeded on first use; NULL if the system gave nothing. */
static mbedtls_ctr_drbg_context *rng(void)
{
	static const unsigned char pers[] = "VitaSurf WebCrypto";

	if (!drbg_ready) {
		mbedtls_entropy_init(&entropy);
		mbedtls_ctr_drbg_init(&drbg);
		if (mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func,
					  &entropy, pers,
					  sizeof(pers) - 1) != 0) {
			mbedtls_ctr_drbg_free(&drbg);
			mbedtls_entropy_free(&entropy);
			return NULL;
		}
		drbg_ready = true;
	}
	return &drbg;
}

static int rng_fill(void *ctx, unsigned char *out, size_t len)
{
	return mbedtls_ctr_drbg_random(ctx, out, len);
}

/* ------------------------------------------------------------------------ */
/* Argument helpers                                                         */

struct bytes {
	const uint8_t *p;
	size_t len;
};

/** An ArrayBuffer argument; null and undefined read as empty. */
static int arg_bytes(JSContext *ctx, JSValueConst v, struct bytes *out)
{
	size_t len = 0;
	uint8_t *p;

	if (JS_IsNull(v) || JS_IsUndefined(v)) {
		out->p = (const uint8_t *)"";
		out->len = 0;
		return 0;
	}
	p = JS_GetArrayBuffer(ctx, &len, v);
	if (p == NULL) {
		return -1; /* exception set */
	}
	out->p = p;
	out->len = len;
	return 0;
}

static int arg_int(JSContext *ctx, JSValueConst v, int32_t *out)
{
	return JS_ToInt32(ctx, out, v);
}

/** A hash name as the script side normalised it. */
static mbedtls_md_type_t md_type(JSContext *ctx, JSValueConst v)
{
	const char *s = JS_ToCString(ctx, v);
	mbedtls_md_type_t t = MBEDTLS_MD_NONE;

	if (s == NULL) {
		return MBEDTLS_MD_NONE;
	}
	if (strcmp(s, "SHA-1") == 0) {
		t = MBEDTLS_MD_SHA1;
	} else if (strcmp(s, "SHA-256") == 0) {
		t = MBEDTLS_MD_SHA256;
	} else if (strcmp(s, "SHA-384") == 0) {
		t = MBEDTLS_MD_SHA384;
	} else if (strcmp(s, "SHA-512") == 0) {
		t = MBEDTLS_MD_SHA512;
	}
	JS_FreeCString(ctx, s);
	return t;
}

static mbedtls_ecp_group_id curve_id(JSContext *ctx, JSValueConst v)
{
	const char *s = JS_ToCString(ctx, v);
	mbedtls_ecp_group_id id = MBEDTLS_ECP_DP_NONE;

	if (s == NULL) {
		return MBEDTLS_ECP_DP_NONE;
	}
	if (strcmp(s, "P-256") == 0) {
		id = MBEDTLS_ECP_DP_SECP256R1;
	} else if (strcmp(s, "P-384") == 0) {
		id = MBEDTLS_ECP_DP_SECP384R1;
	} else if (strcmp(s, "P-521") == 0) {
		id = MBEDTLS_ECP_DP_SECP521R1;
	}
	JS_FreeCString(ctx, s);
	return id;
}

static JSValue buffer(JSContext *ctx, const uint8_t *p, size_t len)
{
	return JS_NewArrayBufferCopy(ctx, p, len);
}

/** A big number as big-endian bytes, at least \a width long. */
static JSValue mpi_buffer(JSContext *ctx, const mbedtls_mpi *x, size_t width)
{
	size_t len = mbedtls_mpi_size(x);
	uint8_t *tmp;
	JSValue r;

	if (len < width) {
		len = width;
	}
	if (len == 0) {
		len = 1;
	}
	tmp = malloc(len);
	if (tmp == NULL) {
		return JS_ThrowOutOfMemory(ctx);
	}
	if (mbedtls_mpi_write_binary(x, tmp, len) != 0) {
		free(tmp);
		return JS_NULL;
	}
	r = buffer(ctx, tmp, len);
	free(tmp);
	return r;
}

/* ------------------------------------------------------------------------ */
/* Digests, HMAC, key derivation                                            */

/* digest(hash, data) */
static JSValue js_digest(JSContext *ctx, JSValueConst this_val,
			 int argc, JSValueConst *argv)
{
	const mbedtls_md_info_t *info;
	uint8_t out[MBEDTLS_MD_MAX_SIZE];
	struct bytes data;

	(void)this_val;
	(void)argc;
	info = mbedtls_md_info_from_type(md_type(ctx, argv[0]));
	if (info == NULL || arg_bytes(ctx, argv[1], &data) != 0) {
		return info == NULL ? JS_NULL : JS_EXCEPTION;
	}
	if (mbedtls_md(info, data.p, data.len, out) != 0) {
		return JS_NULL;
	}
	return buffer(ctx, out, mbedtls_md_get_size(info));
}

/* hmac(hash, key, data) */
static JSValue js_hmac(JSContext *ctx, JSValueConst this_val,
		       int argc, JSValueConst *argv)
{
	const mbedtls_md_info_t *info;
	uint8_t out[MBEDTLS_MD_MAX_SIZE];
	struct bytes key, data;

	(void)this_val;
	(void)argc;
	info = mbedtls_md_info_from_type(md_type(ctx, argv[0]));
	if (info == NULL) {
		return JS_NULL;
	}
	if (arg_bytes(ctx, argv[1], &key) != 0 ||
	    arg_bytes(ctx, argv[2], &data) != 0) {
		return JS_EXCEPTION;
	}
	if (mbedtls_md_hmac(info, key.p, key.len, data.p, data.len,
			    out) != 0) {
		return JS_NULL;
	}
	return buffer(ctx, out, mbedtls_md_get_size(info));
}

/* pbkdf2(hash, password, salt, iterations, bits) */
static JSValue js_pbkdf2(JSContext *ctx, JSValueConst this_val,
			 int argc, JSValueConst *argv)
{
	mbedtls_md_type_t md = md_type(ctx, argv[0]);
	struct bytes pass, salt;
	int32_t iterations, bits;
	uint8_t *out;
	JSValue r;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[1], &pass) != 0 ||
	    arg_bytes(ctx, argv[2], &salt) != 0 ||
	    arg_int(ctx, argv[3], &iterations) != 0 ||
	    arg_int(ctx, argv[4], &bits) != 0) {
		return JS_EXCEPTION;
	}
	if (md == MBEDTLS_MD_NONE || iterations <= 0 || bits <= 0 ||
	    bits % 8 != 0) {
		return JS_NULL;
	}
	out = malloc(bits / 8);
	if (out == NULL) {
		return JS_ThrowOutOfMemory(ctx);
	}
	if (mbedtls_pkcs5_pbkdf2_hmac_ext(md, pass.p, pass.len, salt.p,
					  salt.len, (unsigned)iterations,
					  (uint32_t)(bits / 8), out) != 0) {
		free(out);
		return JS_NULL;
	}
	r = buffer(ctx, out, bits / 8);
	free(out);
	return r;
}

/* hkdf(hash, ikm, salt, info, bits) */
static JSValue js_hkdf(JSContext *ctx, JSValueConst this_val,
		       int argc, JSValueConst *argv)
{
	const mbedtls_md_info_t *info;
	struct bytes ikm, salt, inf;
	int32_t bits;
	uint8_t *out;
	JSValue r;

	(void)this_val;
	(void)argc;
	info = mbedtls_md_info_from_type(md_type(ctx, argv[0]));
	if (arg_bytes(ctx, argv[1], &ikm) != 0 ||
	    arg_bytes(ctx, argv[2], &salt) != 0 ||
	    arg_bytes(ctx, argv[3], &inf) != 0 ||
	    arg_int(ctx, argv[4], &bits) != 0) {
		return JS_EXCEPTION;
	}
	if (info == NULL || bits <= 0 || bits % 8 != 0) {
		return JS_NULL;
	}
	out = malloc(bits / 8);
	if (out == NULL) {
		return JS_ThrowOutOfMemory(ctx);
	}
	if (mbedtls_hkdf(info, salt.p, salt.len, ikm.p, ikm.len, inf.p,
			 inf.len, out, bits / 8) != 0) {
		free(out);
		return JS_NULL;
	}
	r = buffer(ctx, out, bits / 8);
	free(out);
	return r;
}

/* random(length): at most 65536 bytes, the script side checks */
static JSValue js_random(JSContext *ctx, JSValueConst this_val,
			 int argc, JSValueConst *argv)
{
	mbedtls_ctr_drbg_context *g = rng();
	int32_t n;
	uint8_t *out;
	JSValue r;

	(void)this_val;
	(void)argc;
	if (arg_int(ctx, argv[0], &n) != 0) {
		return JS_EXCEPTION;
	}
	if (g == NULL || n < 0 || n > 65536) {
		return JS_NULL;
	}
	out = malloc(n > 0 ? n : 1);
	if (out == NULL) {
		return JS_ThrowOutOfMemory(ctx);
	}
	/* the generator hands out at most 1024 bytes a call */
	{
		int32_t done = 0;

		while (done < n) {
			int32_t step = n - done > 1024 ? 1024 : n - done;

			if (mbedtls_ctr_drbg_random(g, out + done, step) != 0) {
				free(out);
				return JS_NULL;
			}
			done += step;
		}
	}
	r = buffer(ctx, out, n);
	free(out);
	return r;
}

/* ------------------------------------------------------------------------ */
/* AES                                                                      */

/* aesGcm(encrypt, key, iv, data, aad, tagBits) */
static JSValue js_aes_gcm(JSContext *ctx, JSValueConst this_val,
			  int argc, JSValueConst *argv)
{
	struct bytes key, iv, data, aad;
	int32_t tag_bits;
	bool enc = JS_ToBool(ctx, argv[0]);
	mbedtls_gcm_context gcm;
	uint8_t *out;
	size_t tag_len, out_len;
	JSValue r = JS_NULL;
	int rc;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[1], &key) != 0 ||
	    arg_bytes(ctx, argv[2], &iv) != 0 ||
	    arg_bytes(ctx, argv[3], &data) != 0 ||
	    arg_bytes(ctx, argv[4], &aad) != 0 ||
	    arg_int(ctx, argv[5], &tag_bits) != 0) {
		return JS_EXCEPTION;
	}
	tag_len = tag_bits / 8;
	if (iv.len == 0 || tag_len < 4 || tag_len > 16 ||
	    (!enc && data.len < tag_len)) {
		return JS_NULL;
	}
	out_len = enc ? data.len + tag_len : data.len - tag_len;
	out = malloc(out_len > 0 ? out_len : 1);
	if (out == NULL) {
		return JS_ThrowOutOfMemory(ctx);
	}
	mbedtls_gcm_init(&gcm);
	rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key.p,
				key.len * 8);
	if (rc == 0 && enc) {
		rc = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT,
					       data.len, iv.p, iv.len, aad.p,
					       aad.len, data.p, out,
					       tag_len, out + data.len);
	} else if (rc == 0) {
		rc = mbedtls_gcm_auth_decrypt(&gcm, out_len, iv.p, iv.len,
					      aad.p, aad.len,
					      data.p + out_len, tag_len,
					      data.p, out);
	}
	mbedtls_gcm_free(&gcm);
	if (rc == 0) {
		r = buffer(ctx, out, out_len);
	}
	free(out);
	return r;
}

/* aesCbc(encrypt, key, iv, data): PKCS#7 padding, as WebCrypto has it */
static JSValue js_aes_cbc(JSContext *ctx, JSValueConst this_val,
			  int argc, JSValueConst *argv)
{
	struct bytes key, iv, data;
	bool enc = JS_ToBool(ctx, argv[0]);
	mbedtls_aes_context aes;
	unsigned char ivc[16];
	uint8_t *in = NULL, *out = NULL;
	size_t len, out_len;
	JSValue r = JS_NULL;
	int rc;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[1], &key) != 0 ||
	    arg_bytes(ctx, argv[2], &iv) != 0 ||
	    arg_bytes(ctx, argv[3], &data) != 0) {
		return JS_EXCEPTION;
	}
	if (iv.len != 16 || (!enc && (data.len == 0 || data.len % 16))) {
		return JS_NULL;
	}
	len = enc ? (data.len / 16 + 1) * 16 : data.len;
	in = malloc(len);
	out = malloc(len);
	if (in == NULL || out == NULL) {
		free(in);
		free(out);
		return JS_ThrowOutOfMemory(ctx);
	}
	memcpy(in, data.p, data.len);
	if (enc) {
		memset(in + data.len, (int)(len - data.len), len - data.len);
	}
	memcpy(ivc, iv.p, 16);
	mbedtls_aes_init(&aes);
	rc = enc ? mbedtls_aes_setkey_enc(&aes, key.p, key.len * 8)
		 : mbedtls_aes_setkey_dec(&aes, key.p, key.len * 8);
	if (rc == 0) {
		rc = mbedtls_aes_crypt_cbc(&aes, enc ? MBEDTLS_AES_ENCRYPT
					   : MBEDTLS_AES_DECRYPT,
					   len, ivc, in, out);
	}
	mbedtls_aes_free(&aes);
	out_len = len;
	if (rc == 0 && !enc) {
		/* the padding has to be whole, or the key or data are wrong */
		unsigned pad = out[len - 1];
		size_t i;

		if (pad == 0 || pad > 16) {
			rc = -1;
		} else {
			for (i = len - pad; i < len; i++) {
				if (out[i] != pad) {
					rc = -1;
				}
			}
			out_len = len - pad;
		}
	}
	if (rc == 0) {
		r = buffer(ctx, out, out_len);
	}
	free(in);
	free(out);
	return r;
}

/*
 * aesCtr(key, counter, bits, data). Only the rightmost \a bits of the
 * counter block count up, and they may not come round to where they
 * started: mbedTLS's own CTR counts the whole block, so this does it by
 * hand.
 */
static JSValue js_aes_ctr(JSContext *ctx, JSValueConst this_val,
			  int argc, JSValueConst *argv)
{
	struct bytes key, counter, data;
	int32_t bits;
	mbedtls_aes_context aes;
	unsigned char block[16], stream[16];
	uint8_t *out;
	size_t i, blocks;
	JSValue r = JS_NULL;
	int rc;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[0], &key) != 0 ||
	    arg_bytes(ctx, argv[1], &counter) != 0 ||
	    arg_int(ctx, argv[2], &bits) != 0 ||
	    arg_bytes(ctx, argv[3], &data) != 0) {
		return JS_EXCEPTION;
	}
	if (counter.len != 16 || bits < 1 || bits > 128) {
		return JS_NULL;
	}
	blocks = (data.len + 15) / 16;
	if (bits < 64 && blocks > ((uint64_t)1 << bits)) {
		return JS_NULL; /* the counter would repeat */
	}
	out = malloc(data.len > 0 ? data.len : 1);
	if (out == NULL) {
		return JS_ThrowOutOfMemory(ctx);
	}
	memcpy(block, counter.p, 16);
	mbedtls_aes_init(&aes);
	rc = mbedtls_aes_setkey_enc(&aes, key.p, key.len * 8);
	for (i = 0; rc == 0 && i < data.len; i += 16) {
		size_t j, n = data.len - i < 16 ? data.len - i : 16;
		int bit;

		rc = mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_ENCRYPT, block,
					   stream);
		for (j = 0; j < n; j++) {
			out[i + j] = data.p[i + j] ^ stream[j];
		}
		/* add one to the low bits, carrying no further */
		for (bit = 0; bit < bits; bit += 8) {
			int idx = 15 - bit / 8;
			int width = bits - bit >= 8 ? 8 : bits - bit;
			unsigned mask = (1u << width) - 1;
			unsigned low = block[idx] & mask;

			low = (low + 1) & mask;
			block[idx] = (unsigned char)((block[idx] & ~mask) | low);
			if (low != 0) {
				break;
			}
		}
	}
	mbedtls_aes_free(&aes);
	if (rc == 0) {
		r = buffer(ctx, out, data.len);
	}
	free(out);
	return r;
}

/* aesKw(wrap, key, data) */
static JSValue js_aes_kw(JSContext *ctx, JSValueConst this_val,
			 int argc, JSValueConst *argv)
{
	struct bytes key, data;
	bool wrap = JS_ToBool(ctx, argv[0]);
	mbedtls_nist_kw_context kw;
	uint8_t *out;
	size_t out_len = 0, cap;
	JSValue r = JS_NULL;
	int rc;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[1], &key) != 0 ||
	    arg_bytes(ctx, argv[2], &data) != 0) {
		return JS_EXCEPTION;
	}
	if (data.len < 16 || data.len % 8 != 0) {
		return JS_NULL;
	}
	cap = data.len + 8;
	out = malloc(cap);
	if (out == NULL) {
		return JS_ThrowOutOfMemory(ctx);
	}
	mbedtls_nist_kw_init(&kw);
	rc = mbedtls_nist_kw_setkey(&kw, MBEDTLS_CIPHER_ID_AES, key.p,
				    key.len * 8, wrap ? 1 : 0);
	if (rc == 0 && wrap) {
		rc = mbedtls_nist_kw_wrap(&kw, MBEDTLS_KW_MODE_KW, data.p,
					  data.len, out, &out_len, cap);
	} else if (rc == 0) {
		rc = mbedtls_nist_kw_unwrap(&kw, MBEDTLS_KW_MODE_KW, data.p,
					    data.len, out, &out_len, cap);
	}
	mbedtls_nist_kw_free(&kw);
	if (rc == 0) {
		r = buffer(ctx, out, out_len);
	}
	free(out);
	return r;
}

/* ------------------------------------------------------------------------ */
/* DER, for the key formats mbedTLS writes differently                     */

/*
 * The AlgorithmIdentifier of an EC key: id-ecPublicKey and the curve.
 * mbedTLS writes a private key as SEC1 and WebCrypto wants PKCS#8, so
 * both EC formats are written here.
 */
static const uint8_t oid_ec_public_key[] = {
	0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01 };
static const uint8_t oid_p256[] = {
	0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07 };
static const uint8_t oid_p384[] = { 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22 };
static const uint8_t oid_p521[] = { 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23 };
static const uint8_t alg_rsa[] = {
	0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
	0x01, 0x01, 0x05, 0x00 };

/** A growable buffer built front to back. */
struct der {
	uint8_t *p;
	size_t len, cap;
	bool failed;
};

static void der_put(struct der *d, const void *p, size_t n)
{
	if (d->failed) {
		return;
	}
	if (d->len + n > d->cap) {
		size_t cap = (d->len + n) * 2 + 64;
		uint8_t *np = realloc(d->p, cap);

		if (np == NULL) {
			d->failed = true;
			return;
		}
		d->p = np;
		d->cap = cap;
	}
	memcpy(d->p + d->len, p, n);
	d->len += n;
}

static void der_head(struct der *d, uint8_t tag, size_t len)
{
	uint8_t h[6];
	size_t n = 0;

	h[n++] = tag;
	if (len < 0x80) {
		h[n++] = (uint8_t)len;
	} else if (len < 0x100) {
		h[n++] = 0x81;
		h[n++] = (uint8_t)len;
	} else if (len < 0x10000) {
		h[n++] = 0x82;
		h[n++] = (uint8_t)(len >> 8);
		h[n++] = (uint8_t)len;
	} else {
		h[n++] = 0x83;
		h[n++] = (uint8_t)(len >> 16);
		h[n++] = (uint8_t)(len >> 8);
		h[n++] = (uint8_t)len;
	}
	der_put(d, h, n);
}

/** Wrap what \a inner holds in a tag, into \a out. */
static void der_wrap(struct der *out, uint8_t tag, const struct der *inner)
{
	if (inner->failed) {
		out->failed = true;
		return;
	}
	der_head(out, tag, inner->len);
	der_put(out, inner->p, inner->len);
}

static void der_ec_algorithm(struct der *d, mbedtls_ecp_group_id id)
{
	struct der alg = { NULL, 0, 0, false };

	der_put(&alg, oid_ec_public_key, sizeof(oid_ec_public_key));
	switch (id) {
	case MBEDTLS_ECP_DP_SECP256R1:
		der_put(&alg, oid_p256, sizeof(oid_p256));
		break;
	case MBEDTLS_ECP_DP_SECP384R1:
		der_put(&alg, oid_p384, sizeof(oid_p384));
		break;
	default:
		der_put(&alg, oid_p521, sizeof(oid_p521));
		break;
	}
	der_wrap(d, 0x30, &alg);
	free(alg.p);
}

/** SubjectPublicKeyInfo for an EC point. */
static void der_ec_spki(struct der *d, mbedtls_ecp_group_id id,
			const struct bytes *pub)
{
	struct der body = { NULL, 0, 0, false };
	uint8_t zero = 0;

	der_ec_algorithm(&body, id);
	der_head(&body, 0x03, pub->len + 1);
	der_put(&body, &zero, 1);
	der_put(&body, pub->p, pub->len);
	der_wrap(d, 0x30, &body);
	free(body.p);
}

/** PKCS#8 PrivateKeyInfo around a SEC1 ECPrivateKey. */
static void der_ec_pkcs8(struct der *d, mbedtls_ecp_group_id id,
			 const struct bytes *priv, const struct bytes *pub)
{
	static const uint8_t version0[] = { 0x02, 0x01, 0x00 };
	static const uint8_t version1[] = { 0x02, 0x01, 0x01 };
	struct der ecpk = { NULL, 0, 0, false };
	struct der ecseq = { NULL, 0, 0, false };
	struct der bits = { NULL, 0, 0, false };
	struct der body = { NULL, 0, 0, false };
	struct der octets = { NULL, 0, 0, false };
	uint8_t zero = 0;

	der_put(&ecpk, version1, sizeof(version1));
	der_head(&ecpk, 0x04, priv->len);
	der_put(&ecpk, priv->p, priv->len);
	der_head(&bits, 0x03, pub->len + 1);
	der_put(&bits, &zero, 1);
	der_put(&bits, pub->p, pub->len);
	der_wrap(&ecpk, 0xa1, &bits);
	der_wrap(&ecseq, 0x30, &ecpk);

	der_put(&body, version0, sizeof(version0));
	der_ec_algorithm(&body, id);
	der_wrap(&octets, 0x04, &ecseq);
	der_put(&body, octets.p, octets.len);
	if (octets.failed) {
		body.failed = true;
	}
	der_wrap(d, 0x30, &body);
	free(ecpk.p);
	free(ecseq.p);
	free(bits.p);
	free(body.p);
	free(octets.p);
}

/** PKCS#8 PrivateKeyInfo around a PKCS#1 RSAPrivateKey. */
static void der_rsa_pkcs8(struct der *d, const uint8_t *pkcs1, size_t len)
{
	static const uint8_t version0[] = { 0x02, 0x01, 0x00 };
	struct der body = { NULL, 0, 0, false };

	der_put(&body, version0, sizeof(version0));
	der_put(&body, alg_rsa, sizeof(alg_rsa));
	der_head(&body, 0x04, len);
	der_put(&body, pkcs1, len);
	der_wrap(d, 0x30, &body);
	free(body.p);
}

static JSValue der_result(JSContext *ctx, struct der *d)
{
	JSValue r = d->failed ? JS_ThrowOutOfMemory(ctx)
			      : buffer(ctx, d->p, d->len);

	free(d->p);
	return r;
}

/* ------------------------------------------------------------------------ */
/* Elliptic curves                                                          */

/** Load the group; the key's private scalar width in bytes. */
static size_t ec_group(mbedtls_ecp_group *grp, mbedtls_ecp_group_id id)
{
	if (mbedtls_ecp_group_load(grp, id) != 0) {
		return 0;
	}
	return (grp->nbits + 7) / 8;
}

/* ecGenerate(curve) -> [d, pub] */
static JSValue js_ec_generate(JSContext *ctx, JSValueConst this_val,
			      int argc, JSValueConst *argv)
{
	mbedtls_ecp_group_id id = curve_id(ctx, argv[0]);
	mbedtls_ctr_drbg_context *g = rng();
	mbedtls_ecp_group grp;
	mbedtls_mpi d;
	mbedtls_ecp_point q;
	uint8_t pub[MBEDTLS_ECP_MAX_PT_LEN];
	size_t plen = 0, width;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (id == MBEDTLS_ECP_DP_NONE || g == NULL) {
		return JS_NULL;
	}
	mbedtls_ecp_group_init(&grp);
	mbedtls_mpi_init(&d);
	mbedtls_ecp_point_init(&q);
	width = ec_group(&grp, id);
	if (width != 0 &&
	    mbedtls_ecp_gen_keypair(&grp, &d, &q, rng_fill, g) == 0 &&
	    mbedtls_ecp_point_write_binary(&grp, &q,
					   MBEDTLS_ECP_PF_UNCOMPRESSED,
					   &plen, pub, sizeof(pub)) == 0) {
		r = JS_NewArray(ctx);
		JS_SetPropertyUint32(ctx, r, 0, mpi_buffer(ctx, &d, width));
		JS_SetPropertyUint32(ctx, r, 1, buffer(ctx, pub, plen));
	}
	mbedtls_ecp_point_free(&q);
	mbedtls_mpi_free(&d);
	mbedtls_ecp_group_free(&grp);
	return r;
}

/*
 * ecCheck(curve, d, pub) -> pub. Either may be null, not both. The
 * point is checked to be on the curve, and a public point is worked out
 * from d when none came with it; with both, they have to agree.
 */
static JSValue js_ec_check(JSContext *ctx, JSValueConst this_val,
			   int argc, JSValueConst *argv)
{
	mbedtls_ecp_group_id id = curve_id(ctx, argv[0]);
	mbedtls_ctr_drbg_context *g = rng();
	struct bytes db, pb;
	mbedtls_ecp_group grp;
	mbedtls_mpi d;
	mbedtls_ecp_point q, qd;
	uint8_t pub[MBEDTLS_ECP_MAX_PT_LEN];
	size_t plen = 0;
	bool have_d = !JS_IsNull(argv[1]), have_q = !JS_IsNull(argv[2]);
	bool ok;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[1], &db) != 0 ||
	    arg_bytes(ctx, argv[2], &pb) != 0) {
		return JS_EXCEPTION;
	}
	if (id == MBEDTLS_ECP_DP_NONE || g == NULL || (!have_d && !have_q)) {
		return JS_NULL;
	}
	mbedtls_ecp_group_init(&grp);
	mbedtls_mpi_init(&d);
	mbedtls_ecp_point_init(&q);
	mbedtls_ecp_point_init(&qd);
	ok = ec_group(&grp, id) != 0;
	if (ok && have_q) {
		ok = mbedtls_ecp_point_read_binary(&grp, &q, pb.p,
						   pb.len) == 0 &&
		     mbedtls_ecp_check_pubkey(&grp, &q) == 0;
	}
	if (ok && have_d) {
		ok = mbedtls_mpi_read_binary(&d, db.p, db.len) == 0 &&
		     mbedtls_ecp_check_privkey(&grp, &d) == 0 &&
		     mbedtls_ecp_mul(&grp, &qd, &d, &grp.G, rng_fill,
				     g) == 0;
		if (ok && have_q) {
			ok = mbedtls_ecp_point_cmp(&q, &qd) == 0;
		} else if (ok) {
			ok = mbedtls_ecp_copy(&q, &qd) == 0;
		}
	}
	if (ok && mbedtls_ecp_point_write_binary(&grp, &q,
			MBEDTLS_ECP_PF_UNCOMPRESSED, &plen, pub,
			sizeof(pub)) == 0) {
		r = buffer(ctx, pub, plen);
	}
	mbedtls_ecp_point_free(&qd);
	mbedtls_ecp_point_free(&q);
	mbedtls_mpi_free(&d);
	mbedtls_ecp_group_free(&grp);
	return r;
}

/* ecPoint(curve, compressedOrUncompressed) -> uncompressed, for 'raw' */
static JSValue js_ec_point(JSContext *ctx, JSValueConst this_val,
			   int argc, JSValueConst *argv)
{
	JSValueConst args[3];

	(void)argc;
	args[0] = argv[0];
	args[1] = JS_NULL;
	args[2] = argv[1];
	return js_ec_check(ctx, this_val, 3, args);
}

/*
 * ecImport(format, der) -> [curve, d or null, pub]. Reads a
 * SubjectPublicKeyInfo ("spki") or a PKCS#8 PrivateKeyInfo ("pkcs8").
 */
static JSValue js_ec_import(JSContext *ctx, JSValueConst this_val,
			    int argc, JSValueConst *argv)
{
	const char *fmt = JS_ToCString(ctx, argv[0]);
	mbedtls_ctr_drbg_context *g = rng();
	struct bytes der;
	mbedtls_pk_context pk;
	mbedtls_ecp_group grp;
	mbedtls_mpi d;
	mbedtls_ecp_point q;
	uint8_t pub[MBEDTLS_ECP_MAX_PT_LEN];
	size_t plen = 0, width;
	bool priv;
	int rc;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (fmt == NULL) {
		return JS_EXCEPTION;
	}
	priv = strcmp(fmt, "pkcs8") == 0;
	JS_FreeCString(ctx, fmt);
	if (arg_bytes(ctx, argv[1], &der) != 0) {
		return JS_EXCEPTION;
	}
	if (g == NULL) {
		return JS_NULL;
	}
	mbedtls_pk_init(&pk);
	mbedtls_ecp_group_init(&grp);
	mbedtls_mpi_init(&d);
	mbedtls_ecp_point_init(&q);
	rc = priv ? mbedtls_pk_parse_key(&pk, der.p, der.len, NULL, 0,
					 rng_fill, g)
		  : mbedtls_pk_parse_public_key(&pk, der.p, der.len);
	if (rc == 0 && mbedtls_pk_get_type(&pk) == MBEDTLS_PK_ECKEY &&
	    mbedtls_ecp_export(mbedtls_pk_ec(pk), &grp, &d, &q) == 0 &&
	    mbedtls_ecp_point_write_binary(&grp, &q,
					   MBEDTLS_ECP_PF_UNCOMPRESSED,
					   &plen, pub, sizeof(pub)) == 0) {
		const char *name = grp.id == MBEDTLS_ECP_DP_SECP256R1 ? "P-256"
			: grp.id == MBEDTLS_ECP_DP_SECP384R1 ? "P-384"
			: grp.id == MBEDTLS_ECP_DP_SECP521R1 ? "P-521" : NULL;

		width = (grp.nbits + 7) / 8;
		if (name != NULL) {
			r = JS_NewArray(ctx);
			JS_SetPropertyUint32(ctx, r, 0,
					     JS_NewString(ctx, name));
			JS_SetPropertyUint32(ctx, r, 1, priv ?
					     mpi_buffer(ctx, &d, width) :
					     JS_NULL);
			JS_SetPropertyUint32(ctx, r, 2,
					     buffer(ctx, pub, plen));
		}
	}
	mbedtls_ecp_point_free(&q);
	mbedtls_mpi_free(&d);
	mbedtls_ecp_group_free(&grp);
	mbedtls_pk_free(&pk);
	return r;
}

/* ecExport(format, curve, d, pub) -> DER */
static JSValue js_ec_export(JSContext *ctx, JSValueConst this_val,
			    int argc, JSValueConst *argv)
{
	const char *fmt = JS_ToCString(ctx, argv[0]);
	mbedtls_ecp_group_id id = curve_id(ctx, argv[1]);
	struct bytes db, pb;
	struct der out = { NULL, 0, 0, false };
	bool priv;

	(void)this_val;
	(void)argc;
	if (fmt == NULL) {
		return JS_EXCEPTION;
	}
	priv = strcmp(fmt, "pkcs8") == 0;
	JS_FreeCString(ctx, fmt);
	if (arg_bytes(ctx, argv[2], &db) != 0 ||
	    arg_bytes(ctx, argv[3], &pb) != 0) {
		return JS_EXCEPTION;
	}
	if (id == MBEDTLS_ECP_DP_NONE) {
		return JS_NULL;
	}
	if (priv) {
		der_ec_pkcs8(&out, id, &db, &pb);
	} else {
		der_ec_spki(&out, id, &pb);
	}
	return der_result(ctx, &out);
}

/* ecdsaSign(curve, hash, d, data) -> r || s */
static JSValue js_ecdsa_sign(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv)
{
	mbedtls_ecp_group_id id = curve_id(ctx, argv[0]);
	const mbedtls_md_info_t *info =
		mbedtls_md_info_from_type(md_type(ctx, argv[1]));
	mbedtls_ctr_drbg_context *g = rng();
	struct bytes db, data;
	mbedtls_ecp_group grp;
	mbedtls_mpi d, rr, ss;
	uint8_t hash[MBEDTLS_MD_MAX_SIZE], sig[2 * 66];
	size_t width;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[2], &db) != 0 ||
	    arg_bytes(ctx, argv[3], &data) != 0) {
		return JS_EXCEPTION;
	}
	if (id == MBEDTLS_ECP_DP_NONE || info == NULL || g == NULL) {
		return JS_NULL;
	}
	mbedtls_ecp_group_init(&grp);
	mbedtls_mpi_init(&d);
	mbedtls_mpi_init(&rr);
	mbedtls_mpi_init(&ss);
	width = ec_group(&grp, id);
	if (width != 0 && 2 * width <= sizeof(sig) &&
	    mbedtls_md(info, data.p, data.len, hash) == 0 &&
	    mbedtls_mpi_read_binary(&d, db.p, db.len) == 0 &&
	    mbedtls_ecdsa_sign(&grp, &rr, &ss, &d, hash,
			       mbedtls_md_get_size(info), rng_fill, g) == 0 &&
	    mbedtls_mpi_write_binary(&rr, sig, width) == 0 &&
	    mbedtls_mpi_write_binary(&ss, sig + width, width) == 0) {
		r = buffer(ctx, sig, 2 * width);
	}
	mbedtls_mpi_free(&ss);
	mbedtls_mpi_free(&rr);
	mbedtls_mpi_free(&d);
	mbedtls_ecp_group_free(&grp);
	return r;
}

/* ecdsaVerify(curve, hash, pub, sig, data) -> bool */
static JSValue js_ecdsa_verify(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	mbedtls_ecp_group_id id = curve_id(ctx, argv[0]);
	const mbedtls_md_info_t *info =
		mbedtls_md_info_from_type(md_type(ctx, argv[1]));
	struct bytes pb, sig, data;
	mbedtls_ecp_group grp;
	mbedtls_ecp_point q;
	mbedtls_mpi rr, ss;
	uint8_t hash[MBEDTLS_MD_MAX_SIZE];
	size_t width;
	bool ok = false;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[2], &pb) != 0 ||
	    arg_bytes(ctx, argv[3], &sig) != 0 ||
	    arg_bytes(ctx, argv[4], &data) != 0) {
		return JS_EXCEPTION;
	}
	if (id == MBEDTLS_ECP_DP_NONE || info == NULL) {
		return JS_NULL;
	}
	mbedtls_ecp_group_init(&grp);
	mbedtls_ecp_point_init(&q);
	mbedtls_mpi_init(&rr);
	mbedtls_mpi_init(&ss);
	width = ec_group(&grp, id);
	/* a signature of the wrong length is simply not valid */
	if (width != 0 && sig.len == 2 * width &&
	    mbedtls_md(info, data.p, data.len, hash) == 0 &&
	    mbedtls_ecp_point_read_binary(&grp, &q, pb.p, pb.len) == 0 &&
	    mbedtls_mpi_read_binary(&rr, sig.p, width) == 0 &&
	    mbedtls_mpi_read_binary(&ss, sig.p + width, width) == 0) {
		ok = mbedtls_ecdsa_verify(&grp, hash,
					  mbedtls_md_get_size(info), &q,
					  &rr, &ss) == 0;
	}
	mbedtls_mpi_free(&ss);
	mbedtls_mpi_free(&rr);
	mbedtls_ecp_point_free(&q);
	mbedtls_ecp_group_free(&grp);
	return JS_NewBool(ctx, ok);
}

/* ecdh(curve, d, peerPub) -> the shared x coordinate */
static JSValue js_ecdh(JSContext *ctx, JSValueConst this_val,
		       int argc, JSValueConst *argv)
{
	mbedtls_ecp_group_id id = curve_id(ctx, argv[0]);
	mbedtls_ctr_drbg_context *g = rng();
	struct bytes db, pb;
	mbedtls_ecp_group grp;
	mbedtls_ecp_point q;
	mbedtls_mpi d, z;
	size_t width;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[1], &db) != 0 ||
	    arg_bytes(ctx, argv[2], &pb) != 0) {
		return JS_EXCEPTION;
	}
	if (id == MBEDTLS_ECP_DP_NONE || g == NULL) {
		return JS_NULL;
	}
	mbedtls_ecp_group_init(&grp);
	mbedtls_ecp_point_init(&q);
	mbedtls_mpi_init(&d);
	mbedtls_mpi_init(&z);
	width = ec_group(&grp, id);
	if (width != 0 &&
	    mbedtls_ecp_point_read_binary(&grp, &q, pb.p, pb.len) == 0 &&
	    mbedtls_ecp_check_pubkey(&grp, &q) == 0 &&
	    mbedtls_mpi_read_binary(&d, db.p, db.len) == 0 &&
	    mbedtls_ecdh_compute_shared(&grp, &z, &q, &d, rng_fill, g) == 0) {
		/* the field's width, which is the key's for these curves */
		r = mpi_buffer(ctx, &z, (grp.pbits + 7) / 8);
	}
	mbedtls_mpi_free(&z);
	mbedtls_mpi_free(&d);
	mbedtls_ecp_point_free(&q);
	mbedtls_ecp_group_free(&grp);
	return r;
}

/* ------------------------------------------------------------------------ */
/* RSA                                                                      */

/** Parse a key the script side holds: PKCS#8 if private, else SPKI. */
static int rsa_parse(mbedtls_pk_context *pk, const struct bytes *der,
		     bool priv)
{
	mbedtls_ctr_drbg_context *g = rng();
	int rc;

	if (g == NULL) {
		return -1;
	}
	rc = priv ? mbedtls_pk_parse_key(pk, der->p, der->len, NULL, 0,
					 rng_fill, g)
		  : mbedtls_pk_parse_public_key(pk, der->p, der->len);
	if (rc != 0 || mbedtls_pk_get_type(pk) != MBEDTLS_PK_RSA) {
		return -1;
	}
	return 0;
}

/** The key's SPKI and, when private, PKCS#8 encodings, as [pkcs8, spki]. */
static JSValue rsa_encodings(JSContext *ctx, mbedtls_pk_context *pk,
			     bool priv)
{
	/* a 16384-bit key's private part is under 10 KB of DER */
	size_t cap = 16 * 1024;
	uint8_t *buf = malloc(cap);
	JSValue r = JS_NULL, spki, pkcs8 = JS_NULL;
	int n;

	if (buf == NULL) {
		return JS_ThrowOutOfMemory(ctx);
	}
	n = mbedtls_pk_write_pubkey_der(pk, buf, cap);
	if (n <= 0) {
		free(buf);
		return JS_NULL;
	}
	spki = buffer(ctx, buf + cap - n, n);
	if (priv) {
		struct der out = { NULL, 0, 0, false };

		n = mbedtls_pk_write_key_der(pk, buf, cap);
		if (n <= 0) {
			JS_FreeValue(ctx, spki);
			free(buf);
			return JS_NULL;
		}
		der_rsa_pkcs8(&out, buf + cap - n, n);
		pkcs8 = der_result(ctx, &out);
	}
	free(buf);
	r = JS_NewArray(ctx);
	JS_SetPropertyUint32(ctx, r, 0, pkcs8);
	JS_SetPropertyUint32(ctx, r, 1, spki);
	return r;
}

/* rsaGenerate(bits, exponent) -> [pkcs8, spki] */
static JSValue js_rsa_generate(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	mbedtls_ctr_drbg_context *g = rng();
	int32_t bits, e;
	mbedtls_pk_context pk;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (arg_int(ctx, argv[0], &bits) != 0 ||
	    arg_int(ctx, argv[1], &e) != 0) {
		return JS_EXCEPTION;
	}
	if (g == NULL || bits < 1024 || bits > 8192 || bits % 8 != 0 ||
	    e < 3 || (e & 1) == 0) {
		return JS_NULL;
	}
	mbedtls_pk_init(&pk);
	if (mbedtls_pk_setup(&pk,
			     mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) == 0 &&
	    mbedtls_rsa_gen_key(mbedtls_pk_rsa(pk), rng_fill, g,
				(unsigned)bits, e) == 0) {
		r = rsa_encodings(ctx, &pk, true);
	}
	mbedtls_pk_free(&pk);
	return r;
}

/*
 * rsaImport(format, der) -> [pkcs8 or null, spki, modulusBits, e].
 * Parsed and written again, so what the script keeps is canonical.
 */
static JSValue js_rsa_import(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv)
{
	const char *fmt = JS_ToCString(ctx, argv[0]);
	struct bytes der;
	mbedtls_pk_context pk;
	mbedtls_mpi e;
	bool priv;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (fmt == NULL) {
		return JS_EXCEPTION;
	}
	priv = strcmp(fmt, "pkcs8") == 0;
	JS_FreeCString(ctx, fmt);
	if (arg_bytes(ctx, argv[1], &der) != 0) {
		return JS_EXCEPTION;
	}
	mbedtls_pk_init(&pk);
	mbedtls_mpi_init(&e);
	if (rsa_parse(&pk, &der, priv) == 0 &&
	    mbedtls_rsa_export(mbedtls_pk_rsa(pk), NULL, NULL, NULL, NULL,
			       &e) == 0) {
		r = rsa_encodings(ctx, &pk, priv);
		if (JS_IsArray(r)) {
			JS_SetPropertyUint32(ctx, r, 2, JS_NewInt32(ctx,
				(int32_t)mbedtls_pk_get_bitlen(&pk)));
			JS_SetPropertyUint32(ctx, r, 3,
					     mpi_buffer(ctx, &e, 0));
		}
	}
	mbedtls_mpi_free(&e);
	mbedtls_pk_free(&pk);
	return r;
}

/*
 * rsaFromJwk([n, e, d, p, q, dp, dq, qi]) -> [pkcs8 or null, spki].
 * Only n and e for a public key. The CRT values are worked out again
 * from p, q and d, and the key is checked before it is taken.
 */
static JSValue js_rsa_from_jwk(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	struct bytes part[8];
	mbedtls_pk_context pk;
	mbedtls_rsa_context *rsa;
	bool priv;
	int i, rc;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	for (i = 0; i < 8; i++) {
		JSValue v = JS_GetPropertyUint32(ctx, argv[0], i);
		int bad = arg_bytes(ctx, v, &part[i]);

		/* the array holds the buffers, so the bytes stay alive */
		JS_FreeValue(ctx, v);
		if (bad != 0) {
			return JS_EXCEPTION;
		}
	}
	priv = part[2].len > 0;
	mbedtls_pk_init(&pk);
	rc = mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA));
	rsa = rc == 0 ? mbedtls_pk_rsa(pk) : NULL;
	if (rsa != NULL) {
		rc = mbedtls_rsa_import_raw(rsa,
			part[0].p, part[0].len,
			priv ? part[3].p : NULL, priv ? part[3].len : 0,
			priv ? part[4].p : NULL, priv ? part[4].len : 0,
			priv ? part[2].p : NULL, priv ? part[2].len : 0,
			part[1].p, part[1].len);
		if (rc == 0) {
			rc = mbedtls_rsa_complete(rsa);
		}
		if (rc == 0) {
			rc = priv ? mbedtls_rsa_check_privkey(rsa)
				  : mbedtls_rsa_check_pubkey(rsa);
		}
		if (rc == 0) {
			r = rsa_encodings(ctx, &pk, priv);
		}
	}
	mbedtls_pk_free(&pk);
	return r;
}

/* rsaToJwk(der, private) -> [n, e, d, p, q, dp, dq, qi] */
static JSValue js_rsa_to_jwk(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv)
{
	struct bytes der;
	bool priv = JS_ToBool(ctx, argv[1]);
	mbedtls_pk_context pk;
	mbedtls_mpi n, p, q, d, e, dp, dq, qp;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[0], &der) != 0) {
		return JS_EXCEPTION;
	}
	mbedtls_pk_init(&pk);
	mbedtls_mpi_init(&n);
	mbedtls_mpi_init(&p);
	mbedtls_mpi_init(&q);
	mbedtls_mpi_init(&d);
	mbedtls_mpi_init(&e);
	mbedtls_mpi_init(&dp);
	mbedtls_mpi_init(&dq);
	mbedtls_mpi_init(&qp);
	if (rsa_parse(&pk, &der, priv) == 0 &&
	    mbedtls_rsa_export(mbedtls_pk_rsa(pk), &n, priv ? &p : NULL,
			       priv ? &q : NULL, priv ? &d : NULL,
			       &e) == 0 &&
	    (!priv || mbedtls_rsa_export_crt(mbedtls_pk_rsa(pk), &dp, &dq,
					     &qp) == 0)) {
		r = JS_NewArray(ctx);
		JS_SetPropertyUint32(ctx, r, 0, mpi_buffer(ctx, &n, 0));
		JS_SetPropertyUint32(ctx, r, 1, mpi_buffer(ctx, &e, 0));
		if (priv) {
			JS_SetPropertyUint32(ctx, r, 2, mpi_buffer(ctx, &d, 0));
			JS_SetPropertyUint32(ctx, r, 3, mpi_buffer(ctx, &p, 0));
			JS_SetPropertyUint32(ctx, r, 4, mpi_buffer(ctx, &q, 0));
			JS_SetPropertyUint32(ctx, r, 5,
					     mpi_buffer(ctx, &dp, 0));
			JS_SetPropertyUint32(ctx, r, 6,
					     mpi_buffer(ctx, &dq, 0));
			JS_SetPropertyUint32(ctx, r, 7,
					     mpi_buffer(ctx, &qp, 0));
		}
	}
	mbedtls_mpi_free(&qp);
	mbedtls_mpi_free(&dq);
	mbedtls_mpi_free(&dp);
	mbedtls_mpi_free(&e);
	mbedtls_mpi_free(&d);
	mbedtls_mpi_free(&q);
	mbedtls_mpi_free(&p);
	mbedtls_mpi_free(&n);
	mbedtls_pk_free(&pk);
	return r;
}

/* rsaSign(scheme, hash, pkcs8, data, saltLength) */
static JSValue js_rsa_sign(JSContext *ctx, JSValueConst this_val,
			   int argc, JSValueConst *argv)
{
	const char *scheme = JS_ToCString(ctx, argv[0]);
	mbedtls_md_type_t md = md_type(ctx, argv[1]);
	const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
	mbedtls_ctr_drbg_context *g = rng();
	struct bytes der, data;
	int32_t salt;
	bool pss;
	mbedtls_pk_context pk;
	uint8_t hash[MBEDTLS_MD_MAX_SIZE];
	uint8_t *sig = NULL;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (scheme == NULL) {
		return JS_EXCEPTION;
	}
	pss = strcmp(scheme, "pss") == 0;
	JS_FreeCString(ctx, scheme);
	if (arg_bytes(ctx, argv[2], &der) != 0 ||
	    arg_bytes(ctx, argv[3], &data) != 0 ||
	    arg_int(ctx, argv[4], &salt) != 0) {
		return JS_EXCEPTION;
	}
	if (info == NULL || g == NULL) {
		return JS_NULL;
	}
	mbedtls_pk_init(&pk);
	if (rsa_parse(&pk, &der, true) == 0 &&
	    mbedtls_md(info, data.p, data.len, hash) == 0) {
		mbedtls_rsa_context *rsa = mbedtls_pk_rsa(pk);
		size_t len = mbedtls_rsa_get_len(rsa);
		int rc;

		sig = malloc(len);
		if (sig != NULL) {
			if (pss) {
				rc = mbedtls_rsa_set_padding(rsa,
					MBEDTLS_RSA_PKCS_V21, md);
				if (rc == 0) {
					rc = mbedtls_rsa_rsassa_pss_sign_ext(
						rsa, rng_fill, g, md,
						mbedtls_md_get_size(info),
						hash, salt, sig);
				}
			} else {
				rc = mbedtls_rsa_set_padding(rsa,
					MBEDTLS_RSA_PKCS_V15, MBEDTLS_MD_NONE);
				if (rc == 0) {
					rc = mbedtls_rsa_rsassa_pkcs1_v15_sign(
						rsa, rng_fill, g, md,
						mbedtls_md_get_size(info),
						hash, sig);
				}
			}
			if (rc == 0) {
				r = buffer(ctx, sig, len);
			}
		}
	}
	free(sig);
	mbedtls_pk_free(&pk);
	return r;
}

/* rsaVerify(scheme, hash, spki, sig, data, saltLength) -> bool */
static JSValue js_rsa_verify(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv)
{
	const char *scheme = JS_ToCString(ctx, argv[0]);
	mbedtls_md_type_t md = md_type(ctx, argv[1]);
	const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
	struct bytes der, sig, data;
	int32_t salt;
	bool pss, ok = false;
	mbedtls_pk_context pk;
	uint8_t hash[MBEDTLS_MD_MAX_SIZE];

	(void)this_val;
	(void)argc;
	if (scheme == NULL) {
		return JS_EXCEPTION;
	}
	pss = strcmp(scheme, "pss") == 0;
	JS_FreeCString(ctx, scheme);
	if (arg_bytes(ctx, argv[2], &der) != 0 ||
	    arg_bytes(ctx, argv[3], &sig) != 0 ||
	    arg_bytes(ctx, argv[4], &data) != 0 ||
	    arg_int(ctx, argv[5], &salt) != 0) {
		return JS_EXCEPTION;
	}
	if (info == NULL) {
		return JS_NULL;
	}
	mbedtls_pk_init(&pk);
	if (rsa_parse(&pk, &der, false) == 0 &&
	    mbedtls_md(info, data.p, data.len, hash) == 0 &&
	    sig.len == mbedtls_rsa_get_len(mbedtls_pk_rsa(pk))) {
		mbedtls_rsa_context *rsa = mbedtls_pk_rsa(pk);

		if (pss) {
			ok = mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21,
						     md) == 0 &&
			     mbedtls_rsa_rsassa_pss_verify_ext(rsa, md,
				mbedtls_md_get_size(info), hash, md, salt,
				sig.p) == 0;
		} else {
			ok = mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V15,
						     MBEDTLS_MD_NONE) == 0 &&
			     mbedtls_rsa_rsassa_pkcs1_v15_verify(rsa, md,
				mbedtls_md_get_size(info), hash, sig.p) == 0;
		}
	}
	mbedtls_pk_free(&pk);
	return JS_NewBool(ctx, ok);
}

/* rsaOaep(encrypt, hash, der, data, label) */
static JSValue js_rsa_oaep(JSContext *ctx, JSValueConst this_val,
			   int argc, JSValueConst *argv)
{
	bool enc = JS_ToBool(ctx, argv[0]);
	mbedtls_md_type_t md = md_type(ctx, argv[1]);
	mbedtls_ctr_drbg_context *g = rng();
	struct bytes der, data, label;
	mbedtls_pk_context pk;
	uint8_t *out = NULL;
	JSValue r = JS_NULL;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[2], &der) != 0 ||
	    arg_bytes(ctx, argv[3], &data) != 0 ||
	    arg_bytes(ctx, argv[4], &label) != 0) {
		return JS_EXCEPTION;
	}
	if (md == MBEDTLS_MD_NONE || g == NULL) {
		return JS_NULL;
	}
	mbedtls_pk_init(&pk);
	if (rsa_parse(&pk, &der, !enc) == 0) {
		mbedtls_rsa_context *rsa = mbedtls_pk_rsa(pk);
		size_t len = mbedtls_rsa_get_len(rsa), olen = 0;

		out = malloc(len);
		if (out != NULL &&
		    mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21,
					    md) == 0) {
			int rc;

			if (enc) {
				rc = mbedtls_rsa_rsaes_oaep_encrypt(rsa,
					rng_fill, g, label.p, label.len,
					data.len, data.p, out);
				olen = len;
			} else if (data.len != len) {
				rc = -1;
			} else {
				rc = mbedtls_rsa_rsaes_oaep_decrypt(rsa,
					rng_fill, g, label.p, label.len,
					&olen, data.p, out, len);
			}
			if (rc == 0) {
				r = buffer(ctx, out, olen);
			}
		}
	}
	free(out);
	mbedtls_pk_free(&pk);
	return r;
}

/* ------------------------------------------------------------------------ */
/* Ed25519 and X25519, from Monocypher                                      */

/*
 * mbedTLS has no Ed25519, so both of the curve 25519 algorithms come from
 * Monocypher (BSD-2-Clause or CC0), which has both. Keys travel as their
 * 32-byte private and public halves.
 */

static bool okp_kind(JSContext *ctx, JSValueConst v, bool *ed)
{
	const char *s = JS_ToCString(ctx, v);
	bool ok = true;

	if (s == NULL) {
		return false;
	}
	if (strcmp(s, "Ed25519") == 0) {
		*ed = true;
	} else if (strcmp(s, "X25519") == 0) {
		*ed = false;
	} else {
		ok = false;
	}
	JS_FreeCString(ctx, s);
	return ok;
}

/** The public half of a private key. */
static void okp_public(bool ed, const uint8_t priv[32], uint8_t pub[32])
{
	if (ed) {
		uint8_t seed[32], sk[64];

		/* the key pair function wipes the seed it is given */
		memcpy(seed, priv, 32);
		crypto_ed25519_key_pair(sk, pub, seed);
		crypto_wipe(sk, sizeof(sk));
	} else {
		crypto_x25519_public_key(pub, priv);
	}
}

/* okpGenerate(kind) -> [private, public] */
static JSValue js_okp_generate(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	mbedtls_ctr_drbg_context *g = rng();
	uint8_t priv[32], pub[32];
	bool ed;
	JSValue r;

	(void)this_val;
	(void)argc;
	if (!okp_kind(ctx, argv[0], &ed) || g == NULL ||
	    mbedtls_ctr_drbg_random(g, priv, sizeof(priv)) != 0) {
		return JS_NULL;
	}
	okp_public(ed, priv, pub);
	r = JS_NewArray(ctx);
	JS_SetPropertyUint32(ctx, r, 0, buffer(ctx, priv, 32));
	JS_SetPropertyUint32(ctx, r, 1, buffer(ctx, pub, 32));
	crypto_wipe(priv, sizeof(priv));
	return r;
}

/* okpPublic(kind, private) -> public */
static JSValue js_okp_public(JSContext *ctx, JSValueConst this_val,
			     int argc, JSValueConst *argv)
{
	struct bytes priv;
	uint8_t pub[32];
	bool ed;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[1], &priv) != 0) {
		return JS_EXCEPTION;
	}
	if (!okp_kind(ctx, argv[0], &ed) || priv.len != 32) {
		return JS_NULL;
	}
	okp_public(ed, priv.p, pub);
	return buffer(ctx, pub, 32);
}

/*
 * The encodings of the eight points of small order on Ed25519, with the
 * sign bit left out, including the two non-canonical ones (p and p + 1).
 * Worked out from the curve: every multiple of a point of order eight.
 */
static const uint8_t small_order[7][32] = {
	{ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 },
	{ 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 },
	{ 0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4,
	  0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6,
	  0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05 },
	{ 0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b,
	  0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39,
	  0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a },
	{ 0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f },
	{ 0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f },
	{ 0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f },
};

static bool small_order_point(const uint8_t *enc)
{
	int i;

	for (i = 0; i < 7; i++) {
		if (memcmp(enc, small_order[i], 31) == 0 &&
		    (enc[31] & 0x7f) == small_order[i][31]) {
			return true;
		}
	}
	return false;
}

/* ed25519Sign(private, data) -> signature */
static JSValue js_ed25519_sign(JSContext *ctx, JSValueConst this_val,
			       int argc, JSValueConst *argv)
{
	struct bytes priv, data;
	uint8_t seed[32], sk[64], pub[32], sig[64];

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[0], &priv) != 0 ||
	    arg_bytes(ctx, argv[1], &data) != 0) {
		return JS_EXCEPTION;
	}
	if (priv.len != 32) {
		return JS_NULL;
	}
	memcpy(seed, priv.p, 32);
	crypto_ed25519_key_pair(sk, pub, seed);
	crypto_ed25519_sign(sig, sk, data.p, data.len);
	crypto_wipe(sk, sizeof(sk));
	return buffer(ctx, sig, 64);
}

/*
 * ed25519Verify(public, signature, data) -> bool. A key or an R of small
 * order verifies nothing, as the specification now says: with one, a
 * signature can be made to pass for more than one message.
 */
static JSValue js_ed25519_verify(JSContext *ctx, JSValueConst this_val,
				 int argc, JSValueConst *argv)
{
	struct bytes pub, sig, data;
	bool ok;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[0], &pub) != 0 ||
	    arg_bytes(ctx, argv[1], &sig) != 0 ||
	    arg_bytes(ctx, argv[2], &data) != 0) {
		return JS_EXCEPTION;
	}
	ok = pub.len == 32 && sig.len == 64 &&
	     !small_order_point(pub.p) && !small_order_point(sig.p) &&
	     crypto_ed25519_check(sig.p, pub.p, data.p, data.len) == 0;
	return JS_NewBool(ctx, ok);
}

/*
 * x25519(private, peerPublic) -> the shared secret, or null when it is
 * all zeroes: the peer gave a point of small order, and the result says
 * nothing secret.
 */
static JSValue js_x25519(JSContext *ctx, JSValueConst this_val,
			 int argc, JSValueConst *argv)
{
	struct bytes priv, pub;
	uint8_t shared[32], any = 0;
	JSValue r;
	int i;

	(void)this_val;
	(void)argc;
	if (arg_bytes(ctx, argv[0], &priv) != 0 ||
	    arg_bytes(ctx, argv[1], &pub) != 0) {
		return JS_EXCEPTION;
	}
	if (priv.len != 32 || pub.len != 32) {
		return JS_NULL;
	}
	crypto_x25519(shared, priv.p, pub.p);
	for (i = 0; i < 32; i++) {
		any |= shared[i];
	}
	if (any == 0) {
		return JS_NULL;
	}
	r = buffer(ctx, shared, 32);
	crypto_wipe(shared, sizeof(shared));
	return r;
}

/* ------------------------------------------------------------------------ */
/* Registration                                                             */

static const JSCFunctionListEntry subtle_funcs[] = {
	JS_CFUNC_DEF("digest", 2, js_digest),
	JS_CFUNC_DEF("hmac", 3, js_hmac),
	JS_CFUNC_DEF("pbkdf2", 5, js_pbkdf2),
	JS_CFUNC_DEF("hkdf", 5, js_hkdf),
	JS_CFUNC_DEF("random", 1, js_random),
	JS_CFUNC_DEF("aesGcm", 6, js_aes_gcm),
	JS_CFUNC_DEF("aesCbc", 4, js_aes_cbc),
	JS_CFUNC_DEF("aesCtr", 4, js_aes_ctr),
	JS_CFUNC_DEF("aesKw", 3, js_aes_kw),
	JS_CFUNC_DEF("ecGenerate", 1, js_ec_generate),
	JS_CFUNC_DEF("ecCheck", 3, js_ec_check),
	JS_CFUNC_DEF("ecPoint", 2, js_ec_point),
	JS_CFUNC_DEF("ecImport", 2, js_ec_import),
	JS_CFUNC_DEF("ecExport", 4, js_ec_export),
	JS_CFUNC_DEF("ecdsaSign", 4, js_ecdsa_sign),
	JS_CFUNC_DEF("ecdsaVerify", 5, js_ecdsa_verify),
	JS_CFUNC_DEF("ecdh", 3, js_ecdh),
	JS_CFUNC_DEF("rsaGenerate", 2, js_rsa_generate),
	JS_CFUNC_DEF("rsaImport", 2, js_rsa_import),
	JS_CFUNC_DEF("rsaFromJwk", 1, js_rsa_from_jwk),
	JS_CFUNC_DEF("rsaToJwk", 2, js_rsa_to_jwk),
	JS_CFUNC_DEF("rsaSign", 5, js_rsa_sign),
	JS_CFUNC_DEF("rsaVerify", 6, js_rsa_verify),
	JS_CFUNC_DEF("rsaOaep", 5, js_rsa_oaep),
	JS_CFUNC_DEF("okpGenerate", 1, js_okp_generate),
	JS_CFUNC_DEF("okpPublic", 2, js_okp_public),
	JS_CFUNC_DEF("ed25519Sign", 2, js_ed25519_sign),
	JS_CFUNC_DEF("ed25519Verify", 3, js_ed25519_verify),
	JS_CFUNC_DEF("x25519", 2, js_x25519),
};

void vita_subtle_register(JSContext *ctx, JSValueConst global)
{
	JSValue obj = JS_NewObject(ctx);

	JS_SetPropertyFunctionList(ctx, obj, subtle_funcs,
				   sizeof(subtle_funcs) /
				   sizeof(subtle_funcs[0]));
	JS_SetPropertyStr(ctx, global, "__vitaSubtle", obj);
}
