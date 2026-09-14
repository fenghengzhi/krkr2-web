#include "Cleanup.h"
#include "tjsInterface.h"
#include <utility>

namespace krkr {
namespace {
CleanupErrors* current = nullptr;
std::exception_ptr orphaned;
}
CleanupErrors::CleanupErrors() noexcept : parent(current) {
    if(!parent) error = std::move(orphaned);
    current = this;
}
CleanupErrors::~CleanupErrors() noexcept {
    if(suppressed || std::uncaught_exceptions()) suppress();
    current = parent;
    if(error) deferCleanupError(std::move(error));
}
void CleanupErrors::suppress() noexcept {
    suppressed = true;
    error = nullptr;
}
void CleanupErrors::rethrow() {
    if(error) {
        auto pending = std::move(error);
        std::rethrow_exception(pending);
    }
}
void deferCleanupError(std::exception_ptr error) noexcept {
    // A destructor encountered while another exception is unwinding must not
    // replace that exception or reappear after a TJS catch handles the primary.
    if(std::uncaught_exceptions()) return;
    if(current) {
        if(!current->suppressed && !current->error) current->error = std::move(error);
    } else if(!orphaned) orphaned = std::move(error);
}
void throwCleanupError() {
    if(current) current->rethrow();
    else if(orphaned) {
        auto error = std::move(orphaned);
        std::rethrow_exception(error);
    }
}
void releaseAll(TJS::iTJSDispatch2* const* objects, std::size_t count) {
    CleanupErrors cleanup;
    std::exception_ptr primary;
    for(std::size_t i = 0; i < count; ++i) {
        try { if(objects[i]) objects[i]->Release(); }
        catch(...) { if(!primary) primary = std::current_exception(); }
    }
    if(primary) { cleanup.suppress(); std::rethrow_exception(primary); }
    cleanup.rethrow();
}
void releaseClosure(TJS::iTJSDispatch2* object, TJS::iTJSDispatch2* context) {
    TJS::iTJSDispatch2* pair[]{object, context};
    releaseAll(pair, 2);
}
}
