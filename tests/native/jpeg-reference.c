/* Hosted-only independent caller for fixed TVPLoadJPEG (2.32stable dec49af).
 * IJG6b + original libjpeg2 configuration; never a turbo/browser oracle.
 * Original exception cleanup boundaries are recorded before harness cleanup. */
#define JPEG_INTERNALS
#include "jinclude.h"
#include "jpeglib.h"
#include "jerror.h"
#include "jmemsys.h"
#include <stdint.h>
#include <stdarg.h>
#include <setjmp.h>

_Static_assert(sizeof(void *) == 4 && sizeof(long) == 4, "32bit reference ABI");
_Static_assert(sizeof(INT32) == 4 && sizeof(JCOEF) == 2 && sizeof(JSAMPLE) == 1 && sizeof(boolean) == 1, "Original JPEG scalar/sample types");
_Static_assert(BITS_IN_JSAMPLE == 8 && RGB_RED == 2 && RGB_GREEN == 1 && RGB_BLUE == 0 && RGB_PIXELSIZE == 3, "Original libjpeg2 layout");
_Static_assert(sizeof(MULTIPLIER) == 2, "Original short IDCT multiplier");

enum { INPUT_CAP = 1048576, DEST_CAP = 65536, RECORD_CAP = 512, MEMORY_CAP = 33554432 };
typedef struct { void *ptr; size_t size; int live; } Allocation;
typedef struct { size_t offset, requested, actual; int synthetic; const char *phase; } Read;
typedef struct { unsigned start, end, returned, requested; int failed; } Batch;
typedef struct { unsigned y, batch; unsigned char *bytes; } Row;
typedef struct {
  struct jpeg_decompress_struct jpeg;
  struct jpeg_compress_struct encoder;
  struct jpeg_error_mgr error;
  jmp_buf jump;
  unsigned char *input, *destination;
  size_t input_size, offset, destination_size;
  const char *phase, *error_phase, *kind;
  int mode, precision, code, failed, size_called, complete, protected_body, original_destroyed;
  int jpeg_space, output_space, output_components, recommended, dct, fancy;
  unsigned width, height, rows_complete, warnings, last_warning, synthetic_eoi, dropped;
  Read reads[RECORD_CAP]; unsigned read_count;
  Batch batches[RECORD_CAP]; unsigned batch_count;
  Row rows[RECORD_CAP]; unsigned row_count;
  Allocation allocations[4096]; unsigned allocation_count;
  size_t live_bytes, peak_bytes; unsigned live_allocations, bad_frees;
} Context;
static Context *active;

static void record_failure(Context *c, const char *kind, int code) {
  c->kind = kind; c->code = code; c->failed = 1; c->error_phase = c->phase;
  if (c->batch_count && !strcmp(c->phase, "rows")) c->batches[c->batch_count - 1].failed = 1;
  longjmp(c->jump, 1);
}
static void error_exit(j_common_ptr jpeg) { record_failure(active, "codec", jpeg->err->msg_code); }
static void emit_message(j_common_ptr jpeg, int level) {
  if (level < 0) { active->warnings++; active->last_warning = (unsigned)jpeg->err->msg_code; }
}
static void ignored_output(j_common_ptr jpeg) { (void)jpeg; }
static void ignored_format(j_common_ptr jpeg, char *text) { (void)jpeg; (void)text; }
static void reset_error(j_common_ptr jpeg) { jpeg->err->num_warnings = 0; jpeg->err->msg_code = 0; }
static void prepare_error(struct jpeg_error_mgr *error) {
  jpeg_std_error(error); error->error_exit = error_exit; error->emit_message = emit_message;
  error->output_message = ignored_output; error->format_message = ignored_format; error->reset_error_mgr = reset_error;
}

/* Independent no-backing-store system allocator. Record library allocations,
 * and bound malicious fixture demand without changing successful algorithms. */
GLOBAL(void *) jpeg_get_small(j_common_ptr jpeg, size_t size) {
  void *ptr; Allocation *item; (void)jpeg;
  if (active->allocation_count >= 4096 || size > MEMORY_CAP - active->live_bytes)
    record_failure(active, "reference-budget", 0);
  ptr = malloc(size ? size : 1); if (!ptr) record_failure(active, "reference-allocation", 0);
  item = &active->allocations[active->allocation_count++]; item->ptr = ptr; item->size = size; item->live = 1;
  active->live_bytes += size; active->live_allocations++;
  if (active->live_bytes > active->peak_bytes) active->peak_bytes = active->live_bytes;
  return ptr;
}
GLOBAL(void) jpeg_free_small(j_common_ptr jpeg, void *ptr, size_t size) {
  unsigned i; (void)jpeg; (void)size;
  if (!ptr) return;
  for (i = active->allocation_count; i; i--) {
    Allocation *item = &active->allocations[i - 1];
    if (item->live && item->ptr == ptr) {
      item->live = 0; active->live_bytes -= item->size; active->live_allocations--; free(ptr); return;
    }
  }
  active->bad_frees++;
}
GLOBAL(void FAR *) jpeg_get_large(j_common_ptr jpeg, size_t size) { return jpeg_get_small(jpeg, size); }
GLOBAL(void) jpeg_free_large(j_common_ptr jpeg, void FAR *ptr, size_t size) { jpeg_free_small(jpeg, ptr, size); }
GLOBAL(long) jpeg_mem_available(j_common_ptr jpeg, long minimum, long maximum, long used) {
  (void)jpeg; (void)minimum; (void)used; return maximum;
}
GLOBAL(void) jpeg_open_backing_store(j_common_ptr jpeg, backing_store_ptr info, long size) {
  (void)info; (void)size; ERREXIT(jpeg, JERR_NO_BACKING_STORE);
}
GLOBAL(long) jpeg_mem_init(j_common_ptr jpeg) { (void)jpeg; return 0; }
GLOBAL(void) jpeg_mem_term(j_common_ptr jpeg) { (void)jpeg; }

typedef struct { struct jpeg_source_mgr pub; JOCTET *buffer; void *stream; boolean start; } Source;
static void init_source(j_decompress_ptr jpeg) { ((Source *)jpeg->src)->start = 1; }
static boolean fill_source(j_decompress_ptr jpeg) {
  Context *c = active; Source *src = (Source *)jpeg->src;
  size_t available = c->input_size - c->offset, count = available < 8192 ? available : 8192;
  Read *read = NULL;
  if (c->read_count < RECORD_CAP) {
    read = &c->reads[c->read_count++]; read->offset = c->offset; read->requested = 8192;
    read->actual = count; read->phase = c->phase;
  } else { c->dropped++; record_failure(c, "reference-budget", 0); }
  if (count) memcpy(src->buffer, c->input + c->offset, count);
  c->offset += count;
  if (!count) {
    if (src->start) ERREXIT(jpeg, JERR_INPUT_EMPTY);
    WARNMS(jpeg, JWRN_JPEG_EOF); src->buffer[0] = 0xff; src->buffer[1] = JPEG_EOI; count = 2;
    c->synthetic_eoi++; read->synthetic = 1;
  }
  src->pub.next_input_byte = src->buffer; src->pub.bytes_in_buffer = count; src->start = 0;
  return TRUE;
}
static void skip_source(j_decompress_ptr jpeg, long count) {
  Source *src = (Source *)jpeg->src;
  if (count > 0) {
    while (count > (long)src->pub.bytes_in_buffer) { count -= (long)src->pub.bytes_in_buffer; fill_source(jpeg); }
    src->pub.next_input_byte += (size_t)count; src->pub.bytes_in_buffer -= (size_t)count;
  }
}
static void term_source(j_decompress_ptr jpeg) { (void)jpeg; }
static void set_source(j_decompress_ptr jpeg) {
  Source *src = (Source *)(*jpeg->mem->alloc_small)((j_common_ptr)jpeg, JPOOL_PERMANENT, sizeof(Source));
  memset(src, 0, sizeof(*src)); jpeg->src = &src->pub;
  src->buffer = (JOCTET *)(*jpeg->mem->alloc_small)((j_common_ptr)jpeg, JPOOL_PERMANENT, 8192);
  src->stream = active;
  src->pub.init_source = init_source; src->pub.fill_input_buffer = fill_source;
  src->pub.skip_input_data = skip_source; src->pub.resync_to_restart = jpeg_resync_to_restart;
  src->pub.term_source = term_source;
}
static void decode(Context *c) {
  struct jpeg_decompress_struct *jpeg = &c->jpeg; JSAMPARRAY buffer;
  c->phase = "header"; jpeg->err = &c->error; prepare_error(&c->error);
  jpeg_create_decompress(jpeg); set_source(jpeg); jpeg_read_header(jpeg, TRUE);
  jpeg->dct_method = c->precision == 2 ? JDCT_FLOAT : JDCT_IFAST;
  jpeg->do_fancy_upsampling = c->precision != 0;
  if (c->mode) jpeg->out_color_space = JCS_GRAYSCALE;
  c->jpeg_space = jpeg->jpeg_color_space; c->output_space = jpeg->out_color_space;
  c->dct = jpeg->dct_method; c->fancy = jpeg->do_fancy_upsampling;
  c->phase = "start"; jpeg_start_decompress(jpeg);
  c->protected_body = 1;
  c->width = jpeg->output_width; c->height = jpeg->output_height;
  c->output_components = jpeg->output_components; c->recommended = jpeg->rec_outbuf_height;
  if (!c->width || !c->height || c->width > 128 || c->height > 128 ||
      c->recommended < 1 || c->recommended > 4 || c->output_components < 1 || c->output_components > 10)
    record_failure(c, "reference-budget", 0);
  buffer = (*jpeg->mem->alloc_sarray)((j_common_ptr)jpeg, JPOOL_IMAGE,
      jpeg->output_width * jpeg->output_components + 3, jpeg->rec_outbuf_height);
  c->phase = "size"; c->size_called = 1;
  c->destination_size = (size_t)c->width * c->height * (c->mode ? 1 : 4);
  if (c->destination_size > DEST_CAP) record_failure(c, "reference-budget", 0);
  c->destination = (unsigned char *)malloc(c->destination_size);
  if (!c->destination) record_failure(c, "reference-allocation", 0);
  memset(c->destination, 165, c->destination_size);
  while (jpeg->output_scanline < jpeg->output_height) {
    Batch *batch; unsigned y, index;
    if (c->batch_count == RECORD_CAP) record_failure(c, "reference-budget", 0);
    batch = &c->batches[c->batch_count++]; batch->start = jpeg->output_scanline;
    batch->requested = jpeg->rec_outbuf_height; c->phase = "rows";
    batch->returned = jpeg_read_scanlines(jpeg, buffer, jpeg->rec_outbuf_height);
    batch->end = jpeg->output_scanline;
    if (!batch->returned || batch->end <= batch->start) record_failure(c, "reference-stalled", 0);
    for (y = batch->start, index = 0; y < batch->end; y++, index++) {
      unsigned x; Row *row; unsigned char *dest = c->destination + (size_t)y * c->width * (c->mode ? 1 : 4);
      if (c->mode) memcpy(dest, buffer[index], c->width);
      else for (x = 0; x < c->width; x++) {
        /* Fixed TVPConvert24BitTo32Bit packs already-BGR library bytes.
         * Every non-RGB out space uses first W component bytes as gray. */
        if (jpeg->out_color_space == JCS_RGB) {
          dest[x * 4] = buffer[index][x * 3]; dest[x * 4 + 1] = buffer[index][x * 3 + 1];
          dest[x * 4 + 2] = buffer[index][x * 3 + 2];
        } else dest[x * 4] = dest[x * 4 + 1] = dest[x * 4 + 2] = buffer[index][x];
        dest[x * 4 + 3] = 255;
      }
      c->rows_complete++;
      if (c->row_count == RECORD_CAP) record_failure(c, "reference-budget", 0);
      row = &c->rows[c->row_count++]; row->y = y; row->batch = c->batch_count - 1;
      row->bytes = (unsigned char *)malloc(c->width * (c->mode ? 1 : 4));
      if (!row->bytes) record_failure(c, "reference-allocation", 0);
      memcpy(row->bytes, dest, c->width * (c->mode ? 1 : 4));
    }
  }
  c->protected_body = 0; c->phase = "finish"; jpeg_finish_decompress(jpeg);
  jpeg_destroy_decompress(jpeg); c->original_destroyed = 1; c->complete = 1; c->phase = "complete";
}
static void string(const char *value) {
  const unsigned char *p = (const unsigned char *)(value ? value : ""); putchar('"');
  for (; *p; p++) { if (*p == '"' || *p == '\\') putchar('\\');
    if (*p < 32) printf("\\u%04x", *p); else putchar(*p); }
  putchar('"');
}
static void bytes(const unsigned char *value, size_t length) {
  size_t i; putchar('['); for (i = 0; i < length; i++) printf("%s%u", i ? "," : "", value[i]); putchar(']');
}
static void report(Context *c) {
  unsigned i;
  printf("{\"schema\":1,\"version\":%d,\"pointerBytes\":%u,\"longBytes\":%u,\"multiplierBytes\":%u,\"rgbOffsets\":[%d,%d,%d],\"mode\":", JPEG_LIB_VERSION,
    (unsigned)sizeof(void *), (unsigned)sizeof(long), (unsigned)sizeof(MULTIPLIER), RGB_RED, RGB_GREEN, RGB_BLUE);
  string(c->mode ? "grayscale" : "normal"); printf(",\"precision\":"); string(c->precision == 0 ? "low" : c->precision == 2 ? "high" : "normal");
  printf(",\"status\":"); string(c->failed ? "error" : c->complete ? "complete" : "incomplete");
  printf(",\"sizeCallback\":%s,\"width\":%u,\"height\":%u,\"jpegColorSpace\":%d,\"outColorSpace\":%d,\"components\":%d,\"recOutbufHeight\":%d,\"dct\":%d,\"fancy\":%s,\"rowsComplete\":%u,\"warnings\":{\"count\":%u,\"lastCode\":%u},\"syntheticEoi\":%u,\"destination\":",
    c->size_called ? "true" : "false", c->width, c->height, c->jpeg_space, c->output_space, c->output_components,
    c->recommended, c->dct, c->fancy ? "true" : "false", c->rows_complete, c->warnings, c->last_warning, c->synthetic_eoi);
  if (c->destination) bytes(c->destination, c->destination_size); else printf("null");
  printf(",\"destinationSentinel\":165,\"rows\":[");
  for (i = 0; i < c->row_count; i++) { Row *r = &c->rows[i]; printf("%s{\"y\":%u,\"batch\":%u,\"bytes\":", i ? "," : "", r->y, r->batch);
    bytes(r->bytes, c->width * (c->mode ? 1 : 4)); putchar('}'); }
  printf("],\"batches\":[");
  for (i = 0; i < c->batch_count; i++) { Batch *b = &c->batches[i];
    printf("%s{\"start\":%u,\"end\":%u,\"returned\":%u,\"requested\":%u,\"failed\":%s}", i ? "," : "", b->start, b->end, b->returned, b->requested, b->failed ? "true" : "false"); }
  printf("],\"reads\":[");
  for (i = 0; i < c->read_count; i++) { Read *r = &c->reads[i];
    printf("%s{\"offset\":%lu,\"requested\":%lu,\"actual\":%lu,\"syntheticEoi\":%s,\"phase\":", i ? "," : "", (unsigned long)r->offset, (unsigned long)r->requested, (unsigned long)r->actual, r->synthetic ? "true" : "false"); string(r->phase); putchar('}'); }
  printf("],\"error\":");
  if (!c->failed) printf("null"); else { printf("{\"kind\":"); string(c->kind); printf(",\"phase\":"); string(c->error_phase); printf(",\"code\":%d}", c->code); }
  printf(",\"originalCleanup\":{\"destroyed\":%s,\"liveAllocations\":%u,\"liveBytes\":%lu,\"badFrees\":%u},\"peakBytes\":%lu,\"dropped\":%u}\n",
    c->original_destroyed ? "true" : "false", c->live_allocations, (unsigned long)c->live_bytes, c->bad_frees, (unsigned long)c->peak_bytes, c->dropped);
}
static int reclaim(Context *c) {
  unsigned i; int failed;
  if (c->jpeg.mem) jpeg_destroy_decompress(&c->jpeg);
  for (i = 0; i < c->allocation_count; i++) if (c->allocations[i].live)
    jpeg_free_small(NULL, c->allocations[i].ptr, c->allocations[i].size);
  failed = c->live_allocations != 0 || c->live_bytes != 0 || c->bad_frees != 0;
  fprintf(stderr, "{\"harnessCleanup\":{\"liveAllocations\":%u,\"liveBytes\":%lu,\"badFrees\":%u}}\n",
    c->live_allocations, (unsigned long)c->live_bytes, c->bad_frees);
  for (i = 0; i < c->row_count; i++) free(c->rows[i].bytes);
  free(c->input); free(c->destination); free(c);
  return failed;
}

/* The fixture encoder is independent of the product. RGB input supplied to
 * YCbCr conversion follows the fixed BGR macro layout; direct RGB streams
 * intentionally supply raw R,G,B components to null_convert. */
static int encode(int argc, char **argv) {
  Context *c; j_compress_ptr jpeg;
  FILE *file; unsigned char *data; unsigned width, height, x, y, components; int result = 0, direct_rgb;
  const char *kind;
  if (argc != 9) return 2;
  kind = argv[3]; width = (unsigned)atoi(argv[4]); height = (unsigned)atoi(argv[5]);
  direct_rgb = !strcmp(kind, "rgb") || !strcmp(kind, "rgbconstant");
  if (!width || !height || width > 128 || height > 128) return 2;
  components = !strncmp(kind, "gray", 4) ? 1 : !strcmp(kind, "unknown") ? 2 :
    (!strcmp(kind, "cmyk") || !strcmp(kind, "ycck")) ? 4 : 3;
  c = (Context *)calloc(1, sizeof(*c)); if (!c) return 2; active = c; c->phase = "encode";
  file = fopen(argv[2], "wb"); if (!file) { free(c); return 2; }
  data = (unsigned char *)malloc((size_t)width * height * components); if (!data) { fclose(file); free(c); return 2; }
  jpeg = &c->encoder; jpeg->err = &c->error; prepare_error(&c->error);
  if (!setjmp(c->jump)) {
    jpeg_create_compress(jpeg); jpeg_stdio_dest(jpeg, file);
    jpeg->image_width = width; jpeg->image_height = height; jpeg->input_components = components;
    jpeg->in_color_space = components == 1 ? JCS_GRAYSCALE : components == 2 ? JCS_UNKNOWN : components == 4 ? JCS_CMYK : JCS_RGB;
    jpeg_set_defaults(jpeg);
    if (direct_rgb) jpeg_set_colorspace(jpeg, JCS_RGB);
    else if (!strcmp(kind, "ycck")) jpeg_set_colorspace(jpeg, JCS_YCCK);
    else if (components == 3) jpeg_set_colorspace(jpeg, JCS_YCbCr);
    if (components == 3 && !direct_rgb) {
      jpeg->comp_info[0].h_samp_factor = !strcmp(kind, "y444") ? 1 : 2;
      jpeg->comp_info[0].v_samp_factor = !strcmp(kind, "y420") ? 2 : 1;
      jpeg->comp_info[1].h_samp_factor = jpeg->comp_info[1].v_samp_factor = 1;
      jpeg->comp_info[2].h_samp_factor = jpeg->comp_info[2].v_samp_factor = 1;
    }
    jpeg_set_quality(jpeg, ((!strncmp(kind, "gray", 4) && strlen(kind) > 4) || !strcmp(kind, "rgbconstant")) ? 100 : 88, TRUE);
    /* Original configuration explicitly undefines ISLOW support. */
    jpeg->dct_method = JDCT_IFAST; jpeg->optimize_coding = FALSE;
    jpeg->restart_interval = (unsigned)atoi(argv[7]); if (atoi(argv[6])) jpeg_simple_progression(jpeg);
    jpeg_start_compress(jpeg, TRUE);
    if (atoi(argv[8])) { unsigned char padding[12000];
      memset(padding, 0x5a, sizeof(padding)); jpeg_write_marker(jpeg, JPEG_APP0 + 3, padding, sizeof(padding)); }
    for (y = 0; y < height; y++) for (x = 0; x < width; x++) {
      unsigned char *p = data + ((size_t)y * width + x) * components;
      unsigned char r = (unsigned char)(x * 31 + y * 7 + 19), g = (unsigned char)(x * 3 + y * 43 + 67), b = (unsigned char)(x * 17 + y * 11 + 151);
      if (components == 1) p[0] = strlen(kind) > 4 ? (unsigned char)atoi(kind + 4) : r;
      else if (components == 2) { p[0] = r; p[1] = g; }
      else if (components == 4) { p[0] = r; p[1] = g; p[2] = b; p[3] = (unsigned char)(x * 53 + y * 29 + 5); }
      /* Three distinct constant direct-RGB planes produce exact quality100
       * DC values. The original normal loader interprets these as BGR. */
      else if (!strcmp(kind, "rgbconstant")) { p[0] = 32; p[1] = 96; p[2] = 160; }
      else if (direct_rgb) { p[0] = r; p[1] = g; p[2] = b; }
      else { p[RGB_RED] = r; p[RGB_GREEN] = g; p[RGB_BLUE] = b; }
    }
    while (jpeg->next_scanline < jpeg->image_height) {
      JSAMPROW row = data + (size_t)jpeg->next_scanline * width * components; jpeg_write_scanlines(jpeg, &row, 1);
    }
    jpeg_finish_compress(jpeg);
  } else result = 1;
  if (jpeg->mem) jpeg_destroy_compress(jpeg);
  if (c->live_allocations || c->bad_frees) result = 1;
  if (fclose(file)) result = 1; free(data); if (reclaim(c)) result = 1; return result;
}
static void codes(void) {
  printf("{\"INPUT_EMPTY\":%d,\"NO_SOI\":%d,\"NO_IMAGE\":%d,\"CONVERSION_NOTIMPL\":%d,\"SOI_DUPLICATE\":%d,\"BAD_PRECISION\":%d,\"DQT_INDEX\":%d,\"BAD_HUFF_TABLE\":%d,\"SOF_UNSUPPORTED\":%d,\"JPEG_EOF\":%d}\n",
    JERR_INPUT_EMPTY, JERR_NO_SOI, JERR_NO_IMAGE, JERR_CONVERSION_NOTIMPL, JERR_SOI_DUPLICATE, JERR_BAD_PRECISION,
    JERR_DQT_INDEX, JERR_BAD_HUFF_TABLE, JERR_SOF_UNSUPPORTED, JWRN_JPEG_EOF);
}
int main(int argc, char **argv) {
  Context *c; FILE *file; long length;
  if (!getenv("GITHUB_ACTIONS") || strcmp(getenv("GITHUB_ACTIONS"), "true") ||
      !getenv("RUNNER_ENVIRONMENT") || strcmp(getenv("RUNNER_ENVIRONMENT"), "github-hosted")) return 2;
  if (argc == 2 && !strcmp(argv[1], "--codes")) { codes(); return 0; }
  if (argc > 1 && !strcmp(argv[1], "--encode")) return encode(argc, argv);
  if (argc != 4 || (strcmp(argv[2], "normal") && strcmp(argv[2], "grayscale")) ||
      (strcmp(argv[3], "low") && strcmp(argv[3], "normal") && strcmp(argv[3], "high"))) return 2;
  c = (Context *)calloc(1, sizeof(*c)); if (!c) return 2; active = c;
  c->mode = !strcmp(argv[2], "grayscale"); c->precision = !strcmp(argv[3], "low") ? 0 : !strcmp(argv[3], "high") ? 2 : 1;
  file = fopen(argv[1], "rb"); if (!file) { free(c); return 2; }
  if (fseek(file, 0, SEEK_END) || (length = ftell(file)) < 0 || length > INPUT_CAP || fseek(file, 0, SEEK_SET)) { fclose(file); free(c); return 2; }
  c->input_size = (size_t)length; c->input = (unsigned char *)malloc(c->input_size ? c->input_size : 1);
  if (!c->input || fread(c->input, 1, c->input_size, file) != c->input_size) { fclose(file); reclaim(c); return 2; }
  fclose(file);
  if (!setjmp(c->jump)) decode(c);
  else if (c->protected_body) { jpeg_destroy_decompress(&c->jpeg); c->original_destroyed = 1; }
  report(c); return reclaim(c) ? 2 : 0;
}
