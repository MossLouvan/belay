// System-audio capture on Windows via WASAPI loopback — the driverless path.
//
// STATUS: WRITTEN-BUT-NOT-COMPILED. There is no Windows machine or csc.exe in
// the environment this was written in. The API shape follows the documented
// WASAPI loopback recipe (IMMDeviceEnumerator.GetDefaultAudioEndpoint(eRender)
// + IAudioClient.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_
// LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK)), which Microsoft supports
// event-driven since Windows 10 1703. Compile and run it on a real Windows box
// (docs/AUDIO.md has the steps) before believing a word of it.
//
// Why WASAPI loopback and not a virtual audio driver: loopback taps the render
// mix of the default device with no driver install, no reboot and no signing
// ceremony. The virtual-driver route (a fork of Microsoft's MIT-licensed SYSVAD
// sample) is only needed later for headless hosts with no audio endpoint at
// all, and lives behind its own milestone. BlackHole is GPL-3 — reference
// material only, never linked or ported into this codebase.
//
// Per-process capture (Windows 11 22H2+) exists via ActivateAudioInterfaceAsync
// with AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, which captures one process
// tree instead of the whole mix. Deliberately not used yet: whole-mix loopback
// works from Windows 10 1703 up and "everything you hear" is the product
// behaviour the phone expects. The constants are noted here so the upgrade is
// an addition, not a rewrite.
//
// Output contract (identical to the macOS helper, see AudioCapture.swift):
// 20 ms frames, 48 kHz interleaved stereo s16le, one
// {"type":"audio","seq":…,"ts":…,"codec":"pcm16","sr":48000,"ch":2,"data":…}
// line per frame, pushed on the shared stdout under BelayHost.StdoutLock. The
// mix format is whatever the endpoint runs at (usually float32 at 44.1 or
// 48 kHz); a linear resampler below normalises to 48 kHz so the wire never
// carries a second clock.

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class BelayHostAudio
{
    // ── WASAPI constants ─────────────────────────────────────────────────────
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const int eRender = 0;
    const int eConsole = 0;
    // Buffer duration in 100 ns units: 200 ms of cushion, far more than the
    // 20 ms cadence needs, so a GC pause never overruns the shared buffer.
    const long REFTIMES_PER_BUFFER = 2000000;

    const int OutSampleRate = 48000;
    const int OutChannels = 2;
    const int SamplesPerFrame = 960; // 20 ms at 48 kHz

    // ── COM interop (only the vtable slots we call are typed fully;
    //    earlier slots must still be DECLARED to keep the vtable offsets right)

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object activated);
        int OpenPropertyStore(int access, out IntPtr properties);
        int GetId(out IntPtr id);
        int GetState(out int state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration,
                       long periodicity, IntPtr format, IntPtr audioSessionGuid);
        int GetBufferSize(out uint bufferFrames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frames, out int flags,
                      out ulong devicePosition, out ulong qpcPosition);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint frames);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int WaitForSingleObject(IntPtr handle, int milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    // ── capture state (guarded by the class lock) ────────────────────────────
    static readonly object Gate = new object();
    static Thread worker;
    static volatile bool running;
    static string lastError;
    static ushort seq;      // u16 wire sequence, wraps
    static uint timestamp;  // u32 sample clock at 48 kHz, wraps

    internal static void Start(TextWriter w, object id)
    {
        lock (Gate)
        {
            if (running) { ReplyStarted(w, id); return; }
            lastError = null;
            running = true;
            worker = new Thread(CaptureLoop);
            worker.IsBackground = true;
            worker.Name = "belay-audio-loopback";
            worker.Start();
        }
        // Give initialisation a moment so an immediate failure (no endpoint,
        // an exclusive-mode holder) surfaces on the reply instead of silence.
        Thread.Sleep(150);
        lock (Gate)
        {
            if (!running && lastError != null) { BelayHost.Err(w, id, "audio capture failed: " + lastError); return; }
        }
        ReplyStarted(w, id);
    }

    static void ReplyStarted(TextWriter w, object id)
    {
        BelayHost.Reply(w, new Dictionary<string, object> {
            { "id", id }, { "ok", true }, { "capturing", true },
            { "codec", "pcm16" }, { "sampleRate", OutSampleRate }, { "channels", OutChannels },
        });
    }

    internal static void Stop(TextWriter w, object id)
    {
        Thread toJoin = null;
        lock (Gate)
        {
            running = false;
            toJoin = worker;
            worker = null;
        }
        if (toJoin != null) toJoin.Join(1000);
        BelayHost.Ok(w, id);
    }

    internal static void Status(TextWriter w, object id)
    {
        var payload = new Dictionary<string, object> {
            { "id", id }, { "ok", true }, { "capturing", running }, { "codec", "pcm16" },
        };
        lock (Gate) { if (lastError != null) payload["stopReason"] = lastError; }
        BelayHost.Reply(w, payload);
    }

    // ── the loopback loop (runs on `worker`) ─────────────────────────────────

    static void CaptureLoop()
    {
        IntPtr eventHandle = IntPtr.Zero;
        IntPtr mixFormatPtr = IntPtr.Zero;
        IAudioClient client = null;
        IAudioCaptureClient captureClient = null;
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device;
            Check(enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device),
                  "no default render endpoint (headless host? that is the future SYSVAD-fork milestone)");

            object activated;
            var iid = IID_IAudioClient;
            Check(device.Activate(ref iid, 1 /* CLSCTX_INPROC_SERVER */, IntPtr.Zero, out activated),
                  "IAudioClient activation failed");
            client = (IAudioClient)activated;

            Check(client.GetMixFormat(out mixFormatPtr), "GetMixFormat failed");
            // WAVEFORMATEX: wFormatTag(2) nChannels(2) nSamplesPerSec(4) ...
            int mixChannels = Marshal.ReadInt16(mixFormatPtr, 2);
            int mixRate = Marshal.ReadInt32(mixFormatPtr, 4);
            int bitsPerSample = Marshal.ReadInt16(mixFormatPtr, 14);
            int formatTag = (ushort)Marshal.ReadInt16(mixFormatPtr, 0);
            bool isFloat = formatTag == 3 /* IEEE float */
                || (formatTag == 0xFFFE /* extensible */ && bitsPerSample == 32);
            if (!isFloat || mixChannels < 1)
                throw new InvalidOperationException("unexpected mix format (tag " + formatTag
                    + ", " + bitsPerSample + " bits) — only the float32 shared mix is handled");

            // Loopback + event-driven, shared mode, at the mix format verbatim
            // (loopback must use the mix format; asking for anything else fails).
            Check(client.Initialize(AUDCLNT_SHAREMODE_SHARED,
                                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                    REFTIMES_PER_BUFFER, 0, mixFormatPtr, IntPtr.Zero),
                  "IAudioClient.Initialize(loopback) failed");

            eventHandle = CreateEventW(IntPtr.Zero, false, false, null);
            if (eventHandle == IntPtr.Zero) throw new InvalidOperationException("CreateEvent failed");
            Check(client.SetEventHandle(eventHandle), "SetEventHandle failed");

            object service;
            var captureIid = IID_IAudioCaptureClient;
            Check(client.GetService(ref captureIid, out service), "GetService(IAudioCaptureClient) failed");
            captureClient = (IAudioCaptureClient)service;

            Check(client.Start(), "IAudioClient.Start failed");

            // Accumulates interleaved stereo s16 at 48 kHz until a 20 ms frame
            // is complete. `resamplePos` carries the fractional read position
            // across packets for the linear resampler.
            var pending = new List<short>(SamplesPerFrame * OutChannels * 2);
            double resamplePos = 0.0;
            double step = (double)mixRate / OutSampleRate;

            while (running)
            {
                // 100 ms timeout so a stopped engine or pulled device cannot
                // hang the thread; the loop just re-checks `running`.
                WaitForSingleObject(eventHandle, 100);
                uint packetFrames;
                while (running && captureClient.GetNextPacketSize(out packetFrames) == 0 && packetFrames > 0)
                {
                    IntPtr data; uint frames; int flags; ulong devPos; ulong qpcPos;
                    Check(captureClient.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos),
                          "GetBuffer failed");
                    try
                    {
                        bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                        // Read float32 interleaved; resample mixRate -> 48 kHz
                        // with linear interpolation (fine for voice/media over
                        // a phone speaker; a polyphase filter is an upgrade,
                        // not a correctness fix). Mono duplicates; >2ch takes
                        // the first two.
                        int total = (int)frames;
                        var left = new float[total];
                        var right = new float[total];
                        if (!silent && total > 0)
                        {
                            // No /unsafe: marshal the interleaved float block,
                            // then split channels. Mono duplicates; >2ch takes
                            // the first two.
                            var interleaved = new float[total * mixChannels];
                            Marshal.Copy(data, interleaved, 0, interleaved.Length);
                            for (int i = 0; i < total; i++)
                            {
                                left[i] = interleaved[i * mixChannels];
                                right[i] = mixChannels > 1 ? interleaved[i * mixChannels + 1] : left[i];
                            }
                        }
                        // Linear resample mixRate -> 48 kHz into the pending
                        // buffer, carrying the fractional position across
                        // packets. Within a packet the last sample is held for
                        // the tail — a one-sample zero-order hold per packet,
                        // inaudible and allocation-free.
                        while (resamplePos < total)
                        {
                            int i0 = (int)resamplePos;
                            double frac = resamplePos - i0;
                            float l0 = left[i0];
                            float r0 = right[i0];
                            float l1 = i0 + 1 < total ? left[i0 + 1] : l0;
                            float r1 = i0 + 1 < total ? right[i0 + 1] : r0;
                            pending.Add(ClampToS16(l0 + (float)frac * (l1 - l0)));
                            pending.Add(ClampToS16(r0 + (float)frac * (r1 - r0)));
                            resamplePos += step;
                        }
                        resamplePos -= total;
                    }
                    finally
                    {
                        captureClient.ReleaseBuffer(frames);
                    }
                    EmitCompleteFrames(pending);
                }
            }
            client.Stop();
        }
        catch (Exception e)
        {
            lock (Gate) { lastError = e.Message; running = false; }
        }
        finally
        {
            if (captureClient != null) Marshal.ReleaseComObject(captureClient);
            if (client != null) Marshal.ReleaseComObject(client);
            if (mixFormatPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormatPtr);
            if (eventHandle != IntPtr.Zero) CloseHandle(eventHandle);
        }
    }

    /// Every complete 20 ms frame in `pending` becomes one pushed wire line.
    static void EmitCompleteFrames(List<short> pending)
    {
        int samplesPerWireFrame = SamplesPerFrame * OutChannels;
        while (pending.Count >= samplesPerWireFrame)
        {
            var bytes = new byte[samplesPerWireFrame * 2];
            for (int i = 0; i < samplesPerWireFrame; i++)
            {
                short s = pending[i];
                bytes[i * 2] = (byte)(s & 0xFF);          // s16 LITTLE-endian: the wire
                bytes[i * 2 + 1] = (byte)((s >> 8) & 0xFF); // contract, not host order
            }
            pending.RemoveRange(0, samplesPerWireFrame);

            BelayHost.Push(new Dictionary<string, object> {
                { "type", "audio" },
                { "seq", (int)seq },
                { "ts", (long)timestamp },
                { "codec", "pcm16" },
                { "sr", OutSampleRate },
                { "ch", OutChannels },
                { "data", Convert.ToBase64String(bytes) },
            });
            seq = (ushort)(seq + 1);
            timestamp = (uint)(timestamp + (uint)SamplesPerFrame);
        }
    }

    static short ClampToS16(float value)
    {
        float scaled = value * 32767f;
        if (scaled >= 32767f) return short.MaxValue;
        if (scaled <= -32768f) return short.MinValue;
        return (short)scaled;
    }

    static void Check(int hresult, string what)
    {
        if (hresult != 0)
            throw new InvalidOperationException(what + " (hr=0x" + hresult.ToString("X8") + ")");
    }
}
