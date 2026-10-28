// A compile-only check of the actual generated catalog. It needs neither
// Emscripten nor the rest of the engine and runs in the early hosted gate.
#include "tjsTypes.h"
#include <cstddef>
#include <string_view>

struct Entry {
    const tjs_char* id;
    const tjs_char* value;
    bool assignable;
};

constexpr Entry catalog[] = {
#define TVP_MESSAGE(name, assignable, value) { TJS_W(#name), value, assignable },
#include "TvpMessages.generated.inc"
#undef TVP_MESSAGE
};

constexpr std::size_t count(bool assignable) {
    std::size_t result = 0;
    for(const auto& entry : catalog) if(entry.assignable == assignable) ++result;
    return result;
}
constexpr const Entry* find(std::u16string_view id) {
    for(const auto& entry : catalog) if(id == entry.id) return &entry;
    return nullptr;
}

static_assert(sizeof(catalog) / sizeof(catalog[0]) == 144);
static_assert(count(true) == 138);
static_assert(count(false) == 6);
static_assert(find(u"TVPInvalidParam") != nullptr);
static_assert(std::u16string_view(find(u"TVPInvalidParam")->value) == u"不正なパラメータです");
static_assert(std::u16string_view(find(u"TVPCannotOpenStorage")->value) == u"ストレージ %1 を開くことができません");
static_assert(!find(u"TVPAboutString")->assignable);
static_assert(std::u16string_view(find(u"TVPAboutString")->value).find(u"Compiled on ") != std::u16string_view::npos);
static_assert(std::u16string_view(find(u"TVPAboutString")->value).ends_with(u"環境情報\n"));
static_assert(std::u16string_view(find(u"TVPExecutionFail")->value) == u"%1 を実行できません");
