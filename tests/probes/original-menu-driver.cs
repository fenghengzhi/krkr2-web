// Compile and execute ONLY on GitHub-hosted Windows via original-runtime.yml.
// No hooks, injected code, global input, foreground changes or unrelated HWNDs.
// Published HWND/HMENU are checked against the held engine PID, a random caption,
// the owner's actual menu tree and two exact leaf captions before any key is posted.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class OriginalMenuReport
{
    public string State { get; set; } = "not-executable";
    public string Reason { get; set; } = "Observation has not completed.";
    public int EnginePid { get; set; }
    public string RequestedAction { get; set; }
    public int Flags { get; set; }
    public long OwnerHwnd { get; set; }
    public uint OwnerThreadId { get; set; }
    public long PopupHmenu { get; set; }
    public uint TargetCommandId { get; set; }
    public uint OtherCommandId { get; set; }
    public bool OwnedPopupActiveSeen { get; set; }
    public bool TargetHighlightSeen { get; set; }
    public bool TerminalKeyPosted { get; set; }
    public bool MenuExitSeen { get; set; }
    public int DownPresses { get; set; }
    public long CaseElapsedMs { get; set; }
    public long ProcessElapsedMs { get; set; }
    public long? RawReturn { get; set; }
    public int? TargetClicks { get; set; }
    public int? OtherClicks { get; set; }
    public string[] NativeEvents { get; set; } = new string[0];
    public List<Dictionary<string, object>> Trace { get; set; } = new List<Dictionary<string, object>>();
}

public static class OriginalMenuDriver
{
    private const uint ByPosition = 0x400, Highlighted = 0x80, Invalid = 0xffffffff;
    private const uint InMenuMode = 0x04, PopupMenuMode = 0x10;
    private const uint KeyDown = 0x100, KeyUp = 0x101, Down = 0x28, Enter = 0x0d, Escape = 0x1b;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int limit);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetMenu(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetSubMenu(IntPtr menu, int position);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetMenuItemID(IntPtr menu, int position);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetMenuState(IntPtr menu, uint position, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetMenuStringW(IntPtr menu, uint position, StringBuilder text, int limit, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(IntPtr window, uint message, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")]
    private static extern uint MapVirtualKeyW(uint code, uint kind);

    private static string[] ReadEvents(string path)
    {
        try
        {
            // Array.save replaces the evidence during observation. A transient
            // sharing/partial-write read never authorizes an input operation.
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(file, Encoding.UTF8, true))
                return reader.ReadToEnd().Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
        }
        catch (IOException) { return new string[0]; }
    }
    private static string Value(string[] rows, string prefix)
    {
        foreach (string row in rows) if (row.StartsWith(prefix, StringComparison.Ordinal)) return row.Substring(prefix.Length);
        return null;
    }
    private static bool Has(string[] rows, string exact)
    {
        return Array.IndexOf(rows, exact) >= 0;
    }
    private static string WindowCaption(IntPtr window)
    {
        var text = new StringBuilder(512);
        GetWindowTextW(window, text, text.Capacity);
        return text.ToString();
    }
    private static string MenuCaption(IntPtr menu, uint position)
    {
        var text = new StringBuilder(512);
        GetMenuStringW(menu, position, text, text.Capacity, ByPosition);
        return text.ToString();
    }
    private static bool ContainsMenu(IntPtr root, IntPtr wanted, int depth)
    {
        if (root == IntPtr.Zero || depth > 8) return false;
        if (root == wanted) return true;
        int count = GetMenuItemCount(root);
        if (count < 0 || count > 128) return false;
        for (int i = 0; i < count; i++)
            if (ContainsMenu(GetSubMenu(root, i), wanted, depth + 1)) return true;
        return false;
    }
    private static uint OwnedThread(Process engine, IntPtr owner, string token)
    {
        if (engine.HasExited) throw new InvalidOperationException("Held engine exited before owned input.");
        uint pid;
        uint thread = GetWindowThreadProcessId(owner, out pid);
        if (thread == 0 || pid != (uint)engine.Id)
            throw new InvalidOperationException("Published HWND does not belong to the held engine.");
        if (WindowCaption(owner) != "KRKR2 Menu " + token)
            throw new InvalidOperationException("Published HWND caption does not match this fixture.");
        return thread;
    }
    private static GuiThreadInfo ThreadInfo(uint thread)
    {
        if (thread == 0) throw new InvalidOperationException("A foreground-thread query is forbidden.");
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
        if (!GetGUIThreadInfo(thread, ref info))
            throw new InvalidOperationException("GetGUIThreadInfo failed: " + Marshal.GetLastWin32Error());
        return info;
    }
    private static void Log(OriginalMenuReport report, Stopwatch clock, string name, params object[] fields)
    {
        var row = new Dictionary<string, object> { { "event", name }, { "processMs", clock.ElapsedMilliseconds } };
        for (int i = 0; i < fields.Length; i += 2) row.Add((string)fields[i], fields[i + 1]);
        report.Trace.Add(row);
    }
    private static void PostKey(Process engine, IntPtr owner, string token, uint key,
        OriginalMenuReport report, Stopwatch clock)
    {
        OwnedThread(engine, owner, token);
        uint bits = 1u | (MapVirtualKeyW(key, 0) << 16) | (key == Down ? 0x01000000u : 0);
        foreach (bool up in new[] { false, true })
        {
            OwnedThread(engine, owner, token);
            uint message = up ? KeyUp : KeyDown;
            uint parameter = bits | (up ? 0xc0000000u : 0);
            bool posted = PostMessageW(owner, message, new IntPtr((long)key), new IntPtr((long)parameter));
            int error = posted ? 0 : Marshal.GetLastWin32Error();
            Log(report, clock, "owned-key-posted", "hwnd", owner.ToInt64(), "key", key,
                "up", up, "message", message, "lParam", parameter, "posted", posted, "error", error);
            if (!posted) throw new InvalidOperationException("Posting the owned key failed: " + error);
        }
    }

    public static OriginalMenuReport Observe(Process engine, string directory, string token,
        int flags, string action, Stopwatch processClock)
    {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" ||
            Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows")
            throw new InvalidOperationException("Only GitHub-hosted Windows observations are authorized.");
        if ((action != "select" && action != "cancel") || (flags != 0 && flags != 128 && flags != 256 && flags != 384))
            throw new InvalidOperationException("Only the bounded four-flag select/Esc matrix is supported.");

        var report = new OriginalMenuReport { EnginePid = engine.Id, Flags = flags, RequestedAction = action };
        string path = Path.Combine(directory, "native-events.txt");
        Stopwatch caseClock = null;
        IntPtr owner = IntPtr.Zero, menu = IntPtr.Zero;
        long nextKeyAt = 0;
        bool identityEstablished = false;
        uint lastGuiFlags = Invalid;
        int highlightedBeforeDown = -1;
        try
        {
            while (processClock.ElapsedMilliseconds < 30000)
            {
                string[] rows = ReadEvents(path);
                if (rows.Length > 0) report.NativeEvents = rows;
                string error = Value(rows, "error:");
                if (error != null) throw new InvalidOperationException("Original script error: " + error);
                if (caseClock == null && Has(rows, "popup-before"))
                {
                    caseClock = Stopwatch.StartNew();
                    Log(report, processClock, "popup-before-observed", "caseBudgetMs", 3000);
                }
                if (caseClock != null && caseClock.ElapsedMilliseconds >= 3000)
                    throw new InvalidOperationException("Case exceeded its 3000 ms deadline; no fallback Escape was sent.");
                if (!identityEstablished && caseClock != null)
                {
                    long hwnd, hmenu;
                    if (!long.TryParse(Value(rows, "window-hwnd:"), out hwnd) ||
                        !long.TryParse(Value(rows, "popup-hmenu:"), out hmenu))
                    {
                        Thread.Sleep(20);
                        continue;
                    }
                    owner = new IntPtr(hwnd);
                    menu = new IntPtr(hmenu);
                    report.OwnerThreadId = OwnedThread(engine, owner, token);
                    if (!ContainsMenu(GetMenu(owner), menu, 0) || GetMenuItemCount(menu) != 2 ||
                        MenuCaption(menu, 0) != "Target " + token || MenuCaption(menu, 1) != "Other " + token ||
                        GetSubMenu(menu, 0) != IntPtr.Zero || GetSubMenu(menu, 1) != IntPtr.Zero)
                        throw new InvalidOperationException("Published popup is not the owned two-leaf menu.");
                    report.TargetCommandId = GetMenuItemID(menu, 0);
                    report.OtherCommandId = GetMenuItemID(menu, 1);
                    if (report.TargetCommandId == 0 || report.TargetCommandId == Invalid ||
                        report.OtherCommandId == 0 || report.OtherCommandId == Invalid ||
                        report.TargetCommandId == report.OtherCommandId)
                        throw new InvalidOperationException("Leaf command IDs were not independently established.");
                    report.OwnerHwnd = hwnd;
                    report.PopupHmenu = hmenu;
                    identityEstablished = true;
                    Log(report, processClock, "owned-menu-identified", "hwnd", hwnd, "hmenu", hmenu,
                        "threadId", report.OwnerThreadId, "targetCommand", report.TargetCommandId,
                        "otherCommand", report.OtherCommandId);
                }
                // After recording menu exit, the script may destroy its HWND
                // while the process is still shutting down. No further input
                // is permitted or needed; consume only its preserved event log.
                if (identityEstablished && !report.MenuExitSeen && !engine.HasExited)
                {
                    OwnedThread(engine, owner, token);
                    GuiThreadInfo info = ThreadInfo(report.OwnerThreadId);
                    bool popupActive = (info.Flags & (InMenuMode | PopupMenuMode)) == (InMenuMode | PopupMenuMode) &&
                        info.MenuOwner == owner;
                    if (info.Flags != lastGuiFlags)
                    {
                        Log(report, processClock, "owned-thread-menu-state", "flags", info.Flags,
                            "menuOwner", info.MenuOwner.ToInt64(), "ownedPopupActive", popupActive);
                        lastGuiFlags = info.Flags;
                    }
                    if (popupActive) report.OwnedPopupActiveSeen = true;
                    if (report.TerminalKeyPosted && !popupActive) report.MenuExitSeen = true;
                    if (popupActive && !report.TerminalKeyPosted && processClock.ElapsedMilliseconds >= nextKeyAt)
                    {
                        // Two DOWN presses are the complete navigation budget for
                        // two leaves. No Home, repeated blind Enter or cleanup Esc.
                        uint targetState = GetMenuState(menu, 0, ByPosition);
                        uint otherState = GetMenuState(menu, 1, ByPosition);
                        if (targetState == Invalid || otherState == Invalid || (targetState & 3) != 0)
                            throw new InvalidOperationException("Menu leaves are unreadable or the target is disabled.");
                        bool highlighted = (targetState & Highlighted) != 0;
                        int highlightedIndex = highlighted ? 0 : (otherState & Highlighted) != 0 ? 1 : -1;
                        bool navigationObserved = highlightedIndex >= 0 && highlightedIndex != highlightedBeforeDown;
                        Log(report, processClock, "real-target-state", "state", targetState,
                            "otherState", otherState, "highlighted", highlighted,
                            "highlightedBeforeDown", highlightedBeforeDown,
                            "navigationObserved", navigationObserved, "downPresses", report.DownPresses);
                        if (action == "cancel")
                        {
                            PostKey(engine, owner, token, Escape, report, processClock);
                            report.TerminalKeyPosted = true;
                        }
                        else if (report.DownPresses > 0 && navigationObserved && highlighted)
                        {
                            report.TargetHighlightSeen = true;
                            PostKey(engine, owner, token, Enter, report, processClock);
                            report.TerminalKeyPosted = true;
                        }
                        else if (report.DownPresses == 0 || (report.DownPresses < 2 && navigationObserved))
                        {
                            highlightedBeforeDown = highlightedIndex;
                            PostKey(engine, owner, token, Down, report, processClock);
                            report.DownPresses++;
                            nextKeyAt = processClock.ElapsedMilliseconds + 120;
                        }
                        else if (report.DownPresses >= 2 && navigationObserved)
                            throw new InvalidOperationException("Two observed DOWN transitions did not highlight the target; selection is not executable.");
                        // An unchanged state is not acknowledgement of the
                        // preceding DOWN. Keep observing within the same 3 s
                        // budget instead of queueing another blind key.
                    }
                }

                if (Has(rows, "observations-complete"))
                {
                    if (!identityEstablished || !report.OwnedPopupActiveSeen || !report.TerminalKeyPosted ||
                        !report.MenuExitSeen || (action == "select" && !report.TargetHighlightSeen))
                        throw new InvalidOperationException("Script completed without sufficient owned input evidence.");
                    string returned = Value(rows, "popup-after:return=");
                    string finalClicks = Value(rows, "final-clicks:");
                    long raw;
                    int targetClicks, otherClicks;
                    string[] clickValues = finalClicks == null ? new string[0] : finalClicks.Split(':');
                    if (returned == null || !long.TryParse(returned.Split(':')[0], out raw) ||
                        clickValues.Length != 2 || !int.TryParse(clickValues[0], out targetClicks) ||
                        !int.TryParse(clickValues[1], out otherClicks))
                        throw new InvalidOperationException("Native return/click observations are incomplete.");
                    report.RawReturn = raw;
                    report.TargetClicks = targetClicks;
                    report.OtherClicks = otherClicks;
                    uint terminal = action == "select" ? Enter : Escape;
                    if (Has(rows, "owner-key-down:" + terminal))
                        throw new InvalidOperationException("Terminal key reached the Window instead of being consumed by its menu.");
                    if (action == "cancel" && (targetClicks != 0 || otherClicks != 0 || ((flags & 256) != 0 && raw != 0)))
                        throw new InvalidOperationException("Requested cancellation contradicted native selection evidence.");
                    if (action == "select" && (otherClicks != 0 || raw == 0 || ((flags & 256) != 0 && raw != report.TargetCommandId)))
                        throw new InvalidOperationException("Requested target selection contradicted native return/click evidence.");
                    // The unknown N-only onClick count remains data, not a Web
                    // expectation. No WM_COMMAND or onClick was synthesized.
                    report.State = "observed";
                    report.Reason = "Owned active popup, bounded key path, native return and 600 ms post-return observations recorded.";
                    return report;
                }
                if (engine.HasExited) throw new InvalidOperationException("Held engine exited before observation completion.");
                Thread.Sleep(20);
            }
            throw new InvalidOperationException("Held process exceeded its 30000 ms budget.");
        }
        catch (Exception error)
        {
            report.Reason = error.ToString();
            return report;
        }
        finally
        {
            string[] finalRows = ReadEvents(path);
            if (finalRows.Length > 0) report.NativeEvents = finalRows;
            report.ProcessElapsedMs = processClock.ElapsedMilliseconds;
            report.CaseElapsedMs = caseClock == null ? 0 : caseClock.ElapsedMilliseconds;
        }
    }
}
