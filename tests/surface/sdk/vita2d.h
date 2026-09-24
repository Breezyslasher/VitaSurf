#ifndef G__vita2d_h
#define G__vita2d_h
#include <psp2/gxm.h>
#include <psp2/kernel/sysmem.h>
typedef struct vita2d_texture vita2d_texture;
int vita2d_init(void); int vita2d_fini(void);
void vita2d_set_clear_color(unsigned int color);
void vita2d_start_drawing(void); void vita2d_end_drawing(void);
void vita2d_swap_buffers(void); void vita2d_wait_rendering_done(void);
int vita2d_common_dialog_update(void);
void vita2d_texture_set_alloc_memblock_type(SceKernelMemBlockType type);
vita2d_texture *vita2d_create_empty_texture_format(unsigned int w, unsigned int h, SceGxmTextureFormat format);
void vita2d_free_texture(vita2d_texture *texture);
void *vita2d_texture_get_datap(const vita2d_texture *texture);
unsigned int vita2d_texture_get_stride(const vita2d_texture *texture);
void vita2d_texture_set_filters(vita2d_texture *texture, SceGxmTextureFilter min_filter, SceGxmTextureFilter mag_filter);
void vita2d_draw_texture(const vita2d_texture *texture, float x, float y);
void vita2d_draw_texture_part(const vita2d_texture *texture, float x, float y, float tex_x, float tex_y, float tex_w, float tex_h);
void vita2d_draw_rectangle(float x, float y, float w, float h, unsigned int color);
void vita2d_draw_fill_circle(float x, float y, float radius, unsigned int color);
#endif
