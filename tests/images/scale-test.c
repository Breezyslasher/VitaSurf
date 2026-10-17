/*
 * The framebuffer frontend's smooth scaling (VitaSurf), held to its
 * sums natively:
 *
 *   gcc -std=c99 -Wall -I deps/netsurf -o scale-test \
 *       tests/images/scale-test.c && ./scale-test
 *
 * Every line must say PASS.
 */

#include <stdio.h>

#include "frontends/framebuffer/scale_smooth.h"

static int fails;

static void check(const char *name, uint32_t got, uint32_t want, int tol)
{
	int i, bad = 0;

	for (i = 0; i < 32; i += 8) {
		int d = (int) ((got >> i) & 255) - (int) ((want >> i) & 255);

		if (d < -tol || d > tol)
			bad = 1;
	}
	printf("%s %s: %08x, want %08x\n", bad ? "FAIL" : "PASS", name,
			(unsigned) got, (unsigned) want);
	fails += bad;
}

int main(void)
{
	uint32_t src[16], dst[64];
	int i;

	src[0] = 0xff0000ff;
	src[1] = 0xff00ff00;
	src[2] = 0xffff0000;
	src[3] = 0xffffffff;
	scale_smooth((uint8_t *) src, 2, 2, 8, (uint8_t *) dst, 1, 1, 4, true);
	check("four pixels shrunk to one are their average", dst[0],
			0xff808080, 1);

	src[0] = 0xff0000ff;
	src[1] = 0x00ff0000;
	scale_smooth((uint8_t *) src, 2, 1, 8, (uint8_t *) dst, 1, 1, 4, true);
	check("a transparent pixel adds no colour", dst[0], 0x800000ff, 1);

	src[0] = 0xff000000;
	src[1] = 0xffffffff;
	scale_smooth((uint8_t *) src, 2, 1, 8, (uint8_t *) dst, 4, 1, 16,
			true);
	check("grown, the first edge", dst[0], 0xff000000, 1);
	check("grown, a quarter of the way", dst[1], 0xff404040, 2);
	check("grown, three quarters of the way", dst[2], 0xffbfbfbf, 2);
	check("grown, the last edge", dst[3], 0xffffffff, 1);

	src[0] = 0xff123456;
	scale_smooth((uint8_t *) src, 1, 1, 4, (uint8_t *) dst, 3, 3, 12,
			true);
	check("one pixel grown is that pixel", dst[4], 0xff123456, 0);

	for (i = 0; i < 16; i++)
		src[i] = ((i >> 1) & 1) ? 0xffffffff : 0xff000000;
	scale_smooth((uint8_t *) src, 16, 1, 64, (uint8_t *) dst, 2, 1, 8,
			false);
	check("shrunk eight times, four samples averaged", dst[0],
			0xff808080, 1);

	return fails != 0;
}
