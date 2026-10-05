// Compile/run only in native-termination.yml on GitHub-hosted Windows.
// One WM_CANCELMODE is posted only to the validated, held engine's own menu
// owner. No global input, foreground changes, hooks or remote injection.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class TerminationMenuObservation
{
    public string State { get; set; } = "failed";
    public string Reason { get; set; } = "No authorized menu observation.";
    public long? TimerAfterSeenMs { get; set; }
    public long? DismissPostedMs { get; set; }
    public long OwnerHwnd { get; set; }
    public long PopupHmenu { get; set; }
    public uint OwnerThread { get; set; }
    public uint MenuFlags { get; set; }
    public bool OwnedPopupConfirmed { get; set; }
    public bool DismissPosted { get; set; }
    public int Win32Error { get; set; }
    public string[] BeforeDismissEvents { get; set; } = new string[0];
}

public static class OriginalTerminationMenu
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiInfo
    {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int limit);
    [DllImport("user32.dll")]
    private static extern IntPtr GetMenu(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")]
    private static extern IntPtr GetSubMenu(IntPtr menu, int position);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetMenuStringW(IntPtr menu, uint position, StringBuilder text, int limit, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wp, IntPtr lp);

    private static string[] Rows(string path)
    {
        try {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream, Encoding.UTF8, true))
                return reader.ReadToEnd().Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
        } catch (IOException) { return new string[0]; }
    }
    private static bool Pointer(string[] rows, string prefix, out IntPtr value)
    {
        foreach (var row in rows) {
            long parsed;
            if (row.StartsWith(prefix, StringComparison.Ordinal) &&
                long.TryParse(row.Substring(prefix.Length), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed != 0) {
                // The pinned engine is 32 bit. Preserve its unsigned handle
                // bits when its TJS integer representation is signed.
                value = new IntPtr(unchecked((long)(uint)parsed));
                return true;
            }
        }
        value = IntPtr.Zero; return false;
    }
    private static bool Contains(IntPtr menu, IntPtr target, int depth = 0)
    {
        if (menu == IntPtr.Zero || depth > 8) return false;
        if (menu == target) return true;
        int count = GetMenuItemCount(menu);
        if (count < 0 || count > 256) return false;
        for (int i = 0; i < count; i++) if (Contains(GetSubMenu(menu, i), target, depth + 1)) return true;
        return false;
    }
    public static TerminationMenuObservation Observe(Process process, string directory, string token, Stopwatch clock)
    {
        var report = new TerminationMenuObservation();
        // Still inside the common 20-second owned-process deadline.
        while (clock.ElapsedMilliseconds < 15000) {
            if (process.HasExited) {
                report.State = "returned-before-dismiss";
                report.Reason = "Engine exited naturally; no message was posted.";
                return report;
            }
            var rows = Rows(Path.Combine(directory, "native-events.txt"));
            if (Array.IndexOf(rows, "timer-after") < 0) { Thread.Sleep(10); continue; }
            if (!report.TimerAfterSeenMs.HasValue) report.TimerAfterSeenMs = clock.ElapsedMilliseconds;
            if (Array.IndexOf(rows, "modal-after") >= 0) {
                report.State = "returned-before-dismiss";
                report.Reason = "Popup returned naturally; no message was posted.";
                return report;
            }
            if (clock.ElapsedMilliseconds - report.TimerAfterSeenMs.Value < 500) { Thread.Sleep(10); continue; }
            IntPtr owner, popup;
            if (!Pointer(rows, "menu-owner-hwnd:", out owner) || !Pointer(rows, "popup-hmenu:", out popup)) {
                Thread.Sleep(10); continue;
            }
            uint pid;
            uint thread = GetWindowThreadProcessId(owner, out pid);
            var caption = new StringBuilder(512);
            var item = new StringBuilder(512);
            GetWindowTextW(owner, caption, caption.Capacity);
            GetMenuStringW(popup, 0, item, item.Capacity, 0x400);
            var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
            if (thread == 0 || pid != (uint)process.Id ||
                caption.ToString() != "KRKR2 termination timer-menu " + token ||
                !Contains(GetMenu(owner), popup) || GetMenuItemCount(popup) != 1 || item.ToString() != "Item " + token ||
                !GetGUIThreadInfo(thread, ref gui) || gui.MenuOwner != owner || (gui.Flags & 0x14) != 0x14) {
                report.Reason = "Published target did not match the owned active popup; no message posted.";
                report.Win32Error = Marshal.GetLastWin32Error();
                return report;
            }
            report.OwnerHwnd = owner.ToInt64(); report.PopupHmenu = popup.ToInt64(); report.OwnerThread = thread;
            report.MenuFlags = gui.Flags; report.OwnedPopupConfirmed = true; report.BeforeDismissEvents = rows;
            // Recheck held process and owner identity immediately before this
            // sole targeted operation; never fall back to a foreground HWND.
            uint currentPid;
            if (process.HasExited || GetWindowThreadProcessId(owner, out currentPid) != thread || currentPid != (uint)process.Id) {
                report.Reason = "Owned process/Window retired before dismissal."; return report;
            }
            report.DismissPosted = PostMessageW(owner, 0x001f, IntPtr.Zero, IntPtr.Zero);
            report.DismissPostedMs = clock.ElapsedMilliseconds;
            report.Win32Error = report.DismissPosted ? 0 : Marshal.GetLastWin32Error();
            report.State = report.DismissPosted ? "dismiss-posted" : "failed";
            report.Reason = report.DismissPosted ? "One owned WM_CANCELMODE posted after the retained menu interval." : "Owned WM_CANCELMODE failed.";
            return report;
        }
        report.Reason = "Menu/termination evidence did not reach the bounded observation gate.";
        return report;
    }
}
