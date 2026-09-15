// Hosted Windows API observation only: no KRKR2/VCL or their command-ID allocator.
// Compile/run ONLY in .github/workflows/native-menu-flags.yml.
//
// All messages, timers and WH_MSGFILTER belong to this process's UI thread.
// No SendInput, global hook, foreground manipulation or unrelated window access.
// Compare two owned-HWND paths: tokenized messages rewritten by the system
// MSGF_MENU hook, and directly posted key messages which that hook only observes.
// Bare PostThreadMessage can be lost in modal loops; neither path uses it.
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postthreadmessagew
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-callmsgfilterw
// https://learn.microsoft.com/en-us/windows/win32/winmsg/messageproc
#include <windows.h>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr UINT targetId = 0x4211, otherId = 0x4212;
constexpr UINT keyMessage = WM_APP + 41, barrierMessage = WM_APP + 42;
constexpr UINT_PTR timerId = 73;
constexpr ULONGLONG caseLimitMs = 3000, observeMs = 200, observeLimitMs = 1000;
constexpr wchar_t className[] = L"KrkrNativeMenuFlagsOwnedProbe";
std::ofstream trace;
std::uint64_t sequence = 0;

std::string quote(const std::string& value) {
    std::string out = "\"";
    for (unsigned char ch : value) {
        if (ch == '"' || ch == '\\') { out += '\\'; out += static_cast<char>(ch); }
        else if (ch == '\n') out += "\\n";
        else if (ch == '\r') out += "\\r";
        else if (ch == '\t') out += "\\t";
        else if (ch < 32) out += "?";
        else out += static_cast<char>(ch);
    }
    return out + '"';
}
std::string utf8(const wchar_t* value) {
    if (!value || !*value) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string out(static_cast<std::size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), size, nullptr, nullptr);
    out.pop_back();
    return out;
}
std::string env(const wchar_t* name) {
    wchar_t value[1024]{};
    DWORD size = GetEnvironmentVariableW(name, value, 1024);
    return size > 0 && size < 1024 ? utf8(value) : std::string{};
}
struct Command {
    std::uint64_t sequence;
    UINT id, notification;
    bool duringTrack;
};
struct Assertion { std::string name; bool passed; };
enum class InputMode { HookRewrite, DirectPost };
const char* modeName(InputMode mode) {
    return mode == InputMode::HookRewrite ? "hook-rewrite" : "direct-post";
}
struct PostedKey {
    UINT message = 0, wireMessage = 0;
    WPARAM wp = 0, wireWp = 0;
    LPARAM lp = 0, wireLp = 0;
    bool posted = false, hookSeen = false, passedHooks = false, reachedWindow = false;
    std::uint64_t postSequence = 0;
};
struct Case {
    int id = 0;
    UINT flags = 0;
    InputMode mode = InputMode::HookRewrite;
    bool select = false;
    HWND owner = nullptr;
    HMENU menu = nullptr;
    HHOOK hook = nullptr;
    UINT_PTR timer = 0;
    bool inTrack = false, hookSeen = false, terminalKey = false;
    bool timedOut = false, postFailed = false, barrierSeen = false, quitSeen = false;
    bool targetHighlighted = false, keySuppressed = false;
    bool inputFinished = false, selectionAborted = false, keyPayloadChanged = false;
    int keyStage = 0, filteredKeys = 0, unconsumedKeys = 0;
    int rewrittenKeys = 0, directObservedKeys = 0;
    ULONGLONG started = 0, nextKeyAt = 0;
    std::uint64_t returnSequence = 0;
    BOOL returnValue = 0;
    DWORD lastError = 0;
    std::string status = "not-run", reason;
    std::vector<Command> commands;
    std::vector<Assertion> assertions;
    std::vector<PostedKey> keys;
};
Case* activeCase = nullptr;

std::uint64_t event(const Case* item, const char* name, const std::string& fields = {}) {
    const auto serial = ++sequence;
    std::ostringstream line;
    line << "{\"sequence\":" << serial << ",\"tickMs\":" << GetTickCount64()
         << ",\"threadId\":" << GetCurrentThreadId()
         << ",\"caseId\":" << (item ? item->id : 0)
         << ",\"mode\":" << (item ? quote(modeName(item->mode)) : "null")
         << ",\"event\":" << quote(name);
    if (!fields.empty()) line << ',' << fields;
    line << '}';
    trace << line.str() << std::endl;
    std::cout << line.str() << std::endl;
    return serial;
}
std::string messageFields(UINT message, WPARAM wp, LPARAM lp) {
    return "\"message\":" + std::to_string(message) +
        ",\"wParam\":" + std::to_string(static_cast<std::uint64_t>(wp)) +
        ",\"lParam\":" + std::to_string(static_cast<std::int64_t>(lp));
}
LPARAM keyParameter(UINT key, bool up) {
    const DWORD scan = MapVirtualKeyW(key, MAPVK_VK_TO_VSC);
    // DOWN is an extended navigation key, not the numeric-keypad key.
    // https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-keydown
    const DWORD extended = key == VK_DOWN ? 0x01000000u : 0;
    return static_cast<LPARAM>(1u | (scan << 16) | extended | (up ? 0xc0000000u : 0));
}
bool relevant(UINT message) {
    switch (message) {
        case WM_ENTERMENULOOP: case WM_EXITMENULOOP: case WM_INITMENU:
        case WM_INITMENUPOPUP: case WM_UNINITMENUPOPUP: case WM_MENUSELECT:
        case WM_MENUCHAR: case WM_MENURBUTTONUP: case WM_MENUCOMMAND:
        case WM_COMMAND: case WM_CANCELMODE: case WM_ACTIVATE:
        case WM_SETFOCUS: case WM_KILLFOCUS: case WM_KEYDOWN: case WM_KEYUP: case WM_CHAR:
            return true;
        default: return false;
    }
}
void assertion(Case& item, const char* name, bool passed) {
    item.assertions.push_back({name, passed});
    event(&item, "assertion", "\"name\":" + quote(name) +
        ",\"passed\":" + (passed ? "true" : "false"));
}
LRESULT CALLBACK ownerProcedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    auto* item = reinterpret_cast<Case*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        item = static_cast<Case*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
        item->owner = window;
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(item));
    }
    if (item && relevant(message)) {
        const auto serial = event(item, "window-message", messageFields(message, wp, lp) +
            ",\"hwnd\":" + std::to_string(reinterpret_cast<std::uintptr_t>(window)) +
            ",\"duringTrack\":" + (item->inTrack ? "true" : "false"));
        if (message == WM_COMMAND)
            item->commands.push_back({serial, LOWORD(wp), HIWORD(wp), item->inTrack});
    }
    if (item && message == keyMessage) {
        item->unconsumedKeys++;
        event(item, "key-not-consumed-by-menu", messageFields(message, wp, lp));
        return 0;
    }
    if (item && item->mode == InputMode::DirectPost &&
        (message == WM_KEYDOWN || message == WM_KEYUP)) {
        for (auto& key : item->keys) {
            if (key.posted && !key.reachedWindow && message == key.message &&
                wp == key.wp && lp == key.lp) {
                key.reachedWindow = true;
                item->unconsumedKeys++;
                event(item, "direct-key-reached-owner", messageFields(message, wp, lp) +
                    ",\"postSequence\":" + std::to_string(key.postSequence));
                break;
            }
        }
    }
    if (item && message == barrierMessage && wp == static_cast<WPARAM>(item->id)) {
        item->barrierSeen = true;
        event(item, "after-return-message-barrier");
        return 0;
    }
    if (message == WM_COMMAND) return 0;
    return DefWindowProcW(window, message, wp, lp);
}

// Never called manually: the code must come from the actual USER32 menu loop.
LRESULT CALLBACK menuFilter(int code, WPARAM wp, LPARAM lp) {
    auto* item = activeCase;
    bool matched = false, terminal = false;
    std::size_t keyIndex = 0;
    MSG* observedMessage = nullptr;
    if (code == MSGF_MENU && item && item->inTrack) {
        auto* message = reinterpret_cast<MSG*>(lp);
        item->hookSeen = true;
        event(item, "system-menu-filter",
            messageFields(message->message, message->wParam, message->lParam) +
            ",\"hwnd\":" + std::to_string(reinterpret_cast<std::uintptr_t>(message->hwnd)));
        if (message->hwnd == item->owner) {
            for (std::size_t index = 0; index < item->keys.size(); ++index) {
                auto& key = item->keys[index];
                if (!key.posted || key.hookSeen || message->message != key.wireMessage ||
                    message->wParam != key.wireWp || message->lParam != key.wireLp) continue;
                matched = true;
                keyIndex = index;
                observedMessage = message;
                key.hookSeen = true;
                if (item->mode == InputMode::HookRewrite) {
                    message->message = key.message;
                    message->wParam = key.wp;
                    message->lParam = key.lp;
                    item->rewrittenKeys++;
                } else {
                    // Observe the already-posted WM_KEYDOWN/UP without writing to MSG.
                    item->directObservedKeys++;
                }
                item->filteredKeys++;
                terminal = key.message == WM_KEYDOWN &&
                    key.wp == static_cast<WPARAM>(item->select ? VK_RETURN : VK_ESCAPE);
                event(item, item->mode == InputMode::HookRewrite ?
                    "owned-key-injected-into-menu" : "direct-key-observed-by-menu",
                    messageFields(message->message, message->wParam, message->lParam) +
                    ",\"postSequence\":" + std::to_string(key.postSequence));
                break;
            }
        }
    }
    const LRESULT next = CallNextHookEx(nullptr, code, wp, lp);
    if (matched) {
        auto& key = item->keys[keyIndex];
        const bool unchanged = observedMessage->hwnd == item->owner &&
            observedMessage->message == key.message && observedMessage->wParam == key.wp &&
            observedMessage->lParam == key.lp;
        if (next != 0) item->keySuppressed = true;
        if (!unchanged) item->keyPayloadChanged = true;
        key.passedHooks = next == 0 && unchanged;
        if (terminal && key.passedHooks) item->terminalKey = true;
        event(item, "remaining-hook-chain-return", "\"value\":" + std::to_string(next) +
            ",\"postSequence\":" + std::to_string(key.postSequence) +
            ",\"payloadUnchanged\":" + (unchanged ? "true" : "false") + "," +
            messageFields(observedMessage->message, observedMessage->wParam, observedMessage->lParam));
    }
    return next;
}
void CALLBACK driveCase(HWND window, UINT, UINT_PTR, DWORD) {
    auto* item = reinterpret_cast<Case*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!item || !item->inTrack) return;
    const auto now = GetTickCount64();
    if (now - item->started >= caseLimitMs) {
        if (!item->timedOut) {
            item->timedOut = true;
            event(item, "case-deadline-endmenu");
            SetLastError(ERROR_SUCCESS);
            const BOOL ended = EndMenu(); // Calling thread's menu only.
            const DWORD error = GetLastError();
            event(item, "endmenu-return", "\"result\":" + std::to_string(ended) +
                ",\"lastError\":" + std::to_string(error));
            PostMessageW(window, WM_CANCELMODE, 0, 0);
        }
        return;
    }
    if (now < item->nextKeyAt || item->inputFinished) return;
    // Navigate using the standard menu keyboard interface. With two leaves,
    // at most two DOWN presses reach the target regardless of initial hover.
    // https://learn.microsoft.com/en-us/windows/win32/menurc/about-menus#standard-keyboard-interface
    // Each press is followed by key-up, then a real menu-state observation.
    // These posted messages do not change any hardware/global keyboard state.
    UINT key = item->select ? VK_DOWN : VK_ESCAPE;
    const bool up = item->select && (item->keyStage % 2) == 1;
    if (item->select && !up && item->keyStage >= 2) {
        SetLastError(ERROR_SUCCESS);
        const UINT state = GetMenuState(item->menu, 0, MF_BYPOSITION);
        const DWORD error = GetLastError();
        item->targetHighlighted = state != static_cast<UINT>(-1) && (state & MF_HILITE) != 0;
        event(item, "owned-target-after-navigation", "\"menuState\":" + std::to_string(state) +
            ",\"navigationPresses\":" + std::to_string(item->keyStage / 2) +
            ",\"highlighted\":" + (item->targetHighlighted ? "true" : "false") +
            ",\"lastError\":" + std::to_string(error));
        if (item->targetHighlighted) key = VK_RETURN;
        else if (item->keyStage >= 4) {
            // Escape is cleanup for a failed SELECT attempt; it never changes
            // this case into a successful cancellation observation.
            item->selectionAborted = true;
            key = VK_ESCAPE;
            event(item, "selection-aborted-before-enter");
        }
    }
    if (key == VK_RETURN || key == VK_ESCAPE) item->inputFinished = true;
    PostedKey queued;
    queued.message = up ? WM_KEYUP : WM_KEYDOWN;
    queued.wp = key;
    queued.lp = keyParameter(key, up);
    queued.wireMessage = item->mode == InputMode::DirectPost ? queued.message : keyMessage;
    queued.wireWp = item->mode == InputMode::DirectPost ? queued.wp : static_cast<WPARAM>(item->id);
    queued.wireLp = item->mode == InputMode::DirectPost ? queued.lp :
        static_cast<LPARAM>(key | (up ? 0x10000u : 0));
    item->keys.push_back(queued);
    auto& postedKey = item->keys.back();
    SetLastError(ERROR_SUCCESS);
    const BOOL posted = PostMessageW(window, postedKey.wireMessage, postedKey.wireWp, postedKey.wireLp);
    const DWORD error = GetLastError();
    postedKey.posted = posted != FALSE;
    postedKey.postSequence = event(item, "owned-key-posted", "\"key\":" + std::to_string(key) +
        ",\"up\":" + (up ? "true" : "false") + ",\"posted\":" + std::to_string(posted) +
        ",\"lastError\":" + std::to_string(error) +
        ",\"hwnd\":" + std::to_string(reinterpret_cast<std::uintptr_t>(window)) + "," +
        messageFields(postedKey.wireMessage, postedKey.wireWp, postedKey.wireLp));
    if (!posted) item->postFailed = true;
    item->keyStage++;
    item->nextKeyAt = now + 100;
}
void observeAfterReturn(Case& item) {
    const auto started = GetTickCount64();
    SetLastError(ERROR_SUCCESS);
    const BOOL posted = PostMessageW(item.owner, barrierMessage, item.id, 0);
    const DWORD error = GetLastError();
    event(&item, "after-return-barrier-posted", "\"posted\":" + std::to_string(posted) +
        ",\"lastError\":" + std::to_string(error));
    if (!posted) item.postFailed = true;
    for (;;) {
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) {
                item.quitSeen = true;
                event(&item, "unexpected-thread-quit");
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
            if (GetTickCount64() - started >= observeLimitMs) break;
        }
        const auto elapsed = GetTickCount64() - started;
        if (item.quitSeen || elapsed >= observeLimitMs ||
            (item.barrierSeen && elapsed >= observeMs)) break;
        MsgWaitForMultipleObjectsEx(0, nullptr, 10, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    }
    event(&item, "after-return-observation-ended", "\"elapsedMs\":" +
        std::to_string(GetTickCount64() - started) +
        ",\"barrierSeen\":" + (item.barrierSeen ? "true" : "false"));
}
void releaseCase(Case& item) {
    item.inTrack = false;
    if (item.timer) KillTimer(item.owner, item.timer);
    if (item.hook) UnhookWindowsHookEx(item.hook);
    item.timer = 0;
    item.hook = nullptr;
    activeCase = nullptr;
    if (item.menu) DestroyMenu(item.menu);
    item.menu = nullptr;
    if (item.owner) DestroyWindow(item.owner);
    item.owner = nullptr;
}
void runCase(Case& item, HINSTANCE instance) {
    event(&item, "case-start", "\"flags\":" + std::to_string(item.flags) +
        ",\"action\":" + quote(item.select ? "select" : "cancel") +
        ",\"targetCommandId\":" + std::to_string(targetId));
    item.status = "not-executable";
    item.owner = CreateWindowExW(WS_EX_TOOLWINDOW, className, L"Owned native menu flags probe",
        WS_OVERLAPPEDWINDOW, 40, 40, 360, 220, nullptr, nullptr, instance, &item);
    if (!item.owner) { item.reason = "CreateWindowExW failed: " + std::to_string(GetLastError()); return; }
    item.menu = CreatePopupMenu();
    if (!item.menu || !AppendMenuW(item.menu, MF_STRING, targetId, L"&Target") ||
        !AppendMenuW(item.menu, MF_STRING, otherId, L"&Other")) {
        item.reason = "Menu creation failed: " + std::to_string(GetLastError());
        releaseCase(item); return;
    }
    ShowWindow(item.owner, SW_SHOWNOACTIVATE);
    UpdateWindow(item.owner);
    activeCase = &item;
    item.hook = SetWindowsHookExW(WH_MSGFILTER, menuFilter, nullptr, GetCurrentThreadId());
    if (!item.hook) {
        item.reason = "Thread-local WH_MSGFILTER failed: " + std::to_string(GetLastError());
        releaseCase(item); return;
    }
    item.timer = SetTimer(item.owner, timerId, 25, driveCase);
    if (!item.timer) {
        item.reason = "SetTimer failed: " + std::to_string(GetLastError());
        releaseCase(item); return;
    }
    POINT position{24, 48};
    if (!ClientToScreen(item.owner, &position)) {
        item.reason = "ClientToScreen failed: " + std::to_string(GetLastError());
        releaseCase(item); return;
    }
    event(&item, "track-enter", "\"x\":" + std::to_string(position.x) +
        ",\"y\":" + std::to_string(position.y));
    item.started = GetTickCount64();
    item.nextKeyAt = item.started + 200;
    item.inTrack = true;
    SetLastError(ERROR_SUCCESS);
    item.returnValue = TrackPopupMenuEx(item.menu, item.flags, position.x, position.y, item.owner, nullptr);
    item.lastError = GetLastError();
    item.inTrack = false;
    // Record before pumping anything. WM_COMMAND is never withheld, rewritten,
    // or omitted based on its timing or the outcome the probe expects.
    item.returnSequence = event(&item, "track-return", "\"value\":" +
        std::to_string(item.returnValue) + ",\"lastError\":" + std::to_string(item.lastError) +
        ",\"elapsedMs\":" + std::to_string(GetTickCount64() - item.started));
    KillTimer(item.owner, item.timer);
    item.timer = 0;
    observeAfterReturn(item);
    // Include any synchronous owner notifications during destruction in the
    // observed command list before deciding the case's assertion status.
    releaseCase(item);
    bool allKeysPassed = !item.keys.empty();
    for (const auto& key : item.keys)
        if (!key.posted || !key.hookSeen || !key.passedHooks) allKeysPassed = false;
    if (item.timedOut) item.reason = "Per-case deadline required EndMenu";
    else if (item.postFailed) item.reason = "An owned message could not be posted";
    else if (item.selectionAborted)
        item.reason = "Two owned DOWN presses did not establish the known highlighted leaf; Escape was cleanup only";
    else if (!item.hookSeen || !item.terminalKey)
        item.reason = "Owned terminal key was not passed through the system menu hook chain";
    else if (item.keySuppressed)
        item.reason = "Another thread-local hook suppressed an owned key";
    else if (item.keyPayloadChanged)
        item.reason = "Another hook changed the owned key payload";
    else if (!allKeysPassed)
        item.reason = "Not every posted key was observed unchanged through the system menu hook chain";
    else if (item.select && !item.targetHighlighted)
        item.reason = "Selection injection did not establish the known highlighted leaf";
    else if (!item.barrierSeen || item.quitSeen)
        item.reason = "After-return message observation did not complete";
    if (item.timedOut) item.status = "timeout";
    else if (item.reason.empty()) {
        const bool returnsCommand = (item.flags & TPM_RETURNCMD) != 0;
        const bool notifies = (item.flags & (TPM_NONOTIFY | TPM_RETURNCMD)) == 0;
        if (item.select)
            assertion(item, returnsCommand ? "selection returns owned command ID" : "selection returns nonzero BOOL",
                returnsCommand ? item.returnValue == static_cast<BOOL>(targetId) : item.returnValue != 0);
        else if (returnsCommand) assertion(item, "RETURNCMD cancellation returns zero", item.returnValue == 0);
        else event(&item, "cancel-bool-observed-without-presupposed-value",
            "\"value\":" + std::to_string(item.returnValue));
        assertion(item, "selected command notification count",
            item.commands.size() == (item.select && notifies ? 1u : 0u));
        for (const auto& command : item.commands) {
            assertion(item, "notification identifies owned leaf", command.id == targetId && command.notification == 0);
            assertion(item, "WM_COMMAND is delivered after TrackPopupMenuEx returns",
                !command.duringTrack && command.sequence > item.returnSequence);
        }
        item.status = "observed";
        for (const auto& check : item.assertions) if (!check.passed) item.status = "assertion-failed";
    }
    event(&item, "case-end", "\"status\":" + quote(item.status) + ",\"reason\":" + quote(item.reason));
}
void summary(const std::filesystem::path& directory, const std::vector<Case>& cases,
    const std::string& status, const std::string& reason) {
    std::ofstream file(directory / "summary.json", std::ios::trunc);
    int observed = 0, passed = 0;
    for (const auto& item : cases) {
        if (item.status == "observed" || item.status == "assertion-failed") observed++;
        if (item.status == "observed") passed++;
    }
    file << "{\"schemaVersion\":1,\"scope\":\"Win32 TrackPopupMenuEx only; no KRKR2 or VCL\","
         << "\"status\":" << quote(status) << ",\"reason\":" << quote(reason)
         << ",\"expectedCases\":32,\"observedCases\":" << observed << ",\"passedCases\":" << passed
         << ",\"nestedMenuCoverage\":\"not-run; RECURSE bit tested only without an existing menu\","
         << "\"inputModes\":[\"hook-rewrite\",\"direct-post\"],\"expectedCasesPerMode\":16,"
         << "\"inputMethod\":\"owned HWND keys: hook rewrite versus direct PostMessage with observation-only hook\","
         << "\"globalInputUsed\":false,\"caseLimitMs\":" << caseLimitMs
         << ",\"postReturnObservationMs\":" << observeMs << ",\"cases\":[";
    bool comma = false;
    for (const auto& item : cases) {
        if (comma) file << ',';
        comma = true;
        file << "{\"id\":" << item.id << ",\"mode\":" << quote(modeName(item.mode))
             << ",\"flags\":" << item.flags
             << ",\"action\":" << quote(item.select ? "select" : "cancel")
             << ",\"status\":" << quote(item.status) << ",\"reason\":" << quote(item.reason)
             << ",\"returnValue\":";
        if (item.returnSequence) file << item.returnValue; else file << "null";
        file << ",\"returnSequence\":" << item.returnSequence << ",\"lastError\":" << item.lastError
             << ",\"menuFilterSeen\":" << (item.hookSeen ? "true" : "false")
             << ",\"filteredKeys\":" << item.filteredKeys << ",\"unconsumedKeys\":" << item.unconsumedKeys
             << ",\"postedKeyCount\":" << item.keys.size() << ",\"rewrittenKeys\":" << item.rewrittenKeys
             << ",\"directObservedKeys\":" << item.directObservedKeys
             << ",\"terminalKeyPassedThroughHooks\":" << (item.terminalKey ? "true" : "false")
             << ",\"targetHighlighted\":" << (item.targetHighlighted ? "true" : "false")
             << ",\"selectionAborted\":" << (item.selectionAborted ? "true" : "false")
             << ",\"keySuppressed\":" << (item.keySuppressed ? "true" : "false")
             << ",\"keyPayloadChanged\":" << (item.keyPayloadChanged ? "true" : "false")
             << ",\"barrierSeen\":" << (item.barrierSeen ? "true" : "false") << ",\"commands\":[";
        bool childComma = false;
        for (const auto& command : item.commands) {
            if (childComma) file << ',';
            childComma = true;
            file << "{\"sequence\":" << command.sequence << ",\"id\":" << command.id
                 << ",\"notification\":" << command.notification << ",\"duringTrack\":"
                 << (command.duringTrack ? "true" : "false") << '}';
        }
        file << "],\"assertions\":[";
        childComma = false;
        for (const auto& check : item.assertions) {
            if (childComma) file << ',';
            childComma = true;
            file << "{\"name\":" << quote(check.name) << ",\"passed\":"
                 << (check.passed ? "true" : "false") << '}';
        }
        file << "]}";
    }
    file << "]}" << std::endl;
    if (!file.good()) throw std::runtime_error("Failed to preserve summary.json");
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) { std::cerr << "Expected one output directory; hosted Actions only.\n"; return 2; }
    const std::filesystem::path directory(argv[1]);
    std::vector<Case> cases;
    for (InputMode mode : {InputMode::HookRewrite, InputMode::DirectPost}) {
        for (UINT bits = 0; bits < 8; ++bits) {
            const UINT flags = ((bits & 1) ? TPM_NONOTIFY : 0) |
                ((bits & 2) ? TPM_RETURNCMD : 0) | ((bits & 4) ? TPM_RECURSE : 0);
            for (bool select : {false, true}) {
                Case item;
                item.id = static_cast<int>(cases.size()) + 1;
                item.mode = mode;
                item.flags = flags; item.select = select;
                cases.push_back(item);
            }
        }
    }
    try {
        std::filesystem::create_directories(directory);
        trace.open(directory / "trace.jsonl", std::ios::trunc);
        if (!trace) throw std::runtime_error("Cannot open trace.jsonl");
        if (env(L"GITHUB_ACTIONS") != "true" || env(L"RUNNER_ENVIRONMENT") != "github-hosted" ||
            env(L"RUNNER_OS") != "Windows") {
            const std::string reason = "Execution requires a GitHub-hosted Windows Actions runner";
            event(nullptr, "not-executable", "\"reason\":" + quote(reason));
            summary(directory, cases, "not-executable", reason); return 2;
        }
        USEROBJECTFLAGS station{};
        DWORD needed = 0;
        SetLastError(ERROR_SUCCESS);
        const BOOL stationRead = GetUserObjectInformationW(GetProcessWindowStation(), UOI_FLAGS,
            &station, sizeof(station), &needed);
        const DWORD stationError = GetLastError();
        // Visibility alone does not prove whether a private, synthetic menu
        // loop can execute. Attempt the bounded cases and report actual evidence.
        event(nullptr, "window-station", "\"metadataAvailable\":" + std::to_string(stationRead) +
            ",\"visible\":" + ((stationRead && (station.dwFlags & WSF_VISIBLE)) ? "true" : "false") +
            ",\"lastError\":" + std::to_string(stationError));
        event(nullptr, "probe-start", "\"runnerOS\":" + quote(env(L"RUNNER_OS")) +
            ",\"runnerEnvironment\":" + quote(env(L"RUNNER_ENVIRONMENT")) +
            ",\"githubSha\":" + quote(env(L"GITHUB_SHA")) +
            ",\"pid\":" + std::to_string(GetCurrentProcessId()));
        const HINSTANCE instance = GetModuleHandleW(nullptr);
        WNDCLASSEXW definition{};
        definition.cbSize = sizeof(definition);
        definition.lpfnWndProc = ownerProcedure;
        definition.hInstance = instance;
        definition.lpszClassName = className;
        if (!RegisterClassExW(&definition)) {
            const std::string reason = "RegisterClassExW failed: " + std::to_string(GetLastError());
            event(nullptr, "not-executable", "\"reason\":" + quote(reason));
            summary(directory, cases, "not-executable", reason); return 2;
        }
        summary(directory, cases, "running", "No cases have completed yet");
        for (auto& item : cases) {
            runCase(item, instance);
            summary(directory, cases, "running", "Checkpoint; final completion has not been recorded");
        }
        UnregisterClassW(className, instance);
        bool complete = trace.good();
        for (const auto& item : cases) if (item.status != "observed") complete = false;
        const std::string status = complete ? "completed" : "failed";
        event(nullptr, "probe-end", "\"status\":" + quote(status));
        summary(directory, cases, status, complete ? "" : "Some cases were incomplete or known assertions failed");
        return complete ? 0 : 1;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        if (activeCase) releaseCase(*activeCase);
        try { summary(directory, cases, "failed", error.what()); } catch (...) {}
        return 2;
    }
}
