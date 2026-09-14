#pragma once
#include <cstddef>
#include <exception>

namespace TJS { class iTJSDispatch2; }
namespace krkr {
// Native destructors must not unwind a noexcept C++ container. Keep their first
// error in the innermost execution/cleanup scope and report it at a safe boundary.
class CleanupErrors {
    CleanupErrors* parent;
    std::exception_ptr error;
    bool suppressed = false;
    friend void deferCleanupError(std::exception_ptr) noexcept;
public:
    CleanupErrors() noexcept;
    ~CleanupErrors() noexcept;
    CleanupErrors(const CleanupErrors&) = delete;
    CleanupErrors& operator=(const CleanupErrors&) = delete;
    void suppress() noexcept;
    void rethrow();
};
void deferCleanupError(std::exception_ptr error) noexcept;
void throwCleanupError();
void releaseAll(TJS::iTJSDispatch2* const* objects, std::size_t count);
void releaseClosure(TJS::iTJSDispatch2* object, TJS::iTJSDispatch2* context);
}
