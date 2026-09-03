// Belay native host helper (compiled).
//
// A long-lived console process. The Node server writes one JSON command per
// line to stdin; we write one JSON reply per line to stdout. All screen capture
// and input injection goes through Win32 directly, so the server itself needs
// no compiled npm modules.
//
// Compiled to an exe rather than run as a PowerShell script on purpose: the
// SendInput/keybd input-injection any remote-control tool requires trips
// PowerShell's AMSI heuristic when it is scanned as script text. A normal
// compiled binary the user builds locally does not go through that path.
//
// Commands: info | capture | move | down | up | click | scroll | key | text | ping
//           audiostart | audiostop | audiostatus  (WASAPI loopback, BelayHostAudio.cs)

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000;
    const uint ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    const uint KEYUP = 0x0002, UNICODE = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint n, INPUT[] p, int cb);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
    const int CURSOR_SHOWING = 0x0001, DI_NORMAL = 0x0003;
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] static extern IntPtr CopyIcon(IntPtr h);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr h, int cx, int cy, int step, IntPtr br, int flags);

    static int Size { get { return Marshal.SizeOf(typeof(INPUT)); } }
    static void Send(INPUT[] i) { SendInput((uint)i.Length, i, Size); }

    public static void Dpi() { SetProcessDPIAware(); }

    // Absolute coordinates run 0..65535 across the whole virtual desktop. The
    // phone sends nx/ny normalized against the frame it is LOOKING at, which is
    // one monitor's capture — so the 0..1 must be mapped onto that monitor's
    // rectangle within the virtual desktop, not onto the desktop as a whole.
    // Mapping straight to 0..65535 was the multi-monitor bug: with the primary
    // at X=1920 in a 0..3840 desktop, nx=0 (left edge of the picture) landed at
    // virtual x=0 — the other monitor — shifting every click a full screen.
    //
    // Worked example (two 1920x1080 monitors, primary on the right):
    //   V = { X:0, W:3840 }, S = primary = { X:1920, W:1920 }, nx = 0.5
    //   vx = 1920 + 0.5*1920 = 2880
    //   dx = round((2880 - 0) / 3839 * 65535) = 49164  -> centre of the right
    //   monitor, exactly where the frame showed the tap.
    public static void MoveAbsolute(double nx, double ny, Rectangle s)
    {
        Rectangle v = SystemInformation.VirtualScreen;
        if (v.Width <= 1 || v.Height <= 1) return;
        double vx = s.X + nx * s.Width;
        double vy = s.Y + ny * s.Height;
        int dx = (int)Math.Round((vx - v.X) / (double)(v.Width - 1) * 65535.0);
        int dy = (int)Math.Round((vy - v.Y) / (double)(v.Height - 1) * 65535.0);
        if (dx < 0) dx = 0; else if (dx > 65535) dx = 65535;
        if (dy < 0) dy = 0; else if (dy > 65535) dy = 65535;
        var i = new INPUT[1];
        i[0].type = INPUT_MOUSE;
        i[0].U.mi.dx = dx;
        i[0].U.mi.dy = dy;
        i[0].U.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK;
        Send(i);
    }

    public static void Button(string b, bool down)
    {
        uint f;
        if (b == "right") f = down ? RIGHTDOWN : RIGHTUP;
        else if (b == "middle") f = down ? MIDDLEDOWN : MIDDLEUP;
        else f = down ? LEFTDOWN : LEFTUP;
        var i = new INPUT[1];
        i[0].type = INPUT_MOUSE;
        i[0].U.mi.dwFlags = f;
        Send(i);
    }

    public static void Scroll(int dy, int dx)
    {
        if (dy != 0) { var i = new INPUT[1]; i[0].type = INPUT_MOUSE; i[0].U.mi.mouseData = unchecked((uint)dy); i[0].U.mi.dwFlags = WHEEL; Send(i); }
        if (dx != 0) { var i = new INPUT[1]; i[0].type = INPUT_MOUSE; i[0].U.mi.mouseData = unchecked((uint)dx); i[0].U.mi.dwFlags = HWHEEL; Send(i); }
    }

    public static void Key(ushort vk, bool down)
    {
        var i = new INPUT[1];
        i[0].type = INPUT_KEYBOARD;
        i[0].U.ki.wVk = vk;
        i[0].U.ki.dwFlags = down ? 0 : KEYUP;
        Send(i);
    }

    // Unicode scan-code injection bypasses keyboard-layout translation, so
    // accented characters and emoji arrive exactly as sent.
    public static void TypeText(string t)
    {
        if (string.IsNullOrEmpty(t)) return;
        var i = new INPUT[t.Length * 2];
        for (int c = 0; c < t.Length; c++)
        {
            i[c * 2].type = INPUT_KEYBOARD;
            i[c * 2].U.ki.wScan = t[c];
            i[c * 2].U.ki.dwFlags = UNICODE;
            i[c * 2 + 1].type = INPUT_KEYBOARD;
            i[c * 2 + 1].U.ki.wScan = t[c];
            i[c * 2 + 1].U.ki.dwFlags = UNICODE | KEYUP;
        }
        Send(i);
    }

    public static void DrawCursor(Graphics g, int originX, int originY)
    {
        var ci = new CURSORINFO();
        ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (!GetCursorInfo(ref ci) || ci.flags != CURSOR_SHOWING) return;
        IntPtr icon = CopyIcon(ci.hCursor);
        if (icon == IntPtr.Zero) return;
        try
        {
            IntPtr hdc = g.GetHdc();
            try { DrawIconEx(hdc, ci.ptScreenPos.x - originX, ci.ptScreenPos.y - originY, icon, 0, 0, 0, IntPtr.Zero, DI_NORMAL); }
            finally { g.ReleaseHdc(hdc); }
        }
        finally { DestroyIcon(icon); }
    }
}

static class BelayHost
{
    static JavaScriptSerializer J = new JavaScriptSerializer();
    static ImageCodecInfo jpeg;
    static Bitmap srcBmp;
    static Graphics srcGfx;
    static int srcW, srcH;

    static void Main()
    {
        Native.Dpi();
        J.MaxJsonLength = int.MaxValue;
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") { jpeg = c; break; }

        var stdout = Console.Out;
#if BELAY_WEBRTC_BUILD
        // Wire the hardware-gated WebRTC path to this process's reply writer and
        // input primitives. Reply() locks nothing today because the stdio loop is
        // single-threaded; the WebRTC callbacks arrive on library threads, so
        // pushes go through a lock shared with Reply (see ReplyLocked).
        WebrtcHost.Write = delegate(Dictionary<string, object> obj) { Reply(stdout, obj); };
        InputBridge.Route = RouteChannelInput;
#endif
        Reply(stdout, new Dictionary<string, object> { { "id", 0 }, { "ok", true }, { "ready", true } });

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            object idObj = null;
            try
            {
                var c = (Dictionary<string, object>)J.DeserializeObject(line);
                idObj = Get(c, "id");
                string cmd = Str(Get(c, "cmd"));
                switch (cmd)
                {
                    case "info": DoInfo(stdout, idObj); break;
                    case "capture": DoCapture(stdout, idObj, c); break;
                    case "move": Native.MoveAbsolute(Dbl(Get(c, "x")), Dbl(Get(c, "y")), TargetBounds(c)); Ok(stdout, idObj); break;
                    case "down": MaybeMove(c); Native.Button(Str(Get(c, "button")), true); Ok(stdout, idObj); break;
                    case "up": MaybeMove(c); Native.Button(Str(Get(c, "button")), false); Ok(stdout, idObj); break;
                    case "click": DoClick(stdout, idObj, c); break;
                    case "scroll": Native.Scroll(Int(Get(c, "dy")), Int(Get(c, "dx"))); Ok(stdout, idObj); break;
                    case "key": DoKey(stdout, idObj, c); break;
                    case "text": Native.TypeText(Str(Get(c, "text"))); Ok(stdout, idObj); break;
                    case "windows": Reply(stdout, new Dictionary<string, object> { { "id", idObj }, { "ok", true }, { "windows", WindowList.All() } }); break;
                    case "capturewindow": DoCaptureWindow(stdout, idObj, c); break;
                    case "focuswindow": DoFocusWindow(stdout, idObj, c); break;
                    case "ping": Reply(stdout, new Dictionary<string, object> { { "id", idObj }, { "ok", true }, { "pong", true } }); break;
                    case "webrtc": DoWebrtc(stdout, idObj, c); break;
                    // Virtual display driver (opt-in; Node gates it behind
                    // BELAY_VIRTUAL_DISPLAY). Needs the BelayVDD driver from
                    // native/win-display/ installed — without it the handler
                    // throws a message that says so. See docs/VIRTUAL-DISPLAY.md.
                    case "virtualdisplay": Reply(stdout, BelayVirtualDisplay.Handle(idObj, c)); break;
                    // Driverless system-audio loopback (WASAPI). WRITTEN-BUT-
                    // NOT-COMPILED — see BelayHostAudio.cs and docs/AUDIO.md.
                    case "audiostart": BelayHostAudio.Start(stdout, idObj); break;
                    case "audiostop": BelayHostAudio.Stop(stdout, idObj); break;
                    case "audiostatus": BelayHostAudio.Status(stdout, idObj); break;
                    default: Err(stdout, idObj, "unknown command: " + cmd); break;
                }
            }
            catch (Exception e) { Err(stdout, idObj, e.Message); }
        }
#if BELAY_WEBRTC_BUILD
        // stdin closed: Node is gone. Tear the peer + encoder down before exit
        // so the encode thread never outlives the process teardown.
        WebrtcHost.Shutdown();
#endif
    }

    static void MaybeMove(Dictionary<string, object> c)
    {
        if (Get(c, "x") != null) Native.MoveAbsolute(Dbl(Get(c, "x")), Dbl(Get(c, "y")), TargetBounds(c));
    }

    // ── WebRTC transport (opt-in, HARDWARE-GATED) ────────────────────────────
    //
    // STATUS: WRITTEN-BUT-HARDWARE-GATED. The Windows media path is not built.
    // The intended shape mirrors macOS (server/native/mac): replace the GDI
    // CopyFromScreen + System.Drawing JPEG in DoCapture/EnsureSource with
    //   1. Desktop Duplication (IDXGIOutputDuplication) for a GPU surface with no
    //      CPU readback, feeding
    //   2. a Media Foundation H.264/HEVC hardware encoder chosen by the support
    //      matrix below (NVENC -> QSV -> AMF -> software), whose NAL sink is
    //   3. the libdatachannel SRTP video track (the same statically-linked
    //      transport shim as mac/transport, exposed to C# via P/Invoke).
    // The `webrtc` verb then hands the peer SDP/ICE and pushes the helper's
    // local answer/ICE back as `type:"webrtc"` lines (see native.ts). Input
    // injection (SendInput) is unchanged and already bypasses the video pipeline.
    //
    // The implementation lives in BelayHostWebRtc.cs and is compiled ONLY when
    // build.ps1 runs with BELAY_WEBRTC_BUILD=1 (it adds /define + the source).
    // In the default build the verb fails cleanly — exactly like an unknown
    // command — so /ws/webrtc degrades to a JPEG fallback rather than hanging.
    static void DoWebrtc(TextWriter w, object id, Dictionary<string, object> c)
    {
#if BELAY_WEBRTC_BUILD
        WebrtcHost.Handle(id, c);
#else
        Err(w, id, "webrtc transport is not built on this host (HARDWARE-GATED: "
                 + "rebuild with BELAY_WEBRTC_BUILD=1 — Desktop Duplication + Media "
                 + "Foundation + libdatachannel; see docs/WEBRTC-SLICE.md). "
                 + "Falling back to JPEG.");
#endif
    }

#if BELAY_WEBRTC_BUILD
    /// One already-parsed input event from the WebRTC data channels, dispatched
    /// through the same primitives as the stdio loop (no reply line — the
    /// channel has its own error reporting on `control`).
    static void RouteChannelInput(Dictionary<string, object> c)
    {
        string cmd = Str(Get(c, "cmd"));
        switch (cmd)
        {
            case "move": Native.MoveAbsolute(Dbl(Get(c, "x")), Dbl(Get(c, "y")), TargetBounds(c)); break;
            case "down": MaybeMove(c); Native.Button(Str(Get(c, "button")), true); break;
            case "up": MaybeMove(c); Native.Button(Str(Get(c, "button")), false); break;
            case "scroll": Native.Scroll(Int(Get(c, "dy")), Int(Get(c, "dx"))); break;
            case "key": DoKey(TextWriter.Null, null, c); break;
            case "text": Native.TypeText(Str(Get(c, "text"))); break;
            default: throw new ArgumentException("unknown input cmd: " + cmd);
        }
    }
#endif

    /// Hardware encoder preference on Windows, best first. The real path
    /// enumerates Media Foundation transforms (MFT_CATEGORY_VIDEO_ENCODER,
    /// hardware-only) and picks the first available; the software fallback cannot
    /// sustain 60fps at useful resolution and is a last resort. Expressed as the
    /// support matrix (docs/PERFORMANCE-PLAN.md §6) even though selection is not
    /// wired yet, so the ordering is reviewable now.
    enum EncoderKind { NvEnc, QuickSync, Amf, Software }

    static readonly EncoderKind[] EncoderPreference =
    {
        EncoderKind.NvEnc,     // NVIDIA
        EncoderKind.QuickSync, // Intel iGPU
        EncoderKind.Amf,       // AMD
        EncoderKind.Software,  // last resort — degraded, matches Parsec's weak spot
    };

    /// The rectangle a normalized coordinate is measured against.
    ///
    /// A `window` outranks a `screen`, because a client showing one window has
    /// normalized against that window and nothing else. A window that has
    /// closed, or moved to zero size, falls back to the monitor rule rather
    /// than failing: the click lands somewhere harmless instead of being mapped
    /// against a stale rectangle that may now belong to a different window.
    static Rectangle TargetBounds(Dictionary<string, object> c)
    {
        var hwnd = WindowList.Parse(Get(c, "window"));
        if (hwnd != IntPtr.Zero)
        {
            var b = WindowList.Bounds(hwnd);
            if (b.Width > 0 && b.Height > 0) return b;
        }
        return ScreenBounds(Get(c, "screen"));
    }

    /// The monitor a normalized coordinate (or a capture) refers to. A valid
    /// index picks that entry of Screen.AllScreens; absent or out-of-range
    /// falls back to the primary, which keeps single-monitor hosts and older
    /// phones (which never send an index) behaving exactly as before.
    static Rectangle ScreenBounds(object screenIndex)
    {
        if (screenIndex != null)
        {
            int i = Int(screenIndex);
            if (i >= 0 && i < Screen.AllScreens.Length) return Screen.AllScreens[i].Bounds;
        }
        return Screen.PrimaryScreen.Bounds;
    }

    static void DoInfo(TextWriter w, object id)
    {
        var b = Screen.PrimaryScreen.Bounds;
        var v = SystemInformation.VirtualScreen;
        var all = Screen.AllScreens;
        var screens = new List<object>();
        for (int i = 0; i < all.Length; i++)
        {
            var sb = all[i].Bounds;
            var entry = new Dictionary<string, object> {
                { "index", i }, { "X", sb.X }, { "Y", sb.Y }, { "W", sb.Width }, { "H", sb.Height },
                { "primary", all[i].Primary },
            };
            // Identity strings (adapter/monitor/device path) so the client can
            // tell a virtual display from a physical one. Merged in rather than
            // nested so the shape stays flat across both platforms' helpers.
            foreach (var kv in DisplayIdentity.Describe(all[i].DeviceName)) entry[kv.Key] = kv.Value;
            screens.Add(entry);
        }
        Reply(w, new Dictionary<string, object> {
            { "id", id }, { "ok", true },
            { "primary", Rect(b.X, b.Y, b.Width, b.Height) },
            { "virtual", Rect(v.X, v.Y, v.Width, v.Height) },
            { "screens", screens },
        });
    }

    /// One window's own pixels, plus where that window currently is.
    ///
    /// The bounds ride along with every frame because they are the thing a
    /// seamless client cannot get any other way: the user drags a window on the
    /// host, and the only sign of it here is the next frame's rectangle. The
    /// client moves and resizes its local window to match.
    ///
    /// A minimized window has no pixels to print, so it is reported as such
    /// instead of being sent as a black frame the client would faithfully draw.
    static void DoCaptureWindow(TextWriter w, object id, Dictionary<string, object> c)
    {
        var hwnd = WindowList.Parse(Get(c, "window"));
        if (hwnd == IntPtr.Zero) { Err(w, id, "no such window"); return; }

        int targetW = Get(c, "w") != null ? Int(Get(c, "w")) : 1280;
        int quality = Get(c, "q") != null ? Int(Get(c, "q")) : 55;

        Rectangle bounds;
        using (var shot = WindowList.Grab(hwnd, out bounds))
        {
            if (shot == null)
            {
                Reply(w, new Dictionary<string, object> {
                    { "id", id }, { "ok", true }, { "hidden", true },
                    { "rect", Rect(bounds.X, bounds.Y, bounds.Width, bounds.Height) },
                });
                return;
            }

            int targetH;
            byte[] bytes = EncodeScaled(shot, bounds.Width, bounds.Height, ref targetW, quality, out targetH);
            Reply(w, new Dictionary<string, object> {
                { "id", id }, { "ok", true },
                { "data", Convert.ToBase64String(bytes) },
                { "w", targetW }, { "h", targetH },
                { "sw", bounds.Width }, { "sh", bounds.Height }, { "bytes", bytes.Length },
                // Nested rather than flat X/Y/W/H beside the frame's own w/h:
                // two keys differing only in case are legal JSON and a trap for
                // every case-insensitive parser that reads this reply.
                { "rect", Rect(bounds.X, bounds.Y, bounds.Width, bounds.Height) },
                { "title", WindowList.TitleOfPublic(hwnd) },
            });
        }
    }

    /// Raise a window on the host so keystrokes reach it.
    ///
    /// Reports `focused: false` rather than failing when Windows refuses the
    /// foreground change — a refusal is a normal outcome of its foreground-lock
    /// rules, not a broken call, and the client says so instead of retrying.
    static void DoFocusWindow(TextWriter w, object id, Dictionary<string, object> c)
    {
        var hwnd = WindowList.Parse(Get(c, "window"));
        if (hwnd == IntPtr.Zero) { Err(w, id, "no such window"); return; }
        bool focused = WindowList.Focus(hwnd);
        Reply(w, new Dictionary<string, object> { { "id", id }, { "ok", true }, { "focused", focused } });
    }

    static Dictionary<string, object> Rect(int x, int y, int w, int h)
    {
        return new Dictionary<string, object> { { "X", x }, { "Y", y }, { "W", w }, { "H", h } };
    }

    static void EnsureSource(int w, int h)
    {
        if (srcBmp != null && srcW == w && srcH == h) return;
        if (srcGfx != null) srcGfx.Dispose();
        if (srcBmp != null) srcBmp.Dispose();
        srcBmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        srcGfx = Graphics.FromImage(srcBmp);
        srcW = w; srcH = h;
    }

    /// Scale a captured bitmap to `targetW` and JPEG-encode it.
    ///
    /// Shared by the whole-monitor and single-window capture paths so the two
    /// cannot drift apart in scaling quality or encoder settings. `targetW` is
    /// clamped in place — the caller reports back the width it actually got,
    /// which is not the width it asked for when the source is smaller.
    static byte[] EncodeScaled(Bitmap source, int sourceW, int sourceH, ref int targetW, int quality, out int targetH)
    {
        if (targetW < 64) targetW = 64;
        if (targetW > sourceW) targetW = sourceW;
        double scale = targetW / (double)sourceW;
        targetH = (int)Math.Round(sourceH * scale);
        if (targetH < 1) targetH = 1;

        using (var outBmp = new Bitmap(targetW, targetH))
        {
            using (var g = Graphics.FromImage(outBmp))
            {
                // Bilinear, not bicubic: at streaming frame rates the visual
                // difference is nil and bicubic costs about 3x the CPU.
                g.InterpolationMode = InterpolationMode.Bilinear;
                g.PixelOffsetMode = PixelOffsetMode.HighSpeed;
                g.SmoothingMode = SmoothingMode.None;
                g.DrawImage(source, 0, 0, targetW, targetH);
            }
            var ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            using (var ms = new MemoryStream())
            {
                outBmp.Save(ms, jpeg, ep);
                return ms.ToArray();
            }
        }
    }

    static void DoCapture(TextWriter w, object id, Dictionary<string, object> c)
    {
        int targetW = Get(c, "w") != null ? Int(Get(c, "w")) : 1280;
        int quality = Get(c, "q") != null ? Int(Get(c, "q")) : 55;
        bool virt = Bool(Get(c, "virtual"));

        // The same monitor selection as input mapping (ScreenBounds), so the
        // frame the phone sees and the rectangle its taps land on always agree.
        Rectangle b = virt ? SystemInformation.VirtualScreen : ScreenBounds(Get(c, "screen"));
        EnsureSource(b.Width, b.Height);
        srcGfx.CopyFromScreen(b.X, b.Y, 0, 0, new Size(b.Width, b.Height), CopyPixelOperation.SourceCopy);
        Native.DrawCursor(srcGfx, b.X, b.Y);

        int targetH;
        byte[] bytes = EncodeScaled(srcBmp, b.Width, b.Height, ref targetW, quality, out targetH);

        Reply(w, new Dictionary<string, object> {
            { "id", id }, { "ok", true },
            { "data", Convert.ToBase64String(bytes) },
            { "w", targetW }, { "h", targetH },
            { "sw", b.Width }, { "sh", b.Height }, { "bytes", bytes.Length },
        });
    }

    static void DoClick(TextWriter w, object id, Dictionary<string, object> c)
    {
        MaybeMove(c);
        string btn = Get(c, "button") != null ? Str(Get(c, "button")) : "left";
        int times = Bool(Get(c, "double")) ? 2 : 1;
        // Modifiers (Ctrl/Shift/...) are held down for the whole click so the
        // host sees e.g. Ctrl+click, then released in reverse order.
        var mods = new List<ushort>();
        object m = Get(c, "mods");
        if (m is object[])
            foreach (var x in (object[])m) mods.Add((ushort)Int(x));
        foreach (var vk in mods) Native.Key(vk, true);
        for (int n = 0; n < times; n++)
        {
            Native.Button(btn, true);
            Native.Button(btn, false);
            if (n < times - 1) System.Threading.Thread.Sleep(40);
        }
        for (int n = mods.Count - 1; n >= 0; n--) Native.Key(mods[n], false);
        Ok(w, id);
    }

    static void DoKey(TextWriter w, object id, Dictionary<string, object> c)
    {
        var mods = new List<ushort>();
        object m = Get(c, "mods");
        if (m is object[])
            foreach (var x in (object[])m) mods.Add((ushort)Int(x));
        foreach (var vk in mods) Native.Key(vk, true);
        if (Get(c, "vk") != null)
        {
            ushort vk = (ushort)Int(Get(c, "vk"));
            Native.Key(vk, true);
            Native.Key(vk, false);
        }
        for (int n = mods.Count - 1; n >= 0; n--) Native.Key(mods[n], false);
        Ok(w, id);
    }

    internal static void Ok(TextWriter w, object id) { Reply(w, new Dictionary<string, object> { { "id", id }, { "ok", true } }); }
    internal static void Err(TextWriter w, object id, string msg) { Reply(w, new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", msg } }); }

    // One lock for everything that reaches stdout: command replies from the
    // main loop, pushed audio lines from the capture thread, and (under
    // BELAY_WEBRTC_BUILD) pushed webrtc signaling — none may interleave
    // mid-line (the macOS ReplyWriter holds the same invariant).
    internal static readonly object StdoutLock = new object();

    internal static void Reply(TextWriter w, Dictionary<string, object> obj)
    {
        lock (StdoutLock)
        {
            w.WriteLine(J.Serialize(obj));
            w.Flush();
        }
    }

    /// A pushed line that answers no command — audio frames (type:"audio").
    internal static void Push(Dictionary<string, object> obj)
    {
        lock (StdoutLock)
        {
            Console.Out.WriteLine(J.Serialize(obj));
            Console.Out.Flush();
        }
    }

    static object Get(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v : null; }
    static string Str(object o) { return o == null ? "" : o.ToString(); }
    static int Int(object o) { return o == null ? 0 : (int)Math.Round(Convert.ToDouble(o)); }
    static double Dbl(object o) { return o == null ? 0.0 : Convert.ToDouble(o); }
    static bool Bool(object o) { return o != null && (o is bool ? (bool)o : Convert.ToBoolean(o)); }
}
