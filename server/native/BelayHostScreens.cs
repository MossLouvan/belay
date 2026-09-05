using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;

// Live monitor enumeration.
//
// WHY THIS EXISTS
// ---------------
// System.Windows.Forms.Screen.AllScreens CACHES. It builds its array once and
// invalidates only when the process receives WM_DISPLAYCHANGE, via a
// SystemEvents hook that needs a message pump. BelayHost is a long-lived
// console process with no window and no pump, so its idea of "the monitors"
// freezes at whatever existed when it started and never changes again.
//
// That is fatal for the whole point of the virtual display. Create one and:
//
//   * ScreenBounds(1) sees AllScreens.Length == 1, decides the index is out of
//     range, and silently falls back to the primary — so capture and input both
//     keep addressing the physical screen while the client believes it asked
//     for the new one.
//   * DoInfo reports one screen forever, so the client is never even offered
//     the monitor it just created.
//
// Nothing errors. The display exists, Windows has extended the desktop onto it,
// and the helper simply cannot see it. That is precisely the shape of
// "the virtual display doesn't work" with no error anywhere to explain it.
//
// EnumDisplayMonitors asks the OS every time and cannot go stale. It costs one
// syscall per call, which against a capture that copies a whole screen is not
// worth caching to avoid.
//
// The same caching trap has now bitten twice: once in diagnosis, where
// Screen.AllScreens reported one monitor while the desktop plainly had two,
// and once here in the product. Do not reintroduce it.
static class LiveScreens
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprc, IntPtr data);

    [DllImport("user32.dll")]
    static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX mi);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int index);

    const uint MONITORINFOF_PRIMARY = 1;
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77;
    const int SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

    public sealed class Info
    {
        public Rectangle Bounds;
        public Rectangle Work;
        public bool Primary;
        public string Device = "";
    }

    /// Every monitor attached to the desktop, right now.
    ///
    /// Ordered primary-first so index 0 is always the primary, which is what
    /// every caller that omits an index expects and what the client's monitor
    /// list assumes. EnumDisplayMonitors makes no ordering promise of its own.
    public static List<Info> All()
    {
        var found = new List<Info>();
        MonitorEnumProc cb = (hMon, hdc, lprc, data) =>
        {
            var mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hMon, ref mi))
            {
                found.Add(new Info
                {
                    Bounds = Rect(mi.rcMonitor),
                    Work = Rect(mi.rcWork),
                    Primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0,
                    Device = mi.szDevice ?? "",
                });
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        found.Sort((a, b) =>
        {
            if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
            // Then left-to-right, so the order is stable across calls rather
            // than whatever order the OS happened to walk them in.
            if (a.Bounds.X != b.Bounds.X) return a.Bounds.X.CompareTo(b.Bounds.X);
            return a.Bounds.Y.CompareTo(b.Bounds.Y);
        });
        return found;
    }

    public static Rectangle Primary()
    {
        List<Info> all = All();
        foreach (Info s in all) if (s.Primary) return s.Bounds;
        // A desktop with no monitor flagged primary should be impossible, but
        // returning an empty rectangle would make capture produce a zero-sized
        // bitmap rather than say anything, so fall back to the virtual desktop.
        return all.Count > 0 ? all[0].Bounds : VirtualDesktop();
    }

    /// The union of every monitor. Read from the OS rather than
    /// SystemInformation.VirtualScreen, which caches for the same reason.
    public static Rectangle VirtualDesktop()
    {
        return new Rectangle(
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN));
    }

    /// The monitor an index refers to; the primary when absent or out of range.
    public static Rectangle Bounds(int index)
    {
        List<Info> all = All();
        if (index >= 0 && index < all.Count) return all[index].Bounds;
        return Primary();
    }

    static Rectangle Rect(RECT r)
    {
        return new Rectangle(r.left, r.top, r.right - r.left, r.bottom - r.top);
    }
}
