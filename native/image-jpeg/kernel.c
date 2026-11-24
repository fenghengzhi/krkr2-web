/* Standalone IJG6b decompressor. No TJS, DOM, JS callbacks or retained encoded
 * file copy. Each call owns its setjmp; suspension carries bytes, not a stack. */
#include <emscripten/emscripten.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <setjmp.h>
#define JPEG_INTERNALS
#include "jpeglib.h"
#include "jerror.h"
#include "jmemsys.h"
#include "jversion.h"

_Static_assert(sizeof(INT32) == 4 && sizeof(JCOEF) == 2 && sizeof(JSAMPLE) == 1 && sizeof(boolean) == 1,
    "Use the fixed 32-bit eight-sample IJG configuration");
_Static_assert(RGB_RED == 2 && RGB_GREEN == 1 && RGB_BLUE == 0 && RGB_PIXELSIZE == 3,
    "Use the original BGR component configuration");

#define STREAMS 64u
#define INPUT_BYTES 8192u
#define OUTPUT_BYTES 32768u
#define CARRY_BYTES 73728u
#define SOURCE_BYTES (64u * 1024u * 1024u)
#define TOTAL_BYTES (128u * 1024u * 1024u)
#define MAX_DIM 4096u
#define MAX_STEPS 131072u
enum { PROGRESS, SIZE, ROWS, DONE, CODEC_ERROR, BUDGET_ERROR };
enum { HEADER, START, SCANLINES, FINISH, COMPLETE };

typedef struct Slot Slot;
typedef union Allocation Allocation;
union Allocation {
    struct { Allocation *previous, *next; Slot *owner; size_t bytes; } v;
    max_align_t alignment;
};
typedef struct { struct jpeg_source_mgr pub; Slot *owner; size_t skip; } Source;
struct Slot {
    struct jpeg_decompress_struct jpeg;
    struct jpeg_error_mgr error;
    Source source;
    jmp_buf jump;
    uint32_t token;
    Allocation *allocations;
    size_t bytes, limit;
    unsigned char *carry;
    JSAMPARRAY rows;
    unsigned total_input, input_used, needs_input, eof, steps;
    unsigned width, height, batch_start, batch_count, batch_wanted, row_count, output_bytes;
    unsigned warning_count, warning_code;
    int mode, precision, created, stage, phase, status, code;
    const char *budget_reason;
};
static Slot slots[STREAMS];
static unsigned char input_buffer[INPUT_BYTES], output_buffer[OUTPUT_BYTES];
static uint32_t next_token = 1;
static unsigned active_count;
static size_t allocated_bytes, peak_bytes;
static const char *open_reason;

static void *allocate(Slot *s, size_t payload) {
    Allocation *a; size_t total;
    if (payload > SIZE_MAX - sizeof(Allocation)) { s->budget_reason = "JPEG allocation size overflow"; return NULL; }
    total = payload + sizeof(Allocation);
    if (total > s->limit - s->bytes || total > TOTAL_BYTES - allocated_bytes) {
        s->budget_reason = "JPEG native allocation budget exceeded"; return NULL;
    }
    a = (Allocation *)malloc(total);
    if (!a) { s->budget_reason = "JPEG native memory allocation failed"; return NULL; }
    /* alloc_small may retry with less optional slop after a failed request.
     * A successful retry is not a sticky failure of a later codec operation. */
    s->budget_reason = NULL;
    a->v.owner = s; a->v.bytes = total; a->v.previous = NULL; a->v.next = s->allocations;
    if (s->allocations) s->allocations->v.previous = a;
    s->allocations = a; s->bytes += total; allocated_bytes += total;
    if (allocated_bytes > peak_bytes) peak_bytes = allocated_bytes;
    return a + 1;
}
static void release(void *pointer) {
    Allocation *a; Slot *s;
    if (!pointer) return;
    a = (Allocation *)pointer - 1; s = a->v.owner;
    if (a->v.previous) a->v.previous->v.next = a->v.next; else s->allocations = a->v.next;
    if (a->v.next) a->v.next->v.previous = a->v.previous;
    s->bytes -= a->v.bytes; allocated_bytes -= a->v.bytes; free(a);
}

/* IJG's own pool/virtual-array algorithms are unchanged. Only their system
 * allocation hooks are replaced, with no backing files and one shared ledger. */
GLOBAL(void *) jpeg_get_small(j_common_ptr cinfo, size_t bytes) { return allocate((Slot *)cinfo->client_data, bytes); }
GLOBAL(void) jpeg_free_small(j_common_ptr cinfo, void *pointer, size_t bytes) { (void)cinfo; (void)bytes; release(pointer); }
GLOBAL(void FAR *) jpeg_get_large(j_common_ptr cinfo, size_t bytes) { return allocate((Slot *)cinfo->client_data, bytes); }
GLOBAL(void) jpeg_free_large(j_common_ptr cinfo, void FAR *pointer, size_t bytes) { (void)cinfo; (void)bytes; release(pointer); }
GLOBAL(long) jpeg_mem_available(j_common_ptr cinfo, long minimum, long maximum, long already) {
    (void)cinfo; (void)minimum; (void)already; return maximum;
}
GLOBAL(void) jpeg_open_backing_store(j_common_ptr cinfo, backing_store_ptr info, long bytes) {
    Slot *s = (Slot *)cinfo->client_data; (void)info; (void)bytes;
    s->budget_reason = "JPEG backing storage is unavailable";
    s->status = BUDGET_ERROR; longjmp(s->jump, 1);
}
GLOBAL(long) jpeg_mem_init(j_common_ptr cinfo) { (void)cinfo; return 0; }
GLOBAL(void) jpeg_mem_term(j_common_ptr cinfo) { (void)cinfo; }

static void fatal(j_common_ptr cinfo) {
    Slot *s = (Slot *)cinfo->client_data;
    s->code = cinfo->err->msg_code;
    s->status = s->budget_reason ? BUDGET_ERROR : CODEC_ERROR;
    longjmp(s->jump, 1);
}
static void emit(j_common_ptr cinfo, int level) {
    Slot *s = (Slot *)cinfo->client_data;
    /* The game's warning callback is silent. Private diagnostics count it
     * without changing libjpeg's num_warnings or its decoding decisions. */
    if (level < 0) { if (s->warning_count != UINT32_MAX) s->warning_count++; s->warning_code = (unsigned)cinfo->err->msg_code; }
}
static void output_message(j_common_ptr cinfo) { (void)cinfo; }
static void format_message(j_common_ptr cinfo, char *buffer) { (void)cinfo; if (buffer) buffer[0] = 0; }
static void reset_error(j_common_ptr cinfo) { cinfo->err->num_warnings = 0; cinfo->err->msg_code = 0; }
static void budget(Slot *s, const char *reason) { s->budget_reason = reason; s->status = BUDGET_ERROR; longjmp(s->jump, 1); }

static void init_source(j_decompress_ptr cinfo) { (void)cinfo; /* Fresh handles have no prior source cycle. */ }
static boolean fill_input(j_decompress_ptr cinfo) {
    Slot *s = (Slot *)cinfo->client_data;
    if (s->eof && !s->total_input) ERREXIT(cinfo, JERR_INPUT_EMPTY);
    s->needs_input = 1;
    /* Do not change the pointer/count here: they identify IJG's rollback
     * point, which may precede the bytes it already inspected in this call. */
    return FALSE;
}
static void skip_input(j_decompress_ptr cinfo, long count) {
    Source *source = (Source *)cinfo->src;
    size_t used, rest;
    if (count <= 0) return;
    used = (size_t)count < source->pub.bytes_in_buffer ? (size_t)count : source->pub.bytes_in_buffer;
    source->pub.next_input_byte += used; source->pub.bytes_in_buffer -= used;
    rest = (size_t)count - used;
    if (rest > SIZE_MAX - source->skip) budget(source->owner, "JPEG pending skip overflow");
    source->skip += rest;
    /* skip_input_data is void and cannot suspend. The next fill call returns
     * FALSE; feed() consumes this outstanding skip before exposing new bytes. */
}
static void term_source(j_decompress_ptr cinfo) { (void)cinfo; }

static int feed(Slot *s, unsigned input_size, unsigned eof) {
    Source *source = &s->source;
    size_t retained = source->pub.bytes_in_buffer, skip, append;
    unsigned synthetic = 0;
    if (!s->needs_input) {
        if (input_size) return -1;
        if (eof) s->eof = 1;
        return 1;
    }
    if (s->eof && input_size) return -1;
    if (input_size > SOURCE_BYTES - s->total_input) budget(s, "JPEG encoded source exceeds 64 MiB budget");
    if (retained > CARRY_BYTES || (retained &&
        ((uintptr_t)source->pub.next_input_byte < (uintptr_t)s->carry ||
         (uintptr_t)source->pub.next_input_byte > (uintptr_t)s->carry + CARRY_BYTES - retained)))
        budget(s, "JPEG rollback bytes escaped the owned input window");
    if (retained) memmove(s->carry, source->pub.next_input_byte, retained);
    source->pub.next_input_byte = s->carry;
    skip = source->skip < input_size ? source->skip : input_size;
    source->skip -= skip; append = input_size - skip;
    if (append > CARRY_BYTES - retained) budget(s, "JPEG rollback/input window exceeds 73728 bytes");
    if (append) memcpy(s->carry + retained, input_buffer + skip, append);
    retained += append; s->total_input += input_size; s->input_used = input_size;
    if (eof) s->eof = 1;
    /* Empty first input is diagnosed by the real header reader's fill call.
     * Later EOF behaves like the original Read(8192)==0 then FFD9. Keep skip
     * recovery bounded too: at most8192 synthetic bytes are skipped perstep. */
    if (!input_size && s->eof && s->total_input) {
        while (source->skip >= 2 && synthetic < INPUT_BYTES) {
            WARNMS(&s->jpeg, JWRN_JPEG_EOF); source->skip -= 2; synthetic += 2;
        }
        if (!source->skip || source->skip == 1) {
            const unsigned char eoi[2] = { 0xff, JPEG_EOI };
            size_t first = source->skip;
            if (synthetic < INPUT_BYTES) {
                WARNMS(&s->jpeg, JWRN_JPEG_EOF);
                if (2 - first > CARRY_BYTES - retained) budget(s, "JPEG synthetic EOI exceeds rollback window");
                memcpy(s->carry + retained, eoi + first, 2 - first);
                retained += 2 - first; source->skip = 0;
            }
        }
    }
    source->pub.bytes_in_buffer = retained;
    if (source->skip || (!append && !synthetic && !s->eof)) return 0;
    s->needs_input = 0;
    return 1;
}

static Slot *find(uint32_t token) {
    unsigned i;
    if (!token) return NULL;
    for (i = 0; i < STREAMS; i++) if (slots[i].token == token) return &slots[i];
    return NULL;
}
static void initialize(Slot *s) {
    s->jpeg.err = jpeg_std_error(&s->error); s->jpeg.client_data = s;
    s->error.error_exit = fatal; s->error.emit_message = emit; s->error.output_message = output_message;
    s->error.format_message = format_message; s->error.reset_error_mgr = reset_error;
    /* Set before creation so partial initialization is destroyable on failure. */
    s->created = 1;
    jpeg_create_decompress(&s->jpeg);
    s->source.owner = s;
    s->source.pub.init_source = init_source; s->source.pub.fill_input_buffer = fill_input;
    s->source.pub.skip_input_data = skip_input; s->source.pub.resync_to_restart = jpeg_resync_to_restart;
    s->source.pub.term_source = term_source;
    s->jpeg.src = &s->source.pub;
}
static void convert_batch(Slot *s) {
    unsigned row, x; size_t at = 0;
    for (row = 0; row < s->batch_count; row++) {
        const unsigned char *source = s->rows[row];
        for (x = 0; x < s->width; x++, at += 4) {
            if (!s->mode && s->jpeg.out_color_space == JCS_RGB) {
                output_buffer[at] = source[x * 3 + 2]; output_buffer[at + 1] = source[x * 3 + 1]; output_buffer[at + 2] = source[x * 3];
            } else output_buffer[at] = output_buffer[at + 1] = output_buffer[at + 2] = source[x];
            output_buffer[at + 3] = 255;
        }
    }
    s->row_count = s->batch_count; s->output_bytes = (unsigned)at; s->batch_count = 0;
}

EMSCRIPTEN_KEEPALIVE unsigned image_jpeg_abi(void) { return 1; }
EMSCRIPTEN_KEEPALIVE unsigned image_jpeg_version(void) { return JPEG_LIB_VERSION; }
EMSCRIPTEN_KEEPALIVE const char *image_jpeg_version_string(void) { return JVERSION; }
EMSCRIPTEN_KEEPALIVE unsigned char *image_jpeg_input(void) { return input_buffer; }
EMSCRIPTEN_KEEPALIVE unsigned char *image_jpeg_output(void) { return output_buffer; }
EMSCRIPTEN_KEEPALIVE const char *image_jpeg_open_reason(void) { return open_reason; }
EMSCRIPTEN_KEEPALIVE uint32_t image_jpeg_open(unsigned mode, unsigned precision, unsigned limit) {
    Slot *s = NULL; unsigned i;
    open_reason = "Invalid JPEG mode, precision or allocation limit";
    if (mode > 1 || precision > 2 || limit > TOTAL_BYTES) return 0;
    open_reason = "JPEG exceeds 64 active decoders or exhausted handle identities";
    if (active_count == STREAMS || !next_token) return 0;
    for (i = 0; i < STREAMS; i++) if (!slots[i].token) { s = &slots[i]; break; }
    if (!s) return 0;
    memset(s, 0, sizeof(*s)); s->limit = limit; s->mode = (int)mode; s->precision = (int)precision;
    s->carry = (unsigned char *)allocate(s, CARRY_BYTES);
    if (!s->carry) { open_reason = s->budget_reason; return 0; }
    s->source.pub.next_input_byte = s->carry;
    s->needs_input = 1; s->phase = s->stage = HEADER; s->status = PROGRESS;
    s->token = next_token++; active_count++; open_reason = NULL;
    return s->token;
}
EMSCRIPTEN_KEEPALIVE int image_jpeg_step(uint32_t token, unsigned input_size, unsigned eof) {
    Slot *s = find(token); int ready; JDIMENSION count;
    if (!s || input_size > INPUT_BYTES || eof > 1) return -1;
    s->input_used = s->output_bytes = s->row_count = 0;
    if (s->status == CODEC_ERROR || s->status == BUDGET_ERROR || s->status == DONE) return s->status;
    s->status = PROGRESS; s->phase = s->stage;
    if (setjmp(s->jump)) return s->status;
    if (++s->steps > MAX_STEPS) budget(s, "JPEG cooperative step budget exceeded");
    if (!s->created) initialize(s);
    ready = feed(s, input_size, eof);
    if (ready < 0) return -1;
    if (!ready) return PROGRESS;
    switch (s->stage) {
    case HEADER:
        if (jpeg_read_header(&s->jpeg, TRUE) == JPEG_SUSPENDED) break;
        if (!s->jpeg.image_width || !s->jpeg.image_height || s->jpeg.image_width > MAX_DIM || s->jpeg.image_height > MAX_DIM)
            budget(s, "JPEG dimensions exceed 4096x4096 image budget");
        s->jpeg.dct_method = s->precision == 2 ? JDCT_FLOAT : JDCT_IFAST;
        s->jpeg.do_fancy_upsampling = s->precision != 0;
        if (s->mode) s->jpeg.out_color_space = JCS_GRAYSCALE;
        s->stage = START;
        break;
    case START:
        if (!jpeg_start_decompress(&s->jpeg)) break;
        s->width = s->jpeg.output_width; s->height = s->jpeg.output_height;
        if (!s->width || !s->height || s->width > MAX_DIM || s->height > MAX_DIM ||
            s->jpeg.output_components < 1 || s->jpeg.output_components > MAX_COMPONENTS ||
            s->jpeg.rec_outbuf_height < 1 || s->jpeg.rec_outbuf_height > 2)
            budget(s, "JPEG output or row-group dimensions exceed the supported native budget");
        s->rows = (*s->jpeg.mem->alloc_sarray)((j_common_ptr)&s->jpeg, JPOOL_IMAGE,
            s->width * (unsigned)s->jpeg.output_components + 3, (JDIMENSION)s->jpeg.rec_outbuf_height);
        s->status = SIZE; s->stage = SCANLINES;
        break;
    case SCANLINES:
        if (!s->batch_count) {
            s->batch_start = s->jpeg.output_scanline;
            s->batch_wanted = (unsigned)s->jpeg.rec_outbuf_height;
            if (s->batch_wanted > s->height - s->batch_start) s->batch_wanted = s->height - s->batch_start;
        }
        if (!s->batch_wanted) { s->stage = FINISH; break; }
        count = jpeg_read_scanlines(&s->jpeg, s->rows + s->batch_count, s->batch_wanted - s->batch_count);
        if (count > s->batch_wanted - s->batch_count) budget(s, "JPEG row count escaped its private group");
        s->batch_count += count;
        if (s->needs_input && s->batch_count < s->batch_wanted) break;
        if (!s->batch_count) budget(s, "JPEG scanline decoder made no progress without requesting input");
        convert_batch(s); s->status = ROWS;
        if (s->jpeg.output_scanline == s->height) s->stage = FINISH;
        break;
    case FINISH:
        if (!jpeg_finish_decompress(&s->jpeg)) break;
        s->status = DONE; s->stage = s->phase = COMPLETE;
        break;
    default: return -1;
    }
    return s->status;
}
EMSCRIPTEN_KEEPALIVE unsigned image_jpeg_value(uint32_t token, unsigned kind) {
    Slot *s = find(token);
    if (!s) return 0;
    switch (kind) {
    case 0: return s->input_used; case 1: return s->needs_input; case 2: return (unsigned)s->phase;
    case 3: return s->width; case 4: return s->height; case 5: return s->batch_start;
    case 6: return s->row_count; case 7: return (unsigned)s->code; case 8: return s->warning_count;
    case 9: return s->warning_code; case 10: return s->output_bytes; case 11: return s->total_input;
    case 12: return (unsigned)s->source.pub.bytes_in_buffer; case 13: return (unsigned)s->source.skip;
    case 14: return (unsigned)s->jpeg.rec_outbuf_height; default: return 0;
    }
}
EMSCRIPTEN_KEEPALIVE const char *image_jpeg_reason(uint32_t token) { Slot *s = find(token); return s ? s->budget_reason : "Invalid JPEG handle"; }
EMSCRIPTEN_KEEPALIVE int image_jpeg_close(uint32_t token) {
    Slot *s = find(token); int failed = 0;
    if (!s) return 0;
    if (setjmp(s->jump)) failed = 1;
    else if (s->created) jpeg_destroy_decompress(&s->jpeg);
    /* Also reclaim an allocation not yet linked into an IJG pool when a
     * constructor throws. No external finalizer runs from these free calls. */
    while (s->allocations) release(s->allocations + 1);
    s->token = 0; active_count--;
    return failed ? -1 : 0;
}
EMSCRIPTEN_KEEPALIVE void image_jpeg_dispose(void) {
    unsigned i;
    for (i = 0; i < STREAMS; i++) if (slots[i].token) image_jpeg_close(slots[i].token);
}
EMSCRIPTEN_KEEPALIVE unsigned image_jpeg_stat(unsigned kind) {
    return kind == 0 ? active_count : kind == 1 ? (unsigned)allocated_bytes : kind == 2 ? (unsigned)peak_bytes : 0;
}
