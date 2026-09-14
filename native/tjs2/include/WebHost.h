#pragma once
#include <cstdint>
extern "C" void krkr_vm_checkpoint();
extern "C" bool krkr_vm_is_shutting_down();
extern "C" int krkr_compiler_enter(int phase);
extern "C" void krkr_compiler_leave(int previous);
extern "C" void krkr_compiler_checkpoint();

// Scope is restored across nested compiler callbacks and exception unwinding.
// Phases: 1 = source preparation, 2 = parsing/code generation, 3 = export,
// 5 = binary input validation/deserialization (4 is the independent dump sink).
// 6 = bytecode pools, 7 = context materialization, 8 = ownership linking.
// 9 = runtime frame preparation, 10 = call argument preparation.
// 11 = collection cleanup (allocation diagnostics; no extra yielding checkpoint).
// 12 = host owner observation registration (allocation diagnostics only).
// 13 = weak owner upgrade to a strong handle (allocation diagnostics only).
// 14 = dependent lifetime registration (allocation diagnostics only).
class KrkrCompilerScope {
    int previous;
public:
    explicit KrkrCompilerScope(int phase) : previous(krkr_compiler_enter(phase)) {}
    ~KrkrCompilerScope() { krkr_compiler_leave(previous); }
    KrkrCompilerScope(const KrkrCompilerScope&) = delete;
    KrkrCompilerScope& operator=(const KrkrCompilerScope&) = delete;
};
inline void krkr_compiler_work(std::uintptr_t position) {
    if((position & 1023) == 0) krkr_compiler_checkpoint();
}
template<class T> inline void krkr_compiler_scan(const T* pointer) {
    krkr_compiler_work(reinterpret_cast<std::uintptr_t>(pointer) / sizeof(T));
}
