/* A standalone PNG-only, synchronous zlib state machine. No TJS/host imports. */
#include <emscripten/emscripten.h>
#include <zlib.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

#define MAX_STREAMS 64u
#define INPUT_BYTES 8192u
#define OUTPUT_BYTES 32769u
#define STREAM_BYTES (128u * 1024u)
#define TOTAL_BYTES (8u * 1024u * 1024u)

typedef struct {
    z_stream stream;
    uint32_t token;
    size_t bytes, limit;
    unsigned input_used, output_used;
    int status;
} Slot;
typedef union {
    struct { size_t bytes; Slot *owner; } value;
    max_align_t alignment;
} Allocation;

static Slot slots[MAX_STREAMS];
static unsigned char input_buffer[INPUT_BYTES], output_buffer[OUTPUT_BYTES];
static uint32_t next_token = 1;
static unsigned active_count;
static size_t allocated_bytes, peak_bytes;
static int open_status;

static voidpf allocate(voidpf opaque, uInt items, uInt size) {
    Slot *slot = (Slot *)opaque;
    size_t payload, total;
    Allocation *allocation;
    if (size && (size_t)items > SIZE_MAX / size) return Z_NULL;
    payload = (size_t)items * size;
    if (payload > SIZE_MAX - sizeof(Allocation)) return Z_NULL;
    total = payload + sizeof(Allocation);
    if (total > slot->limit - slot->bytes || total > TOTAL_BYTES - allocated_bytes) return Z_NULL;
    allocation = (Allocation *)malloc(total);
    if (!allocation) return Z_NULL;
    allocation->value.bytes = total;
    allocation->value.owner = slot;
    slot->bytes += total;
    allocated_bytes += total;
    if (allocated_bytes > peak_bytes) peak_bytes = allocated_bytes;
    memset(allocation + 1, 0, payload);
    return allocation + 1;
}

static void release(voidpf opaque, voidpf address) {
    Allocation *allocation;
    Slot *slot;
    (void)opaque;
    if (!address) return;
    allocation = (Allocation *)address - 1;
    slot = allocation->value.owner;
    slot->bytes -= allocation->value.bytes;
    allocated_bytes -= allocation->value.bytes;
    free(allocation);
}

static Slot *find(uint32_t token) {
    unsigned i;
    if (!token) return NULL;
    for (i = 0; i < MAX_STREAMS; ++i) if (slots[i].token == token) return &slots[i];
    return NULL;
}

EMSCRIPTEN_KEEPALIVE unsigned image_zlib_abi(void) { return 1; }
EMSCRIPTEN_KEEPALIVE const char *image_zlib_version(void) { return zlibVersion(); }
EMSCRIPTEN_KEEPALIVE unsigned char *image_zlib_input(void) { return input_buffer; }
EMSCRIPTEN_KEEPALIVE unsigned char *image_zlib_output(void) { return output_buffer; }
EMSCRIPTEN_KEEPALIVE int image_zlib_open_status(void) { return open_status; }

/* A lower limit is accepted for controlled resource-constrained consumers and
 * hosted allocation-failure tests; it can never raise the production bound. */
EMSCRIPTEN_KEEPALIVE uint32_t image_zlib_open(unsigned allocation_limit) {
    unsigned i;
    Slot *slot = NULL;
    int status;
    open_status = Z_MEM_ERROR;
    if (!next_token || active_count == MAX_STREAMS || allocation_limit > STREAM_BYTES) return 0;
    for (i = 0; i < MAX_STREAMS; ++i) if (!slots[i].token) { slot = &slots[i]; break; }
    if (!slot) return 0;
    memset(slot, 0, sizeof(*slot));
    slot->limit = allocation_limit;
    slot->stream.zalloc = allocate;
    slot->stream.zfree = release;
    slot->stream.opaque = slot;
    status = inflateInit(&slot->stream);
    if (status != Z_OK) {
        if (slot->stream.state) inflateEnd(&slot->stream);
        open_status = status;
        return 0;
    }
    slot->token = next_token++;
    slot->status = Z_OK;
    active_count++;
    open_status = Z_OK;
    return slot->token;
}

EMSCRIPTEN_KEEPALIVE int image_zlib_step(uint32_t token, unsigned input_size, unsigned output_size) {
    Slot *slot = find(token);
    if (!slot || input_size > INPUT_BYTES || output_size > OUTPUT_BYTES) return Z_STREAM_ERROR;
    slot->stream.next_in = input_buffer;
    slot->stream.avail_in = input_size;
    slot->stream.next_out = output_buffer;
    slot->stream.avail_out = output_size;
    slot->status = inflate(&slot->stream, Z_PARTIAL_FLUSH);
    slot->input_used = input_size - slot->stream.avail_in;
    slot->output_used = output_size - slot->stream.avail_out;
    /* No native pointer into a caller-owned buffer survives the step. The
     * consumer supplies precisely the unconsumed suffix on its next call. */
    slot->stream.next_in = Z_NULL;
    slot->stream.avail_in = 0;
    slot->stream.next_out = Z_NULL;
    slot->stream.avail_out = 0;
    return slot->status;
}

EMSCRIPTEN_KEEPALIVE unsigned image_zlib_used(uint32_t token, unsigned output) {
    Slot *slot = find(token);
    return slot ? (output ? slot->output_used : slot->input_used) : 0;
}
EMSCRIPTEN_KEEPALIVE const char *image_zlib_reason(uint32_t token) {
    Slot *slot = find(token);
    if (!slot) return "Invalid image inflater handle";
    /* libpng supplies its own phase-specific fallback when msg is NULL.
     * zError(status) is not the message returned by inflate(). */
    return slot->stream.msg;
}

EMSCRIPTEN_KEEPALIVE int image_zlib_close(uint32_t token) {
    Slot *slot = find(token);
    int status;
    if (!slot) return Z_OK;
    status = inflateEnd(&slot->stream);
    slot->token = 0;
    active_count--;
    return status;
}
EMSCRIPTEN_KEEPALIVE void image_zlib_dispose(void) {
    unsigned i;
    for (i = 0; i < MAX_STREAMS; ++i) if (slots[i].token) image_zlib_close(slots[i].token);
}
EMSCRIPTEN_KEEPALIVE unsigned image_zlib_stat(unsigned kind) {
    return kind == 0 ? active_count : kind == 1 ? (unsigned)allocated_bytes : kind == 2 ? (unsigned)peak_bytes : 0;
}
