#pragma once
#include <cstddef>
#include <cstdint>
#include "tjsError.h"

namespace krkr {
// Lengths stay unsigned until bounded against the actual input. Never form a
// pointer or multiply an attacker-controlled count before checking the range.
class BinaryInput {
    const std::uint8_t* bytes;
    std::size_t length;
    std::size_t offset = 0;
    const tjs_char* error;
public:
    BinaryInput(const std::uint8_t* bytes, std::size_t length, const tjs_char* error)
        : bytes(bytes), length(length), error(error) {
        if((!bytes && length) || length > 64u * 1024 * 1024) fail();
    }
    [[noreturn]] void fail() const { TJS::TJS_eTJSError(error); throw 0; }
    std::size_t remaining() const { return length - offset; }
    std::size_t position() const { return offset; }
    const std::uint8_t* take(std::size_t count) {
        if(count > remaining()) fail();
        const auto* result = bytes ? bytes + offset : nullptr;
        offset += count;
        return result;
    }
    const std::uint8_t* items(std::size_t count, std::size_t width) {
        if(!width || count > remaining() / width) fail();
        return take(count * width);
    }
    std::uint8_t u8() { return *take(1); }
    std::uint16_t u16() {
        const auto* p = take(2);
        return std::uint16_t(p[0]) | (std::uint16_t(p[1]) << 8);
    }
    std::uint32_t u32() {
        const auto* p = take(4);
        return std::uint32_t(p[0]) | (std::uint32_t(p[1]) << 8) |
            (std::uint32_t(p[2]) << 16) | (std::uint32_t(p[3]) << 24);
    }
    std::int32_t i32() { return static_cast<std::int32_t>(u32()); }
    BinaryInput chunk(std::size_t count) { return BinaryInput(take(count), count, error); }
    void finish() const { if(remaining()) fail(); }
};
}
