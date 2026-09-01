// Per-window enumeration, capture and focus for the Windows helper.
//
// This is the half of "seamless windows" (VMware called it Unity) that the OS
// has to provide: a list of the top-level windows worth showing, a picture of
// one window's contents on its own, and a way to put one in front so keystrokes
// reach it. The client draws each of those pictures in a borderless local
// window of its own.
//
// Three Win32 details drive nearly every decision below:
//
//   * A window's "rect" is ambiguous. GetWindowRect on Windows 10+ includes an
//     invisible resize border several pixels wide, so a local window sized from
//     it shows a fringe of whatever is behind the remote window. The DWM's
//     EXTENDED_FRAME_BOUNDS is the rectangle the user actually sees, and it is
//     what a client must size to.
//   * Visible is not the same as shown. Every UWP app keeps hidden top-level
//     windows around that pass IsWindowVisible and carry real titles; they are
//     marked "cloaked" by the DWM instead. Without that check the window list
//     is mostly ghosts.
//   * PrintWindow is the only way to get a window's own pixels, including the
//     parts covered by another window. PW_RENDERFULLCONTENT (0x2, Windows 8.1+)
//     is required for anything drawing through DirectComposition — without it
//     browsers and Electron apps come back as a blank rectangle.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

static class WindowList
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
    const int DWMWA_CLOAKED = 14;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const uint PW_RENDERFULLCONTENT = 0x00000002;
    const int SW_RESTORE = 9;

    /// The visible rectangle of a window, in virtual-desktop pixels.
    ///
    /// Falls back to GetWindowRect when the DWM has no answer (it does not for
    /// windows that were never composited), because a slightly-too-large rect
    /// is far better than no window at all.
    public static Rectangle Bounds(IntPtr hwnd)
    {
        RECT r;
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
        {
            if (!GetWindowRect(hwnd, out r)) return Rectangle.Empty;
        }
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }

    static bool IsCloaked(IntPtr hwnd)
    {
        int cloaked;
        if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) != 0) return false;
        return cloaked != 0;
    }

    static string TitleOf(IntPtr hwnd)
    {
        int length = GetWindowTextLength(hwnd);
        if (length <= 0) return "";
        var buffer = new StringBuilder(length + 1);
        GetWindowText(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    /// Process name for the window's owner, or "" when it cannot be read.
    ///
    /// Reading it costs a process handle and fails outright for anything
    /// running elevated when we are not, which is normal rather than
    /// exceptional — hence the swallow.
    static string AppOf(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return "";
        try { return Process.GetProcessById((int)pid).ProcessName; }
        catch (Exception) { return ""; }
    }

    /// Whether a window is one a person would recognise as an open window.
    ///
    /// The filters are cumulative and each removes a specific kind of noise:
    /// invisible windows, the desktop itself, tool windows (floating palettes
    /// and tray helpers), DWM-cloaked ghosts (mostly suspended UWP apps),
    /// untitled windows, and zero-area ones.
    static bool IsUserWindow(IntPtr hwnd)
    {
        if (!IsWindowVisible(hwnd)) return false;
        if (hwnd == GetShellWindow()) return false;
        if ((GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return false;
        if (IsCloaked(hwnd)) return false;
        if (GetWindowTextLength(hwnd) == 0) return false;
        var bounds = Bounds(hwnd);
        return bounds.Width > 0 && bounds.Height > 0;
    }

    /// The window's title, for callers outside this class. A window's title
    /// changes constantly (a browser tab, a document's dirty marker), so a
    /// client that only read it at enumeration time would show stale captions.
    public static string TitleOfPublic(IntPtr hwnd) { return TitleOf(hwnd); }

    /// A window handle parsed from the string form the wire uses.
    ///
    /// Handles cross the wire as decimal strings because JSON numbers are
    /// doubles, and a 64-bit handle on a 64-bit host does not survive that
    /// round trip intact. Returns IntPtr.Zero for anything unparseable or for a
    /// handle that no longer names a window — a window closing between the list
    /// and the request is ordinary, not an error condition.
    public static IntPtr Parse(object raw)
    {
        long value;
        if (raw == null || !long.TryParse(raw.ToString(), out value)) return IntPtr.Zero;
        var hwnd = new IntPtr(value);
        return IsWindow(hwnd) ? hwnd : IntPtr.Zero;
    }

    /// Every window worth showing, front to back.
    ///
    /// EnumWindows walks in Z order, so the list is already top-first and the
    /// position doubles as the stacking order — the client raises its local
    /// windows to match without a second query.
    public static List<object> All()
    {
        var windows = new List<object>();
        int z = 0;
        EnumWindows((hwnd, _) =>
        {
            if (!IsUserWindow(hwnd)) return true;
            var b = Bounds(hwnd);
            windows.Add(new Dictionary<string, object> {
                { "id", ((long)hwnd).ToString() },
                { "title", TitleOf(hwnd) },
                { "app", AppOf(hwnd) },
                { "X", b.X }, { "Y", b.Y }, { "W", b.Width }, { "H", b.Height },
                { "minimized", IsIconic(hwnd) },
                { "z", z++ },
            });
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    /// The window's own pixels, at its current size. Caller disposes.
    ///
    /// PrintWindow asks the window to redraw itself into our device context, so
    /// the result is the window's content even when another window covers it —
    /// which is the entire point: a seamless client shows remote windows in its
    /// own stacking order, not the host's.
    ///
    /// The GDI fallback is deliberate but lossy: it copies whatever is on the
    /// screen at those coordinates, so anything overlapping the window on the
    /// host appears in the frame. That is worse than PrintWindow and better
    /// than a black rectangle, which is what some hardware-accelerated windows
    /// return from PrintWindow on older drivers.
    public static Bitmap Grab(IntPtr hwnd, out Rectangle bounds)
    {
        bounds = Bounds(hwnd);
        if (bounds.Width <= 0 || bounds.Height <= 0) return null;

        var bmp = new Bitmap(bounds.Width, bounds.Height, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
        bool printed = false;
        using (var g = Graphics.FromImage(bmp))
        {
            IntPtr hdc = g.GetHdc();
            try { printed = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT); }
            finally { g.ReleaseHdc(hdc); }

            if (!printed)
            {
                g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size,
                                 System.Drawing.CopyPixelOperation.SourceCopy);
            }
        }
        return bmp;
    }

    /// Bring a window to the front so typed input reaches it.
    ///
    /// Restores it first when minimized: SetForegroundWindow on an iconic
    /// window succeeds without actually showing it, and the client would then
    /// be typing into a window nobody can see.
    ///
    /// Windows refuses foreground changes from a process that does not own the
    /// current foreground window, which is why this reports what happened
    /// rather than throwing — the client's remedy (tell the user to click the
    /// host once) is different from an error's.
    public static bool Focus(IntPtr hwnd)
    {
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        return SetForegroundWindow(hwnd);
    }
}
