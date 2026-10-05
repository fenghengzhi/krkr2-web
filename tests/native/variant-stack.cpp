// GitHub-hosted only. Compile the shipped pool implementation itself with
// instrumented value/allocator boundaries. Actual TJS finalizers and suspended
// source/bytecode execution are tested separately against the shipped WASM.
#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <new>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using tjs_int = std::int32_t;
using tjs_uint = std::uint32_t;
namespace {
thread_local bool failArray = false, failTable = false;
std::atomic<unsigned> liveValues{0}, liveArrays{0}, liveTables{0}, destructorCallbacks{0};
struct alignas(std::max_align_t) TableSize { std::size_t bytes; };
}
namespace TJS {
struct tTJSVariant {
    int value = 0;
    std::function<void()> finalize;
    tTJSVariant() { ++liveValues; }
    ~tTJSVariant() {
        if(finalize) ++destructorCallbacks;
        try { Clear(); } catch(...) { std::terminate(); }
        --liveValues;
    }
    // Match real tTJSVariant::Clear: publish void before invoking a callback,
    // so even an exception leaves the cell safe for eventual array deletion.
    void Clear() {
        value = 0;
        auto callback = std::move(finalize);
        finalize = {};
        if(callback) callback();
    }
    static void* operator new[](std::size_t size) {
        if(failArray) { failArray = false; throw std::bad_alloc(); }
        void* result = ::operator new(size);
        ++liveArrays;
        return result;
    }
    static void operator delete[](void* pointer) noexcept {
        --liveArrays;
        ::operator delete(pointer);
    }
};
constexpr auto TJSInsufficientMem = u"out of memory";
[[noreturn]] void TJS_eTJSError(const char16_t*) { throw std::bad_alloc(); }
void TJS_free(void* pointer) {
    if(!pointer) return;
    --liveTables;
    std::free(static_cast<TableSize*>(pointer) - 1);
}
void* TJS_realloc(void* pointer, std::size_t size) {
    if(failTable) { failTable = false; return nullptr; }
    auto* previous = pointer ? static_cast<TableSize*>(pointer) - 1 : nullptr;
    if(previous && previous->bytes >= size) return pointer;
    auto* table = static_cast<TableSize*>(std::malloc(sizeof(TableSize) + size));
    if(!table) return nullptr;
    ++liveTables;
    table->bytes = size;
    if(previous) std::memcpy(table + 1, pointer, previous->bytes);
    TJS_free(pointer);
    return table + 1;
}
}
#include "tjsInterCodeExec.h"
namespace TJS {
#include "tjsVariantArrayStack.inc"
}

namespace {
using Stack = TJS::tTJSVariantArrayStack;
void empty(const Stack& stack) {
    const auto state = stack.Inspect();
    assert(state.AllocatedBlocks == 0 && state.UsingBlocks == 0);
    assert(state.AllocatedSlots == 0 && state.UsingSlots == 0);
}
void idleAndActiveBlocks() {
    Stack first, second;
    auto* a = first.Allocate(600);
    auto* b = first.Allocate(600);
    first.Deallocate(600, b); first.Deallocate(600, a);
    auto* c = second.Allocate(200);
    c[0].value = 41; c[199].value = 73;
    auto* d = second.Allocate(900);
    second.Deallocate(900, d);
    assert(first.Inspect().AllocatedBlocks == 2);
    assert(second.Inspect().AllocatedBlocks == 2);
    TJS::TJSVariantArrayStackCompactNow();
    empty(first);
    auto state = second.Inspect();
    assert(state.AllocatedBlocks == 1 && state.UsingBlocks == 1);
    assert(state.AllocatedSlots == 1024 && state.UsingSlots == 200);
    assert(c[0].value == 41 && c[199].value == 73);
    d = second.Allocate(900); d[899].value = 91;
    TJS::TJSVariantArrayStackCompactNow();
    assert(second.Inspect().AllocatedBlocks == 2);
    assert(c[199].value == 73 && d[899].value == 91);
    second.Deallocate(900, d); second.Deallocate(200, c);
    TJS::TJSVariantArrayStackCompactNow(); empty(second);
}
void finalizerReentryAndFailure() {
    Stack stack;
    auto* values = stack.Allocate(600);
    unsigned calls = 0;
    values[0].finalize = [&] {
        ++calls;
        assert(stack.Inspect().UsingSlots == 600);
        Stack transient;
        auto* temporary = transient.Allocate(20);
        transient.Deallocate(20, temporary);
        auto* inner = stack.Allocate(800);
        inner[799].value = 77;
        inner[0].finalize = [&] {
            ++calls;
            TJS::TJSVariantArrayStackCompactNow();
            assert(stack.Inspect().UsingSlots == 1400);
        };
        TJS::TJSVariantArrayStackCompactNow(); empty(transient);
        assert(inner[799].value == 77);
        stack.Deallocate(800, inner);
        TJS::TJSVariantArrayStackCompactNow();
        assert(stack.Inspect().AllocatedBlocks == 1);
    };
    values[1].finalize = [&] { ++calls; throw std::runtime_error("primary finalizer"); };
    values[2].finalize = [&] { ++calls; TJS::TJSVariantArrayStackCompact(); };
    bool failed = false;
    try { stack.Deallocate(600, values); }
    catch(const std::runtime_error& error) { failed = std::string(error.what()) == "primary finalizer"; }
    assert(failed && calls == 4);
    empty(stack); // Last Clear requested deferred compaction, after all cells became void.
    assert(destructorCallbacks == 0);
}
void allocationFailuresAndNoAllocateCompact() {
    Stack stack;
    auto* outer = stack.Allocate(600); outer[599].value = 123;
    for(bool arrayFailure : {true, false}) {
        failArray = arrayFailure; failTable = !arrayFailure;
        bool failed = false;
        try { stack.Allocate(600); } catch(const std::bad_alloc&) { failed = true; }
        assert(failed && !failArray && !failTable);
        const auto state = stack.Inspect();
        assert(state.AllocatedBlocks == 1 && state.UsingSlots == 600);
        assert(outer[599].value == 123);
        assert(liveArrays == 1 && liveTables == 1 && liveValues == 1024);
    }
    auto* extra = stack.Allocate(600); stack.Deallocate(600, extra);
    failArray = failTable = true;
    TJS::TJSVariantArrayStackCompactNow();
    assert(failArray && failTable); // No allocation or realloc attempt while reclaiming.
    assert(stack.Inspect().AllocatedBlocks == 1 && outer[599].value == 123);
    stack.Deallocate(600, outer); TJS::TJSVariantArrayStackCompactNow(); empty(stack);
    assert(failArray && failTable);
    failArray = failTable = false;
}
void directLargeFrame() {
    Stack stack;
    auto* pooled = stack.Allocate(100);
    TJS::TJSVariantArrayStackCompact();
    TJS::TJSVariantArrayStackCompactNow();
    stack.Deallocate(100, pooled);
    empty(stack); // Immediate compact must not swallow the deferred request.
    auto* large = stack.Allocate(1024);
    large[1023].value = 63;
    TJS::TJSVariantArrayStackCompactNow(); empty(stack);
    assert(large[1023].value == 63);
    unsigned finalized = 0;
    large[0].finalize = [&] { ++finalized; TJS::TJSVariantArrayStackCompactNow(); };
    stack.Deallocate(1024, large);
    assert(finalized == 1 && liveValues == 0 && liveArrays == 0);
}
void suspendedOwnerOnAnotherThread() {
    std::atomic<Stack*> observed{nullptr};
    std::atomic<bool> resume{false};
    std::thread owner([&] {
        Stack stack;
        auto* outer = stack.Allocate(700); outer[699].value = 97;
        auto* extra = stack.Allocate(700); stack.Deallocate(700, extra);
        observed.store(&stack, std::memory_order_release);
        while(!resume.load(std::memory_order_acquire)) std::this_thread::yield();
        assert(outer[699].value == 97);
        stack.Deallocate(700, outer);
    });
    Stack* stack;
    while(!(stack = observed.load(std::memory_order_acquire))) std::this_thread::yield();
    TJS::TJSVariantArrayStackCompactNow();
    const auto state = stack->Inspect();
    assert(state.AllocatedBlocks == 1 && state.UsingSlots == 700);
    resume.store(true, std::memory_order_release); owner.join();
}
void concurrentRegistryAndMetadata() {
    std::atomic<bool> go{false}, done{false};
    std::thread collector([&] {
        while(!go.load()) std::this_thread::yield();
        while(!done.load()) {
            TJS::TJSVariantArrayStackCompact();
            TJS::TJSVariantArrayStackCompactNow();
            std::this_thread::yield();
        }
    });
    std::vector<std::thread> owners;
    for(unsigned id = 0; id < 4; ++id) owners.emplace_back([&, id] {
        while(!go.load()) std::this_thread::yield();
        for(unsigned iteration = 0; iteration < 200; ++iteration) {
            Stack stack;
            auto* outer = stack.Allocate(600);
            outer[599].value = static_cast<int>(id + 100);
            auto* inner = stack.Allocate(700);
            inner[0].finalize = [&] {
                Stack nested;
                auto* value = nested.Allocate(1);
                nested.Deallocate(1, value);
                TJS::TJSVariantArrayStackCompactNow();
            };
            stack.Deallocate(700, inner);
            assert(outer[599].value == static_cast<int>(id + 100));
            stack.Deallocate(600, outer);
        }
    });
    go.store(true);
    for(auto& owner : owners) owner.join();
    done.store(true); collector.join();
}
}
int main() {
    const auto* hosted = std::getenv("GITHUB_ACTIONS");
    const auto* runner = std::getenv("RUNNER_ENVIRONMENT");
    if(!hosted || std::string(hosted) != "true" || !runner || std::string(runner) != "github-hosted") {
        std::cerr << "This executable may run only on GitHub-hosted Actions.\n";
        return 77;
    }
    idleAndActiveBlocks();
    finalizerReentryAndFailure();
    allocationFailuresAndNoAllocateCompact();
    directLargeFrame();
    suspendedOwnerOnAnotherThread();
    concurrentRegistryAndMetadata();
    assert(liveArrays == 0 && liveValues == 0 && liveTables == 0 && destructorCallbacks == 0);
    std::cout << "PASS: 6 production variant-pool scenarios; active addresses, throwing/reentrant Clear, allocation failure, suspended owner and concurrent registry\n";
}
