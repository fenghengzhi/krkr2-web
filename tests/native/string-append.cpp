// Hosted-only regression of the shipped inline Append implementation. This
// allocator always relocates long buffers and can fail one allocation; no test
// hooks or alternate string implementation are linked into the release kernel.
#include "tjsVariantString.h"
#include <cassert>
#include <iostream>
#include <map>
#include <new>
#include <string>

namespace {
bool failNext = false;
std::map<tjs_char*, std::size_t> allocations;
}

namespace TJS {
void TJSThrowStringAllocError() { throw std::bad_alloc(); }
size_t TJS_strlen(const tjs_char* value) { return std::char_traits<tjs_char>::length(value); }
tjs_char* TJSVS_malloc(tjs_uint length) {
    if(failNext) { failNext = false; throw std::bad_alloc(); }
    auto* value = static_cast<tjs_char*>(std::malloc(length * sizeof(tjs_char)));
    if(!value) throw std::bad_alloc();
    allocations.emplace(value, length);
    return value;
}
void TJSVS_free(tjs_char* value) {
    assert(allocations.erase(value) == 1);
    std::free(value);
}
tjs_char* TJSVS_realloc(tjs_char* value, tjs_uint length) {
    const auto oldLength = allocations.at(value);
    auto* replacement = TJSVS_malloc(length);
    assert(replacement != value);
    std::memcpy(replacement, value, oldLength * sizeof(tjs_char));
    TJSVS_free(value);
    return replacement;
}
}

namespace {
struct String final : TJS::tTJSVariantString {
    explicit String(const std::u16string& value) { Append(value.data(), value.size()); }
    ~String() { if(LongString) TJS::TJSVS_free(LongString); }
    const char16_t* data() const { return LongString ? LongString : ShortString; }
    std::u16string text() const { return std::u16string(data(), Length); }
    void check(const std::u16string& expected) const {
        assert(Length == static_cast<tjs_int>(expected.size()));
        assert(text() == expected);
        assert(data()[Length] == 0);
    }
};

void unchangedAfterFailure(const std::u16string& initial, unsigned offset, bool external) {
    String value(initial);
    const auto* buffer = value.data();
    const auto length = value.Length;
    const std::u16string suffix = external ? u"external append payload" : initial.substr(offset);
    failNext = true;
    bool failed = false;
    try { value.Append(external ? suffix.data() : buffer + offset, suffix.size()); }
    catch(const std::bad_alloc&) { failed = true; }
    assert(failed && !failNext);
    assert(value.data() == buffer && value.Length == length);
    value.check(initial);
    value.Append(external ? suffix.data() : value.data() + offset, suffix.size());
    value.check(initial + suffix);
}
}

int main() {
    {
        String value(u"x");
        value.Append(value.data());
        value.check(u"xx");
    }
    {
        String value(u"abcdefghij");
        value.Append(value.data());
        value.check(u"abcdefghijabcdefghij");
        assert(!value.LongString);
        value.Append(value.data());
        value.check(u"abcdefghijabcdefghijabcdefghijabcdefghij");
        assert(value.LongString);
    }
    {
        String value(u"abcdef");
        value.Append(value.data() + 2);
        value.check(u"abcdefcdef");
        value.Append(value.data() + 1, 2);
        value.check(u"abcdefcdefbc");
    }
    {
        const std::u16string original = u"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789雪😀";
        String value(original);
        const auto oldAddress = reinterpret_cast<std::uintptr_t>(value.data());
        value.Append(value.data() + 3);
        assert(reinterpret_cast<std::uintptr_t>(value.data()) != oldAddress);
        value.check(original + original.substr(3));
        const auto before = value.text();
        value.Append(value.data());
        value.check(before + before);
    }
    unchangedAfterFailure(std::u16string(TJS_VS_SHORT_LEN, u'x'), 0, false);
    unchangedAfterFailure(std::u16string(64, u'x'), 0, false);
    unchangedAfterFailure(std::u16string(64, u'x'), 3, false);
    unchangedAfterFailure(std::u16string(64, u'x'), 0, true);
    {
        String value(u"unchanged");
        bool rejected = false;
        try { value.Append(value.data(), -1); }
        catch(const std::bad_alloc&) { rejected = true; }
        assert(rejected);
        value.check(u"unchanged");
    }
    {
        String value(u"x");
        while(value.Length < 262144) value.Append(value.data());
        value.check(std::u16string(262144, u'x'));
    }
    assert(allocations.empty());
    std::cout << "PASS: string Append short/long/substring aliases, forced relocation, allocation failure and large repeat\n";
}
