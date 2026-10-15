/*
 * The framebuffer frontend's scheduler (VitaSurf, patch 0436), natively.
 *
 * It runs only in the Vita build, so this links it on its own:
 *
 *   cd deps/netsurf
 *   gcc -std=c99 -D_DEFAULT_SOURCE -D__vita__ -fsanitize=address,undefined \
 *       -I. -Iinclude -Ifrontends -I../../out/native/include \
 *       -o /tmp/sched ../../tests/scheduler/schedule-test.c \
 *       frontends/framebuffer/schedule.c && /tmp/sched
 *
 * Callbacks run in the order they come due, those due together in the
 * order asked for; asking again for one already scheduled moves it, -1
 * removes it; 20000 with random delays, some removed and some moved,
 * each run once; and a round stops once its callbacks have taken 50 ms,
 * so input and drawing get a turn. It must print "all passed".
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <unistd.h>
#include <stdint.h>
typedef int nserror;
void nslog_log(void *a, const char *f, ...) { (void)a; (void)f; }
int nslog_category_netsurf, nslog_category_schedule;
nserror framebuffer_schedule(int tival, void (*callback)(void *p), void *p);
int schedule_run(void);
const char *vitasurf_phase;
unsigned int vitasurf_ms_script, vitasurf_ms_js_jobs, vitasurf_ms_css, vitasurf_css_parsed,
  vitasurf_ms_inline_style, vitasurf_ms_boxes, vitasurf_ms_layout, vitasurf_layout_runs,
  vitasurf_ms_image, vitasurf_ms_draw, vitasurf_ms_css_index, vitasurf_sched_calls,
  vitasurf_ms_sched, vitasurf_ms_sched_max;
unsigned int vitasurf_since(unsigned int a, unsigned int b) { return a - b; }

static int order[100000], n_order;
static void rec(void *p) { order[n_order++] = (int)(intptr_t)p; }
static void rec2(void *p) { order[n_order++] = 100000 + (int)(intptr_t)p; }
static int fails;
#define CHECK(c, ...) do { if (!(c)) { fails++; printf("FAIL " __VA_ARGS__); printf("\n"); } } while (0)
static void drain(void) { int t; for (int i = 0; i < 1000; i++) { t = schedule_run(); if (t < 0) return; if (t > 0) usleep(t * 1000 + 1000); } }
static void slow(void *p) { (void)p; order[n_order++] = 7; usleep(20000); }

int main(void)
{
	/* due order, ties by asking order */
	framebuffer_schedule(30, rec, (void *)3);
	framebuffer_schedule(10, rec, (void *)1);
	framebuffer_schedule(0, rec, (void *)10);
	framebuffer_schedule(0, rec2, (void *)10);
	framebuffer_schedule(0, rec, (void *)11);
	framebuffer_schedule(20, rec, (void *)2);
	usleep(1000);
	drain();
	{ int want[] = {10, 100010, 11, 1, 2, 3};
	  CHECK(n_order == 6 && !memcmp(order, want, sizeof want), "order %d: %d %d %d %d %d %d", n_order, order[0], order[1], order[2], order[3], order[4], order[5]); }
	/* rescheduling replaces, and -1 removes */
	n_order = 0;
	framebuffer_schedule(5, rec, (void *)1);
	framebuffer_schedule(0, rec, (void *)2);
	framebuffer_schedule(0, rec, (void *)1);   /* now after 2 */
	framebuffer_schedule(0, rec, (void *)3);
	framebuffer_schedule(-1, rec, (void *)3);
	framebuffer_schedule(-1, rec, (void *)99); /* never scheduled */
	usleep(1000);
	drain();
	CHECK(n_order == 2 && order[0] == 2 && order[1] == 1, "replace %d %d %d", n_order, order[0], order[1]);
	/* many: random delays, removals; compare with a model */
	srand(7);
	n_order = 0;
	{
		static int delay[20000], alive[20000], seq[20000];
		int N = 20000, s = 0;
		for (int i = 0; i < N; i++) { delay[i] = rand() % 50; framebuffer_schedule(delay[i], rec, (void *)(intptr_t)(i + 1)); alive[i] = 1; seq[i] = s++; }
		for (int i = 0; i < N; i += 3) { framebuffer_schedule(-1, rec, (void *)(intptr_t)(i + 1)); alive[i] = 0; }
		for (int i = 1; i < N; i += 7) { if (alive[i]) { delay[i] = rand() % 50; framebuffer_schedule(delay[i], rec, (void *)(intptr_t)(i + 1)); seq[i] = s++; } }
		usleep(60000);
		drain();
		int expect = 0; for (int i = 0; i < N; i++) expect += alive[i];
		CHECK(n_order == expect, "count %d want %d", n_order, expect);
		/* every one ran once; and those asked at the same moment with
		   the same delay ran in asking order (delays are coarse) */
		static int seen[20001];
		int dup = 0; for (int k = 0; k < n_order; k++) { if (seen[order[k]]++) dup++; if (!alive[order[k] - 1]) dup++; }
		CHECK(dup == 0, "dups or dead %d", dup);
		int inv = 0; for (int k = 1; k < n_order; k++) { int a = order[k-1]-1, b = order[k]-1; if (delay[a] == delay[b] && seq[a] > seq[b] && delay[a] >= 2) inv++; }
		printf("same-delay inversions %d (scheduling takes time, so only meaningful near zero)\n", inv);
	}
	/* a round stops after 50 ms of callbacks */
	n_order = 0;
	for (int i = 0; i < 10; i++) framebuffer_schedule(0, slow, (void *)(intptr_t)i);
	usleep(1000);
	{ int t = schedule_run(); CHECK(t == 0 && n_order == 3, "round bound: returned %d after %d", t, n_order); }
	drain();
	CHECK(n_order == 10, "all ran %d", n_order);
	CHECK(schedule_run() == -1, "empty");
	printf("%s\n", fails ? "FAILED" : "all passed");
	return fails != 0;
}
