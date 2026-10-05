/* Native simulation of the Vita surface's ring texture scrolling. */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <psp2/ctrl.h>
#include <psp2/touch.h>
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/threadmgr.h>
#include <vita2d.h>
#include <stdint.h>

struct vita2d_texture { int w, h, stride; uint32_t *data; SceGxmTextureFilter f; };
static uint32_t fake_screen[544][960];
static int parts_drawn, frames;
static unsigned long long fake_time;

/* ---- SDK stubs ---- */
int sceCtrlPeekBufferPositive(int p, SceCtrlData *d, int c) { (void)p;(void)c; memset(d,0,sizeof(*d)); d->lx=d->ly=d->rx=d->ry=128; return 1; }
int sceCtrlSetSamplingMode(int m) { (void)m; return 0; }
int sceTouchPeek(SceUInt32 p, SceTouchData *d, SceUInt32 n) { (void)p;(void)n; memset(d,0,sizeof(*d)); return 1; }
int sceTouchSetSamplingState(SceUInt32 p, int s) { (void)p;(void)s; return 0; }
SceUInt64 sceKernelGetProcessTimeWide(void) { return fake_time += 1000; }
int sceKernelPowerTick(int t) { (void)t; return 0; }
SceUID sceKernelAllocMemBlock(const char *n, SceKernelMemBlockType t, SceSize s, void *o) { (void)n;(void)t;(void)s;(void)o; return -1; }
int sceKernelFreeMemBlock(SceUID u) { (void)u; return 0; }
int sceKernelGetMemBlockBase(SceUID u, void **b) { (void)u; *b = NULL; return -1; }
SceUID sceKernelCreateMutex(const char *n, SceUInt a, int i, void *o) { (void)n;(void)a;(void)i;(void)o; return 1; }
int sceKernelDeleteMutex(SceUID id) { (void)id; return 0; }
int sceKernelLockMutex(SceUID id, int c, unsigned int *t) { (void)id;(void)c;(void)t; return 0; }
int sceKernelTryLockMutex(SceUID id, int c) { (void)id;(void)c; return 0; }
int sceKernelUnlockMutex(SceUID id, int c) { (void)id;(void)c; return 0; }
SceUID sceKernelCreateThread(const char *n, SceKernelThreadEntry e, int p, SceSize s, SceUInt a, int m, const void *o) { (void)n;(void)e;(void)p;(void)s;(void)a;(void)m;(void)o; return -1; }
int sceKernelStartThread(SceUID t, SceSize l, void *a) { (void)t;(void)l;(void)a; return -1; }
int sceKernelDeleteThread(SceUID t) { (void)t; return 0; }
int sceKernelExitDeleteThread(int s) { (void)s; return 0; }
int sceKernelWaitThreadEnd(SceUID t, int *s, SceUInt *to) { (void)t;(void)s;(void)to; return 0; }
int sceKernelDelayThread(SceUInt d) { (void)d; return 0; }

int vita2d_init(void) { return 0; }
int vita2d_fini(void) { return 0; }
void vita2d_set_clear_color(unsigned int c) { (void)c; }
void vita2d_start_drawing(void) { memset(fake_screen, 0x11, sizeof(fake_screen)); }
void vita2d_end_drawing(void) { frames++; }
void vita2d_swap_buffers(void) {}
void vita2d_wait_rendering_done(void) {}
int vita2d_common_dialog_update(void) { return 0; }
void vita2d_texture_set_alloc_memblock_type(SceKernelMemBlockType t) { (void)t; }
vita2d_texture *vita2d_create_empty_texture_format(unsigned int w, unsigned int h, SceGxmTextureFormat f)
{ vita2d_texture *t = calloc(1, sizeof(*t)); (void)f; t->w = (int)w; t->h = (int)h; t->stride = (int)((w + 7) & ~7u) + 8; t->data = calloc((size_t)t->stride * h, 4); t->f = SCE_GXM_TEXTURE_FILTER_LINEAR; return t; }
void vita2d_free_texture(vita2d_texture *t) { free(t->data); free(t); }
void *vita2d_texture_get_datap(const vita2d_texture *t) { return t->data; }
unsigned int vita2d_texture_get_stride(const vita2d_texture *t) { return (unsigned)t->stride * 4; }
void vita2d_texture_set_filters(vita2d_texture *t, SceGxmTextureFilter a, SceGxmTextureFilter b) { (void)b; t->f = a; }
void vita2d_draw_texture_part(const vita2d_texture *t, float x, float y, float tx, float ty, float tw, float th)
{
	int X = (int)x, Y = (int)y, TX = (int)tx, TY = (int)ty, W = (int)tw, H = (int)th, i, j;
	if ((float)X != x || (float)TX != tx || W <= 0 || H <= 0 || TX < 0 || TY < 0 || TX + W > t->w || TY + H > t->h) {
		printf("BAD PART %g,%g from %g,%g %gx%g\n", x, y, tx, ty, tw, th); exit(1);
	}
	parts_drawn++;
	for (j = 0; j < H; j++) for (i = 0; i < W; i++)
		if (Y + j >= 0 && Y + j < 544 && X + i >= 0 && X + i < 960)
			fake_screen[Y + j][X + i] = t->data[(TY + j) * t->stride + TX + i];
}
void vita2d_draw_texture(const vita2d_texture *t, float x, float y) { vita2d_draw_texture_part(t, x, y, 0, 0, (float)t->w, (float)t->h); }
void vita2d_draw_rectangle(float x, float y, float w, float h, unsigned int c)
{ int i, j; for (j = (int)y; j < (int)(y + h); j++) for (i = (int)x; i < (int)(x + w); i++) if (j >= 0 && j < 544 && i >= 0 && i < 960) fake_screen[j][i] = c; }
void vita2d_draw_fill_circle(float x, float y, float r, unsigned int c) { (void)x;(void)y;(void)r;(void)c; }

/* ---- platform stubs ---- */
void vita_log(const char *fmt, ...) { va_list ap; va_start(ap, fmt); vprintf(fmt, ap); va_end(ap); putchar('\n'); }
int vita_verbose_requested(void) { return 0; }

#include "../../vita/surface/vita.c"

/* ---- the simulation ---- */
static uint32_t page(int px, int py) { return ((uint32_t)(px * 2654435761u) ^ (uint32_t)(py * 40503u) ^ (uint32_t)(px * py)) & 0x00FFFFFFu; }
static uint32_t toolbar_gen = 1;
static uint32_t toolbar(int x, int y) { return ((uint32_t)(x * 7 + y * 13) * toolbar_gen) & 0x00FFFFFFu; }
static nsfb_t *fbp;
#define fb (*fbp)
static uint32_t cur_px[12 * 12];
static nsfb_bbox_t view;
static int sx, sy; /* page point at view origin */

static void paint(const nsfb_bbox_t *b) /* draw expected content into the shadow and update it */
{
	int x, y;
	nsfb_bbox_t c = *b;
	vita_claim(&fb, &c);
	for (y = b->y0; y < b->y1; y++) for (x = b->x0; x < b->x1; x++) {
		uint32_t v;
		if (x >= view.x0 && x < view.x1 && y >= view.y0 && y < view.y1)
			v = page(sx + x - view.x0, sy + y - view.y0);
		else
			v = toolbar(x, y);
		((uint32_t *)(void *)fb.ptr)[y * 960 + x] = v;
	}
	vita_update(&fb, &c);
}

static int over_copied;
static void pan_copy(nsfb_bbox_t *src, nsfb_bbox_t *dst) /* libnsfb's copy(), via the surface */
{
	struct vita_surface *vs = fb.surface_priv;
	unsigned long long px0 = vs->blit_px;
	int w = dst->x1 - dst->x0, h = dst->y1 - dst->y0, j;
	bool gpu = vita_surface_scroll(&view, dst->x0 - src->x0, dst->y0 - src->y0);
	nsfb_bbox_t all; nsfb_plot_add_rect(src, dst, &all);
	vita_claim(&fb, &all);
	if (dst->y0 > src->y0) for (j = h - 1; j >= 0; j--) memmove(fb.ptr + (dst->y0 + j) * fb.linelen + dst->x0 * 4, fb.ptr + (src->y0 + j) * fb.linelen + src->x0 * 4, (size_t)w * 4);
	else for (j = 0; j < h; j++) memmove(fb.ptr + (dst->y0 + j) * fb.linelen + dst->x0 * 4, fb.ptr + (src->y0 + j) * fb.linelen + src->x0 * 4, (size_t)w * 4);
	vita_update(&fb, dst);
	if (gpu) vita_surface_scroll_done();
	/* only the pointer's two boxes may be copied; a screen reorder is the exception */
	{ unsigned long long d = vs->blit_px - px0; if (d >= 960u * 544u) d -= 960u * 544u; if (gpu && d > 2u * 12u * 12u) { over_copied++; printf("copied %u px\n", (unsigned)(vs->blit_px - px0)); } }
}

/* fb_pan, as gui.c does it */
static void pan(int panx, int pany)
{
	int x = view.x0, y = view.y0, width = view.x1 - view.x0, height = view.y1 - view.y0;
	nsfb_bbox_t s, d, strip;
	if (pany < 0) {
		s.x0 = x; s.y0 = y; s.x1 = x + width; s.y1 = y + height + pany;
		d.x0 = x; d.y0 = y - pany; d.x1 = x + width; d.y1 = d.y0 + height + pany;
		pan_copy(&s, &d); sy += pany;
		strip.x0 = x; strip.y0 = y; strip.x1 = x + width; strip.y1 = y - pany; paint(&strip);
	} else if (pany > 0) {
		s.x0 = x; s.y0 = y + pany; s.x1 = x + width; s.y1 = s.y0 + height - pany;
		d.x0 = x; d.y0 = y; d.x1 = x + width; d.y1 = y + height - pany;
		pan_copy(&s, &d); sy += pany;
		strip.x0 = x; strip.y0 = y + height - pany; strip.x1 = x + width; strip.y1 = y + height; paint(&strip);
	}
	if (panx < 0) {
		s.x0 = x; s.y0 = y; s.x1 = x + width + panx; s.y1 = y + height;
		d.x0 = x - panx; d.y0 = y; d.x1 = d.x0 + width + panx; d.y1 = y + height;
		pan_copy(&s, &d); sx += panx;
		strip.x0 = x; strip.y0 = y; strip.x1 = x - panx; strip.y1 = y + height; paint(&strip);
	} else if (panx > 0) {
		s.x0 = x + panx; s.y0 = y; s.x1 = s.x0 + width - panx; s.y1 = y + height;
		d.x0 = x; d.y0 = y; d.x1 = x + width - panx; d.y1 = y + height;
		pan_copy(&s, &d); sx += panx;
		strip.x0 = x + width - panx; strip.y0 = y; strip.x1 = x + width; strip.y1 = y + height; paint(&strip);
	}
}

static int check(const char *what, int step)
{
	struct vita_surface *vs = fb.surface_priv;
	int x, y, bad = 0;
	vs->dirty = true;
	present(vs);
	for (y = 0; y < 544; y++) for (x = 0; x < 960; x++) {
		uint32_t want;
		if (vs->focus_valid && x >= vs->focus.x0 && x < vs->focus.x1 && y >= vs->focus.y0 && y < vs->focus.y1 &&
		    (x < vs->focus.x0 + 3 || x >= vs->focus.x1 - 3 || y < vs->focus.y0 + 3 || y >= vs->focus.y1 - 3))
			want = FOCUS_COLOUR;
		else if (x >= view.x0 && x < view.x1 && y >= view.y0 && y < view.y1)
			want = page(sx + x - view.x0, sy + y - view.y0) | 0xFF000000u;
		else
			want = toolbar(x, y) | 0xFF000000u;
		{
			struct nsfb_cursor_s *c = fb.cursor;
			bool in_focus = vs->focus_valid && x >= vs->focus.x0 && x < vs->focus.x1 && y >= vs->focus.y0 && y < vs->focus.y1;
			uint32_t sh = ((uint32_t *)(void *)fb.ptr)[y * 960 + x] | 0xFF000000u;
			if (!in_focus && fake_screen[y][x] != sh) {
				if (bad < 3) printf("%s step %d: screen %d,%d is %08x, shadow %08x\n", what, step, x, y, fake_screen[y][x], sh);
				bad++;
			}
			if (c != NULL && c->plotted && x >= c->loc.x0 - c->hotspot_x && x < c->loc.x1 - c->hotspot_x &&
			    y >= c->loc.y0 - c->hotspot_y && y < c->loc.y1 - c->hotspot_y)
				continue;
		}
		if (fake_screen[y][x] != want) {
			if (bad < 3) printf("%s step %d: screen %d,%d is %08x, want %08x (ring %d,%d)\n", what, step, x, y, fake_screen[y][x], want, vs->ring_ox, vs->ring_oy);
			bad++;
		}
	}
	return bad;
}

int main(void)
{
	nsfb_bbox_t all = { 0, 0, 960, 544 };
	int step, fails = 0;
	unsigned int m, k, r;
	fbp = nsfb_new(NSFB_SURFACE_VITA);
	if (fbp == NULL || nsfb_set_geometry(fbp, 960, 544, NSFB_FMT_XBGR8888) != 0 || nsfb_init(fbp) != 0) { puts("init failed"); return 1; }
	for (step = 0; step < 144; step++) cur_px[step] = (step % 5) ? 0xFF0000FFu : 0x00000000u;
	nsfb_cursor_init(fbp);
	nsfb_cursor_set(fbp, cur_px, 12, 12, 12, 3, 2);
	if (((struct vita_surface *)fb.surface_priv)->tex->f != SCE_GXM_TEXTURE_FILTER_POINT) { puts("filter not point"); fails++; }
	srand(7);
	view.x0 = 0; view.y0 = 40; view.x1 = 944; view.y1 = 530;
	sx = 100; sy = 1000;
	paint(&all);
	fails += check("first", 0) != 0;
	for (step = 1; step <= 600; step++) {
		int r = rand() % 100;
		if (r < 55) pan(0, rand() % 401 - 200);
		else if (r < 70) pan(rand() % 301 - 150, rand() % 61 - 30);
		else if (r < 80) { /* a redraw somewhere */
			nsfb_bbox_t b; b.x0 = rand() % 900; b.y0 = rand() % 500; b.x1 = b.x0 + 1 + rand() % 60; b.y1 = b.y0 + 1 + rand() % 44;
			if (r < 75) toolbar_gen++; /* toolbar changed: repaint it all */
			if (r < 75) { nsfb_bbox_t t = { 0, 0, 960, 40 }; paint(&t); t.y0 = 530; t.y1 = 544; paint(&t); t.x0 = 944; t.y0 = 40; t.y1 = 530; paint(&t); }
			paint(&b);
		} else if (r < 85) { /* focus moves */
			nsfb_bbox_t f; f.x0 = rand() % 900; f.y0 = rand() % 500; f.x1 = f.x0 + 2 + rand() % 60; f.y1 = f.y0 + 2 + rand() % 40;
			vita_surface_set_focus_rect(rand() % 4 ? &f : NULL);
		} else if (r < 88) { /* the view changes shape: the frontend redraws everything */
			view.y0 = view.y0 == 40 ? 0 : 40; view.x1 = view.x1 == 944 ? 960 : 944;
			paint(&all);
		} else if (r < 90) pan(0, rand() % 2 ? 490 : -490); /* a whole view: gui.c redraws, no move */
		else if (r < 95) { nsfb_bbox_t l; l.x0 = rand() % 970 - 5; l.y0 = rand() % 554 - 5; l.x1 = l.x0 + 1; l.y1 = l.y0 + 1; nsfb_cursor_loc_set(fbp, &l); }
		else pan(0, rand() % 21 - 10);
		if (check("run", step) != 0 || over_copied) { fails++; printf("over copied %d\n", over_copied); break; }
	}
	vita_surface_take_moves(&m, &k, &r);
	printf("%d frames, %d parts, %u GPU moves, %u kpx not copied, %u resets; %s\n", frames, parts_drawn, m, k, r, fails ? "FAIL" : "PASS");
	nsfb_free(fbp);
	return fails != 0;
}
