#include <emscripten.h>
#include <algorithm>
#include <cstring>
#include <malloc.h>
#include <map>
#include <set>
#include <memory>
#include <vector>
#include <string>
#include "tjs.h"
#include "tjsObject.h"
#include "tjsError.h"
#include "tjsDictionary.h"
#include "tjsArray.h"
#include "tjsNative.h"
#include "tjsDebug.h"
#include "tjsBinarySerializer.h"
#include "scripts.h"
#include "ExecutionBudget.h"

using namespace TJS;
#define API extern "C" EMSCRIPTEN_KEEPALIVE

namespace {
bool shuttingDown = false;
struct Reply {
    int kind = 0; // value, error, invoke, source, bytecode
    tTJSVariant value;
    std::vector<tTJSVariant> args;
    ttstr name;
    int line = 0;
    ttstr trace;
    tTJSVariant context;
    bool expression = false;
};

struct Vm {
    tTJS* engine = nullptr;
    std::unique_ptr<iTJSConsoleOutput> console;
    std::map<unsigned, tTJSVariant> handles;
    std::set<unsigned> released;
    unsigned nextHandle = 1;
    ~Vm() {
        // A stopped session must not start asynchronous host work while freeing
        // its memory. Explicit TJS invalidate still runs normally during execution.
        shuttingDown = true;
        if(engine) engine->SetConsoleOutput(nullptr);
        handles.clear();
        if(engine) { engine->Shutdown(); engine->Release(); }
        shuttingDown = false;
    }
    void flushReleased() {
        while(!released.empty()) {
            const auto id = *released.begin();
            released.erase(id);
            auto it = handles.find(id);
            if(it == handles.end()) continue;
            // Clear may run a throwing script finalizer. Do it outside the
            // container's noexcept destruction path and propagate through capture.
            try { it->second.Clear(); }
            catch(...) { handles.erase(it); throw; }
            handles.erase(it);
        }
    }
};

// All VM execution is serialized by the owning Worker. Nested TJS callbacks
// are invoked here, after the JS import returns, so no JS frame needs suspending.
EM_JS(int, cancellation_requested, (), {
    return Module['shouldCancel']() ? 1 : 0;
});
EM_ASYNC_JS(Reply*, dispatch_host_raw, (Vm* vm, const tjs_char* name, unsigned length, int count, tTJSVariant** args), {
    try { return await Module['hostCall'](vm, name, length, count, args); }
    catch(error) {
        if(Module['shouldCancel']()) return 0;
        throw error;
    }
});
Reply* dispatch_host(Vm* vm, const tjs_char* name, unsigned length, int count, tTJSVariant** args) {
    std::unique_ptr<Reply> reply(dispatch_host_raw(vm, name, length, count, args));
    krkr_vm_check_cancellation();
    return reply.release();
}
EM_ASYNC_JS(int, yield_host, (int phase), {
    await new Promise(resolve => setTimeout(resolve, 0));
    try { await Module['onYield'](phase); }
    catch(error) { if(!Module['shouldCancel']()) throw error; }
    return Module['shouldCancel']() ? 1 : 0;
});

unsigned instructionCount = 0;
double deadline = 0;
int compilerPhase = 0;

class MemoryStream : public tTJSBinaryStream {
public:
    std::vector<unsigned char> data;
    size_t position = 0;
    tjs_uint64 Seek(tjs_int64 offset, tjs_int whence) override {
        const auto base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? position : data.size();
        if(offset < 0 && static_cast<tjs_uint64>(-offset) > base) TJS_eTJSError(u"Invalid seek");
        position = base + offset;
        return position;
    }
    tjs_uint Read(void* buffer, tjs_uint size) override {
        size = static_cast<tjs_uint>(std::min<size_t>(size, data.size() - std::min(position, data.size())));
        if(size) std::memcpy(buffer, data.data() + position, size);
        position += size;
        return size;
    }
    tjs_uint Write(const void* buffer, tjs_uint size) override {
        if(position + size > 64 * 1024 * 1024) TJS_eTJSError(u"Bytecode exceeds 64 MiB limit");
        if(position + size > data.size()) data.resize(position + size);
        if(size) std::memcpy(data.data() + position, buffer, size);
        position += size;
        return size;
    }
    tjs_uint64 GetSize() override { return data.size(); }
    void SetEndOfStorage() override { data.resize(position); }
};

class DumpOutput final : public iTJSConsoleOutput {
public:
    std::basic_string<tjs_char> text{u"\ufeff"};
    void ExceptionPrint(const tjs_char* message) override { Print(message); }
    void Print(const tjs_char* message) override {
        const auto length = TJS_strlen(message);
        if(length > 8 * 1024 * 1024 - 2 || text.size() > 8 * 1024 * 1024 - 2 - length)
            TJS_eTJSError(u"Script dump exceeds 16 MiB");
        text.append(message, length);
        text.append(u"\r\n");
        if(emscripten_get_now() >= deadline) {
            if(yield_host(4)) throw krkr::ExecutionCancelled{};
            deadline = emscripten_get_now() + 8;
        }
    }
};
class ConsoleScope {
    tTJS* engine;
    iTJSConsoleOutput* previous;
public:
    ConsoleScope(tTJS* engine, iTJSConsoleOutput* output) : engine(engine), previous(engine->GetConsoleOutput()) { engine->SetConsoleOutput(output); }
    ~ConsoleScope() { engine->SetConsoleOutput(previous); }
};

void loadBinary(Vm* vm, const tjs_uint8* bytes, std::size_t length,
    tTJSVariant* result, iTJSDispatch2* context, const tjs_char* name) {
    if(length > 64u * 1024 * 1024) TJS_eTJSError(TJSReadError);
    if(length >= tTJSBinarySerializer::HEADER_LENGTH && tTJSBinarySerializer::IsBinary(bytes)) {
        tTJSBinarySerializer reader;
        std::unique_ptr<tTJSVariant> value(reader.Read(bytes + 8, length - 8));
        if(result) *result = *value;
    } else vm->engine->LoadByteCode(bytes, length, result, context, name);
}

void resolveReply(Vm* vm, Reply& reply, tTJSVariant* result) {
    if(reply.kind == 1) TJS_eTJSError(ttstr(reply.value));
    if(reply.kind == 2 || reply.kind == 7) {
        krkr::ExecutionFrame delegation(2);
        if(reply.args.size() > 1000000) throw krkr::ExecutionLimitError(u"VM call exceeds 1000000 arguments");
        krkr::TemporaryMemory memory;
        memory.reserve(reply.args.size(), sizeof(tTJSVariant*));
        auto closure = reply.value.AsObjectClosureNoAddRef();
        std::vector<tTJSVariant*> args;
        args.reserve(reply.args.size());
        for(auto& arg : reply.args) args.push_back(&arg);
        auto status = closure.FuncCall(0, nullptr, nullptr, reply.kind == 7 ? nullptr : result,
            args.size(), args.data(), nullptr);
        if(reply.kind == 7) { if(result) *result = static_cast<tjs_int>(status); }
        else if(TJS_FAILED(status)) TJSThrowFrom_tjs_error(status, nullptr);
    } else if(reply.kind == 3) {
        krkr::ExecutionFrame delegation(2);
        auto context = reply.context.Type() == tvtObject ? reply.context.AsObjectNoAddRef() : nullptr;
        if(reply.expression) vm->engine->EvalExpression(ttstr(reply.value), result, context, &reply.name, reply.line);
        else vm->engine->ExecScript(ttstr(reply.value), result, context, &reply.name, reply.line);
    } else if(reply.kind == 4) {
        krkr::ExecutionFrame delegation(2);
        auto* bytes = reply.value.AsOctetNoAddRef();
        loadBinary(vm, bytes ? bytes->GetData() : nullptr, bytes ? bytes->GetLength() : 0, result,
            reply.context.Type() == tvtObject ? reply.context.AsObjectNoAddRef() : nullptr, reply.name.c_str());
    } else if(reply.kind == 8) {
        // The original dump uses its own file sink, not log observers. Collect
        // under a scoped sink so no callback mutates ScriptBlocks mid-iteration.
        DumpOutput output;
        { ConsoleScope scope(vm->engine, &output); vm->engine->Dump(); }
        if(result) *result = tTJSVariant(reinterpret_cast<const tjs_uint8*>(output.text.data()), output.text.size() * sizeof(tjs_char));
    } else if(result) *result = reply.value;
}

class HostConsole final : public iTJSConsoleOutput {
    Vm* vm;
public:
    explicit HostConsole(Vm* vm) : vm(vm) {}
    void ExceptionPrint(const tjs_char* message) override { Print(message); }
    void Print(const tjs_char* message) override {
        if(shuttingDown) return;
        tTJSVariant value(message);
        tTJSVariant* args[] = {&value};
        const ttstr operation(u"Runtime.console");
        std::unique_ptr<Reply> reply(dispatch_host(vm, operation.c_str(), operation.GetLen(), 1, args));
        if(!reply) TJS_eTJSError(u"Console returned no response");
        vm->flushReleased();
        resolveReply(vm, *reply, nullptr);
    }
};

Vm* streamVm = nullptr; // A module is owned by one session/VM.
std::unique_ptr<Reply> requestStorage(const tjs_char* operation, const ttstr& name, const ttstr& mode) {
    tTJSVariant values[] = { tTJSVariant(name), tTJSVariant(mode) };
    tTJSVariant* args[] = { &values[0], &values[1] };
    std::unique_ptr<Reply> reply(dispatch_host(streamVm, operation, TJS_strlen(operation), 2, args));
    if(!reply) TJS_eTJSError(u"No storage response");
    if(reply->kind == 1) TJS_eTJSError(ttstr(reply->value));
    return reply;
}
// Closing a native binary stream is a C++ destructor and cannot await or throw.
// Copy into the JS write queue before freeing native memory. That queue is
// applied before the next host operation and flushed before execute resolves.
EM_JS(void, queue_storage_write, (const tjs_char* name, unsigned nameLength, const tjs_char* mode, unsigned modeLength, const void* data, unsigned length, int text), {
    Module['queueWrite'](name, nameLength, mode, modeLength, data, length, text);
});
class HostTextRead final : public iTJSTextReadStream {
    ttstr content;
    unsigned position = 0;
public:
    explicit HostTextRead(const ttstr& name, const ttstr& mode) : content(requestStorage(u"Storage.readText", name, mode)->value) {}
    tjs_uint Read(ttstr& target, tjs_uint size) override {
        const auto count = std::min<unsigned>(size ? size : content.GetLen(), content.GetLen() - position);
        target = ttstr(content.c_str() + position, count);
        position += count;
        return count;
    }
    void Destruct() override { delete this; }
};
class HostTextWrite final : public iTJSTextWriteStream {
    ttstr name, mode, content;
public:
    HostTextWrite(const ttstr& name, const ttstr& mode) : name(name), mode(mode) {}
    void Write(const ttstr& value) override { content += value; }
    void Destruct() override {
        queue_storage_write(name.c_str(), name.GetLen(), mode.c_str(), mode.GetLen(), content.c_str(), content.GetLen() * 2, 1);
        delete this;
    }
};
class HostBinaryWrite final : public MemoryStream {
    ttstr name, mode;
public:
    HostBinaryWrite(const ttstr& name, const ttstr& mode) : name(name), mode(mode) {}
    ~HostBinaryWrite() override { queue_storage_write(name.c_str(), name.GetLen(), mode.c_str(), mode.GetLen(), data.data(), data.size(), 0); }
};
iTJSTextReadStream* createTextRead(const ttstr& name, const ttstr& mode) { return new HostTextRead(name, mode); }
iTJSTextWriteStream* createTextWrite(const ttstr& name, const ttstr& mode) {
    requestStorage(u"Storage.validateWrite", name, mode);
    return new HostTextWrite(name, mode);
}
tTJSBinaryStream* createBinaryRead(const ttstr& name, const ttstr& mode) {
    auto result = requestStorage(u"Storage.readBinary", name, mode);
    auto bytes = result->value.AsOctetNoAddRef();
    auto stream = std::make_unique<MemoryStream>();
    if(bytes && bytes->GetLength()) stream->data.assign(bytes->GetData(), bytes->GetData() + bytes->GetLength());
    return stream.release();
}
tTJSBinaryStream* createBinaryWrite(const ttstr& name, const ttstr& mode) {
    // Destruction queues bytes without throwing; reject invalid targets while
    // still on the caller's suspendable, exception-capable script stack.
    requestStorage(u"Storage.validateWrite", name, mode);
    return new HostBinaryWrite(name, mode);
}

class HostFunction final : public tTJSDispatch {
    Vm* vm;
public:
    explicit HostFunction(Vm* vm) : vm(vm) {}
    tjs_error FuncCall(tjs_uint32, const tjs_char* member, tjs_uint32*, tTJSVariant* result,
                      tjs_int count, tTJSVariant** args, iTJSDispatch2*) override {
        if(member) return TJS_E_MEMBERNOTFOUND;
        if(shuttingDown) return TJS_E_INVALIDOBJECT;
        if(count < 1) return TJS_E_BADPARAMCOUNT;
        ttstr name(*args[0]);
        std::unique_ptr<Reply> reply(dispatch_host(vm, name.c_str(), name.GetLen(), count - 1, args + 1));
        if(!reply) TJS_eTJSError(u"Host returned no response");
        vm->flushReleased();
        resolveReply(vm, *reply, result);
        return TJS_S_OK;
    }
};

// A narrow native dispatch object for indexed host properties (e.g. WaveFlags).
// Property reads/writes execute on the same suspendable native stack as __host.
class HostProxy final : public tTJSDispatch {
    Vm* vm;
    ttstr prefix, className;
    tjs_int id;
    bool valid = true;
    tjs_error dispatch(const tjs_char* operation, const tjs_char* member, tTJSVariant* result, tjs_int count, tTJSVariant** params) {
        if(!valid || shuttingDown) return TJS_E_INVALIDOBJECT;
        // A dispatch object is not a default property. TJSDefaultPropGet must
        // return this object itself when it probes a stored proxy with null.
        if(!member) return TJS_E_INVALIDTYPE;
        ttstr name = prefix + operation;
        tTJSVariant identifier(id), key(member);
        std::vector<tTJSVariant*> args{&identifier, &key};
        for(int i=0;i<count;i++) args.push_back(params[i]);
        std::unique_ptr<Reply> reply(dispatch_host(vm, name.c_str(), name.GetLen(), args.size(), args.data()));
        if(!reply) TJS_eTJSError(u"Host proxy returned no response");
        vm->flushReleased();
        resolveReply(vm, *reply, result);
        return TJS_S_OK;
    }
public:
    HostProxy(Vm* vm, const tjs_char* prefix, int id, const tjs_char* className) : vm(vm),prefix(prefix),className(className),id(id) {}
    tjs_error PropGet(tjs_uint32, const tjs_char* member, tjs_uint32*, tTJSVariant* result, iTJSDispatch2*) override { return dispatch(u".get",member,result,0,nullptr); }
    tjs_error PropSet(tjs_uint32, const tjs_char* member, tjs_uint32*, const tTJSVariant* value, iTJSDispatch2*) override { auto p=const_cast<tTJSVariant*>(value);return dispatch(u".set",member,nullptr,1,&p); }
    tjs_error FuncCall(tjs_uint32, const tjs_char* member, tjs_uint32*, tTJSVariant* result, tjs_int count, tTJSVariant** args, iTJSDispatch2*) override { return dispatch(u".call",member,result,count,args); }
    tjs_error Invalidate(tjs_uint32, const tjs_char* member, tjs_uint32*, iTJSDispatch2*) override { if(member)return TJS_E_MEMBERNOTFOUND;valid=false;return TJS_S_TRUE; }
    tjs_error IsValid(tjs_uint32, const tjs_char* member, tjs_uint32*, iTJSDispatch2*) override { if(member)return TJS_E_MEMBERNOTFOUND;return valid?TJS_S_TRUE:TJS_S_FALSE; }
    tjs_error IsInstanceOf(tjs_uint32, const tjs_char*, tjs_uint32*, const tjs_char* name, iTJSDispatch2*) override { return className==ttstr(name)||ttstr(name)==u"Object"?TJS_S_TRUE:TJS_S_FALSE; }
};

// Class identity/construction and static-member copying are owned by TJS.
// Only the property operation crosses into the TypeScript engine.
class HostClass final : public tTJSNativeClass {
    static tjs_error noOp(tTJSVariant*, tjs_int, tTJSVariant**, iTJSDispatch2*) { return TJS_S_OK; }
public:
    explicit HostClass(const tjs_char* name) : tTJSNativeClass(name) {
        SetClassID(TJSRegisterNativeClass(name));
        RegisterNCM(name, TJSCreateNativeClassConstructor(noOp), name, nitMethod);
        RegisterNCM(u"finalize", TJSCreateNativeClassMethod(noOp), name, nitMethod);
    }
};
class HostProperty final : public tTJSDispatch {
    Vm* vm;
    ttstr prefix, member;
    int id, options;
    tjs_error dispatch(const tjs_char* suffix, tTJSVariant* result, const tTJSVariant* input) {
        if(shuttingDown) return TJS_E_INVALIDOBJECT;
        const ttstr operation = prefix + suffix;
        tTJSVariant identifier(id), key(member), converted;
        std::vector<tTJSVariant*> args{&identifier, &key};
        if(input) {
            converted = options & 4 ? tTJSVariant(static_cast<tjs_int>(input->operator bool())) : *input;
            args.push_back(&converted);
        }
        std::unique_ptr<Reply> reply(dispatch_host(vm, operation.c_str(), operation.GetLen(), args.size(), args.data()));
        if(!reply) TJS_eTJSError(u"Host property returned no response");
        vm->flushReleased();
        resolveReply(vm, *reply, result);
        return TJS_S_OK;
    }
public:
    HostProperty(Vm* vm, const tjs_char* prefix, int id, const tjs_char* member, int options)
        : vm(vm), prefix(prefix), member(member), id(id), options(options) {}
    tjs_error PropGet(tjs_uint32 flag, const tjs_char* name, tjs_uint32* hint, tTJSVariant* result, iTJSDispatch2* context) override {
        if(name) return tTJSDispatch::PropGet(flag, name, hint, result, context);
        if(!context) return TJS_E_NATIVECLASSCRASH;
        if(!result) return TJS_E_FAIL;
        return dispatch(u".get", result, nullptr);
    }
    tjs_error PropSet(tjs_uint32 flag, const tjs_char* name, tjs_uint32* hint, const tTJSVariant* input, iTJSDispatch2* context) override {
        if(name) return tTJSDispatch::PropSet(flag, name, hint, input, context);
        if(!context) return TJS_E_NATIVECLASSCRASH;
        if(!input) return TJS_E_FAIL;
        if(!(options & 1)) return TJS_E_ACCESSDENYED;
        return dispatch(u".set", nullptr, input);
    }
    tjs_error IsInstanceOf(tjs_uint32 flag, const tjs_char* name, tjs_uint32* hint, const tjs_char* type, iTJSDispatch2* context) override {
        if(!name && ttstr(type) == u"Property") return TJS_S_TRUE;
        return tTJSDispatch::IsInstanceOf(flag, name, hint, type, context);
    }
};

template<typename Fn> Reply* capture(Fn fn) {
    auto reply = std::make_unique<Reply>();
    try { fn(reply->value); }
    catch(const krkr::ExecutionCancelled&) {
        reply->kind = 1;
        reply->value = u"Execution cancelled";
    } catch(const eTJSScriptError& error) {
        reply->kind = 1;
        reply->value = error.GetMessage();
        reply->name = error.GetBlockName() ? error.GetBlockName() : u"";
        reply->line = error.GetSourceLine() + 1;
        reply->trace = error.GetTrace();
    } catch(const eTJS& error) {
        reply->kind = 1;
        reply->value = error.GetMessage();
    } catch(const std::exception& error) {
        reply->kind = 1;
        reply->value = ttstr(error.what());
    }
    return reply.release();
}
}

extern "C" void krkr_vm_check_cancellation() {
    if(!shuttingDown && cancellation_requested()) throw krkr::ExecutionCancelled{};
}
extern "C" void krkr_vm_checkpoint() {
    if((++instructionCount & 2047) != 0) return;
    if(shuttingDown) return;
    if(emscripten_get_now() < deadline) return;
    if(yield_host(0)) throw krkr::ExecutionCancelled{};
    deadline = emscripten_get_now() + 8;
}

extern "C" int krkr_compiler_enter(int phase) {
    const int previous = compilerPhase;
    compilerPhase = phase;
    return previous;
}
extern "C" void krkr_compiler_leave(int previous) { compilerPhase = previous; }
extern "C" int krkr_diagnostic_phase() { return compilerPhase; }
API unsigned krkr_native_string_cells() { return TJSGetStringHeapAllocationCount(); }
API unsigned krkr_native_heap_usage() { return mallinfo().uordblks; }
API unsigned krkr_vm_script_blocks(Vm* vm) { return vm->engine->GetScriptBlockCount(); }
API unsigned krkr_vm_script_contexts(Vm* vm) { return vm->engine->GetScriptContextCount(); }
extern "C" void krkr_compiler_checkpoint() {
    if(!compilerPhase || shuttingDown || emscripten_get_now() < deadline) return;
    if(yield_host(compilerPhase)) throw krkr::ExecutionCancelled{};
    deadline = emscripten_get_now() + 8;
}

API Vm* krkr_create(int debugMode) {
    auto vm = std::make_unique<Vm>();
    // Each module owns exactly one VM. Set immutable creation options before
    // tTJS acquires its balanced debug object map and stack tracer references.
    TJSEnableDebugMode = debugMode != 0;
    TJSWarnOnExecutionOnDeletingObject = TJSEnableDebugMode;
    vm->engine = new tTJS();
    vm->console = std::make_unique<HostConsole>(vm.get());
    streamVm = vm.get();
    TJSCreateTextStreamForRead = createTextRead;
    TJSCreateTextStreamForWrite = createTextWrite;
    TJSCreateBinaryStreamForRead = createBinaryRead;
    TJSCreateBinaryStreamForWrite = createBinaryWrite;
    auto host = new HostFunction(vm.get());
    tTJSVariant value(host);
    host->Release();
    auto global = vm->engine->GetGlobalNoAddRef();
    global->PropSet(TJS_MEMBERENSURE, u"__host", nullptr, &value, global);
    return vm.release();
}
extern "C" bool krkr_vm_is_shutting_down() { return shuttingDown; }
API void krkr_destroy(Vm* vm) { delete vm; }
API void krkr_set_console(Vm* vm, int enabled) { vm->engine->SetConsoleOutput(enabled ? vm->console.get() : nullptr); }
API int krkr_abi_version() { return 5; }
API Reply* krkr_execute(Vm* vm, const void* source, unsigned length, const tjs_char* name, int mode) {
    deadline = emscripten_get_now() + 8;
    return capture([&](tTJSVariant& value) {
        vm->flushReleased();
        if(mode == 2) loadBinary(vm, static_cast<const tjs_uint8*>(source), length, &value, nullptr, name);
        else if(mode == 1) vm->engine->EvalExpression(static_cast<const tjs_char*>(source), &value, nullptr, name);
        else vm->engine->ExecScript(static_cast<const tjs_char*>(source), &value, nullptr, name);
    });
}
API Reply* krkr_compile(Vm* vm, const tjs_char* source, const tjs_char* name, int expression) {
    deadline = emscripten_get_now() + 8;
    return capture([&](tTJSVariant& value) {
        vm->flushReleased();
        MemoryStream stream;
        vm->engine->CompileScript(source, &stream, true, true, expression != 0, name);
        value = tTJSVariant(stream.data.data(), stream.data.size());
    });
}
API Reply* krkr_invoke(Vm* vm, unsigned handle, Reply* arguments) {
    deadline = emscripten_get_now() + 8;
    return capture([&](tTJSVariant& value) {
        vm->flushReleased();
        auto it = vm->handles.find(handle);
        if(it == vm->handles.end()) TJS_eTJSError(u"Invalid object handle");
        Reply call; call.kind = 2; call.value = it->second;
        if(arguments) call.args = arguments->args;
        resolveReply(vm, call, &value);
    });
}
API Reply* krkr_reply_new(int kind) { auto r = new Reply(); r->kind = kind; return r; }
API void krkr_reply_delete(Reply* r) { delete r; }
API int krkr_reply_kind(Reply* r) { return r->kind; }
API tTJSVariant* krkr_reply_value(Reply* r) { return &r->value; }
API tTJSVariant* krkr_reply_arg(Reply* r) { r->args.emplace_back(); return &r->args.back(); }
API void krkr_reply_name(Reply* r, const tjs_char* name) { r->name = name; }
API tTJSVariant* krkr_reply_context(Reply* r) { return &r->context; }
API void krkr_reply_script_options(Reply* r, int expression, int line) { r->expression = expression != 0; r->line = line; }
API const tjs_char* krkr_reply_source(Reply* r) { return r->name.c_str(); }
API int krkr_reply_line(Reply* r) { return r->line; }
API const tjs_char* krkr_reply_trace(Reply* r) { return r->trace.c_str(); }
API int krkr_value_type(tTJSVariant* v) { return v->Type(); }
API tjs_int64 krkr_value_integer(tTJSVariant* v) { return v->AsInteger(); }
API double krkr_value_real(tTJSVariant* v) { return v->AsReal(); }
API const void* krkr_value_data(tTJSVariant* v) {
    if(v->Type() == tvtString) { auto s = v->AsStringNoAddRef(); return s ? s->operator const tjs_char*() : u""; }
    auto bytes = v->AsOctetNoAddRef(); return bytes ? bytes->GetData() : nullptr;
}
API unsigned krkr_value_length(tTJSVariant* v) {
    if(v->Type() == tvtString) { auto s = v->AsStringNoAddRef(); return s ? s->GetLength() : 0; }
    auto bytes = v->AsOctetNoAddRef(); return bytes ? bytes->GetLength() : 0;
}
API int krkr_value_is_null(tTJSVariant* v) { return v->Type() == tvtObject && !v->AsObjectNoAddRef(); }
API void krkr_value_set_integer(tTJSVariant* v, tjs_int64 n) { *v = n; }
API void krkr_value_set_real(tTJSVariant* v, double n) { *v = n; }
API void krkr_value_set_text(tTJSVariant* v, const tjs_char* text, unsigned length) { *v = ttstr(text, length); }
API void krkr_value_set_bytes(tTJSVariant* v, const tjs_uint8* bytes, unsigned length) { *v = tTJSVariant(bytes, length); }
API void krkr_value_set_null(tTJSVariant* v) { *v = tTJSVariant(static_cast<iTJSDispatch2*>(nullptr)); }
API void krkr_value_set_trace_function(tTJSVariant* value) {
    auto method = TJSCreateNativeClassMethod(krkr::getScriptTrace);
    *value = tTJSVariant(method);
    method->Release();
}
API void krkr_value_set_scripts_class(Vm* vm, tTJSVariant* value) {
    auto object = krkr::createScriptsClass(vm->engine,
        [vm](const tjs_char* operation, std::vector<tTJSVariant> values, tTJSVariant* result) {
            if(shuttingDown) TJS_eTJSError(u"Runtime is shutting down");
            std::vector<tTJSVariant*> args;
            for(auto& arg : values) args.push_back(&arg);
            std::unique_ptr<Reply> reply(dispatch_host(vm, operation, TJS_strlen(operation), args.size(), args.data()));
            if(!reply) TJS_eTJSError(u"Scripts host returned no response");
            vm->flushReleased();
            resolveReply(vm, *reply, result);
        });
    *value = tTJSVariant(object);
    object->Release();
}
API void krkr_value_set_proxy(Vm* vm, tTJSVariant* value, const tjs_char* prefix, int id, const tjs_char* className) {
    auto proxy=new HostProxy(vm,prefix,id,className);
    *value=tTJSVariant(proxy,proxy);proxy->Release();
}
API void krkr_value_set_class(Vm*, tTJSVariant* value, const tjs_char*, int, const tjs_char* className) {
    auto object = new HostClass(className);
    *value = tTJSVariant(object, object);
    object->Release();
}
// Called only while assembling a fresh native-class reply, before publishing it.
API void krkr_class_property(Vm* vm, tTJSVariant* value, const tjs_char* prefix, int id, const tjs_char* member, int options) {
    auto object = static_cast<HostClass*>(value->AsObjectNoAddRef());
    object->RegisterNCM(member, new HostProperty(vm, prefix, id, member, options),
        object->GetClassName().c_str(), nitProperty, options & 2 ? TJS_STATICMEMBER : 0);
}
API void krkr_value_set_container(tTJSVariant* value, int array) {
    auto object = array ? TJSCreateArrayObject() : TJSCreateDictionaryObject();
    *value = tTJSVariant(object, object);
    object->Release();
}
// Only called on newly allocated containers owned by a reply under construction.
// IGNOREPROP keeps data fields from dispatching a script property while suspended.
API void krkr_data_put(tTJSVariant* value, const tjs_char* key, int index, tTJSVariant* member) {
    auto object = value->AsObjectNoAddRef();
    if(key) object->PropSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, key, nullptr, member, object);
    else object->PropSetByNum(TJS_MEMBERENSURE | TJS_IGNOREPROP, index, member, object);
}
struct DataEnumerator final : tTJSDispatch {
    Reply* reply;
    explicit DataEnumerator(Reply* reply) : reply(reply) {}
    tjs_error FuncCall(tjs_uint32, const tjs_char*, tjs_uint32*, tTJSVariant* result,
                      tjs_int count, tTJSVariant** args, iTJSDispatch2*) override {
        if(count == 3 && !(args[1]->AsInteger() & TJS_HIDDENMEMBER)) {
            if(reply->args.size() >= 200000) TJS_eTJSError(u"Data snapshot exceeds member budget");
            reply->args.push_back(*args[0]);
            reply->args.push_back(*args[2]);
        }
        if(result) *result = (tjs_int)1;
        return TJS_S_OK;
    }
};
API Reply* krkr_data_entries(Vm* vm, unsigned handle) {
    auto reply = std::make_unique<Reply>();
    try {
        auto found = vm->handles.find(handle);
        if(vm->released.count(handle) || found == vm->handles.end()) TJS_eTJSError(u"Released object handle");
        auto object = found->second.AsObjectNoAddRef();
        tTJSArrayNI* array = nullptr;
        if(dynamic_cast<tTJSArrayObject*>(object) && TJS_SUCCEEDED(object->NativeInstanceSupport(
            TJS_NIS_GETINSTANCE, TJSGetArrayClassID(), (iTJSNativeInstance**)&array))) {
            if(array->Items.size() > 100000) TJS_eTJSError(u"Data snapshot exceeds member budget");
            reply->kind = 6;
            reply->args.assign(array->Items.begin(), array->Items.end());
        } else if(auto dictionary = dynamic_cast<tTJSDictionaryObject*>(object)) {
            reply->kind = 5;
            DataEnumerator callback(reply.get());
            tTJSVariantClosure closure(&callback, nullptr);
            dictionary->tTJSCustomObject::EnumMembers(TJS_IGNOREPROP, &closure, dictionary);
        } else TJS_eTJSError(u"Data snapshot requires an Array or Dictionary without script properties");
    } catch(const eTJS& error) { reply->kind = 1; reply->value = error.GetMessage(); }
    return reply.release();
}
API unsigned krkr_data_identity(Vm* vm, unsigned handle) {
    auto found = vm->handles.find(handle);
    return found == vm->handles.end() ? 0 : (unsigned)(uintptr_t)found->second.AsObjectNoAddRef();
}
// Read the exact TJS closure pair without invoking script or retaining a new
// handle. The caller must retain the closure while using this identity as a key.
API uint64_t krkr_closure_identity(Vm* vm, unsigned handle) {
    static_assert(sizeof(void*) == 4, "Closure identity uses WASM32 addresses");
    auto found = vm->handles.find(handle);
    if(vm->released.count(handle) || found == vm->handles.end()) return 0;
    const auto closure = found->second.AsObjectClosureNoAddRef();
    return (static_cast<uint64_t>(reinterpret_cast<uintptr_t>(closure.Object)) << 32) |
        static_cast<uint64_t>(reinterpret_cast<uintptr_t>(closure.ObjThis));
}
API unsigned krkr_reply_arg_count(Reply* reply) { return reply->args.size(); }
API tTJSVariant* krkr_reply_arg_at(Reply* reply, unsigned index) { return &reply->args.at(index); }
API unsigned krkr_value_pin(Vm* vm, tTJSVariant* value) {
    const auto id = vm->nextHandle++;
    vm->handles.emplace(id, *value);
    return id;
}
API unsigned krkr_handle_retain(Vm* vm, unsigned id) {
    if(vm->released.count(id)) return 0;
    auto it = vm->handles.find(id); if(it == vm->handles.end()) return 0;
    return krkr_value_pin(vm, &it->second);
}
// Finalizers can call async host functions. Reclaim on the next native execution
// boundary (or after a host import returns), never inside a synchronous JS setter.
API void krkr_handle_release(Vm* vm, unsigned id) { if(vm->handles.count(id)) vm->released.insert(id); }
API int krkr_value_set_handle(Vm* vm, tTJSVariant* v, unsigned id) {
    if(vm->released.count(id)) return 0;
    auto it = vm->handles.find(id); if(it == vm->handles.end()) return 0;
    *v = it->second; return 1;
}
API unsigned krkr_handle_count(Vm* vm) { return vm->handles.size() - vm->released.size(); }
