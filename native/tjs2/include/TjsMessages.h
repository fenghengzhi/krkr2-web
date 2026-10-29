#pragma once
#include "tjsString.h"

namespace krkr {
// A private, literal-only whitelist. This reads the existing native TJS holder
// and never registers another holder or exposes a new script API.
TJS::ttstr formatTjsMessage(const tjs_char* id);
}
