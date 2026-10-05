// GitHub-hosted User32 reference: owned HWND/HMENU, not legacy VCL behavior.
// Fixed KRKR2 dec49af97e174d31059c3ccd7efc700ba3c6b788:
// WindowImpl.cpp:1694-1820, WindowFormUnit.cpp:1553-1691.
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-adjustwindowrectexfordpi
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getmenubarinfo
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <uxtheme.h>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
constexpr wchar_t ClassName[] = L"KrkrHostedWindowGeometryReference";
const char* boolean(bool value) { return value ? "true" : "false"; }
std::string env(const char* key) { const char* value = std::getenv(key); return value ? value : ""; }
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
std::string rect(const RECT& r) {
    return '[' + std::to_string(r.left) + ',' + std::to_string(r.top) + ',' +
        std::to_string(r.right) + ',' + std::to_string(r.bottom) + ']';
}
std::string handle(HWND window) {
    std::ostringstream out; out << "\"0x" << std::hex << reinterpret_cast<std::uintptr_t>(window) << '"'; return out.str();
}
void write(const fs::path& path, const std::string& text) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file << text << '\n'; file.flush();
    if (!file) throw std::runtime_error("Cannot preserve geometry evidence");
}
void require(bool ok, const char* operation) {
    if (!ok) throw std::runtime_error(std::string(operation) + " failed: " + std::to_string(GetLastError()));
}
using GetDpi = UINT (WINAPI*)(HWND);
using AdjustForDpi = BOOL (WINAPI*)(LPRECT, DWORD, BOOL, DWORD, UINT);
GetDpi getDpi = nullptr;
AdjustForDpi adjustForDpi = nullptr;
struct Case {
    std::string id;
    std::ofstream events, measurements;
    unsigned eventCount = 0, measurementCount = 0;
    bool failed = false;
    ULONGLONG started = GetTickCount64();
    explicit Case(const std::string& name, const fs::path& output) : id(name),
        events(output / (name + ".events.jsonl"), std::ios::binary),
        measurements(output / (name + ".measurements.jsonl"), std::ios::binary) {
        require(!!events && !!measurements, "open journals");
    }
    void event(const char* role, HWND window, UINT message, WPARAM wp, LPARAM lp) noexcept {
        try {
            if (eventCount >= 8192) { failed = true; return; }
            events << "{\"sequence\":" << eventCount++ << ",\"elapsedMs\":" << GetTickCount64() - started
              << ",\"role\":" << quote(role) << ",\"window\":" << handle(window) << ",\"message\":" << message
              << ",\"wParam\":" << quote(std::to_string(static_cast<unsigned long long>(wp)))
              << ",\"lParam\":" << quote(std::to_string(static_cast<long long>(lp)));
            if (message == WM_GETMINMAXINFO) {
                const auto* value = reinterpret_cast<const MINMAXINFO*>(lp);
                events << ",\"minTrack\":[" << value->ptMinTrackSize.x << ',' << value->ptMinTrackSize.y
                  << "],\"maxTrack\":[" << value->ptMaxTrackSize.x << ',' << value->ptMaxTrackSize.y << ']';
            }
            events << "}\n"; events.flush(); if (!events) failed = true;
        } catch (...) { failed = true; }
    }
};
struct Binding { Case* owner; const char* role; };
LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    auto* binding = reinterpret_cast<Binding*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        binding = static_cast<Binding*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(binding));
    }
    // Record the result of default processing; impose no custom MINMAXINFO.
    const LRESULT result = DefWindowProcW(window, message, wp, lp);
    if (binding && (message == WM_SIZE || message == WM_MOVE || message == WM_WINDOWPOSCHANGED ||
        message == WM_GETMINMAXINFO || message == WM_NCCALCSIZE || message == WM_DESTROY || message == WM_NCDESTROY))
        binding->owner->event(binding->role, window, message, wp, lp);
    return result;
}
void pump() {
    const ULONGLONG deadline = GetTickCount64() + 500;
    MSG message{}; unsigned count = 0;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (++count > 4096 || GetTickCount64() > deadline) throw std::runtime_error("Bounded geometry pump exhausted");
        if (message.message == WM_QUIT) throw std::runtime_error("Unexpected quit in geometry observation");
        TranslateMessage(&message); DispatchMessageW(&message);
    }
}
struct OwnedWindow {
    HWND value = nullptr;
    ~OwnedWindow() {
        if (value && IsWindow(value) && !DestroyWindow(value)) {
            // A failed cleanup must not retain a pointer to a dead stack binding.
            auto* binding = reinterpret_cast<Binding*>(GetWindowLongPtrW(value, GWLP_USERDATA));
            if (binding) binding->owner->failed = true;
            SetWindowLongPtrW(value, GWLP_USERDATA, 0);
        }
    }
    void close() { if (value) { const HWND old = value; require(DestroyWindow(old) != FALSE, "DestroyWindow");
        require(!IsWindow(old), "HWND cleanup confirmation"); value = nullptr; } }
};
struct OwnedMenu {
    HMENU value = nullptr;
    ~OwnedMenu() { if (value && IsMenu(value)) DestroyMenu(value); }
    void close() { if (value) { const HMENU old = value; require(DestroyMenu(old) != FALSE, "DestroyMenu");
        require(!IsMenu(old), "HMENU cleanup confirmation"); value = nullptr; } }
};
struct Style { const char* id; DWORD style, extended; };
const Style Styles[] = {
    {"popup", WS_POPUP, 0}, {"popup-border", WS_POPUP | WS_BORDER, 0},
    {"caption", WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, 0},
    {"resizable", WS_OVERLAPPEDWINDOW, 0},
    {"tool-caption", WS_CAPTION | WS_SYSMENU, WS_EX_TOOLWINDOW},
    {"tool-resizable", WS_OVERLAPPEDWINDOW, WS_EX_TOOLWINDOW},
};
const char* MenuKinds[] = {"absent", "empty", "short", "long-labels"};
std::string geometry(HWND window) {
    RECT outer{}, client{}; POINT origin{};
    require(GetWindowRect(window, &outer) != FALSE, "GetWindowRect");
    require(GetClientRect(window, &client) != FALSE, "GetClientRect");
    require(ClientToScreen(window, &origin) != FALSE, "ClientToScreen");
    const UINT dpi = getDpi(window); require(dpi != 0, "GetDpiForWindow");
    std::ostringstream out;
    out << "{\"handle\":" << handle(window) << ",\"outerScreen\":" << rect(outer) << ",\"clientLocal\":" << rect(client)
      << ",\"clientScreen\":[" << origin.x << ',' << origin.y << ',' << origin.x + client.right << ',' << origin.y + client.bottom << ']'
      << ",\"style\":" << static_cast<DWORD>(GetWindowLongPtrW(window, GWL_STYLE))
      << ",\"exstyle\":" << static_cast<DWORD>(GetWindowLongPtrW(window, GWL_EXSTYLE))
      << ",\"dpi\":" << dpi << ",\"visible\":" << boolean(IsWindowVisible(window) != FALSE) << '}';
    return out.str();
}
std::string scroll(HWND window, int bar, bool requested) {
    SCROLLINFO info{}; info.cbSize = sizeof(info); info.fMask = SIF_ALL;
    SetLastError(0); const bool ok = GetScrollInfo(window, bar, &info) != FALSE; const DWORD error = GetLastError();
    SCROLLBARINFO visual{}; visual.cbSize = sizeof(visual);
    SetLastError(0); const bool visualOk = GetScrollBarInfo(window, bar == SB_HORZ ? OBJID_HSCROLL : OBJID_VSCROLL, &visual) != FALSE;
    const DWORD visualError = GetLastError();
    std::ostringstream out;
    out << "{\"requested\":" << boolean(requested) << ",\"infoOk\":" << boolean(ok) << ",\"error\":" << error
      << ",\"range\":[" << info.nMin << ',' << info.nMax << "],\"page\":" << info.nPage << ",\"position\":" << info.nPos
      << ",\"trackPosition\":" << info.nTrackPos << ",\"visualOk\":" << boolean(visualOk)
      << ",\"visualError\":" << visualError << ",\"screenRect\":" << rect(visual.rcScrollBar) << ",\"states\":[";
    for (unsigned i = 0; i < 6; ++i) { if (i) out << ','; out << visual.rgstate[i]; }
    out << "]}"; return out.str();
}
std::string menuGeometry(HWND window, HMENU menu) {
    MENUBARINFO bar{}; bar.cbSize = sizeof(bar);
    SetLastError(0); const bool ok = GetMenuBarInfo(window, OBJID_MENU, 0, &bar) != FALSE; const DWORD error = GetLastError();
    const int count = menu ? GetMenuItemCount(menu) : 0; require(count >= 0, "GetMenuItemCount");
    std::ostringstream out;
    out << "{\"attached\":" << boolean(GetMenu(window) == menu && menu != nullptr)
      << ",\"itemCount\":" << count << ",\"barInfoOk\":" << boolean(ok) << ",\"barInfoError\":" << error
      << ",\"barScreen\":" << rect(bar.rcBar) << ",\"items\":[";
    for (int i = 0; i < count; ++i) {
        RECT item{}; SetLastError(0); const bool itemOk = GetMenuItemRect(window, menu, static_cast<UINT>(i), &item) != FALSE;
        const DWORD itemError = GetLastError();
        if (i) out << ',';
        out << "{\"index\":" << i << ",\"ok\":" << boolean(itemOk) << ",\"error\":" << itemError << ",\"screen\":" << rect(item) << '}';
    }
    out << "]}"; return out.str();
}
void setSize(HWND window, int width, int height) {
    require(width > 0 && height > 0 && width <= 4096 && height <= 4096, "bounded size request");
    require(SetWindowPos(window, nullptr, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE) != FALSE, "SetWindowPos");
    if (GetMenu(window)) require(DrawMenuBar(window) != FALSE, "DrawMenuBar");
    pump();
}
std::string observe(const Style& style, unsigned menuKind, const fs::path& output, POINT origin) {
    const std::string id = std::string(style.id) + '-' + MenuKinds[menuKind];
    Case state(id, output); Binding parentBinding{&state, "parent"};
    // Exceptional unwinding destroys the attached window before its menu.
    // The successful path explicitly detaches and verifies both destructions.
    OwnedMenu menu; OwnedWindow parent;
    bool cleaned = false; std::string failure;
    try {
        if (menuKind) {
            menu.value = CreateMenu(); require(menu.value != nullptr, "CreateMenu");
            const unsigned count = menuKind == 1 ? 0 : menuKind == 2 ? 3 : 6;
            for (unsigned i = 0; i < count; ++i) {
                const std::wstring label = menuKind == 2 ? L"Item " + std::to_wstring(i)
                    : L"Geometry measurement item " + std::to_wstring(i);
                require(AppendMenuW(menu.value, MF_STRING, 100 + i, label.c_str()) != FALSE, "AppendMenu");
            }
        }
        parent.value = CreateWindowExW(style.extended, ClassName, L"Owned geometry reference", style.style | WS_CLIPCHILDREN,
            origin.x, origin.y, 640, 360, nullptr, menu.value, GetModuleHandleW(nullptr), &parentBinding);
        require(parent.value != nullptr, "Create parent");
        require(GetMenu(parent.value) == menu.value, "owned menu attachment");
        ShowWindow(parent.value, SW_SHOWNOACTIVATE); pump();
        const char* phases[] = {"outer-wide", "outer-narrow", "outer-restored", "nominal-client", "measured-client-correction"};
        for (unsigned phase = 0; phase < 5; ++phase) {
            if (GetTickCount64() - state.started > 10000) throw std::runtime_error("Owned geometry case exceeded 10 seconds");
            RECT estimate{}; int requestedWidth = phase == 1 ? 240 : 640, requestedHeight = 360;
            if (phase == 3) {
                estimate = {0, 0, 320, 180};
                require(adjustForDpi(&estimate, static_cast<DWORD>(GetWindowLongPtrW(parent.value, GWL_STYLE)), menu.value != nullptr,
                    static_cast<DWORD>(GetWindowLongPtrW(parent.value, GWL_EXSTYLE)), getDpi(parent.value)) != FALSE, "AdjustWindowRectExForDpi");
                requestedWidth = estimate.right - estimate.left; requestedHeight = estimate.bottom - estimate.top;
            } else if (phase == 4) {
                RECT outer{}, client{}; require(GetWindowRect(parent.value, &outer) != FALSE, "correction outer");
                require(GetClientRect(parent.value, &client) != FALSE, "correction client");
                requestedWidth = outer.right - outer.left + 320 - client.right;
                requestedHeight = outer.bottom - outer.top + 180 - client.bottom;
            }
            setSize(parent.value, requestedWidth, requestedHeight);
            RECT parentClient{}; require(GetClientRect(parent.value, &parentClient) != FALSE, "parent client");
            require(parentClient.right > 0 && parentClient.bottom > 0, "positive parent client");
            const bool clientMatched = parentClient.right == 320 && parentClient.bottom == 180;
            if (phase == 4 && !clientMatched) {
                // Keep all eight raw rows; a failed bounded correction is not
                // a successful client-size request.
                state.failed = true; failure = "Single measured correction did not reach requested client size";
            }
            for (unsigned sunken = 0; sunken < 2; ++sunken) for (unsigned bars = 0; bars < 4; ++bars) {
                Binding childBinding{&state, "viewport"}, paintBinding{&state, "paintbox"};
                OwnedWindow child, paint;
                child.value = CreateWindowExW(sunken ? WS_EX_CLIENTEDGE : 0, ClassName, L"Owned viewport",
                    WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | (bars & 1 ? WS_HSCROLL : 0) | (bars & 2 ? WS_VSCROLL : 0),
                    0, 0, parentClient.right, parentClient.bottom, parent.value, nullptr, GetModuleHandleW(nullptr), &childBinding);
                require(child.value != nullptr, "Create viewport");
                RECT viewport{}; require(GetClientRect(child.value, &viewport) != FALSE, "viewport client");
                // Explicit independent content/range geometry, not VCL autoscroll.
                if (bars & 1) { SCROLLINFO info{sizeof(info), SIF_RANGE | SIF_PAGE | SIF_POS, 0, 959,
                    static_cast<UINT>(viewport.right), 17, 0}; SetScrollInfo(child.value, SB_HORZ, &info, TRUE); }
                if (bars & 2) { SCROLLINFO info{sizeof(info), SIF_RANGE | SIF_PAGE | SIF_POS, 0, 719,
                    static_cast<UINT>(viewport.bottom), 23, 0}; SetScrollInfo(child.value, SB_VERT, &info, TRUE); }
                const int left = 11 - (bars & 1 ? GetScrollPos(child.value, SB_HORZ) : 0),
                    top = -7 - (bars & 2 ? GetScrollPos(child.value, SB_VERT) : 0);
                paint.value = CreateWindowExW(0, ClassName, L"Owned oversized paintbox", WS_CHILD | WS_VISIBLE,
                    left, top, 960, 720, child.value, nullptr, GetModuleHandleW(nullptr), &paintBinding);
                require(paint.value != nullptr, "Create paintbox"); pump();
                state.measurements << "{\"sequence\":" << state.measurementCount++ << ",\"case\":" << quote(id)
                  << ",\"phase\":" << quote(phases[phase]) << ",\"phaseIndex\":" << phase
                  << ",\"sunken\":" << boolean(sunken != 0) << ",\"scrollbars\":" << bars
                  << ",\"requestedOuter\":[" << requestedWidth << ',' << requestedHeight << ']'
                  << ",\"requestedClient\":" << (phase >= 3 ? "[320,180]" : "null")
                  << ",\"adjustedRect\":" << (phase == 3 ? rect(estimate) : "null")
                  << ",\"clientTargetMatched\":" << (phase >= 3 ? boolean(clientMatched) : "null")
                  << ",\"correctionIterations\":" << (phase == 4 ? 1 : 0)
                  << ",\"parent\":" << geometry(parent.value) << ",\"viewport\":" << geometry(child.value)
                  << ",\"paintbox\":" << geometry(paint.value) << ",\"menu\":" << menuGeometry(parent.value, menu.value)
                  << ",\"horizontal\":" << scroll(child.value, SB_HORZ, (bars & 1) != 0)
                  << ",\"vertical\":" << scroll(child.value, SB_VERT, (bars & 2) != 0) << "}\n";
                state.measurements.flush(); require(!!state.measurements, "preserve measurement");
                paint.close(); child.close();
            }
        }
        if (menu.value) require(SetMenu(parent.value, nullptr) != FALSE, "detach owned menu");
        parent.close(); menu.close(); cleaned = true;
    } catch (const std::exception& error) {
        failure = error.what(); state.failed = true;
        bool detached = true;
        if (parent.value && IsWindow(parent.value) && menu.value) detached = SetMenu(parent.value, nullptr) != FALSE;
        const bool parentGone = !parent.value || !IsWindow(parent.value) || DestroyWindow(parent.value) != FALSE;
        if (parentGone) parent.value = nullptr;
        const bool menuGone = !menu.value || !IsMenu(menu.value) || (detached && DestroyMenu(menu.value) != FALSE);
        if (menuGone) menu.value = nullptr;
        cleaned = parentGone && menuGone;
    }
    std::ostringstream row;
    row << "{\"id\":" << quote(id) << ",\"styleName\":" << quote(style.id) << ",\"style\":" << style.style
      << ",\"exstyle\":" << style.extended << ",\"menuKind\":" << quote(MenuKinds[menuKind])
      << ",\"status\":" << quote(!state.failed && state.measurementCount == 40 && cleaned ? "observed" : "failed")
      << ",\"measurements\":" << state.measurementCount << ",\"events\":" << state.eventCount
      << ",\"measurementFile\":" << quote(id + ".measurements.jsonl") << ",\"eventFile\":" << quote(id + ".events.jsonl")
      << ",\"cleanupConfirmed\":" << boolean(cleaned) << ",\"elapsedMs\":" << GetTickCount64() - state.started
      << ",\"error\":" << (failure.empty() ? "null" : quote(failure)) << '}';
    write(output / (id + ".json"), row.str()); return row.str();
}
struct Deadline { HANDLE finished; fs::path output; };
DWORD WINAPI watchdog(void* pointer) {
    auto* deadline = static_cast<Deadline*>(pointer);
    if (WaitForSingleObject(deadline->finished, 90000) != WAIT_OBJECT_0) {
        try { write(deadline->output / "timeout.json", "{\"timedOut\":true,\"deadlineMs\":90000,\"cleanupConfirmed\":false}"); } catch (...) {}
        TerminateProcess(GetCurrentProcess(), 124);
    }
    return 0;
}
int wmain(int argc, wchar_t** argv) {
    HANDLE finished = nullptr, timer = nullptr; bool registered = false; int exitCode = 1;
    Deadline deadline{};
    try {
        if (env("GITHUB_ACTIONS") != "true" || env("RUNNER_ENVIRONMENT") != "github-hosted" || env("RUNNER_OS") != "Windows")
            throw std::runtime_error("Geometry reference requires GitHub-hosted Windows");
        if (argc != 2) throw std::runtime_error("Expected output directory");
        deadline.output = fs::absolute(argv[1]); fs::create_directories(deadline.output);
        finished = CreateEventW(nullptr, TRUE, FALSE, nullptr); require(finished != nullptr, "Create deadline event");
        deadline.finished = finished; timer = CreateThread(nullptr, 0, watchdog, &deadline, 0, nullptr); require(timer != nullptr, "Create watchdog");
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
        const bool dpiAware = SetProcessDPIAware() != FALSE;
        getDpi = reinterpret_cast<GetDpi>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
        adjustForDpi = reinterpret_cast<AdjustForDpi>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "AdjustWindowRectExForDpi"));
        require(getDpi && adjustForDpi, "required DPI entry points");
        using VersionFunction = LONG (WINAPI*)(OSVERSIONINFOW*);
        OSVERSIONINFOW version{}; version.dwOSVersionInfoSize = sizeof(version);
        const auto versionFunction = reinterpret_cast<VersionFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
        require(versionFunction && versionFunction(&version) == 0, "Windows version");
        RECT work{}; require(SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0) != FALSE, "work area");
        WNDCLASSW type{}; type.lpfnWndProc = windowProc; type.hInstance = GetModuleHandleW(nullptr);
        type.lpszClassName = ClassName; type.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
        require(RegisterClassW(&type) != 0, "RegisterClass"); registered = true;
        std::vector<std::string> rows;
        const auto save = [&](bool complete, bool classCleanup) {
            std::ostringstream json;
            json << "{\"schema\":1,\"sourceCommit\":" << quote(env("GITHUB_SHA")) << ",\"runId\":" << quote(env("GITHUB_RUN_ID"))
              << ",\"scope\":\"Owned User32 geometry; not VCL property retention, constraints or automatic scrolling\""
              << ",\"globalInputUsed\":false,\"displayModeChanged\":false,\"vclCompatibilityClaim\":false"
              << ",\"fixedSource\":\"dec49af97e174d31059c3ccd7efc700ba3c6b788 WindowImpl.cpp:1694-1820 WindowFormUnit.cpp:1553-1691\""
              << ",\"platform\":{\"windowsVersion\":" << quote(std::to_string(version.dwMajorVersion) + '.' + std::to_string(version.dwMinorVersion) + '.' + std::to_string(version.dwBuildNumber))
              << ",\"architecture\":" << quote(sizeof(void*) == 8 ? "x64" : "x86") << ",\"runner\":" << quote(env("PROBE_RUNNER_LABEL"))
              << ",\"systemDpiAwareRequested\":true,\"systemDpiAwareSucceeded\":" << boolean(dpiAware)
              << ",\"themeActive\":" << boolean(IsThemeActive() != FALSE) << ",\"appThemed\":" << boolean(IsAppThemed() != FALSE)
              << ",\"workArea\":" << rect(work) << ",\"metrics\":{\"cxFrame\":" << GetSystemMetrics(SM_CXFRAME)
              << ",\"cyFrame\":" << GetSystemMetrics(SM_CYFRAME) << ",\"cyCaption\":" << GetSystemMetrics(SM_CYCAPTION)
              << ",\"cyMenu\":" << GetSystemMetrics(SM_CYMENU) << ",\"cxVScroll\":" << GetSystemMetrics(SM_CXVSCROLL)
              << ",\"cyHScroll\":" << GetSystemMetrics(SM_CYHSCROLL) << "}}"
              << ",\"paintboxPolicy\":\"960x720 at (11,-7) minus explicit scroll position (17,23); not VCL autoscroll\""
              << ",\"completed\":" << boolean(complete) << ",\"classCleanupConfirmed\":" << boolean(classCleanup)
              << ",\"expectedCases\":24,\"expectedMeasurements\":960,\"observedCases\":" << rows.size() << ",\"cases\":[";
            for (size_t i = 0; i < rows.size(); ++i) { if (i) json << ','; json << rows[i]; }
            json << "]}"; write(deadline.output / "observations.json", json.str());
        };
        save(false, false);
        for (const auto& style : Styles) for (unsigned menu = 0; menu < 4; ++menu) {
            std::cout << "BEGIN " << style.id << '-' << MenuKinds[menu] << std::endl;
            rows.push_back(observe(style, menu, deadline.output, {work.left + 32, work.top + 32})); save(false, false);
        }
        const bool cleanup = UnregisterClassW(ClassName, GetModuleHandleW(nullptr)) != FALSE;
        registered = !cleanup; save(true, cleanup);
        bool failed = !cleanup;
        for (const auto& row : rows) if (row.find("\"status\":\"failed\"") != std::string::npos) failed = true;
        exitCode = failed ? 2 : 0;
        std::cout << "OBSERVED " << rows.size() << " cases; no VCL compatibility pass claim" << std::endl;
    } catch (const std::exception& error) { std::cerr << error.what() << std::endl; }
    if (registered) UnregisterClassW(ClassName, GetModuleHandleW(nullptr));
    if (finished) SetEvent(finished);
    if (timer) {
        if (WaitForSingleObject(timer, 5000) != WAIT_OBJECT_0) TerminateProcess(GetCurrentProcess(), 125);
        CloseHandle(timer);
    }
    if (finished) CloseHandle(finished);
    return exitCode;
}
