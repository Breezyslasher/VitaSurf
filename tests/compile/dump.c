/*
 * Compile each file named on the command line as a classic script and as
 * a module, in a fresh runtime each, and print its bytecode's size and
 * hash, or the error. Two QuickJS builds that print the same lines
 * compile the same programs to the same bytecode. With -t, print the
 * time each compile took instead. Used by scripts/compile-corpus.sh.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>
#include <quickjs.h>

static double now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static unsigned long long fnv(const unsigned char *p, size_t n)
{
	unsigned long long h = 1469598103934665603ULL;

	while (n--) {
		h ^= *p++;
		h *= 1099511628211ULL;
	}
	return h;
}

int main(int argc, char **argv)
{
	int a = 1, timing = 0, k;

	if (argc > 1 && strcmp(argv[1], "-t") == 0) {
		timing = 1;
		a = 2;
	}
	for (; a < argc; a++) {
		struct stat st;
		FILE *f;
		char *b;
		long n;

		if (stat(argv[a], &st) != 0 || !S_ISREG(st.st_mode))
			continue;
		f = fopen(argv[a], "rb");
		if (f == NULL)
			continue;
		n = (long)st.st_size;
		b = malloc(n + 1);
		if (b == NULL || fread(b, 1, n, f) != (size_t)n) {
			fclose(f);
			free(b);
			continue;
		}
		b[n] = 0;
		fclose(f);
		for (k = 0; k < 2; k++) {
			JSRuntime *rt = JS_NewRuntime();
			JSContext *ctx = JS_NewContext(rt);
			double t = now_ms();
			JSValue v = JS_Eval(ctx, b, n, argv[a],
					    (k ? JS_EVAL_TYPE_MODULE :
					     JS_EVAL_TYPE_GLOBAL) |
					    JS_EVAL_FLAG_COMPILE_ONLY);
			double d = now_ms() - t;

			if (JS_IsException(v)) {
				JSValue e = JS_GetException(ctx);
				const char *s = JS_ToCString(ctx, e);

				if (!timing)
					printf("%s %d ERR %s\n", argv[a], k,
					       s ? s : "?");
				JS_FreeCString(ctx, s);
				JS_FreeValue(ctx, e);
			} else if (timing) {
				printf("%s %d %.2f\n", argv[a], k, d);
			} else {
				size_t len;
				uint8_t *o = JS_WriteObject(ctx, &len, v,
						JS_WRITE_OBJ_BYTECODE);

				printf("%s %d %u %016llx\n", argv[a], k,
				       (unsigned)len,
				       o ? fnv(o, len) : 0ULL);
				js_free(ctx, o);
			}
			JS_FreeValue(ctx, v);
			JS_FreeContext(ctx);
			JS_FreeRuntime(rt);
		}
		free(b);
	}
	return 0;
}
