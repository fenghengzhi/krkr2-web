// Linked only into the separate hosted allocation diagnostic, never releases.
#include <cstddef>
#include <emscripten.h>
extern "C" void* __real_malloc(std::size_t);
extern "C" int krkr_diagnostic_phase();
namespace {
int phase = 0, remaining = -1, hits = 0;
}
extern "C" EMSCRIPTEN_KEEPALIVE void krkr_test_fail_allocation(int target, int after) {
    phase = target; remaining = after; hits = 0;
}
extern "C" EMSCRIPTEN_KEEPALIVE int krkr_test_allocation_hits() { return hits; }
extern "C" void* __wrap_malloc(std::size_t bytes) {
    if(remaining >= 0 && phase == krkr_diagnostic_phase() && remaining-- == 0) {
        remaining = -1; // A single failure leaves exception construction usable.
        ++hits;
        return nullptr;
    }
    return __real_malloc(bytes);
}
