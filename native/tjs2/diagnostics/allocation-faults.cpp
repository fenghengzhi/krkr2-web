// Linked only into the separate hosted allocation diagnostic, never releases.
#include <cstddef>
#include <cstdint>
#include <limits>
#include <emscripten.h>
#include <emscripten/heap.h>
#include "tjsVariantString.h"
extern "C" int krkr_diagnostic_phase();
namespace {
int phase = 0, remaining = -1, hits = 0;
std::size_t sizeFilter = 0, failedBytes = 0;
// Diagnostic-only, allocation-free ledger. Requested live bytes and blocks
// are independent of dlmalloc's variable chunk rounding/fragmentation.
constexpr std::size_t slots = 262144;
struct Allocation { std::uintptr_t pointer; std::size_t bytes; } ledger[slots]{};
std::uint64_t liveBytes = 0;
unsigned liveBlocks = 0, ledgerOverflow = 0;
std::size_t bucket(std::uintptr_t pointer) { return ((pointer >> 3) * 2654435761u) & (slots - 1); }
void remember(void* value, std::size_t bytes) {
    if(!value) return;
    const auto pointer = reinterpret_cast<std::uintptr_t>(value);
    std::size_t vacant = slots;
    for(std::size_t count = 0, index = bucket(pointer); count < slots; ++count, index = (index + 1) & (slots - 1)) {
        auto& entry = ledger[index];
        if(entry.pointer == pointer) { liveBytes -= entry.bytes; entry.bytes = bytes; liveBytes += bytes; return; }
        if(entry.pointer == 1 && vacant == slots) vacant = index;
        if(entry.pointer == 0) { if(vacant == slots) vacant = index; break; }
    }
    if(vacant == slots) { ++ledgerOverflow; return; }
    ledger[vacant] = {pointer, bytes};
    liveBytes += bytes; ++liveBlocks;
}
void forget(void* value) {
    if(!value) return;
    const auto pointer = reinterpret_cast<std::uintptr_t>(value);
    for(std::size_t count = 0, index = bucket(pointer); count < slots; ++count, index = (index + 1) & (slots - 1)) {
        auto& entry = ledger[index];
        if(entry.pointer == 0) return;
        if(entry.pointer == pointer) {
            liveBytes -= entry.bytes; --liveBlocks; entry = {1, 0}; return;
        }
    }
}
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
extern "C" EMSCRIPTEN_KEEPALIVE unsigned krkr_test_live_allocation_stat(unsigned field) {
    switch(field) {
        case 0: return liveBytes;
        case 1: return liveBlocks;
        case 2: return ledgerOverflow;
        default: return 0;
    }
}
extern "C" EMSCRIPTEN_KEEPALIVE std::size_t krkr_test_string_block_bytes() { return 4096 * sizeof(TJS::tTJSVariantString); }
extern "C" EMSCRIPTEN_KEEPALIVE std::size_t krkr_test_string_index_bytes() { return 8192 * sizeof(TJS::tTJSVariantString*); }
// Use Emscripten's supported builtin aliases; linker --wrap removes the malloc
// symbol needed by the generated Asyncify/JSPI JavaScript glue.
extern "C" void* malloc(std::size_t bytes) {
    if(fail(bytes)) return nullptr;
    auto* value = emscripten_builtin_malloc(bytes); remember(value, bytes); return value;
}
extern "C" void* calloc(std::size_t count, std::size_t width) {
    if(width && count > std::numeric_limits<std::size_t>::max() / width) return nullptr;
    const auto bytes = count * width;
    if(fail(bytes)) return nullptr;
    auto* value = emscripten_builtin_calloc(count, width); remember(value, bytes); return value;
}
extern "C" void* realloc(void* value, std::size_t bytes) {
    if(fail(bytes)) return nullptr;
    auto* replacement = emscripten_builtin_realloc(value, bytes);
    if(replacement || !bytes) { forget(value); remember(replacement, bytes); }
    return replacement;
}
extern "C" void free(void* value) { forget(value); emscripten_builtin_free(value); }
extern "C" void* memalign(std::size_t alignment, std::size_t bytes) {
    if(fail(bytes)) return nullptr;
    auto* value = emscripten_builtin_memalign(alignment, bytes); remember(value, bytes); return value;
}
