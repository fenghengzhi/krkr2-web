#include "scripts.h"
#include <memory>
#include <utility>
#include "tjsArray.h"
#include "tjsDebug.h"
#include "tjsError.h"

using namespace TJS;
namespace krkr {
tjs_error getScriptTrace(tTJSVariant* result, tjs_int count, tTJSVariant** args, iTJSDispatch2*) {
    tjs_int limit = 0;
    if(count >= 1 && args[0]->Type() != tvtVoid) limit = *args[0];
    if(result) *result = TJSGetStackTraceString(limit);
    return TJS_S_OK;
}
namespace {
struct Services {
    tTJS* engine;
    HostCall host;
};
enum class Method { Exec, Eval, ExecStorage, EvalStorage, CompileStorage, Dump, Trace, SetCallMissing, GetClassNames };
bool present(tjs_int count, tTJSVariant** args, tjs_int index) {
    return count > index && args[index]->Type() != tvtVoid;
}
tjs_error noOp(tTJSVariant*, tjs_int, tTJSVariant**, iTJSDispatch2*) { return TJS_S_OK; }

class ScriptMethod final : public tTJSNativeClassMethod {
    std::shared_ptr<Services> services;
    Method method;
public:
    ScriptMethod(std::shared_ptr<Services> services, Method method)
        : tTJSNativeClassMethod(noOp), services(std::move(services)), method(method) {}
    tjs_error FuncCall(tjs_uint32 flag, const tjs_char* member, tjs_uint32* hint,
        tTJSVariant* result, tjs_int count, tTJSVariant** args, iTJSDispatch2* context) override {
        if(member) return tTJSNativeClassMethod::FuncCall(flag, member, hint, result, count, args, context);
        if(!context) return TJS_E_NATIVECLASSCRASH;
        if(result) result->Clear();
        if(method == Method::Trace) return getScriptTrace(result, count, args, context);
        if(method == Method::Dump) {
            tTJSVariant bytes;
            services->host(u"Scripts.dump", {}, &bytes);
            services->host(u"Scripts.writeDump", {bytes}, nullptr);
            return TJS_S_OK;
        }
        if(count < (method == Method::CompileStorage ? 2 : 1)) return TJS_E_BADPARAMCOUNT;
        if(method == Method::Exec || method == Method::Eval) {
            const ttstr source(*args[0]);
            const ttstr name = present(count, args, 1) ? ttstr(*args[1]) : ttstr();
            const tjs_int line = present(count, args, 2) ? static_cast<tjs_int>(*args[2]) : 0;
            auto target = present(count, args, 3) ? args[3]->AsObjectNoAddRef() : nullptr;
            if(method == Method::Exec) services->engine->ExecScript(source, result, target, &name, line);
            else services->engine->EvalExpression(source, result, target, &name, line);
            return TJS_S_OK;
        }
        if(method == Method::ExecStorage || method == Method::EvalStorage) {
            const ttstr name(*args[0]);
            const ttstr mode = present(count, args, 1) ? ttstr(*args[1]) : ttstr();
            auto target = present(count, args, 2) ? args[2]->AsObjectNoAddRef() : nullptr;
            services->host(u"Scripts.execStorage", {tTJSVariant(name), tTJSVariant(mode),
                tTJSVariant(target), tTJSVariant(static_cast<tjs_int>(method == Method::EvalStorage))}, result);
            return TJS_S_OK;
        }
        if(method == Method::CompileStorage) {
            const ttstr name(*args[0]), output(*args[1]);
            const bool requestResult = count >= 3 && static_cast<tjs_int>(*args[2]);
            const bool outputDebug = count >= 4 && static_cast<tjs_int>(*args[3]);
            const bool expression = count >= 5 && static_cast<tjs_int>(*args[4]);
            tTJSVariant source;
            services->host(u"Scripts.readCompile", {tTJSVariant(name)}, &source);
            // Match native stream lifetime: read errors preserve the old output;
            // once opened, failure still closes/publishes the empty/partial stream.
            std::unique_ptr<tTJSBinaryStream> stream(TJSCreateBinaryStreamForWrite(output, ttstr()));
            services->engine->CompileScript(ttstr(source).c_str(), stream.get(), requestResult,
                outputDebug, expression, name.c_str(), 0);
            return TJS_S_OK;
        }
        auto object = args[0]->AsObjectNoAddRef();
        if(method == Method::SetCallMissing) {
            if(object) {
                tTJSVariant name(u"missing");
                object->ClassInstanceInfo(TJS_CII_SET_MISSING, 0, &name);
            }
            return TJS_S_OK;
        }
        if(!object) return TJS_E_FAIL;
        auto array = TJSCreateArrayObject();
        tTJSVariant value(array, array);
        array->Release();
        for(tjs_uint index = 0;; index++) {
            tTJSVariant name;
            if(TJS_FAILED(object->ClassInstanceInfo(TJS_CII_GET, index, &name))) break;
            array->PropSetByNum(TJS_MEMBERENSURE, index, &name, array);
        }
        if(result) *result = value;
        return TJS_S_OK;
    }
};

class TextEncoding final : public tTJSDispatch {
    std::shared_ptr<Services> services;
public:
    explicit TextEncoding(std::shared_ptr<Services> services) : services(std::move(services)) {}
    tjs_error PropGet(tjs_uint32 flag, const tjs_char* member, tjs_uint32* hint,
        tTJSVariant* result, iTJSDispatch2* context) override {
        if(member) return tTJSDispatch::PropGet(flag, member, hint, result, context);
        if(!context) return TJS_E_NATIVECLASSCRASH;
        if(!result) return TJS_E_FAIL;
        services->host(u"Scripts.textEncoding.get", {}, result);
        return TJS_S_OK;
    }
    tjs_error PropSet(tjs_uint32 flag, const tjs_char* member, tjs_uint32* hint,
        const tTJSVariant* value, iTJSDispatch2* context) override {
        if(member) return tTJSDispatch::PropSet(flag, member, hint, value, context);
        if(!context) return TJS_E_NATIVECLASSCRASH;
        if(!value) return TJS_E_FAIL;
        services->host(u"Scripts.textEncoding.set", {tTJSVariant(ttstr(*value))}, nullptr);
        return TJS_S_OK;
    }
    tjs_error IsInstanceOf(tjs_uint32 flag, const tjs_char* member, tjs_uint32* hint,
        const tjs_char* name, iTJSDispatch2* context) override {
        if(!member && ttstr(name) == u"Property") return TJS_S_TRUE;
        return tTJSDispatch::IsInstanceOf(flag, member, hint, name, context);
    }
};

class Scripts final : public tTJSNativeClass {
    iTJSNativeInstance* CreateNativeInstance() override {
        TJS_eTJSError(u"Cannot create an instance of Scripts");
        return nullptr;
    }
public:
    explicit Scripts(std::shared_ptr<Services> services) : tTJSNativeClass(u"Scripts") {
        SetClassID(TJSRegisterNativeClass(u"Scripts"));
        RegisterNCM(u"Scripts", TJSCreateNativeClassConstructor(noOp), u"Scripts", nitMethod);
        RegisterNCM(u"finalize", TJSCreateNativeClassMethod(noOp), u"Scripts", nitMethod);
        const std::pair<const tjs_char*, Method> methods[] = {
            {u"exec", Method::Exec}, {u"eval", Method::Eval},
            {u"execStorage", Method::ExecStorage}, {u"evalStorage", Method::EvalStorage},
            {u"compileStorage", Method::CompileStorage}, {u"dump", Method::Dump},
            {u"getTraceString", Method::Trace}, {u"setCallMissing", Method::SetCallMissing},
            {u"getClassNames", Method::GetClassNames},
        };
        for(const auto& [name, method] : methods)
            RegisterNCM(name, new ScriptMethod(services, method), u"Scripts", nitMethod, TJS_STATICMEMBER);
        RegisterNCM(u"textEncoding", new TextEncoding(services), u"Scripts", nitProperty, TJS_STATICMEMBER);
    }
};
}
tTJSNativeClass* createScriptsClass(tTJS* engine, HostCall host) {
    return new Scripts(std::make_shared<Services>(Services{engine, std::move(host)}));
}
}
