#pragma once
#include <cstddef>
#include <cstdint>
#include "tjsError.h"

extern "C" void krkr_vm_check_cancellation();
extern "C" void krkr_vm_enter_frame(unsigned kind);
extern "C" void krkr_vm_leave_frame(unsigned kind);
extern "C" void krkr_vm_reserve_temporary(std::uint64_t bytes);
extern "C" void krkr_vm_release_temporary(std::uint64_t bytes);

namespace krkr {
struct ExecutionCancelled : TJS::eTJSSilent {};
// Functions, try bodies and superclass delegation share one nesting budget.
class ExecutionFrame {
    unsigned kind;
public:
    explicit ExecutionFrame(unsigned kind) : kind(kind) { krkr_vm_enter_frame(kind); }
    ~ExecutionFrame() { krkr_vm_leave_frame(kind); }
    ExecutionFrame(const ExecutionFrame&) = delete;
    ExecutionFrame& operator=(const ExecutionFrame&) = delete;
};
class TemporaryMemory {
    std::uint64_t bytes = 0;
public:
    void reserve(std::size_t count, std::size_t width) {
        const auto size = std::uint64_t(count) * width;
        krkr_vm_reserve_temporary(size);
        bytes += size;
    }
    ~TemporaryMemory() { krkr_vm_release_temporary(bytes); }
    TemporaryMemory() = default;
    TemporaryMemory(const TemporaryMemory&) = delete;
    TemporaryMemory& operator=(const TemporaryMemory&) = delete;
};
}
