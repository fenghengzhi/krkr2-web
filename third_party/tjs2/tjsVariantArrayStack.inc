// Shared production implementation, included inside namespace TJS. The native
// sanitizer harness compiles this exact code with instrumented value/allocator
// boundaries; real TJS finalizers are covered by the hosted WASM regressions.
#define TJS_VA_ONE_ALLOC_MAX 1024
static std::atomic<std::uint64_t> TJSCompactVariantArrayMagic{0};
static std::mutex TJSVariantArrayStackMutex;
static std::set<tTJSVariantArrayStack*> TJSVariantArrayStacks;

tTJSVariantArrayStack::tTJSVariantArrayStack() {
    NumArraysAllocated = NumArraysUsing = 0;
    Arrays = nullptr;
    Current = nullptr;
    OperationDisabledCount = 0;
    CompactVariantArrayMagic = TJSCompactVariantArrayMagic.load(std::memory_order_relaxed);
    std::lock_guard<std::mutex> registry(TJSVariantArrayStackMutex);
    TJSVariantArrayStacks.insert(this);
}

tTJSVariantArrayStack::~tTJSVariantArrayStack() {
    // Remove the lifetime from the registry before deleting any values. Never
    // take registry after MetadataMutex; the global compactor uses that order.
    {
        std::lock_guard<std::mutex> registry(TJSVariantArrayStackMutex);
        TJSVariantArrayStacks.erase(this);
    }
    OperationDisabledCount++;
    for(tjs_int i = 0; i < NumArraysAllocated; i++) delete[] Arrays[i].Array;
    TJS_free(Arrays);
    Arrays = nullptr;
}

void tTJSVariantArrayStack::IncreaseVariantArray(tjs_int num) {
    if(NumArraysUsing == NumArraysAllocated) {
        // Publish only after both allocations succeed. A descriptor-table move
        // does not move any register block or its live frame pointers.
        auto values = std::make_unique<tTJSVariant[]>(num);
        auto* next = static_cast<tVariantArray*>(TJS_realloc(
            Arrays, sizeof(tVariantArray) * (NumArraysUsing + 1)));
        if(!next) TJS_eTJSError(TJSInsufficientMem);
        Arrays = next;
        Arrays[NumArraysUsing].Array = values.release();
        Arrays[NumArraysUsing].Allocated = num;
        ++NumArraysAllocated;
    }
    Current = Arrays + NumArraysUsing;
    Current->Using = 0;
    ++NumArraysUsing;
}

void tTJSVariantArrayStack::DecreaseVariantArray() {
    --NumArraysUsing;
    Current = NumArraysUsing ? Arrays + NumArraysUsing - 1 : nullptr;
}

void tTJSVariantArrayStack::InternalCompact() {
    // MetadataMutex is held. Deallocate clears every returned slot (even when
    // a finalizer throws) BEFORE reducing NumArraysUsing. New slots start void.
    // Consequently every retired block is all-void: delete[] cannot call TJS,
    // yield, allocate, or reenter the registry. Never inspect an active tail.
    while(NumArraysAllocated > NumArraysUsing) {
        --NumArraysAllocated;
        delete[] Arrays[NumArraysAllocated].Array;
    }
    if(!NumArraysUsing) {
        TJS_free(Arrays);
        Arrays = nullptr;
        Current = nullptr;
    }
    // Keep the descriptor backing while any frame is active. TJS_realloc does
    // not shrink it anyway; avoiding a replacement also makes compact OOM-safe.
}

void tTJSVariantArrayStack::Compact() {
    std::lock_guard<std::mutex> metadata(MetadataMutex);
    InternalCompact();
    // An immediate request must not consume an already pending deferred one:
    // the latter still compacts after the next frame has actually unwound.
}

tTJSVariantArrayStackStats tTJSVariantArrayStack::Inspect() const {
    std::lock_guard<std::mutex> metadata(MetadataMutex);
    tTJSVariantArrayStackStats result;
    result.AllocatedBlocks = NumArraysAllocated;
    result.UsingBlocks = NumArraysUsing;
    for(tjs_int i = 0; i < NumArraysAllocated; ++i) result.AllocatedSlots += Arrays[i].Allocated;
    for(tjs_int i = 0; i < NumArraysUsing; ++i) result.UsingSlots += Arrays[i].Using;
    return result;
}

tTJSVariant* tTJSVariantArrayStack::Allocate(tjs_int num) {
    std::lock_guard<std::mutex> metadata(MetadataMutex);
    if(!OperationDisabledCount && num < TJS_VA_ONE_ALLOC_MAX) {
        if(!Current || Current->Using + num > Current->Allocated)
            IncreaseVariantArray(TJS_VA_ONE_ALLOC_MAX);
        auto* result = Current->Array + Current->Using;
        Current->Using += num;
        return result;
    }
    return new tTJSVariant[num];
}

void tTJSVariantArrayStack::Deallocate(tjs_int num, tTJSVariant* ptr) {
    // Same-stack execution is LIFO, including nested finalizers. Keep this
    // frame registered while Clear may suspend or reenter TJS. Global compact
    // may run concurrently but cannot touch any block still marked in use.
    std::exception_ptr failure;
    for(tjs_int i = 0; i < num; ++i) {
        try { ptr[i].Clear(); }
        catch(...) { if(!failure) failure = std::current_exception(); }
    }
    {
        std::lock_guard<std::mutex> metadata(MetadataMutex);
        if(!OperationDisabledCount && num < TJS_VA_ONE_ALLOC_MAX) {
            Current->Using -= num;
            if(!Current->Using) DecreaseVariantArray();
        } else {
            delete[] ptr; // all slots are now void, including throwing Clear.
        }
        const auto generation = TJSCompactVariantArrayMagic.load(std::memory_order_relaxed);
        if(!OperationDisabledCount && CompactVariantArrayMagic != generation) {
            InternalCompact();
            CompactVariantArrayMagic = generation;
        }
    }
    if(failure) std::rethrow_exception(failure);
}

void TJSVariantArrayStackCompact() {
    TJSCompactVariantArrayMagic.fetch_add(1, std::memory_order_relaxed);
}

void TJSVariantArrayStackCompactNow() {
    // Registration and pool lifetime stay stable for this no-callback pass.
    // Allocations/deallocations take only MetadataMutex; Clear/finalizers hold
    // neither lock. This also protects other native threads' suspended pools
    // without attempting to execute their VM or clear their active registers.
    std::lock_guard<std::mutex> registry(TJSVariantArrayStackMutex);
    for(auto* stack : TJSVariantArrayStacks) stack->Compact();
}
