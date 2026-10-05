#include "tjsCommHead.h"
#include "TvpMessages.h"
#include "ExecutionBudget.h"
#include "tjsMessage.h"
#include "tjsError.h"
#include <array>
#include <cstring>
#include <limits>

namespace krkr {
namespace {
struct MessageEntry {
    const tjs_char* id;
    TJS::tTJSMessageHolder holder;
    MessageEntry(const tjs_char* id, const tjs_char* value, bool assignable)
        : id(id), holder(id, value, assignable) {}
    MessageEntry(const MessageEntry&) = delete;
    MessageEntry& operator=(const MessageEntry&) = delete;
};

auto& messages() {
    // Construct after tTJS creation, before script initialization. Each holder
    // AddRefs the existing native mapper; its normal destructor unregisters it.
    static std::array<MessageEntry, 144> catalog{{
#define TVP_MESSAGE(name, assignable, value) { TJS_W(#name), value, assignable },
#include "TvpMessages.generated.inc"
#undef TVP_MESSAGE
    }};
    return catalog;
}

MessageEntry* findMessage(const tjs_char* id) {
    if(!id) return nullptr;
    for(auto& entry : messages())
        if(TJS::TJS_strcmp(entry.id, id) == 0) return &entry;
    return nullptr;
}

// Counting and copying share the token scanner. The second pass performs one
// expansion; placeholders inside arguments never become input to the scanner.
template<class Emit>
void expand(const tjs_char* text, const TJS::ttstr* args, std::size_t count, Emit emit) {
    for(auto* cursor = text; *cursor;) {
        if(*cursor == u'%' && cursor[1] == u'%') {
            emit(cursor + 1, std::size_t(1));
            cursor += 2;
        } else if(*cursor == u'%' &&
                  (cursor[1] == u'1' || (count == 2 && cursor[1] == u'2'))) {
            const auto& argument = args[cursor[1] - u'1'];
            emit(argument.c_str(), static_cast<std::size_t>(argument.GetLen()));
            cursor += 2;
        } else {
            auto* start = cursor++;
            while(*cursor && *cursor != u'%') ++cursor;
            emit(start, static_cast<std::size_t>(cursor - start));
        }
    }
}
}

void initializeTvpMessages() { (void)messages(); }
bool hasTvpMessage(const tjs_char* id) { return findMessage(id) != nullptr; }

TJS::ttstr formatTvpMessage(const tjs_char* id, const TJS::ttstr* args, std::size_t count) {
    if(count > 2 || (count != 0 && !args))
        TJS::TJS_eTJSError(u"Invalid TVP message format arguments");
    auto* entry = findMessage(id);
    if(!entry) TJS::TJS_eTJSError(u"Unknown TVP message ID");
    const auto* text = static_cast<const tjs_char*>(entry->holder);
    TemporaryMemory temporary;
    if(count == 0) {
        temporary.reserve(TJS::TJS_strlen(text) + 1, sizeof(tjs_char));
        return TJS::ttstr(text);
    }
    std::size_t length = 0;
    expand(text, args, count, [&](const tjs_char*, std::size_t size) {
        if(size > static_cast<std::size_t>(std::numeric_limits<tjs_int>::max()) - length)
            TJS::TJS_eTJSError(u"TVP formatted message exceeds the native string range");
        length += size;
    });
    temporary.reserve(length + 1, sizeof(tjs_char));
    TJS::ttstr result;
    auto* output = result.AllocBuffer(static_cast<tjs_uint>(length));
    expand(text, args, count, [&](const tjs_char* source, std::size_t size) {
        if(size) std::memcpy(output, source, size * sizeof(tjs_char));
        output += size;
    });
    *output = 0;
    // The original builds its result from a NUL-terminated buffer. FixLen also
    // keeps that boundary if an argument itself contained a NUL character.
    result.FixLen();
    return result;
}
}
