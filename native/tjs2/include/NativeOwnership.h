#pragma once
#include <memory>
#include <cstdint>
#include "tjsConfig.h"
#include "tjsError.h"
#include "Cleanup.h"

namespace krkr {
struct ReleaseNative {
    template<class T> void operator()(T* value) const noexcept {
        try { if(value) value->Release(); }
        catch(...) { deferCleanupError(std::current_exception()); }
    }
};
template<class T> using NativeOwner = std::unique_ptr<T, ReleaseNative>;
struct FreeTjs {
    void operator()(void* value) const { TJS::TJS_free(value); }
};
template<class T> using TjsBuffer = std::unique_ptr<T[], FreeTjs>;
template<class T> TjsBuffer<T> allocateTjs(std::size_t count) {
    if(count > SIZE_MAX / sizeof(T)) TJS::TJS_eTJSError(TJSInsufficientMem);
    if(!count) return {};
    auto* value = static_cast<T*>(TJS::TJS_malloc(count * sizeof(T)));
    if(!value) TJS::TJS_eTJSError(TJSInsufficientMem);
    return TjsBuffer<T>(value);
}
}
