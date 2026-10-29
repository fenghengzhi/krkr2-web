/* Hosted-only reference for TVPLoadPNG's normal branch and metadata callbacks.
 * Call order is from krkrz/krkr2 dec49af97e174d31059c3ccd7efc700ba3c6b788,
 * GraphicsLoaderIntf.cpp:1028-1358. This executes pinned upstream libpng1.0.6;
 * it is not a claim about the identity of the original deelibpng.lib binary.
 * png.h must precede headers that could include setjmp.h (old pngconf rule). */
#include "png.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <limits.h>
#include <zlib.h>

_Static_assert(sizeof(png_uint_32) == 4, "Use the original 32-bit png long ABI");
_Static_assert(sizeof(png_int_32) == 4, "Use the original 32-bit png signed ABI");
_Static_assert(sizeof(int32_t) == 4 && INT_MAX == 2147483647, "tjs_int32 required");

typedef struct { const char *phase, *kind; char detail[256]; } Event;
typedef struct { const char *phase, *key; char value[64]; unsigned sequence; } Meta;
typedef struct { void *pointer; uintptr_t address; size_t bytes; int live; } Allocation;
typedef struct {
    jmp_buf jump;
    png_structp png;
    png_infop info, end;
    unsigned char *input, *pixels;
    png_bytep *rows;
    size_t input_size, offset;
    unsigned width, height, rowbytes, rows_complete, read_calls;
    int depth, color, interlace, channels, output_depth, keyidx;
    int original_trns, info_trans_before, decoder_trans_before;
    int info_trans_after, decoder_trans_after;
    int size_called, decoded, failed, unsafe_pixels, unsafe_frees, warnings;
    const char *phase, *error_phase, *error_kind;
    char error[256];
    Event events[512]; unsigned event_count, dropped_events;
    Meta metadata[128]; unsigned meta_count;
    Allocation allocations[4096]; unsigned allocation_count;
} Context;
static Context *active;

static void event(Context *c, const char *kind, const char *format, ...) {
    va_list args;
    if (c->event_count == 512) { c->dropped_events++; return; }
    Event *e = &c->events[c->event_count++];
    e->phase = c->phase; e->kind = kind;
    va_start(args, format); vsnprintf(e->detail, sizeof(e->detail), format, args); va_end(args);
}
static void fail(Context *c, const char *kind, const char *message) {
    c->failed = 1; c->error_kind = kind; c->error_phase = c->phase;
    snprintf(c->error, sizeof(c->error), "%s", message);
    event(c, "error", "%s: %s", kind, message);
    longjmp(c->jump, 1);
}
static png_voidp allocate(png_structp png, png_size_t size) {
    void *p; (void)png;
    if (active->allocation_count == 4096) return NULL;
    p = malloc(size);
    if (p) {
        Allocation *a = &active->allocations[active->allocation_count++];
        a->pointer = p; a->address = (uintptr_t)p; a->bytes = size; a->live = 1;
    }
    return p;
}
static void release(png_structp png, png_voidp pointer) {
    unsigned i; (void)png;
    if (!pointer) return;
    /* Keep unsafe frees observable instead of passing a stack/stale pointer
     * to libc. Such a case is explicitly unsafe-cleanup, never a native pass. */
    for (i = active->allocation_count; i > 0; --i) {
        Allocation *a = &active->allocations[i - 1];
        if (a->address == (uintptr_t)pointer && a->live) {
            a->live = 0; a->pointer = NULL; free(pointer); return;
        }
    }
    active->unsafe_frees++;
    event(active, "unsafe-free-refused", "%p", pointer);
}
static void error_callback(png_structp png, png_const_charp message) {
    fail((Context *)png_get_error_ptr(png), "libpng", message);
}
static void warning_callback(png_structp png, png_const_charp message) {
    Context *c = (Context *)png_get_error_ptr(png);
    /* The fixed loader ignores warnings. Record without changing that flow. */
    c->warnings++; event(c, "warning", "%s", message);
}
static void read_callback(png_structp png, png_bytep bytes, png_size_t count) {
    Context *c = (Context *)png_get_io_ptr(png);
    c->read_calls++;
    if (count > c->input_size - c->offset)
        fail(c, "stream-short-read", "ReadBuffer cannot satisfy requested bytes");
    memcpy(bytes, c->input + c->offset, count); c->offset += count;
}
static void row_callback(png_structp png, png_uint_32 row, int pass) {
    Context *c = (Context *)png_get_io_ptr(png);
    event(c, "libpng-row-status", "row=%lu pass=%d", (unsigned long)row, pass);
}
static void meta(Context *c, const char *key, const char *value) {
    Meta *m;
    if (c->meta_count == 128) fail(c, "probe-budget", "Too many metadata callbacks");
    event(c, "metadata", "%s=%s", key, value);
    m = &c->metadata[c->meta_count++]; m->key = key; m->phase = c->phase;
    m->sequence = c->event_count;
    snprintf(m->value, sizeof(m->value), "%s", value);
}
static void meta_int(Context *c, const char *key, uint32_t value) {
    char text[32]; snprintf(text, sizeof(text), "%ld", (long)(int32_t)value); meta(c, key, text);
}
static uint32_t be32(const unsigned char *p) {
    return ((uint32_t)p[0] << 24) + ((uint32_t)p[1] << 16) + ((uint32_t)p[2] << 8) + p[3];
}
static const char *offset_unit(unsigned unit) {
    return unit == PNG_OFFSET_PIXEL ? "pixel" : unit == PNG_OFFSET_MICROMETER ? "micrometer" : "unknown";
}
static int unknown_callback(png_structp png, png_unknown_chunkp chunk) {
    Context *c = (Context *)png_get_user_chunk_ptr(png);
    event(c, "unknown-chunk", "%.4s size=%lu", chunk->name, (unsigned long)chunk->size);
    /* Direct port of PNG_read_chunk_callback, including all case combinations,
     * minimum length rather than exact length, and tjs_int signed casts. */
    if ((chunk->name[0] == 'v' || chunk->name[0] == 'V') &&
        (chunk->name[1] == 'p' || chunk->name[1] == 'P') &&
        (chunk->name[2] == 'a' || chunk->name[2] == 'A') &&
        (chunk->name[3] == 'g' || chunk->name[3] == 'G') && chunk->size >= 9) {
        meta_int(c, "vpag_w", be32(chunk->data));
        meta_int(c, "vpag_h", be32(chunk->data + 4));
        meta(c, "vpag_unit", offset_unit(chunk->data[8]));
        return 1;
    }
    return 0;
}
static void header_metadata(Context *c) {
    png_int_32 x, y; png_uint_32 rx, ry; int unit;
    if (png_get_oFFs(c->png, c->info, &x, &y, &unit)) {
        meta_int(c, "offs_x", (uint32_t)x); meta_int(c, "offs_y", (uint32_t)y);
        meta(c, "offs_unit", offset_unit((unsigned)unit));
    }
    if (png_get_pHYs(c->png, c->info, &rx, &ry, &unit)) {
        meta_int(c, "reso_x", (uint32_t)rx); meta_int(c, "reso_y", (uint32_t)ry);
        meta(c, "reso_unit", unit == PNG_RESOLUTION_METER ? "meter" : "unknown");
    }
}
static void decode(Context *c) {
    png_uint_32 width, height; int depth, color, interlace, compression, filter;
    unsigned y;
    c->phase = "create";
    c->png = png_create_read_struct_2(PNG_LIBPNG_VER_STRING, c, error_callback,
        warning_callback, c, allocate, release);
    if (!c->png) fail(c, "allocation", "png_create_read_struct_2 failed");
    png_set_read_user_chunk_fn(c->png, c, unknown_callback);
    png_set_keep_unknown_chunks(c->png, 2, NULL, 0);
    c->info = png_create_info_struct(c->png);
    c->end = png_create_info_struct(c->png);
    if (!c->info || !c->end) fail(c, "allocation", "png_create_info_struct failed");
    png_set_read_fn(c->png, c, read_callback);
    png_set_read_status_fn(c->png, row_callback);
    c->phase = "read_info"; event(c, "call", "png_read_info");
    png_read_info(c->png, c->info);
    png_get_IHDR(c->png, c->info, &width, &height, &depth, &color, &interlace, &compression, &filter);
    c->width = width; c->height = height; c->depth = depth; c->color = color; c->interlace = interlace;
    c->original_trns = !!png_get_valid(c->png, c->info, PNG_INFO_tRNS);
    c->info_trans_before = c->info->num_trans; c->decoder_trans_before = c->png->num_trans;
    if (depth == 16) png_set_strip_16(c->png);
    c->phase = "header_metadata"; header_metadata(c);
    c->phase = "normal_transforms";
    /* These are the original normal-mode calls, not a reconstructed decoder. */
    if (color == PNG_COLOR_TYPE_PALETTE) {
        if (c->keyidx == -1) {
            if (png_get_valid(c->png, c->info, PNG_INFO_tRNS)) {
                png_set_palette_to_rgb(c->png); png_set_tRNS_to_alpha(c->png);
                color = PNG_COLOR_TYPE_RGB_ALPHA;
            } else { png_set_palette_to_rgb(c->png); color = PNG_COLOR_TYPE_RGB; }
        } else {
            png_byte trans = (png_byte)c->keyidx;
            png_set_tRNS(c->png, c->info, &trans, 1, 0);
            png_set_palette_to_rgb(c->png); png_set_tRNS_to_alpha(c->png);
            color = PNG_COLOR_TYPE_RGB_ALPHA;
        }
    }
    c->info_trans_after = c->info->num_trans; c->decoder_trans_after = c->png->num_trans;
    switch (color) {
        case PNG_COLOR_TYPE_GRAY_ALPHA:
            png_set_gray_to_rgb(c->png); color = PNG_COLOR_TYPE_RGB_ALPHA;
            png_set_filler(c->png, 0xff, PNG_FILLER_AFTER); break;
        case PNG_COLOR_TYPE_GRAY:
            png_set_expand(c->png); png_set_gray_to_rgb(c->png); color = PNG_COLOR_TYPE_RGB;
            png_set_filler(c->png, 0xff, PNG_FILLER_AFTER); break;
        case PNG_COLOR_TYPE_RGB_ALPHA: png_set_bgr(c->png); break;
        case PNG_COLOR_TYPE_RGB:
            png_set_bgr(c->png); png_set_filler(c->png, 0xff, PNG_FILLER_AFTER); break;
        default: fail(c, "loader", "Unsupported color type");
    }
    if (width >= 65536 || height >= 65536) fail(c, "loader", "Too large image");
    if (!width || !height || width > 32 || height > 32) fail(c, "probe-budget", "Fixture exceeds 32x32");
    c->phase = "read_update_info"; event(c, "call", "png_read_update_info");
    png_read_update_info(c->png, c->info);
    c->rowbytes = png_get_rowbytes(c->png, c->info);
    c->channels = png_get_channels(c->png, c->info); c->output_depth = png_get_bit_depth(c->png, c->info);
    c->unsafe_pixels = (c->color == PNG_COLOR_TYPE_PALETTE && !c->original_trns && c->keyidx != -1) || c->rowbytes != width * 4;
    c->phase = "size_callback"; c->size_called = 1; event(c, "size", "%ux%u rowbytes=%u", c->width, c->height, c->rowbytes);
    if (c->rowbytes > 4096) fail(c, "probe-budget", "Row exceeds probe budget");
    c->pixels = (unsigned char *)malloc((size_t)c->rowbytes * height);
    if (!c->pixels) fail(c, "allocation", "Row allocation failed");
    if (interlace == PNG_INTERLACE_NONE) {
        for (y = 0; y < height; y++) {
            c->phase = "read_row"; event(c, "scanline-acquire", "%u", y);
            png_read_row(c->png, c->pixels + (size_t)y * c->rowbytes, NULL);
            c->rows_complete++; event(c, "scanline-commit", "%u", y);
        }
        c->phase = "read_end"; event(c, "call", "png_read_end(info_ptr)");
        png_read_end(c->png, c->info);
    } else {
        c->rows = (png_bytep *)malloc(sizeof(png_bytep) * height);
        if (!c->rows) fail(c, "allocation", "Row pointer allocation failed");
        for (y = 0; y < height; y++) c->rows[y] = c->pixels + (size_t)y * c->rowbytes;
        c->phase = "read_image"; event(c, "call", "png_read_image");
        png_read_image(c->png, c->rows);
        c->phase = "read_end"; event(c, "call", "png_read_end(info_ptr)");
        png_read_end(c->png, c->info);
        c->phase = "interlace_publish";
        for (y = 0; y < height; y++) { c->rows_complete++; event(c, "scanline-commit", "%u", y); }
    }
    c->decoded = 1; c->phase = "decoded"; event(c, "complete", "decode returned");
}
static void json_string(const char *s) {
    const unsigned char *p = (const unsigned char *)(s ? s : ""); putchar('"');
    for (; *p; p++) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
static void output(Context *c) {
    unsigned i; size_t live = 0, live_bytes = 0;
    for (i = 0; i < c->allocation_count; i++) if (c->allocations[i].live) { live++; live_bytes += c->allocations[i].bytes; }
    printf("{\"schema\":1,\"status\":");
    json_string(c->failed ? "error" : c->unsafe_frees ? "unsafe-cleanup" : c->decoded ? "complete" : "incomplete");
    printf(",\"libpng\":"); json_string(PNG_LIBPNG_VER_STRING);
    printf(",\"zlibCompile\":"); json_string(ZLIB_VERSION); printf(",\"zlibRuntime\":"); json_string(zlibVersion());
    printf(",\"pngLongBytes\":%u,\"pointerBytes\":%u,\"keyidx\":%d,\"width\":%u,\"height\":%u,\"bitDepth\":%d,\"colorType\":%d,\"interlace\":%d,\"rowbytes\":%u,\"channels\":%d,\"outputDepth\":%d,\"rowsComplete\":%u,\"sizeCallback\":%s,\"decodeComplete\":%s",
        (unsigned)sizeof(png_uint_32), (unsigned)sizeof(void *), c->keyidx, c->width, c->height, c->depth, c->color, c->interlace, c->rowbytes, c->channels, c->output_depth, c->rows_complete, c->size_called ? "true" : "false", c->decoded ? "true" : "false");
    printf(",\"transparencyState\":{\"originalInfoValid\":%s,\"infoBefore\":%d,\"decoderBefore\":%d,\"infoAfterSetter\":%d,\"decoderAfterSetter\":%d}", c->original_trns ? "true" : "false", c->info_trans_before, c->decoder_trans_before, c->info_trans_after, c->decoder_trans_after);
    printf(",\"pixelObservation\":"); json_string(c->unsafe_pixels ? "unsafe-native-destination-layout; rowbytes only; pixel bytes not inspected" : "complete rows only");
    printf(",\"bgra\":");
    if (c->unsafe_pixels) printf("null");
    else { putchar('['); for (i = 0; i < c->rows_complete * c->rowbytes; i++) printf("%s%u", i ? "," : "", c->pixels[i]); putchar(']'); }
    printf(",\"rgba\":");
    if (c->unsafe_pixels) printf("null");
    else { putchar('['); for (i = 0; i < c->rows_complete * c->width; i++) { const unsigned char *p = c->pixels + i * 4; printf("%s%u,%u,%u,%u", i ? "," : "", p[2], p[1], p[0], p[3]); } putchar(']'); }
    printf(",\"metadata\":[");
    for (i = 0; i < c->meta_count; i++) { Meta *m = &c->metadata[i]; printf("%s{\"sequence\":%u,\"phase\":", i ? "," : "", m->sequence); json_string(m->phase); printf(",\"key\":"); json_string(m->key); printf(",\"value\":"); json_string(m->value); putchar('}'); }
    printf("],\"events\":[");
    for (i = 0; i < c->event_count; i++) { Event *e = &c->events[i]; printf("%s{\"sequence\":%u,\"phase\":", i ? "," : "", i + 1); json_string(e->phase); printf(",\"kind\":"); json_string(e->kind); printf(",\"detail\":"); json_string(e->detail); putchar('}'); }
    printf("],\"droppedEvents\":%u,\"warnings\":%d,\"inputBytes\":%lu,\"bytesRead\":%lu,\"readCalls\":%u,\"cleanup\":{\"unsafeFrees\":%d,\"liveAllocations\":%lu,\"liveBytes\":%lu},\"error\":", c->dropped_events, c->warnings, (unsigned long)c->input_size, (unsigned long)c->offset, c->read_calls, c->unsafe_frees, (unsigned long)live, (unsigned long)live_bytes);
    if (!c->failed) printf("null"); else { printf("{\"phase\":"); json_string(c->error_phase); printf(",\"kind\":"); json_string(c->error_kind); printf(",\"message\":"); json_string(c->error); putchar('}'); }
    printf("}\n");
}
int main(int argc, char **argv) {
    Context *c; FILE *file; long length; unsigned i;
    const char *actions = getenv("GITHUB_ACTIONS"), *hosted = getenv("RUNNER_ENVIRONMENT");
    if (!actions || strcmp(actions, "true") || !hosted || strcmp(hosted, "github-hosted")) {
        fprintf(stderr, "Native PNG reference runs only on GitHub-hosted Actions.\n"); return 2;
    }
    if (argc != 3) { fprintf(stderr, "usage: png-reference input.png keyidx\n"); return 2; }
    c = (Context *)calloc(1, sizeof(Context)); if (!c) return 2; active = c;
    c->phase = "input"; c->keyidx = atoi(argv[2]);
    file = fopen(argv[1], "rb"); if (!file) { perror("input"); free(c); return 2; }
    if (fseek(file, 0, SEEK_END) || (length = ftell(file)) < 0 || length > 65536 || fseek(file, 0, SEEK_SET)) { fclose(file); free(c); return 2; }
    c->input_size = (size_t)length; c->input = (unsigned char *)malloc(c->input_size ? c->input_size : 1);
    if (!c->input || fread(c->input, 1, c->input_size, file) != c->input_size) { fclose(file); free(c->input); free(c); return 2; }
    fclose(file);
    if (!setjmp(c->jump)) decode(c);
    c->phase = "destroy";
    if (c->png) { event(c, "call", "png_destroy_read_struct(info,end_info)"); png_destroy_read_struct(&c->png, &c->info, &c->end); }
    output(c);
    /* Record library cleanup first; reclaim any error-path residual blocks only
     * after the report. This is harness cleanup, not a native success claim. */
    for (i = 0; i < c->allocation_count; i++) if (c->allocations[i].live) free(c->allocations[i].pointer);
    free(c->rows); free(c->pixels); free(c->input); free(c);
    return 0;
}
