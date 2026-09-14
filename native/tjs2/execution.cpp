#include "ExecutionBudget.h"
#include "tjsError.h"
#include <algorithm>
#include <emscripten.h>
#include <emscripten/stack.h>

namespace {
constexpr unsigned depthLimit = 256;
constexpr unsigned functionLimit = 128, delegationLimit = 128;
constexpr std::uint64_t temporaryLimit = 16u * 1024 * 1024;
constexpr unsigned stackReserve = 64u * 1024;
unsigned depth = 0, peakDepth = 0, minimumStackFree = ~0u;
std::uint64_t temporary = 0, peakTemporary = 0;
unsigned kinds[3]{}, peaks[3]{};
}
extern "C" void krkr_vm_enter_frame(unsigned kind) {
    krkr_vm_check_cancellation();
    if(kind == 0 && kinds[0] >= functionLimit) TJS::TJS_eTJSError(u"VM function depth exceeds 128 frames");
    if(kind == 2 && kinds[2] >= delegationLimit) TJS::TJS_eTJSError(u"VM delegation depth exceeds 128 frames");
    if(depth >= depthLimit) TJS::TJS_eTJSError(u"VM execution depth exceeds 256 frames");
    const auto free = emscripten_stack_get_free();
    minimumStackFree = std::min(minimumStackFree, unsigned(free));
    if(free < stackReserve)
        TJS::TJS_eTJSError(u"VM native stack reserve exhausted");
    ++depth;
    ++kinds[kind];
    peaks[kind] = std::max(peaks[kind], kinds[kind]);
    peakDepth = std::max(peakDepth, depth);
}
extern "C" void krkr_vm_leave_frame(unsigned kind) { --depth; --kinds[kind]; }
extern "C" void krkr_vm_reserve_temporary(std::uint64_t bytes) {
    if(bytes > temporaryLimit - temporary)
        TJS::TJS_eTJSError(u"VM temporary registers and arguments exceed 16 MiB budget");
    temporary += bytes;
    peakTemporary = std::max(peakTemporary, temporary);
}
extern "C" void krkr_vm_release_temporary(std::uint64_t bytes) { temporary -= bytes; }
// One native module owns one serialized VM. These read-only exports also work
// while a continuation is suspended, without entering the interpreter again.
extern "C" EMSCRIPTEN_KEEPALIVE unsigned krkr_vm_execution_stat(unsigned field) {
    switch(field) {
        case 0: return depth;
        case 1: return temporary;
        case 2: return peakDepth;
        case 3: return peakTemporary;
        case 4: return depthLimit;
        case 5: return temporaryLimit;
        case 6: return emscripten_stack_get_free();
        case 7: return stackReserve;
        case 8: case 9: case 10: return kinds[field - 8];
        case 11: return minimumStackFree;
        case 12: return functionLimit;
        case 13: return delegationLimit;
        case 14: case 15: case 16: return peaks[field - 14];
        default: return 0;
    }
}
