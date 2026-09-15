// GitHub-hosted Windows only. The only input messages are directed WM_SETTEXT
// to the held process's real Edit and BM_CLICK to its real owned push button.
// No WM_COMMAND, hooks, injected code, foreground changes or global input.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class OriginalDialogControl
{
    public long Hwnd { get; set; }
    public long Parent { get; set; }
    public string ClassName { get; set; }
    public string Text { get; set; }
    public int Id { get; set; }
    public uint Style { get; set; }
    public bool Unicode { get; set; }
    public bool Enabled { get; set; }
    public bool Visible { get; set; }
}
public sealed class OriginalSystemDialogReport
{
    public string State { get; set; } = "not-executable";
    public string Reason { get; set; } = "Observation has not completed.";
    public int EnginePid { get; set; }
    public string Scenario { get; set; }
    public string DialogClass { get; set; }
    public long DialogHwnd { get; set; }
    public uint DialogThreadId { get; set; }
    public long DialogOwner { get; set; }
    public uint DialogOwnerPid { get; set; }
    public bool PromptControlObserved { get; set; }
    public int TimerCountAtDiscovery { get; set; }
    public int TimerCountBeforeClick { get; set; }
    public int TimerDeltaWhileDialogPresent { get; set; }
    public long ObservedDialogMsBeforeClick { get; set; }
    public bool ButtonMessageDelivered { get; set; }
    public string ButtonRole { get; set; }
    public string ButtonIdentification { get; set; }
    public long ButtonHwnd { get; set; }
    public string DesiredText { get; set; }
    public string InitialControlText { get; set; }
    public string ReadBackText { get; set; }
    public bool? ReturnedVoid { get; set; }
    public string ReturnType { get; set; }
    public string ReturnedText { get; set; }
    public int? ReturnedLength { get; set; }
    public uint HostAnsiCodePage { get; set; }
    public long CaseElapsedMs { get; set; }
    public long ProcessElapsedMs { get; set; }
    public List<OriginalDialogControl> Controls { get; set; } = new List<OriginalDialogControl>();
    public string[] NativeEvents { get; set; } = new string[0];
    public List<Dictionary<string, object>> Trace { get; set; } = new List<Dictionary<string, object>>();
}

public static class OriginalSystemDialogDriver
{
    private const uint GetText = 0x000d, SetText = 0x000c, ButtonClick = 0x00f5;
    private const uint RootAncestor = 2, OwnerWindow = 4, AbortIfHung = 2, Block = 1;
    private delegate bool EnumerateWindow(IntPtr hwnd, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumerateWindow callback, IntPtr data);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumerateWindow callback, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int limit);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int limit);
    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint mode);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hwnd, uint mode);
    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowUnicode(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr ReadTextMessage(IntPtr hwnd, uint message, IntPtr wp,
        StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr SetTextMessage(IntPtr hwnd, uint message, IntPtr wp,
        string text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr PlainMessage(IntPtr hwnd, uint message, IntPtr wp,
        IntPtr lp, uint flags, uint timeout, out IntPtr result);
    [DllImport("kernel32.dll")]
    private static extern uint GetACP();

    private static string[] ReadEvents(string path)
    {
        try
        {
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
    private static int TimerCount(string[] rows)
    {
        int count = 0;
        foreach (string row in rows)
        {
            int value;
            if (row.StartsWith("timer-in-call:", StringComparison.Ordinal) &&
                int.TryParse(row.Substring("timer-in-call:".Length), out value))
                count = Math.Max(count, value);
        }
        return count;
    }
    private static string Caption(IntPtr hwnd)
    {
        var text = new StringBuilder(512);
        GetWindowTextW(hwnd, text, text.Capacity);
        return text.ToString();
    }
    private static string ClassName(IntPtr hwnd)
    {
        var text = new StringBuilder(256);
        GetClassNameW(hwnd, text, text.Capacity);
        return text.ToString();
    }
    private static uint Owns(Process engine, IntPtr hwnd)
    {
        if (engine.HasExited) throw new InvalidOperationException("Held engine already exited.");
        uint pid;
        uint thread = GetWindowThreadProcessId(hwnd, out pid);
        if (thread == 0 || pid != (uint)engine.Id)
            throw new InvalidOperationException("HWND does not belong to the held engine.");
        return thread;
    }
    private static uint DialogIdentity(Process engine, IntPtr dialog, string caption)
    {
        uint thread = Owns(engine, dialog);
        if (!IsWindowVisible(dialog) || Caption(dialog) != caption)
            throw new InvalidOperationException("The exact owned dialog is no longer visible.");
        return thread;
    }
    private static void ControlIdentity(Process engine, IntPtr dialog, IntPtr child, uint thread)
    {
        if (Owns(engine, child) != thread || GetAncestor(child, RootAncestor) != dialog ||
            !IsWindowVisible(child) || !IsWindowEnabled(child))
            throw new InvalidOperationException("Target control is not an enabled visible child of the owned dialog.");
    }
    private static uint RemainingMessageMs(Stopwatch clock)
    {
        long remaining = 3000 - clock.ElapsedMilliseconds;
        if (remaining <= 0) throw new InvalidOperationException("Dialog exceeded its 3000 ms case budget.");
        return (uint)Math.Min(300, remaining);
    }
    private static string ControlText(IntPtr child, Stopwatch clock)
    {
        var text = new StringBuilder(2048);
        IntPtr result;
        if (ReadTextMessage(child, GetText, new IntPtr(text.Capacity), text, AbortIfHung | Block,
            RemainingMessageMs(clock), out result) == IntPtr.Zero)
            throw new InvalidOperationException("Owned WM_GETTEXT failed: " + Marshal.GetLastWin32Error());
        return text.ToString();
    }
    private static List<IntPtr> FindDialogs(Process engine, string caption)
    {
        var found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused)
        {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            // No caption, class or child is inspected outside the held PID.
            if (pid == (uint)engine.Id && IsWindowVisible(hwnd) && Caption(hwnd) == caption)
                found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }
    private static void FindControls(Process engine, IntPtr dialog, uint thread, Stopwatch clock,
        List<OriginalDialogControl> controls)
    {
        var handles = new List<IntPtr>();
        EnumChildWindows(dialog, delegate(IntPtr hwnd, IntPtr unused)
        {
            uint pid;
            uint actualThread = GetWindowThreadProcessId(hwnd, out pid);
            if (pid == (uint)engine.Id && actualThread == thread && GetAncestor(hwnd, RootAncestor) == dialog)
                handles.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        if (handles.Count > 32) throw new InvalidOperationException("Unexpectedly large dialog control tree.");
        foreach (IntPtr hwnd in handles)
        {
            Owns(engine, hwnd);
            var control = new OriginalDialogControl
            {
                Hwnd = hwnd.ToInt64(), Parent = GetParent(hwnd).ToInt64(),
                ClassName = ClassName(hwnd), Text = null,
                Id = GetDlgCtrlID(hwnd), Style = unchecked((uint)GetWindowLongW(hwnd, -16)),
                Unicode = IsWindowUnicode(hwnd), Visible = IsWindowVisible(hwnd), Enabled = IsWindowEnabled(hwnd)
            };
            // Preserve identity/style even if a bounded text read then fails.
            controls.Add(control);
            control.Text = ControlText(hwnd, clock);
        }
    }
    private static bool PushButton(OriginalDialogControl control)
    {
        bool buttonClass = control.ClassName == "Button" || control.ClassName == "TButton";
        uint kind = control.Style & 15;
        return buttonClass && (kind == 0 || kind == 1) && control.Enabled && control.Visible;
    }
    private static string ButtonName(OriginalDialogControl control)
    {
        return control.Text.Replace("&", "").Trim();
    }
    private static OriginalDialogControl UniqueButton(List<OriginalDialogControl> controls, string role)
    {
        var matches = new List<OriginalDialogControl>();
        foreach (var control in controls)
        {
            if (!PushButton(control)) continue;
            string name = ButtonName(control);
            if ((role == "ok" && string.Equals(name, "OK", StringComparison.OrdinalIgnoreCase)) ||
                (role == "cancel" && (string.Equals(name, "Cancel", StringComparison.OrdinalIgnoreCase) || name == "キャンセル")))
                matches.Add(control);
        }
        if (matches.Count == 0 && role == "cancel")
        {
            // The first hosted run recorded exactly these two ANSI TButtons:
            // default "OK" and non-default "?????" (lost localized caption).
            // Treat the latter only as a candidate. Its real BM_CLICK handler
            // must return native void before the observation can be completed.
            var buttons = new List<OriginalDialogControl>();
            foreach (var control in controls) if (PushButton(control)) buttons.Add(control);
            if (buttons.Count == 2)
            {
                OriginalDialogControl ok = null, candidate = null;
                foreach (var control in buttons)
                {
                    if (control.ClassName == "TButton" && ButtonName(control) == "OK" && (control.Style & 15) == 1)
                        ok = control;
                    if (control.ClassName == "TButton" && ButtonName(control) == "?????" && (control.Style & 15) == 0)
                        candidate = control;
                }
                if (ok != null && candidate != null) matches.Add(candidate);
            }
        }
        if (matches.Count != 1) throw new InvalidOperationException("Exactly one real " + role + " push button was not identified.");
        return matches[0];
    }
    private static void Log(OriginalSystemDialogReport report, Stopwatch clock, string name, params object[] values)
    {
        var row = new Dictionary<string, object> { { "event", name }, { "processMs", clock.ElapsedMilliseconds } };
        for (int i = 0; i < values.Length; i += 2) row.Add((string)values[i], values[i + 1]);
        report.Trace.Add(row);
    }

    public static OriginalSystemDialogReport Observe(Process engine, string directory, string token,
        string scenario, Stopwatch processClock)
    {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" ||
            Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows")
            throw new InvalidOperationException("Only GitHub-hosted Windows observations are authorized.");
        if (scenario != "inform" && scenario != "input-unicode" && scenario != "input-empty" && scenario != "input-cancel")
            throw new InvalidOperationException("Unsupported bounded dialog scenario.");
        var report = new OriginalSystemDialogReport { EnginePid = engine.Id, Scenario = scenario, HostAnsiCodePage = GetACP() };
        string path = Path.Combine(directory, "native-events.txt"), caption = "KRKR2 Dialog " + token;
        Stopwatch caseClock = null, observedDialogClock = null;
        IntPtr dialog = IntPtr.Zero;
        OriginalDialogControl button = null, edit = null;
        bool clicked = false;
        try
        {
            while (processClock.ElapsedMilliseconds < 30000)
            {
                string[] rows = ReadEvents(path);
                if (rows.Length > 0) report.NativeEvents = rows;
                string error = Value(rows, "error:");
                if (error != null) throw new InvalidOperationException("Original script error: " + error);
                if (caseClock == null && Array.IndexOf(rows, "dialog-before") >= 0)
                {
                    caseClock = Stopwatch.StartNew();
                    Log(report, processClock, "dialog-before-observed", "caseBudgetMs", 3000);
                }
                if (caseClock != null && caseClock.ElapsedMilliseconds >= 3000)
                    throw new InvalidOperationException("Dialog exceeded its 3000 ms case budget.");

                if (!clicked && caseClock != null)
                {
                    if (dialog == IntPtr.Zero)
                    {
                        var candidates = FindDialogs(engine, caption);
                        if (candidates.Count > 1) throw new InvalidOperationException("Ambiguous dialog identity.");
                        if (candidates.Count == 1)
                        {
                            dialog = candidates[0];
                            report.DialogThreadId = DialogIdentity(engine, dialog, caption);
                            report.DialogHwnd = dialog.ToInt64();
                            report.DialogClass = ClassName(dialog);
                            IntPtr owner = GetWindow(dialog, OwnerWindow);
                            report.DialogOwner = owner.ToInt64();
                            uint ownerPid = 0;
                            if (owner != IntPtr.Zero)
                            {
                                GetWindowThreadProcessId(owner, out ownerPid);
                                if (ownerPid != (uint)engine.Id) throw new InvalidOperationException("Dialog has an unrelated owner.");
                            }
                            report.DialogOwnerPid = ownerPid;
                            report.TimerCountAtDiscovery = TimerCount(ReadEvents(path));
                            observedDialogClock = Stopwatch.StartNew();
                            Log(report, processClock, "owned-dialog-identified", "hwnd", report.DialogHwnd,
                                "class", report.DialogClass, "thread", report.DialogThreadId,
                                "promptControlState", "not-read-yet",
                                "timerCount", report.TimerCountAtDiscovery);
                        }
                    }
                    if (dialog != IntPtr.Zero && observedDialogClock.ElapsedMilliseconds >= 800)
                    {
                        DialogIdentity(engine, dialog, caption);
                        uint thread = report.DialogThreadId;
                        // A visible VCL Form can still be constructing its
                        // children. Observe first, then read the stable controls.
                        FindControls(engine, dialog, thread, caseClock, report.Controls);
                        foreach (var control in report.Controls)
                            if (control.Text == "Prompt " + token) report.PromptControlObserved = true;
                        if (scenario == "inform" && !report.PromptControlObserved)
                            throw new InvalidOperationException("MessageBox prompt text was not identified.");
                        button = UniqueButton(report.Controls, scenario == "input-cancel" ? "cancel" : "ok");
                        report.ButtonIdentification = ButtonName(button) == "?????"
                            ? "Recorded two-button ANSI InputQuery candidate; native void return required"
                            : "Exact visible button caption; native handler return required";
                        if (scenario != "inform")
                        {
                            var edits = new List<OriginalDialogControl>();
                            foreach (var control in report.Controls)
                                if ((control.ClassName == "Edit" || control.ClassName == "TEdit") && control.Visible && control.Enabled)
                                    edits.Add(control);
                            if (edits.Count != 1) throw new InvalidOperationException("Exactly one real owned Edit was not identified.");
                            edit = edits[0];
                            UniqueButton(report.Controls, "ok");
                            UniqueButton(report.Controls, "cancel");
                            report.InitialControlText = edit.Text;
                        }
                        Log(report, processClock, "owned-controls-identified", "count", report.Controls.Count,
                            "promptControlObserved", report.PromptControlObserved,
                            "button", button.Hwnd, "buttonIdentification", report.ButtonIdentification);
                        if (scenario == "input-unicode" || scenario == "input-empty")
                        {
                            IntPtr editHwnd = new IntPtr(edit.Hwnd);
                            ControlIdentity(engine, dialog, editHwnd, thread);
                            report.DesiredText = scenario == "input-unicode" ? "Hello 雪 Ω 😀" : "";
                            IntPtr result;
                            bool delivered = SetTextMessage(editHwnd, SetText, IntPtr.Zero, report.DesiredText,
                                AbortIfHung | Block, RemainingMessageMs(caseClock), out result) != IntPtr.Zero;
                            Log(report, processClock, "owned-edit-settext", "hwnd", edit.Hwnd, "delivered", delivered,
                                "result", result.ToInt64(), "unicodeControl", edit.Unicode);
                            if (!delivered || result == IntPtr.Zero) throw new InvalidOperationException("Owned WM_SETTEXT did not complete.");
                            report.ReadBackText = ControlText(editHwnd, caseClock);
                            // ANSI conversion is observed data. Empty confirmation
                            // additionally requires that the actual Edit be empty.
                            if (scenario == "input-empty" && report.ReadBackText.Length != 0)
                                throw new InvalidOperationException("Owned Edit did not become empty.");
                        }
                        DialogIdentity(engine, dialog, caption);
                        IntPtr buttonHwnd = new IntPtr(button.Hwnd);
                        ControlIdentity(engine, dialog, buttonHwnd, thread);
                        if (ClassName(buttonHwnd) != button.ClassName || ControlText(buttonHwnd, caseClock) != button.Text)
                            throw new InvalidOperationException("Selected push button changed before input.");
                        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
                        if (thread == 0 || !GetGUIThreadInfo(thread, ref info))
                            throw new InvalidOperationException("Owned GUI thread state could not be read.");
                        string[] beforeClickRows = ReadEvents(path);
                        if (Value(beforeClickRows, "dialog-after:") != null)
                            throw new InvalidOperationException("Dialog returned before its controlled button input.");
                        report.TimerCountBeforeClick = TimerCount(beforeClickRows);
                        report.TimerDeltaWhileDialogPresent = report.TimerCountBeforeClick - report.TimerCountAtDiscovery;
                        report.ObservedDialogMsBeforeClick = observedDialogClock.ElapsedMilliseconds;
                        report.ButtonRole = scenario == "input-cancel" ? "cancel" : "ok";
                        report.ButtonHwnd = button.Hwnd;
                        Log(report, processClock, "before-owned-button-click", "hwnd", button.Hwnd,
                            "role", report.ButtonRole, "dialogObservedMs", report.ObservedDialogMsBeforeClick,
                            "timerCount", report.TimerCountBeforeClick, "guiActive", info.Active.ToInt64(),
                            "guiFocus", info.Focus.ToInt64());
                        IntPtr buttonResult;
                        bool clickedResult = PlainMessage(buttonHwnd, ButtonClick, IntPtr.Zero, IntPtr.Zero,
                            AbortIfHung | Block, RemainingMessageMs(caseClock), out buttonResult) != IntPtr.Zero;
                        clicked = true;
                        report.ButtonMessageDelivered = clickedResult;
                        Log(report, processClock, "owned-button-message-returned", "delivered", clickedResult,
                            "result", buttonResult.ToInt64(), "error", clickedResult ? 0 : Marshal.GetLastWin32Error());
                        if (!clickedResult) throw new InvalidOperationException("Owned BM_CLICK was not delivered.");
                        // The real dialog may now be destroyed. Only read its
                        // evidence file; never query or reuse a retired HWND.
                    }
                }
                if (Array.IndexOf(rows, "observations-complete") >= 0)
                {
                    if (!clicked || !report.ButtonMessageDelivered)
                        throw new InvalidOperationException("Script completed without controlled real-button evidence.");
                    string returned = Value(rows, "dialog-after:void=");
                    if (returned == null) throw new InvalidOperationException("Native result metadata is missing.");
                    string[] parts = returned.Split(new[] { ":type=" }, StringSplitOptions.None);
                    if (parts.Length != 2 || (parts[0] != "0" && parts[0] != "1"))
                        throw new InvalidOperationException("Native result metadata is malformed.");
                    report.ReturnedVoid = parts[0] == "1";
                    report.ReturnType = parts[1];
                    report.ReturnedText = Value(rows, "result-text:");
                    int length;
                    if (int.TryParse(Value(rows, "result-length:"), out length)) report.ReturnedLength = length;
                    bool wantsVoid = scenario == "inform" || scenario == "input-cancel";
                    if (report.ReturnedVoid != wantsVoid || (!wantsVoid &&
                        (!string.Equals(report.ReturnType, "String", StringComparison.OrdinalIgnoreCase) || report.ReturnedText == null)))
                        throw new InvalidOperationException("Native return does not confirm the selected button handler.");
                    if (scenario == "input-empty" && (report.ReturnedText != "" || report.ReturnedLength != 0))
                        throw new InvalidOperationException("Empty confirmation was not an empty native string.");
                    report.State = "observed";
                    report.Reason = "Owned real dialog/control messages and native handler return recorded; Timer delta and text conversions are observations.";
                    return report;
                }
                if (engine.HasExited)
                {
                    // A final file write and process exit can happen between two
                    // polls. Re-read once; the next loop consumes only that log.
                    string[] finalRows = ReadEvents(path);
                    if (Array.IndexOf(finalRows, "observations-complete") >= 0) continue;
                    throw new InvalidOperationException("Held engine exited before completing the observation.");
                }
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
            string[] rows = ReadEvents(path);
            if (rows.Length > 0) report.NativeEvents = rows;
            report.CaseElapsedMs = caseClock == null ? 0 : caseClock.ElapsedMilliseconds;
            report.ProcessElapsedMs = processClock.ElapsedMilliseconds;
        }
    }
}
