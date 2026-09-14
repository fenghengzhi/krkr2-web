#pragma once
#include <functional>
#include <vector>
#include "tjs.h"
#include "tjsNative.h"

namespace krkr {
// The adapter owns TJS types and execution; storage and persistence stay in TS.
using HostCall = std::function<void(const tjs_char*, std::vector<TJS::tTJSVariant>, TJS::tTJSVariant*)>;
TJS::tTJSNativeClass* createScriptsClass(TJS::tTJS* engine, HostCall host);
tjs_error getScriptTrace(TJS::tTJSVariant* result, tjs_int count,
    TJS::tTJSVariant** args, TJS::iTJSDispatch2* context);
}
