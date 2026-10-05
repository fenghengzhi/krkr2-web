// GitHub-hosted Windows reference only. This measures User32 with owned HWNDs;
// it is not the VCL WindowForm or KRKR2 Layer capture implementation.
// Fixed source: krkr2 2.32stable dec49af97e174d31059c3ccd7efc700ba3c6b788,
// WindowFormUnit.cpp:1483: ReleaseCapture(); Perform(WM_SYSCOMMAND, SC_MOVE+2, 0).
// User32 boundary: https://learn.microsoft.com/windows/win32/menurc/wm-syscommand
// https://learn.microsoft.com/windows/win32/winmsg/wm-entersizemove
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
constexpr UINT Begin = WM_APP + 41, Finish = WM_APP + 42, PrepareInput = WM_APP + 43;
constexpr ULONG_PTR ControlledInputTag = 0x4b4d4f56;
constexpr wchar_t ClassName[] = L"KrkrHostedWindowMoveReference";
const char* boolean(bool value) { return value ? "true" : "false"; }
std::string quote(const std::string& value) {
    std::ostringstream out; out << '"';
    for (unsigned char ch : value) {
        if (ch == '\\' || ch == '"') out << '\\' << ch;
        else if (ch == '\n') out << "\\n";
        else if (ch == '\r') out << "\\r";
        else if (ch == '\t') out << "\\t";
        else if (ch < 32) out << '?';
        else out << ch;
    }
    out << '"'; return out.str();
}
std::string handle(HWND value) {
    std::ostringstream out; out << "\"0x" << std::hex << reinterpret_cast<std::uintptr_t>(value) << '"'; return out.str();
}
std::string rectangle(const RECT& value) {
    return "[" + std::to_string(value.left) + "," + std::to_string(value.top) + "," +
        std::to_string(value.right) + "," + std::to_string(value.bottom) + "]";
}
void write(const fs::path& path, const std::string& value) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << value << '\n'; out.flush();
    if (!out) throw std::runtime_error("Cannot preserve observation file");
}
struct OwnedHandle {
    HANDLE value = nullptr;
    explicit OwnedHandle(HANDLE next = nullptr) : value(next) {}
    ~OwnedHandle() { if (value) CloseHandle(value); }
    OwnedHandle(const OwnedHandle&) = delete;
    OwnedHandle& operator=(const OwnedHandle&) = delete;
};
struct Scenario {
    const char* id;
    bool borderless, leftButton, visible, disabled, noActivate;
    const char* termination;
};
struct State {
    Scenario scenario;
    std::ofstream journal;
    std::mutex mutex;
    const ULONGLONG started = GetTickCount64();
    OwnedHandle ready{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    OwnedHandle entered{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    OwnedHandle returned{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    OwnedHandle buttonSeen{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    OwnedHandle inputPrepared{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    OwnedHandle neutralSeen{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    OwnedHandle movingSeen{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    std::atomic<HWND> window{nullptr}, child{nullptr};
    std::atomic<DWORD> threadId{0};
    std::atomic<bool> failed{false}, invoked{false}, inCommand{false}, didReturn{false};
    std::atomic<bool> prepared{false}, neutralObserved{false}, controlledDownObserved{false};
    std::atomic<LONG> inputX{0}, inputY{0};
    std::atomic<unsigned> leftDownInjections{0};
    std::atomic<unsigned> enters{0}, exits{0}, moves{0}, moving{0}, captureChanges{0};
    unsigned records = 0;
    RECT before{}, after{};
    bool captureBeforeChild = false, captureAfterReleaseNull = false, releaseSucceeded = false;
    SHORT asyncButtonBefore = 0, queuedButtonBefore = 0;
    LRESULT returnValue = 0;
    State(Scenario config, const fs::path& output) : scenario(config), journal(output / (std::string(config.id) + ".jsonl"), std::ios::binary) {
        if (!journal || !ready.value || !entered.value || !returned.value || !buttonSeen.value ||
            !inputPrepared.value || !neutralSeen.value || !movingSeen.value)
            throw std::runtime_error("Cannot create owned observation resources");
    }
    void record(const char* phase, HWND source = nullptr, UINT message = 0, WPARAM wp = 0, LPARAM lp = 0,
        const std::string& details = "null") {
        std::lock_guard<std::mutex> lock(mutex);
        if (records >= 512) { failed = true; return; }
        RECT rect{}; POINT cursor{}; GUITHREADINFO gui{sizeof(gui)};
        const HWND owned = window.load();
        const bool rectOk = owned && GetWindowRect(owned, &rect), cursorOk = GetCursorPos(&cursor) != FALSE,
            guiOk = threadId.load() && GetGUIThreadInfo(threadId.load(), &gui);
        journal << "{\"sequence\":" << records++ << ",\"elapsedMs\":" << GetTickCount64() - started
          << ",\"phase\":" << quote(phase) << ",\"threadId\":" << GetCurrentThreadId()
          << ",\"source\":" << handle(source) << ",\"message\":" << message
          << ",\"wParam\":" << quote(std::to_string(static_cast<unsigned long long>(wp)))
          << ",\"lParam\":" << quote(std::to_string(static_cast<long long>(lp)))
          << ",\"inCommand\":" << boolean(inCommand.load()) << ",\"getCapture\":" << handle(GetCapture())
          << ",\"guiOk\":" << boolean(guiOk) << ",\"guiCapture\":" << handle(gui.hwndCapture)
          << ",\"guiActive\":" << handle(gui.hwndActive) << ",\"guiFocus\":" << handle(gui.hwndFocus)
          << ",\"foreground\":" << handle(GetForegroundWindow())
          << ",\"asyncLeft\":" << GetAsyncKeyState(VK_LBUTTON) << ",\"queuedLeft\":" << GetKeyState(VK_LBUTTON)
          << ",\"rectOk\":" << boolean(rectOk) << ",\"rect\":" << rectangle(rect)
          << ",\"cursorOk\":" << boolean(cursorOk) << ",\"cursor\":[" << cursor.x << ',' << cursor.y << ']'
          << ",\"details\":" << details << "}\n";
        journal.flush(); if (!journal) failed = true;
    }
    void error(const char* reason) { failed = true; record("error", nullptr, 0, 0, 0, quote(reason)); }
};
// This is only the visible, enabled held-button stimulus precondition. Hidden,
// disabled and no-activate cases retain their original no-button observations.
bool controlledTargetReady(const State& s) {
    const HWND hwnd = s.window.load(), child = s.child.load();
    GUITHREADINFO gui{sizeof(gui)}; POINT cursor{}; DWORD process = 0;
    return hwnd && child && GetWindowThreadProcessId(hwnd, &process) == s.threadId.load() &&
        process == GetCurrentProcessId() && GetParent(child) == hwnd &&
        GetForegroundWindow() == hwnd && GetGUIThreadInfo(s.threadId.load(), &gui) &&
        gui.hwndActive == hwnd && gui.hwndFocus == hwnd && gui.hwndCapture == child &&
        GetCursorPos(&cursor) && std::abs(cursor.x - s.inputX.load()) <= 1 &&
        std::abs(cursor.y - s.inputY.load()) <= 1 && WindowFromPoint(cursor) == child;
}
bool deliveredAtTarget(const State& s, HWND hwnd, LPARAM lp) {
    POINT point{static_cast<short>(LOWORD(lp)), static_cast<short>(HIWORD(lp))};
    return hwnd == s.child.load() && ClientToScreen(hwnd, &point) &&
        std::abs(point.x - s.inputX.load()) <= 1 && std::abs(point.y - s.inputY.load()) <= 1;
}
LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
    State* state = reinterpret_cast<State*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        state = static_cast<State*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
    }
    if (!state) return DefWindowProcW(hwnd, message, wp, lp);
    switch (message) {
    case WM_ENTERSIZEMOVE: ++state->enters; state->record("WM_ENTERSIZEMOVE", hwnd, message, wp, lp); SetEvent(state->entered.value); break;
    case WM_EXITSIZEMOVE: ++state->exits; state->record("WM_EXITSIZEMOVE", hwnd, message, wp, lp); break;
    case WM_MOVING:
        ++state->moving;
        state->record("WM_MOVING", hwnd, message, wp, lp, rectangle(*reinterpret_cast<RECT*>(lp)));
        SetEvent(state->movingSeen.value); break;
    case WM_MOVE: ++state->moves; state->record("WM_MOVE", hwnd, message, wp, lp); break;
    case WM_CAPTURECHANGED: ++state->captureChanges; state->record("WM_CAPTURECHANGED", hwnd, message, wp, lp); break;
    case WM_SYSCOMMAND: state->record("WM_SYSCOMMAND", hwnd, message, wp, lp); break;
    case WM_ACTIVATEAPP: case WM_ACTIVATE: case WM_SETFOCUS: case WM_KILLFOCUS:
        state->record("activation-or-focus", hwnd, message, wp, lp); break;
    case WM_MOUSEMOVE:
        state->record("WM_MOUSEMOVE", hwnd, message, wp, lp);
        if (state->prepared && !state->neutralObserved && GetMessageExtraInfo() == static_cast<LPARAM>(ControlledInputTag) &&
            deliveredAtTarget(*state, hwnd, lp) && controlledTargetReady(*state) &&
            !(wp & MK_LBUTTON) && !(GetAsyncKeyState(VK_LBUTTON) & 0x8000) && !(GetKeyState(VK_LBUTTON) & 0x8000)) {
            state->neutralObserved = true;
            state->record("owned-neutral-pointer-observed", hwnd, message, wp, lp);
            SetEvent(state->neutralSeen.value);
        }
        break;
    case WM_LBUTTONDOWN:
        state->record("WM_LBUTTONDOWN", hwnd, message, wp, lp);
        if (state->neutralObserved && GetMessageExtraInfo() == static_cast<LPARAM>(ControlledInputTag) &&
            deliveredAtTarget(*state, hwnd, lp) && controlledTargetReady(*state) && (wp & MK_LBUTTON) &&
            (GetAsyncKeyState(VK_LBUTTON) & 0x8000) && (GetKeyState(VK_LBUTTON) & 0x8000)) {
            state->controlledDownObserved = true;
            state->record("owned-controlled-left-observed", hwnd, message, wp, lp);
            SetEvent(state->buttonSeen.value);
        }
        break;
    case WM_LBUTTONUP: case WM_KEYDOWN: case WM_KEYUP: case WM_CANCELMODE:
        state->record("input-or-cancel", hwnd, message, wp, lp); break;
    case PrepareInput: {
        // The initial neutral SendInput has completed before this owner-thread
        // request. Do not combine the first desktop move with the left press:
        // launcher activation may still revoke the startup capture during it.
        if (hwnd != state->window.load() || !state->scenario.leftButton ||
            !state->scenario.visible || state->scenario.disabled || state->scenario.noActivate || state->prepared) {
            state->error("Invalid or repeated controlled input preparation");
        } else {
            const bool requested = SetForegroundWindow(hwnd) != FALSE;
            SetFocus(hwnd); SetCapture(state->child.load());
            GUITHREADINFO gui{sizeof(gui)};
            const bool ready = GetForegroundWindow() == hwnd && GetGUIThreadInfo(state->threadId.load(), &gui) &&
                gui.hwndActive == hwnd && gui.hwndFocus == hwnd && gui.hwndCapture == state->child.load() &&
                !(GetAsyncKeyState(VK_LBUTTON) & 0x8000) && !(GetKeyState(VK_LBUTTON) & 0x8000);
            state->record("prepare-controlled-input", hwnd, message, wp, lp,
                "{\"foregroundRequested\":" + std::string(boolean(requested)) + ",\"ready\":" + boolean(ready) + "}");
            if (ready) state->prepared = true;
            else state->error("Owned foreground, focus, capture or neutral button preparation failed");
        }
        SetEvent(state->inputPrepared.value); return 0;
    }
    case Begin: {
        if (state->scenario.leftButton && (state->failed || !state->controlledDownObserved ||
            !controlledTargetReady(*state) || !(GetAsyncKeyState(VK_LBUTTON) & 0x8000) || !(GetKeyState(VK_LBUTTON) & 0x8000))) {
            state->error("Owned controlled input precondition changed before synchronous command");
            SetEvent(state->returned.value); return 0;
        }
        state->invoked = true;
        GetWindowRect(hwnd, &state->before);
        state->captureBeforeChild = GetCapture() == state->child.load();
        state->record("before-ReleaseCapture", hwnd);
        state->releaseSucceeded = ReleaseCapture() != FALSE;
        state->captureAfterReleaseNull = GetCapture() == nullptr;
        state->record("after-ReleaseCapture", hwnd);
        state->asyncButtonBefore = GetAsyncKeyState(VK_LBUTTON);
        state->queuedButtonBefore = GetKeyState(VK_LBUTTON);
        state->inCommand = true;
        state->record("before-synchronous-SendMessage", hwnd, WM_SYSCOMMAND, SC_MOVE + 2, 0);
        // Keep all low bits exactly as fixed native source; do not replace
        // this with PostMessage, a caption event, or SC_MOVE without +2.
        state->returnValue = SendMessageW(hwnd, WM_SYSCOMMAND, SC_MOVE + 2, 0);
        state->inCommand = false; state->didReturn = true;
        GetWindowRect(hwnd, &state->after);
        state->record("after-synchronous-SendMessage", hwnd, WM_SYSCOMMAND, SC_MOVE + 2, state->returnValue);
        SetEvent(state->returned.value); return 0;
    }
    case Finish:
        state->record("cleanup-on-owner-thread", hwnd);
        ReleaseCapture(); DestroyWindow(hwnd); return 0;
    case WM_DESTROY:
        state->record("WM_DESTROY", hwnd, message, wp, lp);
        if (!(GetWindowLongPtrW(hwnd, GWL_STYLE) & WS_CHILD)) PostQuitMessage(0);
        return 0;
    default: break;
    }
    return DefWindowProcW(hwnd, message, wp, lp);
}
DWORD WINAPI uiThread(void* parameter) {
    State& s = *static_cast<State*>(parameter); s.threadId = GetCurrentThreadId();
    try {
        RECT work{};
        if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0) || work.right - work.left < 480 || work.bottom - work.top < 360)
            throw std::runtime_error("Interactive work area is unavailable or too small");
        const DWORD style = s.scenario.borderless ? WS_POPUP : WS_OVERLAPPEDWINDOW,
            extended = s.scenario.noActivate ? WS_EX_NOACTIVATE : 0;
        HWND hwnd = CreateWindowExW(extended, ClassName, L"Owned hosted beginMove reference", style,
            work.left + 80, work.top + 80, 320, 200, nullptr, nullptr, GetModuleHandleW(nullptr), &s);
        if (!hwnd) throw std::runtime_error("CreateWindowEx failed");
        s.window = hwnd;
        HWND child = CreateWindowExW(0, ClassName, L"Owned capture child", WS_CHILD | WS_VISIBLE,
            0, 0, 120, 80, hwnd, nullptr, GetModuleHandleW(nullptr), &s);
        if (!child) throw std::runtime_error("Create child HWND failed");
        s.child = child;
        if (s.scenario.visible) ShowWindow(hwnd, s.scenario.noActivate ? SW_SHOWNOACTIVATE : SW_SHOW);
        if (s.scenario.visible && !s.scenario.noActivate) {
            SetForegroundWindow(hwnd); SetFocus(hwnd);
            if (GetForegroundWindow() != hwnd) throw std::runtime_error("Owned window could not acquire foreground");
        }
        if (s.scenario.disabled) EnableWindow(hwnd, FALSE);
        SetCapture(child);
        if (GetCapture() != child) throw std::runtime_error("Owned child capture was not established");
        s.record("ready-child-captured", hwnd); SetEvent(s.ready.value);
        MSG message{}; BOOL result;
        while ((result = GetMessageW(&message, nullptr, 0, 0)) > 0) {
            TranslateMessage(&message); DispatchMessageW(&message);
        }
        if (result == -1) throw std::runtime_error("GetMessage failed");
    } catch (const std::exception& error) {
        s.error(error.what()); SetEvent(s.ready.value);
    }
    ReleaseCapture();
    if (IsWindow(s.window.load())) DestroyWindow(s.window.load());
    s.record("owner-thread-finished"); return s.failed ? 1 : 0;
}
bool inject(State& s, INPUT* values, UINT count, const char* phase) {
    SetLastError(0); const UINT sent = SendInput(count, values, sizeof(INPUT)); const DWORD error = GetLastError();
    s.record(phase, nullptr, 0, 0, 0, "{\"requested\":" + std::to_string(count) + ",\"sent\":" +
        std::to_string(sent) + ",\"error\":" + std::to_string(error) + "}");
    if (sent != count) s.error("SendInput did not insert the complete controlled stimulus");
    return sent == count;
}
bool mouse(State& s, POINT point, DWORD button, const char* phase) {
    const LONG left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN),
        width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (width <= 1 || height <= 1) { s.error("Invalid virtual desktop dimensions"); return false; }
    INPUT input{}; input.type = INPUT_MOUSE;
    input.mi.dx = static_cast<LONG>((static_cast<long long>(point.x - left) * 65535) / (width - 1));
    input.mi.dy = static_cast<LONG>((static_cast<long long>(point.y - top) * 65535) / (height - 1));
    input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | button;
    input.mi.dwExtraInfo = ControlledInputTag;
    if (button & MOUSEEVENTF_LEFTDOWN) {
        if (++s.leftDownInjections != 1) { s.error("Repeated controlled left down is forbidden"); return false; }
    }
    s.record("controlled-mouse-request", nullptr, 0, 0, 0,
        "{\"x\":" + std::to_string(point.x) + ",\"y\":" + std::to_string(point.y) +
        ",\"normalizedX\":" + std::to_string(input.mi.dx) + ",\"normalizedY\":" + std::to_string(input.mi.dy) +
        ",\"flags\":" + std::to_string(input.mi.dwFlags) + "}");
    return inject(s, &input, 1, phase);
}
void escape(State& s) {
    INPUT keys[2]{};
    keys[0].type = keys[1].type = INPUT_KEYBOARD; keys[0].ki.wVk = keys[1].ki.wVk = VK_ESCAPE;
    keys[1].ki.dwFlags = KEYEVENTF_KEYUP;
    inject(s, keys, 2, "controlled-SendInput-Escape");
}
bool wait(HANDLE event, DWORD milliseconds) { return WaitForSingleObject(event, milliseconds) == WAIT_OBJECT_0; }
bool cursorReached(POINT target) {
    const ULONGLONG deadline = GetTickCount64() + 500;
    do {
        POINT actual{};
        if (GetCursorPos(&actual) && std::abs(actual.x - target.x) <= 1 && std::abs(actual.y - target.y) <= 1) return true;
        Sleep(5);
    } while (GetTickCount64() < deadline);
    return false;
}
bool ownedWindow(const State& s, HWND window) {
    DWORD process = 0;
    return window && GetWindowThreadProcessId(window, &process) == s.threadId.load() && process == GetCurrentProcessId();
}

std::string observe(const Scenario& scenario, const fs::path& output) {
    State s(scenario, output); POINT original{}; const bool originalOk = GetCursorPos(&original) != FALSE;
    if (!originalOk || (GetAsyncKeyState(VK_LBUTTON) & 0x8000) || (GetAsyncKeyState(VK_ESCAPE) & 0x8000))
        throw std::runtime_error("Initial desktop cursor/key state is not neutral");
    OwnedHandle thread{CreateThread(nullptr, 0, uiThread, &s, 0, nullptr)};
    if (!thread.value) throw std::runtime_error("Cannot create owned UI thread");
    if (!wait(s.ready.value, 3000)) s.error("Owned UI setup deadline exceeded");
    HWND hwnd = s.window.load(); POINT start{30, 30};
    if (!s.failed && ClientToScreen(hwnd, &start)) {
        s.inputX = start.x; s.inputY = start.y;
        const POINT initial{start.x - (scenario.leftButton ? 2 : 0), start.y};
        const bool positioned = mouse(s, initial, 0, "controlled-initial-neutral-pointer");
        if (positioned && !cursorReached(initial)) s.error("Controlled initial pointer did not reach its declared screen position");
        if (!s.failed && scenario.leftButton) {
            if (!PostMessageW(hwnd, PrepareInput, 0, 0)) s.error("Could not schedule owned input preparation");
            else if (!wait(s.inputPrepared.value, 1000)) s.error("Owned input preparation deadline exceeded");
            if (!s.failed) {
                const bool moved = mouse(s, start, 0, "controlled-neutral-pointer");
                if (moved && !wait(s.neutralSeen.value, 1000)) s.error("Owned child did not observe the tagged neutral pointer before deadline");
            }
            if (!s.failed && !controlledTargetReady(s)) s.error("Owned input target changed before controlled left down");
            if (!s.failed) {
                const bool pressed = mouse(s, start, MOUSEEVENTF_LEFTDOWN, "controlled-left-down");
                if (pressed && !wait(s.buttonSeen.value, 1000)) s.error("Controlled left down was not observed by owned child");
            }
        }
        if (!s.failed) {
            if (!PostMessageW(hwnd, Begin, 0, 0)) s.error("Could not schedule owned synchronous command");
            HANDLE signals[] = {s.returned.value, s.entered.value};
            const DWORD outcome = WaitForMultipleObjects(2, signals, FALSE, 2000);
            s.record("wait-command-entry-or-return", hwnd, 0, outcome);
            if (outcome == WAIT_TIMEOUT || outcome == WAIT_FAILED) s.error("Command neither entered nor returned before deadline");
            if (!wait(s.returned.value, 0)) {
                // The injected displacement is independent of whether User32
                // decides that this style/button condition is movable.
                POINT target{start.x + 37, start.y + 23}; mouse(s, target, 0, "controlled-move-37-23");
                const bool moving = wait(s.movingSeen.value, 400);
                s.record("moving-observation-window", hwnd, 0, moving ? 1 : 0);
                if (std::string(scenario.termination) == "mouse-up") mouse(s, target, MOUSEEVENTF_LEFTUP, "controlled-left-up");
                else if (std::string(scenario.termination) == "escape") {
                    if (ownedWindow(s, hwnd) && GetForegroundWindow() == hwnd) escape(s);
                    else s.error("Escape stimulus lost its owned foreground target");
                } else {
                    const bool posted = PostMessageW(hwnd, WM_CANCELMODE, 0, 0) != FALSE;
                    s.record("controlled-WM_CANCELMODE", hwnd, WM_CANCELMODE, posted);
                    if (!posted) s.error("Could not post owned cancel stimulus");
                }
            }
            if (!wait(s.returned.value, 2000)) {
                s.error("Synchronous command return deadline exceeded; fallback cancellation required");
                PostMessageW(hwnd, WM_CANCELMODE, 0, 0);
                PostMessageW(hwnd, WM_KEYDOWN, VK_ESCAPE, 0);
                PostMessageW(hwnd, WM_KEYUP, VK_ESCAPE, 0);
            }
        }
    } else if (!s.failed) s.error("ClientToScreen failed");
    // Always release the injected button, including immediate-return and error
    // cases, before requesting owner-thread destruction or any forced exit.
    mouse(s, original, MOUSEEVENTF_LEFTUP, "cleanup-left-up-and-restore-cursor");
    if (s.invoked && !wait(s.returned.value, 1000)) s.error("Command still blocked after fallback cancellation");
    if (ownedWindow(s, hwnd)) PostMessageW(hwnd, Finish, 0, 0);
    if (!wait(thread.value, 2000)) {
        s.error("Owned UI thread did not finish; terminating only this probe process");
        write(output / (std::string(scenario.id) + ".timeout.json"), "{\"complete\":false,\"cleanupConfirmed\":false}");
        // Never detach a thread that still points at stack state or terminate a
        // foreign process/thread. The workflow separately bounds this process.
        TerminateProcess(GetCurrentProcess(), 124);
        std::abort();
    }
    const ULONGLONG releaseDeadline = GetTickCount64() + 500;
    while ((GetAsyncKeyState(VK_LBUTTON) & 0x8000) && GetTickCount64() < releaseDeadline) Sleep(5);
    s.record("cleanup-observed-after-owner-join");
    const bool cleaned = !ownedWindow(s, s.window.load()) && !ownedWindow(s, s.child.load()) && !(GetAsyncKeyState(VK_LBUTTON) & 0x8000);
    const bool buttonMatches = !!(s.asyncButtonBefore & 0x8000) == scenario.leftButton &&
        !!(s.queuedButtonBefore & 0x8000) == scenario.leftButton;
    if (!cleaned) s.error("Owned windows or injected button survived cleanup");
    if (s.invoked && !buttonMatches) s.error("Button state at the actual command did not match the declared case");
    if (!s.invoked || !s.didReturn || !s.captureBeforeChild || !s.captureAfterReleaseNull || !s.releaseSucceeded)
        s.error("Command/capture observation was incomplete");
    std::ostringstream row;
    row << "{\"id\":" << quote(scenario.id) << ",\"journal\":" << quote(std::string(scenario.id) + ".jsonl")
      << ",\"status\":" << quote(s.failed ? "failed" : "observed")
      << ",\"visible\":" << boolean(scenario.visible) << ",\"borderless\":" << boolean(scenario.borderless)
      << ",\"disabled\":" << boolean(scenario.disabled) << ",\"noActivate\":" << boolean(scenario.noActivate)
      << ",\"leftButton\":" << boolean(scenario.leftButton) << ",\"termination\":" << quote(scenario.termination)
      << ",\"invoked\":" << boolean(s.invoked) << ",\"returned\":" << boolean(s.didReturn)
      << ",\"returnValue\":" << quote(std::to_string(static_cast<long long>(s.returnValue)))
      << ",\"captureBeforeChild\":" << boolean(s.captureBeforeChild) << ",\"releaseSucceeded\":" << boolean(s.releaseSucceeded)
      << ",\"captureAfterReleaseNull\":" << boolean(s.captureAfterReleaseNull) << ",\"buttonMatches\":" << boolean(buttonMatches)
      << ",\"inputPrepared\":" << boolean(s.prepared) << ",\"neutralPointerObserved\":" << boolean(s.neutralObserved)
      << ",\"controlledLeftObserved\":" << boolean(s.controlledDownObserved) << ",\"leftDownInjections\":" << s.leftDownInjections
      << ",\"before\":" << rectangle(s.before) << ",\"after\":" << rectangle(s.after)
      << ",\"enters\":" << s.enters << ",\"exits\":" << s.exits << ",\"movingMessages\":" << s.moving
      << ",\"moveMessages\":" << s.moves << ",\"captureChanges\":" << s.captureChanges
      << ",\"records\":" << s.records << ",\"ownerThreadJoined\":true,\"cleanupConfirmed\":" << boolean(cleaned) << '}';
    write(output / (std::string(scenario.id) + ".json"), row.str()); return row.str();
}
int wmain(int argc, wchar_t** argv) {
    try {
        const auto environment = [](const char* key) { const char* value = std::getenv(key); return std::string(value ? value : ""); };
        if (environment("GITHUB_ACTIONS") != "true" || environment("RUNNER_ENVIRONMENT") != "github-hosted" || environment("RUNNER_OS") != "Windows")
            throw std::runtime_error("Window move reference requires GitHub-hosted Windows");
        if (argc != 2) throw std::runtime_error("Expected one output directory");
        const fs::path output = fs::absolute(argv[1]); fs::create_directories(output);
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX); const bool dpiAware = SetProcessDPIAware() != FALSE;
        using VersionFunction = LONG (WINAPI*)(OSVERSIONINFOW*);
        OSVERSIONINFOW version{}; version.dwOSVersionInfoSize = sizeof(version);
        const auto getVersion = reinterpret_cast<VersionFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
        const bool versionOk = getVersion && getVersion(&version) == 0;
        RECT workArea{}; const bool workAreaOk = SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0) != FALSE;
        WNDCLASSW type{}; type.lpfnWndProc = windowProc; type.hInstance = GetModuleHandleW(nullptr);
        type.lpszClassName = ClassName; type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        type.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
        if (!RegisterClassW(&type)) throw std::runtime_error("Cannot register owned window class");
        const Scenario cases[] = {
            {"caption-left-up", false, true, true, false, false, "mouse-up"},
            {"borderless-left-up", true, true, true, false, false, "mouse-up"},
            {"caption-no-left-up", false, false, true, false, false, "mouse-up"},
            {"caption-no-left-escape", false, false, true, false, false, "escape"},
            {"disabled-no-left-cancel", false, false, true, true, false, "cancel-mode"},
            {"hidden-no-left-cancel", false, false, false, false, false, "cancel-mode"},
            {"noactivate-no-left-cancel", false, false, true, false, true, "cancel-mode"},
        };
        std::vector<std::string> rows;
        const auto save = [&](bool completed, bool cleanup) {
            std::ostringstream json;
            json << "{\"schema\":1,\"sourceCommit\":" << quote(environment("GITHUB_SHA"))
              << ",\"runId\":" << quote(environment("GITHUB_RUN_ID"))
              << ",\"fixedSource\":\"dec49af97e174d31059c3ccd7efc700ba3c6b788 WindowFormUnit.cpp:1483-1488\""
              << ",\"scope\":\"Owned HWND User32 synchronous WM_SYSCOMMAND 0xF012; not VCL or KRKR2 Layer capture, not physical hardware\""
              << ",\"globalInputUsed\":true,\"controlledSendInput\":true,\"physicalHardwareClaim\":false"
              << ",\"focusabilityIsDisabledClaim\":false,\"dpiAware\":" << boolean(dpiAware)
              << ",\"platform\":{\"architecture\":" << quote(sizeof(void*) == 8 ? "x64" : "x86")
              << ",\"windowsVersion\":" << quote(versionOk ? std::to_string(version.dwMajorVersion) + "." +
                  std::to_string(version.dwMinorVersion) + "." + std::to_string(version.dwBuildNumber) : "unavailable")
              << ",\"workAreaOk\":" << boolean(workAreaOk) << ",\"workArea\":" << rectangle(workArea)
              << ",\"virtualDesktop\":[" << GetSystemMetrics(SM_XVIRTUALSCREEN) << ',' << GetSystemMetrics(SM_YVIRTUALSCREEN)
              << ',' << GetSystemMetrics(SM_CXVIRTUALSCREEN) << ',' << GetSystemMetrics(SM_CYVIRTUALSCREEN) << "]}"
              << ",\"completed\":" << boolean(completed) << ",\"classCleanupConfirmed\":" << boolean(cleanup)
              << ",\"expectedCases\":7,\"observedCases\":" << rows.size() << ",\"cases\":[";
            for (size_t i = 0; i < rows.size(); i++) { if (i) json << ','; json << rows[i]; }
            json << "]}"; write(output / "observations.json", json.str());
        };
        save(false, false);
        for (const auto& scenario : cases) {
            std::cout << "BEGIN " << scenario.id << std::endl;
            rows.push_back(observe(scenario, output)); save(false, false);
            std::cout << "OBSERVED " << scenario.id << std::endl;
        }
        const bool cleanup = UnregisterClassW(ClassName, GetModuleHandleW(nullptr)) != FALSE;
        save(true, cleanup);
        bool failed = !cleanup;
        for (const auto& row : rows) if (row.find("\"status\":\"failed\"") != std::string::npos) failed = true;
        std::cout << "COMPLETE " << rows.size() << " observations; no browser compatibility pass claim" << std::endl;
        return failed ? 2 : 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl; return 1;
    }
}
