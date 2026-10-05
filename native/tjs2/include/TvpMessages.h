#pragma once
#include <cstddef>
#include "tjsString.h"

namespace krkr {
// A module owns one VM. Holders live until module teardown; destroying a
// Session never resets another module's translations.
void initializeTvpMessages();
bool hasTvpMessage(const tjs_char* id);

// This is a private host/native boundary, not a new TJS API. IDs include the
// six original constant holders, which remain unassignable through the mapper.
// Count is 0..2. Zero arguments return the literal; one/two arguments scan only
// the template, replacing %%, %1 and (when available) %2. Inserted text is never
// recursively interpreted. Unknown IDs and invalid arguments throw explicitly.
TJS::ttstr formatTvpMessage(const tjs_char* id, const TJS::ttstr* args, std::size_t count);
}
