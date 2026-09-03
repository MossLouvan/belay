// BelayHostWebRtc.cs — the Windows WebRTC media path:
// Desktop Duplication -> Media Foundation H.264/HEVC (NVENC/QSV/AMF/software)
// -> libdatachannel SRTP transport (belay_transport.dll, same C ABI as macOS).
//
// ┌─ STATUS: WRITTEN-BUT-NOT-COMPILED (hardware-gated) ─────────────────────┐
// │ Compiled ONLY when build.ps1 runs with BELAY_WEBRTC_BUILD=1 (it adds     │
// │ /define:BELAY_WEBRTC_BUILD and this source). It has NEVER been compiled  │
// │ or run — there is no Windows machine in this loop. The COM interface     │
// │ declarations below must have their vtable method order verified against  │
// │ the dxgi/mftransform headers on first compile; treat NOTHING here as     │
// │ working until docs/WEBRTC-SLICE.md's runbook produces a number (M6).     │
// │ Written for csc.exe v4.0.30319 = C# 5: no interpolation, no ?., etc.    │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Structure (the same encode→packetize→SRTP shape as the macOS helper, and the
// same class of pipeline Sunshine uses on Windows):
//   1. WebrtcHost.Handle — the `webrtc` stdio verb. Every failure path returns
//      a clean error reply, which is exactly the signal /ws/webrtc needs to
//      leave the phone on the JPEG fallback. It must never hang or crash Main.
//   2. EncoderMatrix — MFTEnumEx over MFT_CATEGORY_VIDEO_ENCODER, hardware
//      first, mapped to NVENC -> QSV -> AMF by vendor string, software last.
//   3. Duplicator — IDXGIOutputDuplication capture into a D3D11 texture that is
//      handed to the encoder MFT as a DXGI surface buffer (no CPU readback).
//   4. Transport — P/Invoke over belay_transport.dll (belay_transport.h ABI).
//      The delegate instances are held in fields: if the GC collects a
//      marshalled callback delegate while native code holds the pointer, the
//      process dies — the classic P/Invoke callback bug.

#if BELAY_WEBRTC_BUILD

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class WebrtcHost
{
    // Set by Main: writes one JSON reply/push line to stdout (thread-safe there).
    public static Action<Dictionary<string, object>> Write;

    static WebrtcSession session; // one active session, like the mac helper
    static readonly object gate = new object();

    /// The `webrtc` verb. `signal` was validated by relay.ts, but this process
    /// trusts nothing crossing its stdin: every field is re-checked.
    public static void Handle(object id, Dictionary<string, object> c)
    {
        var signal = GetObject(c, "signal");
        if (signal == null) { Fail(id, "webrtc: missing signal"); return; }
        string kind = AsString(signal, "kind");
        string sid = AsString(signal, "sessionId");
        if (kind == null || sid == null) { Fail(id, "webrtc: malformed signal"); return; }

        try
        {
            lock (gate)
            {
                if (kind == "offer")
                {
                    string sdp = AsString(signal, "sdp");
                    if (sdp == null) { Fail(id, "webrtc offer: missing sdp"); return; }
                    if (session != null) session.Dispose();
                    session = new WebrtcSession(sid, sdp);
                }
                else if (kind == "ice")
                {
                    string cand = AsString(signal, "candidate");
                    if (cand == null) { Fail(id, "webrtc ice: missing candidate"); return; }
                    if (session != null && session.SessionId == sid) session.AddCandidate(cand);
                }
                else if (kind == "bye")
                {
                    if (session != null && session.SessionId == sid) { session.Dispose(); session = null; }
                }
                else { Fail(id, "webrtc: unknown signal kind '" + kind + "'"); return; }
            }
            Write(new Dictionary<string, object> { { "id", id }, { "ok", true } });
        }
        catch (Exception e)
        {
            // The one rule of this path: fail CLEANLY. An error reply is what
            // sends the phone back to JPEG; an exception out of here would kill
            // the helper and take the JPEG path down with it.
            lock (gate) { if (session != null) { session.Dispose(); session = null; } }
            Fail(id, "webrtc failed (falling back to JPEG): " + e.Message);
        }
    }

    public static void Shutdown()
    {
        lock (gate) { if (session != null) { session.Dispose(); session = null; } }
    }

    public static void PushSignal(Dictionary<string, object> signal)
    {
        Write(new Dictionary<string, object> { { "type", "webrtc" }, { "signal", signal } });
    }

    static void Fail(object id, string msg)
    {
        Write(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", msg } });
    }

    static Dictionary<string, object> GetObject(Dictionary<string, object> d, string k)
    {
        object v; d.TryGetValue(k, out v); return v as Dictionary<string, object>;
    }
    static string AsString(Dictionary<string, object> d, string k)
    {
        object v; d.TryGetValue(k, out v);
        var s = v as string; return string.IsNullOrEmpty(s) ? null : s;
    }
}

/// One WebRTC session: transport + duplication + encoder + the encode thread.
sealed class WebrtcSession : IDisposable
{
    public readonly string SessionId;

    IntPtr transport;
    IntPtr duplication;   // IDXGIOutputDuplication (COM, AddRef'd)
    IntPtr encoderMft;    // IMFTransform (COM, AddRef'd)
    Thread encodeThread;
    volatile bool running;
    volatile bool connected;

    // Keep every marshalled callback delegate alive for the transport's life.
    Transport.OnLocalDescription cbDesc;
    Transport.OnLocalCandidate cbCand;
    Transport.OnChannelMessage cbMsg;
    Transport.OnState cbState;
    Transport.OnKeyframeRequest cbKeyframe;
    volatile bool wantKeyframe = true; // first frame a decoder sees must be an IDR

    public WebrtcSession(string sessionId, string offerSdp)
    {
        SessionId = sessionId;

        // Probe order matters: cheap failures first, so a box with no hardware
        // encoder never touches the transport DLL.
        EncoderMatrix.Selection enc = EncoderMatrix.PickBest(
            offerSdp.ToUpperInvariant().Contains("H265"));
        if (enc == null)
            throw new InvalidOperationException("no usable Media Foundation video encoder found");

        cbDesc = OnDesc; cbCand = OnCand; cbMsg = OnMsg; cbState = OnState; cbKeyframe = OnKeyframe;
        var callbacks = new Transport.Callbacks
        {
            ctx = IntPtr.Zero,
            on_local_description = Marshal.GetFunctionPointerForDelegate(cbDesc),
            on_local_candidate = Marshal.GetFunctionPointerForDelegate(cbCand),
            on_channel_message = Marshal.GetFunctionPointerForDelegate(cbMsg),
            on_state = Marshal.GetFunctionPointerForDelegate(cbState),
            on_keyframe_request = Marshal.GetFunctionPointerForDelegate(cbKeyframe),
            on_link_feedback = IntPtr.Zero, // ABR feedback rides the control channel
        };
        transport = Transport.Create(enc.Hevc ? 1 : 0, null, ref callbacks);
        if (transport == IntPtr.Zero)
            throw new InvalidOperationException("belay_transport_create failed (is belay_transport.dll beside BelayHost.exe?)");

        duplication = Duplicator.Open();          // throws with a clear message on denial
        encoderMft = enc.Activate();              // IMFTransform, low-latency configured

        Transport.SetRemoteOffer(transport, offerSdp);
        // Answer + candidates flow back on the callbacks; media starts when the
        // state callback reports "connected".
    }

    // ── transport callbacks (libdatachannel threads) ─────────────────────────

    void OnDesc(IntPtr ctx, string type, string sdp)
    {
        WebrtcHost.PushSignal(new Dictionary<string, object> {
            { "kind", type }, { "sessionId", SessionId }, { "sdp", sdp } });
    }

    void OnCand(IntPtr ctx, string candidate, string mid)
    {
        WebrtcHost.PushSignal(new Dictionary<string, object> {
            { "kind", "ice" }, { "sessionId", SessionId }, { "candidate", candidate } });
    }

    void OnState(IntPtr ctx, string state)
    {
        if (state == "connected" || state == "Connected")
        {
            connected = true;
            StartEncodeLoop();
        }
        else if (state == "failed" || state == "closed" || state == "Failed" || state == "Closed")
        {
            connected = false;
            running = false; // the phone's ICE machine decides recover-vs-die
        }
    }

    void OnKeyframe(IntPtr ctx) { wantKeyframe = true; }

    void OnMsg(IntPtr ctx, int channel, IntPtr data, UIntPtr len)
    {
        // input(0)/cursor(1): injection events, same JSON shapes as stdio.
        // control(2): {"t":"bitrate","bps":N} | {"t":"keyframe"} | {"t":"ping",...}
        try
        {
            var bytes = new byte[(int)len];
            Marshal.Copy(data, bytes, 0, bytes.Length);
            string json = Encoding.UTF8.GetString(bytes);
            var msg = (Dictionary<string, object>)new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(json);
            if (channel == 2) HandleControl(msg);
            else InputBridge.Inject(msg); // routes to the existing Native.* injectors
        }
        catch (Exception e)
        {
            SendControl("{\"t\":\"error\",\"message\":\"" + e.Message.Replace("\"", "'") + "\"}");
        }
    }

    void HandleControl(Dictionary<string, object> msg)
    {
        object t; msg.TryGetValue("t", out t);
        string kind = t as string;
        if (kind == "bitrate")
        {
            object bps; msg.TryGetValue("bps", out bps);
            if (bps != null) EncoderMatrix.SetBitrate(encoderMft, Convert.ToInt32(bps));
        }
        else if (kind == "keyframe") wantKeyframe = true;
        else if (kind == "ping")
        {
            msg["t"] = "pong";
            msg["tHost"] = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            SendControl(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(msg));
        }
    }

    void SendControl(string json)
    {
        if (transport == IntPtr.Zero) return;
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        Transport.SendOn(transport, 2, bytes, (UIntPtr)bytes.Length);
    }

    // ── the media loop ───────────────────────────────────────────────────────

    void StartEncodeLoop()
    {
        if (encodeThread != null) return;
        running = true;
        encodeThread = new Thread(EncodeLoop);
        encodeThread.IsBackground = true;
        encodeThread.Name = "belay-webrtc-encode";
        encodeThread.Start();
    }

    /// AcquireNextFrame -> encoder MFT -> transport, per frame. Push, not pull:
    /// AcquireNextFrame blocks until the desktop actually changes, which gives
    /// variable-rate encoding for free (idle desktop = no packets), the same
    /// trick Sunshine uses.
    void EncodeLoop()
    {
        while (running)
        {
            IntPtr surface;
            double ptsMs;
            if (!Duplicator.AcquireFrame(duplication, 100 /* ms */, out surface, out ptsMs))
                continue; // timeout: nothing changed on screen
            try
            {
                bool forceIdr = wantKeyframe;
                if (forceIdr) wantKeyframe = false;
                // The MF H.264/HEVC encoders emit Annex-B byte streams (start
                // codes, in-band SPS/PPS on IDRs) — exactly what the packetizer
                // in belay_transport expects; no AVCC conversion on Windows.
                byte[] annexB = EncoderMatrix.Encode(encoderMft, surface, forceIdr, out ptsMs);
                // Re-check `running` after the (bounded) encode: Dispose may have
                // flipped it while we were inside Encode, and SendFrame must not
                // touch a transport Dispose is about to close.
                if (annexB != null && annexB.Length > 0 && running && connected)
                    Transport.SendFrame(transport, annexB, (UIntPtr)annexB.Length, forceIdr ? 1 : 0, ptsMs);
            }
            finally
            {
                Duplicator.ReleaseFrame(duplication, surface);
            }
        }
    }

    public void Dispose()
    {
        running = false;
        connected = false;
        // Wait for EncodeLoop to fully exit BEFORE freeing the native handles it
        // dereferences (duplication, encoder, transport). The old Join(500)
        // ignored its return value and freed regardless — if the loop was still
        // inside AcquireFrame / Encode / SendFrame it then used freed handles and
        // took the whole helper down. The loop re-checks `running` every
        // AcquireFrame timeout (<=100 ms) and one Encode is bounded, so a full
        // join returns promptly; the 3 s cap only guards a wedged encoder, and if
        // it ever trips we LEAK the handles rather than free them under a live
        // thread — a bounded leak is strictly safer than a use-after-free.
        var t = encodeThread;
        encodeThread = null;
        if (t != null && !t.Join(3000)) return;
        if (transport != IntPtr.Zero) { Transport.Close(transport); transport = IntPtr.Zero; }
        if (encoderMft != IntPtr.Zero) { Marshal.Release(encoderMft); encoderMft = IntPtr.Zero; }
        if (duplication != IntPtr.Zero) { Duplicator.CloseDuplication(duplication); duplication = IntPtr.Zero; }
    }
}

/// P/Invoke surface of belay_transport.dll — the identical C ABI compiled from
/// server/native/mac/transport/belay_transport.{h,cpp} for Windows (libdatachannel
/// is cross-platform; build it static with the same pin, see the runbook).
static class Transport
{
    const string DLL = "belay_transport.dll";

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void OnLocalDescription(IntPtr ctx, [MarshalAs(UnmanagedType.LPStr)] string type, [MarshalAs(UnmanagedType.LPStr)] string sdp);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void OnLocalCandidate(IntPtr ctx, [MarshalAs(UnmanagedType.LPStr)] string candidate, [MarshalAs(UnmanagedType.LPStr)] string mid);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void OnChannelMessage(IntPtr ctx, int channel, IntPtr data, UIntPtr len);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void OnState(IntPtr ctx, [MarshalAs(UnmanagedType.LPStr)] string state);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void OnKeyframeRequest(IntPtr ctx);

    [StructLayout(LayoutKind.Sequential)]
    public struct Callbacks
    {
        public IntPtr ctx;
        public IntPtr on_local_description;
        public IntPtr on_local_candidate;
        public IntPtr on_channel_message;
        public IntPtr on_state;
        public IntPtr on_keyframe_request;
        public IntPtr on_link_feedback;
    }

    [DllImport(DLL, EntryPoint = "belay_transport_create", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr Create(int codec, [MarshalAs(UnmanagedType.LPStr)] string iceServers, ref Callbacks callbacks);
    [DllImport(DLL, EntryPoint = "belay_transport_set_remote_offer", CallingConvention = CallingConvention.Cdecl)]
    public static extern void SetRemoteOffer(IntPtr t, [MarshalAs(UnmanagedType.LPStr)] string sdp);
    [DllImport(DLL, EntryPoint = "belay_transport_add_remote_candidate", CallingConvention = CallingConvention.Cdecl)]
    public static extern void AddCandidate(IntPtr t, [MarshalAs(UnmanagedType.LPStr)] string candidate, [MarshalAs(UnmanagedType.LPStr)] string mid);
    [DllImport(DLL, EntryPoint = "belay_transport_send_frame", CallingConvention = CallingConvention.Cdecl)]
    public static extern void SendFrame(IntPtr t, byte[] annexb, UIntPtr len, int isKeyframe, double ptsMs);
    [DllImport(DLL, EntryPoint = "belay_transport_send_on", CallingConvention = CallingConvention.Cdecl)]
    public static extern void SendOn(IntPtr t, int channel, byte[] data, UIntPtr len);
    [DllImport(DLL, EntryPoint = "belay_transport_close", CallingConvention = CallingConvention.Cdecl)]
    public static extern void Close(IntPtr t);
}

/// Encoder selection + configuration. Preference: NVENC -> QSV -> AMF ->
/// software (docs/PERFORMANCE-PLAN.md §6). Hardware MFTs are enumerated with
/// MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE) and mapped to
/// a vendor by friendly-name substring — the same heuristic FFmpeg/OBS use.
static class EncoderMatrix
{
    public sealed class Selection
    {
        public bool Hevc;
        public IntPtr ActivateObj; // IMFActivate
        public string FriendlyName;
        public int Rank;           // 0=NVENC 1=QSV 2=AMF 3=software

        public IntPtr Activate()
        {
            // IMFActivate::ActivateObject(IID_IMFTransform) then configure:
            //  - CODECAPI_AVLowLatencyMode = TRUE (ICodecAPI)
            //  - CODECAPI_AVEncCommonRateControlMode = CBR
            //  - CODECAPI_AVEncCommonMeanBitRate = initial setpoint
            //  - CODECAPI_AVEncMPVGOPSize = large (IDRs forced explicitly)
            //  - output type MFVideoFormat_H264 / _HEVC, input NV12 from a
            //    D3D11 video processor stage (BGRA duplication -> NV12)
            //  - MFT_MESSAGE_SET_D3D_MANAGER with the same device as capture,
            //    so frames never leave the GPU
            // Deferred to first compile on a Windows box (M6): the ICodecAPI /
            // IMFTransform COM signatures below carry the shape.
            throw new NotImplementedException(
                "MF encoder activation is written to shape but needs its COM vtables "
                + "verified on a Windows build (M6) — see docs/WEBRTC-SLICE.md");
        }
    }

    [DllImport("mfplat.dll")] static extern int MFStartup(int version, int flags);
    [DllImport("mfplat.dll")]
    static extern int MFTEnumEx(Guid guidCategory, int flags, IntPtr inputType, IntPtr outputType,
                                out IntPtr pppMFTActivate, out int numMFTActivate);

    static readonly Guid MFT_CATEGORY_VIDEO_ENCODER = new Guid("f79eac7d-e545-4387-bdee-d647d7bde42a");
    const int MFT_ENUM_FLAG_HARDWARE = 0x4;
    const int MFT_ENUM_FLAG_SYNCMFT = 0x1;
    const int MFT_ENUM_FLAG_SORTANDFILTER = 0x40;
    const int MF_VERSION = 0x20070; // MF_SDK_VERSION << 16 | MF_API_VERSION

    /// Enumerates hardware encoder MFTs and returns the best per the matrix,
    /// or the software MFT as last resort, or null when none exists. This part
    /// is real enumeration code (P/Invoke only, no COM vtables), so a machine
    /// with no encoder fails here — before any transport/duplication work.
    public static Selection PickBest(bool preferHevc)
    {
        if (MFStartup(MF_VERSION, 0) < 0) return null;
        IntPtr activates; int count;
        int hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
                           MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                           IntPtr.Zero, IntPtr.Zero, out activates, out count);
        Selection best = null;
        if (hr >= 0 && count > 0)
        {
            for (int i = 0; i < count; i++)
            {
                IntPtr activate = Marshal.ReadIntPtr(activates, i * IntPtr.Size);
                string name = ReadFriendlyName(activate);
                int rank = RankOf(name);
                if (best == null || rank < best.Rank)
                    best = new Selection { ActivateObj = activate, FriendlyName = name, Rank = rank, Hevc = preferHevc };
            }
        }
        if (best == null)
        {
            // Software fallback: enumerate again without the hardware flag.
            hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_SYNCMFT,
                           IntPtr.Zero, IntPtr.Zero, out activates, out count);
            if (hr >= 0 && count > 0)
                best = new Selection {
                    ActivateObj = Marshal.ReadIntPtr(activates, 0),
                    FriendlyName = "software", Rank = 3, Hevc = false /* soft HEVC is hopeless live */ };
        }
        return best;
    }

    static int RankOf(string friendlyName)
    {
        string n = (friendlyName ?? "").ToUpperInvariant();
        if (n.Contains("NVIDIA")) return 0;                        // NVENC
        if (n.Contains("INTEL") || n.Contains("QUICK")) return 1;  // QSV
        if (n.Contains("AMD") || n.Contains("AMF")) return 2;      // AMF
        return 3;
    }

    static string ReadFriendlyName(IntPtr activate)
    {
        // IMFActivate inherits IMFAttributes; GetAllocatedString(MFT_FRIENDLY_NAME)
        // via a minimal vtable call. Written to shape, verified on first compile.
        try
        {
            var attrs = (IMFAttributes)Marshal.GetObjectForIUnknown(activate);
            IntPtr str; int len;
            Guid MFT_FRIENDLY_NAME = new Guid("314ffbae-5b41-4c95-9c19-4e7d586face3");
            if (attrs.GetAllocatedString(ref MFT_FRIENDLY_NAME, out str, out len) >= 0 && str != IntPtr.Zero)
            {
                string s = Marshal.PtrToStringUni(str, len);
                Marshal.FreeCoTaskMem(str);
                return s;
            }
        }
        catch (Exception) { /* an MFT with no name is still usable; rank 3 */ }
        return "";
    }

    public static void SetBitrate(IntPtr mft, int bps)
    {
        // ICodecAPI::SetValue(CODECAPI_AVEncCommonMeanBitRate, bps) on the live
        // encoder — NVENC/QSV/AMF all accept dynamic bitrate in CBR mode.
        // Deferred to M6 with Activate(); clamped like the mac side there.
    }

    public static byte[] Encode(IntPtr mft, IntPtr dxgiSurface, bool forceIdr, out double ptsMs)
    {
        // ProcessInput(MFCreateDXGISurfaceBuffer(sample)) -> ProcessOutput.
        // forceIdr => ICodecAPI::SetValue(CODECAPI_AVEncVideoForceKeyFrame, 1).
        // Deferred to M6 with Activate().
        ptsMs = 0;
        throw new NotImplementedException("MF encode loop needs a Windows build (M6)");
    }

    /// Minimal IMFAttributes slice — ONLY safe if the full vtable order below
    /// matches mfobjects.h; every method up to GetAllocatedString must be
    /// declared (as placeholders) to keep the COM slot numbers right. Verify on
    /// first Windows compile (M6).
    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFAttributes
    {
        int GetItem(ref Guid key, IntPtr value);
        int GetItemType(ref Guid key, out int type);
        int CompareItem(ref Guid key, IntPtr value, out bool result);
        int Compare(IMFAttributes theirs, int matchType, out bool result);
        int GetUINT32(ref Guid key, out int value);
        int GetUINT64(ref Guid key, out long value);
        int GetDouble(ref Guid key, out double value);
        int GetGUID(ref Guid key, out Guid value);
        int GetStringLength(ref Guid key, out int length);
        int GetString(ref Guid key, IntPtr value, int size, out int length);
        int GetAllocatedString(ref Guid key, out IntPtr value, out int length);
        // ... remaining IMFAttributes methods are never called through this
        // slice, and COM dispatch is positional from the top, so they may be
        // omitted ONLY because no method after GetAllocatedString is invoked.
    }
}

/// Desktop Duplication: the GPU-surface capture source. Full IDXGI* vtable
/// declarations are deferred to the first Windows compile (M6); Open() throws a
/// descriptive error until then so the probe order in WebrtcSession fails clean.
static class Duplicator
{
    public static IntPtr Open()
    {
        // D3D11CreateDevice(BGRA support) -> IDXGIDevice -> IDXGIAdapter ->
        // EnumOutputs(0) -> IDXGIOutput1::DuplicateOutput(device). Fails with
        // E_ACCESSDENIED on secure desktops (UAC/lock screen) — that error must
        // surface as the fallback reason, not crash the loop.
        throw new NotImplementedException(
            "Desktop Duplication is written to shape but needs its COM vtables "
            + "verified on a Windows build (M6) — see docs/WEBRTC-SLICE.md");
    }

    public static bool AcquireFrame(IntPtr duplication, int timeoutMs, out IntPtr surface, out double ptsMs)
    {
        // IDXGIOutputDuplication::AcquireNextFrame(timeout) -> DXGI_OUTDUPL_FRAME_INFO
        // (LastPresentTime = the capture timestamp for glass-to-glass) + the
        // IDXGIResource -> ID3D11Texture2D surface. DXGI_ERROR_WAIT_TIMEOUT => false.
        surface = IntPtr.Zero; ptsMs = 0;
        return false;
    }

    public static void ReleaseFrame(IntPtr duplication, IntPtr surface)
    {
        // Release the texture + IDXGIOutputDuplication::ReleaseFrame — holding a
        // frame stalls the compositor's queue and shows up as capture jitter.
    }

    public static void CloseDuplication(IntPtr duplication)
    {
        if (duplication != IntPtr.Zero) Marshal.Release(duplication);
    }
}

/// Routes input-channel events (same JSON shapes as stdio commands) to the
/// existing Native.* injectors, so the datachannel path and the stdio path can
/// never drift in behavior. Key-up integrity comes from channels.ts routing key
/// events onto the reliable channel.
static class InputBridge
{
    public static void Inject(Dictionary<string, object> msg)
    {
        object cmdObj; msg.TryGetValue("cmd", out cmdObj);
        string cmd = cmdObj as string;
        if (cmd == null) throw new ArgumentException("input event missing cmd");
        // Delegates installed by Main (BelayHost.cs) so this file needs no
        // access to BelayHost's private helpers.
        if (Route == null) throw new InvalidOperationException("input bridge not wired");
        Route(msg);
    }

    /// Set by Main: dispatches one already-parsed input command dictionary
    /// through the exact switch the stdio loop uses (minus the reply).
    public static Action<Dictionary<string, object>> Route;
}

#endif // BELAY_WEBRTC_BUILD
