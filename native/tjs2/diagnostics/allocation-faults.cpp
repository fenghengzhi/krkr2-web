// Linked only into the separate hosted allocation diagnostic, never releases.
#include <cstddef>
#include <emscripten.h>
#include <emscripten/heap.h>
#include "tjsVariantString.h"
extern "C" int krkr_diagnostic_phase();
namespace {
int phase = 0, remaining = -1, hits = 0;
std::size_t sizeFilter = 0, failedBytes = 0;
bool fail(std::size_t bytes) {
    if(remaining >= 0 && phase == krkr_diagnostic_phase() && (!sizeFilter || bytes == sizeFilter) && remaining-- == 0) {
        remaining = -1; // A single failure leaves exception construction usable.
        ++hits; failedBytes = bytes;
        return true;
    }
    return false;
}
}
extern "C" EMSCRIPTEN_KEEPALIVE void krkr_test_fail_allocation(int target, int after, std::size_t size) {
    phase = target; remaining = after; hits = 0; sizeFilter = size; failedBytes = 0;
}
extern "C" EMSCRIPTEN_KEEPALIVE int krkr_test_allocation_hits() { return hits; }
extern "C" EMSCRIPTEN_KEEPALIVE std::size_t krkr_test_failed_bytes() { return failedBytes; }
extern "C" EMSCRIPTEN_KEEPALIVE std::size_t krkr_test_string_block_bytes() { return 4096 * sizeof(TJS::tTJSVariantString); }
extern "C" EMSCRIPTEN_KEEPALIVE std::size_t krkr_test_string_index_bytes() { return 8192 * sizeof(TJS::tTJSVariantString*); }
// Use Emscripten's supported builtin aliases; linker --wrap removes the malloc
// symbol needed by the generated Asyncify/JSPI JavaScript glue.
extern "C" void* malloc(std::size_t bytes) {
    return fail(bytes) ? nullptr : emscripten_builtin_malloc(bytes);
}
extern "C" void* calloc(std::size_t count, std::size_t width) {
    return fail(count * width) ? nullptr : emscripten_builtin_calloc(count, width);
}
extern "C" void* realloc(void* value, std::size_t bytes) {
    return fail(bytes) ? nullptr : emscripten_builtin_realloc(value, bytes);
}
