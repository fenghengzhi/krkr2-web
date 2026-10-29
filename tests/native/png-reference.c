/* Hosted-only reference for TVPLoadPNG's normal/palette-gray branches and metadata callbacks.
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
#include "palette-converter.h"

_Static_assert(sizeof(png_uint_32) == 4, "Use the original 32-bit png long ABI");
_Static_assert(sizeof(png_int_32) == 4, "Use the original 32-bit png signed ABI");
_Static_assert(sizeof(int32_t) == 4 && INT_MAX == 2147483647, "tjs_int32 required");

typedef struct { const char *phase, *kind; char detail[256]; } Event;
typedef struct { const char *phase, *key; char value[64]; unsigned sequence; } Meta;
typedef struct { void *pointer; uintptr_t address; size_t bytes; int live; } Allocation;
enum { DESTINATION_SENTINEL = 0xa5, MAX_DESTINATION_BYTES = 4096, MAX_SNAPSHOTS = 256, MAX_READS = 512 };
typedef struct {
    const char *phase, *event;
    int row;
    unsigned rows_complete, event_sequence, trace_sequence;
    size_t input_offset, bytes;
    unsigned char data[];
} DestinationSnapshot;
typedef struct {
    const char *phase;
    size_t offset, requested, actual;
    unsigned before_snapshot, after_snapshot, trace_sequence;
} ReadObservation;
typedef struct {
    jmp_buf jump;
    png_structp png;
    png_infop info, end;
    unsigned char *input, *pixels, *destination;
    png_bytep *rows;
    size_t input_size, offset;
    unsigned width, height, rowbytes, rows_complete, read_calls;
    int depth, color, interlace, channels, output_depth, keyidx;
    int palette_reference, grayscale, manual_gray;
    unsigned destination_stride, comparison_prefix;
    int original_trns, info_trans_before, decoder_trans_before;
    int info_trans_after, decoder_trans_after;
    int size_called, decoded, failed, unsafe_pixels, unsafe_frees, warnings;
    const char *phase, *error_phase, *error_kind;
    char error[256];
    Event events[512]; unsigned event_count, dropped_events;
    Meta metadata[128]; unsigned meta_count;
    Allocation allocations[4096]; unsigned allocation_count;
    size_t destination_bytes;
    int current_row;
    DestinationSnapshot *snapshots[MAX_SNAPSHOTS];
    unsigned snapshot_count, dropped_snapshots, trace_sequence;
    ReadObservation reads[MAX_READS]; unsigned read_count, dropped_reads;
} Context;
static Context *active;

/* Only initialized, in-bounds destination bytes are inspected. This sentinel
 * is a probe observation aid, not a claim about native Recreate's initial data.
 * Adam7 decodes into a separate private buffer until read_end succeeds. */
static unsigned snapshot(Context *c, const char *name, int row) {
    DestinationSnapshot *s;
    if (!c->destination || (c->unsafe_pixels && !c->palette_reference)) return 0;
    if (c->snapshot_count == MAX_SNAPSHOTS) { c->dropped_snapshots++; return 0; }
    s = (DestinationSnapshot *)malloc(sizeof(*s) + c->destination_bytes);
    if (!s) { c->dropped_snapshots++; return 0; }
    s->phase = c->phase; s->event = name; s->row = row;
    s->rows_complete = c->rows_complete; s->event_sequence = c->event_count;
    s->trace_sequence = ++c->trace_sequence; s->input_offset = c->offset; s->bytes = c->destination_bytes;
    memcpy(s->data, c->destination, c->destination_bytes);
    c->snapshots[c->snapshot_count++] = s;
    return c->snapshot_count;
}

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
    snapshot(c, "error", c->current_row);
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
    size_t offset = c->offset, remaining = c->input_size - c->offset,
        actual = count < remaining ? count : remaining;
    ReadObservation *read = NULL;
    c->read_calls++;
    if (c->read_count < MAX_READS) {
        read = &c->reads[c->read_count++]; read->phase = c->phase;
        read->offset = offset; read->requested = count; read->actual = actual;
        read->trace_sequence = ++c->trace_sequence;
        read->before_snapshot = snapshot(c, "read-before", c->current_row);
    } else c->dropped_reads++;
    /* tTJSBinaryStream::ReadBuffer first calls Read, then throws on a short
     * return. Preserve the bytes actually read and the advanced stream cursor. */
    if (actual) memcpy(bytes, c->input + c->offset, actual);
    c->offset += actual;
    if (read) read->after_snapshot = snapshot(c, "read-after", c->current_row);
    if (actual != count)
        fail(c, "stream-short-read", "ReadBuffer cannot satisfy requested bytes");
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
/* Fixed tvpgl.c TVPBLConvert24BitTo8Bit_c: three-byte BGR stepping,
 * deliberately even when libpng expanded the palette into four-byte BGRA.
 * Only the first 3*width initialized source bytes are read. */
static void palette_gray(unsigned char *destination, const unsigned char *source, unsigned width) {
    TVPBLConvert24BitTo8Bit_c(destination, source, (int)width);
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
    /* These are the original mode-specific calls, not an intended key fix. */
    if (c->grayscale) {
        if (color != PNG_COLOR_TYPE_PALETTE) fail(c, "probe-scope", "Palette-gray reference requires a palette source");
        png_set_palette_to_rgb(c->png);
        png_set_bgr(c->png);
        if (depth < 8) png_set_packing(c->png);
        c->manual_gray = 1;
    } else {
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
    }
    c->info_trans_after = c->info->num_trans; c->decoder_trans_after = c->png->num_trans;
    if (width >= 65536 || height >= 65536) fail(c, "loader", "Too large image");
    if (!width || !height || width > 32 || height > 32) fail(c, "probe-budget", "Fixture exceeds 32x32");
    c->phase = "read_update_info"; event(c, "call", "png_read_update_info");
    png_read_update_info(c->png, c->info);
    c->rowbytes = png_get_rowbytes(c->png, c->info);
    c->channels = png_get_channels(c->png, c->info); c->output_depth = png_get_bit_depth(c->png, c->info);
    c->unsafe_pixels = !c->manual_gray &&
        ((c->color == PNG_COLOR_TYPE_PALETTE && !c->original_trns && c->keyidx != -1) || c->rowbytes != width * 4);
    c->phase = "size_callback"; c->size_called = 1; event(c, "size", "%ux%u rowbytes=%u", c->width, c->height, c->rowbytes);
    if (c->rowbytes > 4096) fail(c, "probe-budget", "Row exceeds probe budget");
    c->destination_stride = width * (c->grayscale ? 1 : 4);
    c->comparison_prefix = c->grayscale ? width : c->rowbytes;
    if (c->palette_reference && ((!c->grayscale && c->rowbytes != width * 3 && c->rowbytes != width * 4) ||
        (c->grayscale && c->rowbytes < width * 3))) fail(c, "probe-scope", "Unexpected palette source row layout");
    c->destination_bytes = (size_t)c->destination_stride * height;
    if (c->destination_bytes > MAX_DESTINATION_BYTES) fail(c, "probe-budget", "Destination exceeds probe budget");
    c->destination = (unsigned char *)malloc(c->destination_bytes);
    if (!c->destination) fail(c, "allocation", "Destination allocation failed");
    memset(c->destination, DESTINATION_SENTINEL, c->destination_bytes);
    if (interlace == PNG_INTERLACE_NONE && !c->manual_gray && (!c->unsafe_pixels || c->palette_reference)) c->pixels = c->destination;
    else {
        size_t temporary = (size_t)c->rowbytes * (c->manual_gray && interlace == PNG_INTERLACE_NONE ? 1 : height);
        c->pixels = (unsigned char *)malloc(temporary);
        if (!c->pixels) fail(c, "allocation", "Row allocation failed");
        memset(c->pixels, DESTINATION_SENTINEL, temporary);
    }
    snapshot(c, "destination-created", -1);
    if (interlace == PNG_INTERLACE_NONE) {
        for (y = 0; y < height; y++) {
            c->current_row = (int)y; c->phase = "read_row"; event(c, "scanline-acquire", "%u", y);
            snapshot(c, "row-call-before", (int)y);
            png_read_row(c->png, c->manual_gray ? c->pixels :
                c->pixels + (size_t)y * (c->pixels == c->destination ? c->destination_stride : c->rowbytes), NULL);
            /* png_combine_row can have written the destination before
             * png_read_finish_row raises a trailer/deflate error. Reaching
             * this point is separate evidence of a completed public row. */
            snapshot(c, "row-call-returned", (int)y);
            if (c->manual_gray) {
                palette_gray(c->destination + (size_t)y * c->destination_stride, c->pixels, width);
                snapshot(c, "manual-gray-converted", (int)y);
            }
            c->rows_complete++; event(c, "scanline-commit", "%u", y);
            snapshot(c, "row-complete", (int)y);
        }
        c->current_row = -1;
        c->phase = "read_end"; event(c, "call", "png_read_end(info_ptr)");
        snapshot(c, "read-end-before", -1);
        png_read_end(c->png, c->info);
        snapshot(c, "read-end-returned", -1);
    } else {
        c->rows = (png_bytep *)malloc(sizeof(png_bytep) * height);
        if (!c->rows) fail(c, "allocation", "Row pointer allocation failed");
        for (y = 0; y < height; y++) c->rows[y] = c->pixels + (size_t)y * c->rowbytes;
        c->phase = "read_image"; event(c, "call", "png_read_image");
        snapshot(c, "interlace-call-before", -1);
        png_read_image(c->png, c->rows);
        snapshot(c, "interlace-call-returned", -1);
        c->phase = "read_end"; event(c, "call", "png_read_end(info_ptr)");
        snapshot(c, "read-end-before", -1);
        png_read_end(c->png, c->info);
        snapshot(c, "read-end-returned", -1);
        c->phase = "interlace_publish";
        for (y = 0; y < height; y++) {
            if (c->manual_gray)
                palette_gray(c->destination + (size_t)y * c->destination_stride, c->pixels + (size_t)y * c->rowbytes, width);
            else if (!c->unsafe_pixels || c->palette_reference)
                memcpy(c->destination + (size_t)y * c->destination_stride, c->pixels + (size_t)y * c->rowbytes, c->rowbytes);
            c->rows_complete++; event(c, "scanline-commit", "%u", y);
            snapshot(c, "interlace-row-published", (int)y);
        }
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
static void json_bytes(const unsigned char *bytes, size_t count, int rgba) {
    size_t i;
    putchar('[');
    if (rgba) for (i = 0; i < count; i += 4)
        printf("%s%u,%u,%u,%u", i ? "," : "", bytes[i + 2], bytes[i + 1], bytes[i], bytes[i + 3]);
    else for (i = 0; i < count; i++) printf("%s%u", i ? "," : "", bytes[i]);
    putchar(']');
}
static void output(Context *c) {
    unsigned i; size_t live = 0, live_bytes = 0;
    for (i = 0; i < c->allocation_count; i++) if (c->allocations[i].live) { live++; live_bytes += c->allocations[i].bytes; }
    printf("{\"schema\":2,\"status\":");
    json_string(c->failed ? "error" : c->unsafe_frees ? "unsafe-cleanup" : c->decoded ? "complete" : "incomplete");
    printf(",\"libpng\":"); json_string(PNG_LIBPNG_VER_STRING);
    printf(",\"zlibCompile\":"); json_string(ZLIB_VERSION); printf(",\"zlibRuntime\":"); json_string(zlibVersion());
    printf(",\"pngLongBytes\":%u,\"pointerBytes\":%u,\"keyidx\":%d,\"width\":%u,\"height\":%u,\"bitDepth\":%d,\"colorType\":%d,\"interlace\":%d,\"rowbytes\":%u,\"channels\":%d,\"outputDepth\":%d,\"rowsComplete\":%u,\"sizeCallback\":%s,\"decodeComplete\":%s",
        (unsigned)sizeof(png_uint_32), (unsigned)sizeof(void *), c->keyidx, c->width, c->height, c->depth, c->color, c->interlace, c->rowbytes, c->channels, c->output_depth, c->rows_complete, c->size_called ? "true" : "false", c->decoded ? "true" : "false");
    printf(",\"transparencyState\":{\"originalInfoValid\":%s,\"infoBefore\":%d,\"decoderBefore\":%d,\"infoAfterSetter\":%d,\"decoderAfterSetter\":%d}", c->original_trns ? "true" : "false", c->info_trans_before, c->decoder_trans_before, c->info_trans_after, c->decoder_trans_after);
    printf(",\"paletteReference\":%s,\"mode\":", c->palette_reference ? "true" : "false"); json_string(c->grayscale ? "grayscale" : "normal");
    printf(",\"pixelObservation\":"); json_string(c->manual_gray ? "defined manual grayscale destination" :
        c->unsafe_pixels && c->palette_reference ? "defined BGR prefix only; original destination tail excluded" :
        c->unsafe_pixels ? "unsafe-native-destination-layout; rowbytes only; pixel bytes not inspected" : "complete rows only");
    printf(",\"bgra\":");
    if (c->grayscale || c->unsafe_pixels) printf("null");
    else json_bytes(c->destination, (size_t)c->rows_complete * c->width * 4, 0);
    printf(",\"rgba\":");
    if (c->grayscale || c->unsafe_pixels) printf("null");
    else json_bytes(c->destination, (size_t)c->rows_complete * c->width * 4, 1);
    printf(",\"destination\":");
    if (!c->destination || (c->unsafe_pixels && !c->palette_reference)) printf("null");
    else {
        size_t at;
        printf("{\"initialByte\":%u,\"width\":%u,\"height\":%u,\"pixelBytes\":%u,\"rowStride\":%u,\"comparisonPrefixBytes\":%u,\"excludedTailBytesPerRow\":%u,\"scope\":",
            DESTINATION_SENTINEL, c->width, c->height, c->grayscale ? 1 : 4, c->destination_stride, c->comparison_prefix,
            c->destination_stride - c->comparison_prefix);
        json_string(!c->palette_reference ? "normal-main-destination; excludes mask temporary and manual palette-gray" :
            c->grayscale ? "manual-palette-gray caller destination; private temporary is not the destination" :
            c->unsafe_pixels ? "normal-palette-key defined BGR prefix; original unwritten tail excluded" :
            "normal-palette complete defined caller destination");
        printf(",\"bytes\":");
        json_bytes(c->destination, c->destination_bytes, 0);
        printf(",\"comparisonMask\":[");
        for (at = 0; at < c->destination_bytes; at++) printf("%s%d", at ? "," : "", at % c->destination_stride < c->comparison_prefix);
        printf("],\"bgra\":");
        if (c->grayscale) printf("null"); else json_bytes(c->destination, c->destination_bytes, 0);
        printf(",\"rgba\":");
        if (c->grayscale) printf("null"); else json_bytes(c->destination, c->destination_bytes, 1);
        putchar('}');
    }
    printf(",\"destinationSnapshots\":[");
    for (i = 0; i < c->snapshot_count; i++) {
        DestinationSnapshot *s = c->snapshots[i];
        printf("%s{\"id\":%u,\"traceSequence\":%u,\"eventSequence\":%u,\"inputOffset\":%lu,\"row\":%d,\"rowsComplete\":%u,\"phase\":", i ? "," : "", i + 1, s->trace_sequence, s->event_sequence, (unsigned long)s->input_offset, s->row, s->rows_complete);
        json_string(s->phase); printf(",\"event\":"); json_string(s->event); printf(",\"bytes\":");
        json_bytes(s->data, s->bytes, 0); printf(",\"bgra\":");
        if (c->grayscale) printf("null"); else json_bytes(s->data, s->bytes, 0); putchar('}');
    }
    printf("],\"reads\":[");
    for (i = 0; i < c->read_count; i++) {
        ReadObservation *r = &c->reads[i];
        printf("%s{\"traceSequence\":%u,\"offset\":%lu,\"requested\":%lu,\"actual\":%lu,\"beforeSnapshot\":%u,\"afterSnapshot\":%u,\"phase\":", i ? "," : "", r->trace_sequence, (unsigned long)r->offset, (unsigned long)r->requested, (unsigned long)r->actual, r->before_snapshot, r->after_snapshot);
        json_string(r->phase); putchar('}');
    }
    printf("],\"droppedSnapshots\":%u,\"droppedReads\":%u", c->dropped_snapshots, c->dropped_reads);
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
    if (argc != 3 && argc != 5) { fprintf(stderr, "usage: png-reference input.png keyidx [normal|grayscale palette]\n"); return 2; }
    c = (Context *)calloc(1, sizeof(Context)); if (!c) return 2; active = c; c->current_row = -1;
    c->phase = "input"; c->keyidx = atoi(argv[2]);
    if (argc == 5) {
        if (strcmp(argv[4], "palette") || (strcmp(argv[3], "normal") && strcmp(argv[3], "grayscale"))) { free(c); return 2; }
        c->palette_reference = 1; c->grayscale = !strcmp(argv[3], "grayscale");
    }
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
    for (i = 0; i < c->snapshot_count; i++) free(c->snapshots[i]);
    free(c->rows); if (c->pixels != c->destination) free(c->pixels);
    free(c->destination); free(c->input); free(c);
    return 0;
}
