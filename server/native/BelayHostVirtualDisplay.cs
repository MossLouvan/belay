// BelayHostVirtualDisplay.cs — the host side of the BelayVDD virtual display
// driver (see native/win-display/). Handles the `virtualdisplay` command:
//
//   create {w,h,hz} -> ensure the software device exists, then
//                      IOCTL_BELAYVDD_ADD_MONITOR at exactly that mode
//   destroy         -> IOCTL_BELAYVDD_REMOVE_MONITOR (idempotent)
//   status          -> is the driver installed / device up / monitor active
//
// ============================================================================
// STATUS: WRITTEN-BUT-NOT-COMPILED. Authored on a machine with no Windows and
// no csc.exe. It targets C# 5 (the in-box .NET Framework compiler build.ps1
// uses): no string interpolation, no null-conditional, no expression bodies.
// Verify by running native/build.ps1 on Windows before trusting it.
// ============================================================================
//
// Constants below MIRROR native/win-display/BelayVddIoctl.h by hand (C# cannot
// include a C header). If you change one file, change both.
//
// Failure philosophy: every path that cannot work throws with a message that
// says what to do ("driver not installed — see docs/VIRTUAL-DISPLAY.md"), and
// the main loop turns that into an error reply. The Node layer then answers
// HTTP 501 with the text, so the phone shows a reason instead of a spinner.
//
// Elevation: the driver's device object is ACL'd to SYSTEM/Administrators
// (Driver.cpp). A non-elevated host gets ERROR_ACCESS_DENIED opening it; the
// message says so explicitly because "access denied" alone sends people
// down the wrong road (they reinstall the driver instead of elevating).

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class BelayVirtualDisplay
{
    // ---- contract mirror of BelayVddIoctl.h --------------------------------

    const string SymbolicLink = "\\\\.\\BelayVDD";
    const string HardwareId = "Root\\BelayVDD";

    // GUID_DEVINTERFACE_BELAYVDD — must match BelayVddIoctl.h exactly.
    // {7f2a6b41-9c1e-4d0b-a2c5-58e1b0d4f9a3}
    static readonly Guid InterfaceGuid = new Guid(
        0x7f2a6b41, 0x9c1e, 0x4d0b, 0xa2, 0xc5, 0x58, 0xe1, 0xb0, 0xd4, 0xf9, 0xa3);
    const uint ProtocolVersion = 1;

    const uint MinWidth = 640, MaxWidth = 7680;
    const uint MinHeight = 480, MaxHeight = 4320;
    const uint MinHz = 24, MaxHz = 240;

    // CTL_CODE(0x8b1a, 0x800+idx, METHOD_BUFFERED=0, FILE_WRITE_ACCESS=2)
    //   = (0x8b1a << 16) | (2 << 14) | ((0x800+idx) << 2) | 0
    static uint Ctl(uint idx) { return (0x8b1au << 16) | (2u << 14) | ((0x800u + idx) << 2); }
    static readonly uint IOCTL_VERSION = Ctl(0);
    static readonly uint IOCTL_ADD_MONITOR = Ctl(1);
    static readonly uint IOCTL_REMOVE_MONITOR = Ctl(2);
    static readonly uint IOCTL_STATUS = Ctl(3);

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct VddMode { public uint Width, Height, RefreshHz; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct VddStatusOut { public uint Protocol, MonitorActive; public VddMode Mode; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct VddMonitorOut { public VddMode Mode; public uint Connected; }

    // ---- command entry point ----------------------------------------------

    /// Returns the reply dictionary for one `virtualdisplay` command, or
    /// throws (the main loop's catch turns that into an error reply).
    public static Dictionary<string, object> Handle(object id, Dictionary<string, object> c)
    {
        string action = c.ContainsKey("action") && c["action"] != null ? c["action"].ToString() : "";
        switch (action)
        {
            case "create": return Create(id, c);
            case "destroy": return Destroy(id);
            case "status": return Status(id);
            default: throw new Exception("unknown virtualdisplay action: " + action);
        }
    }

    static uint UintArg(Dictionary<string, object> c, string key, uint min, uint max, uint fallback, bool required)
    {
        object v;
        if (!c.TryGetValue(key, out v) || v == null)
        {
            if (required) throw new Exception("'" + key + "' is required");
            return fallback;
        }
        double d = Convert.ToDouble(v);
        // Reject rather than clamp: Node validated already, so an out-of-range
        // value here means the layers disagree — surface it, don't paper it.
        if (d != Math.Floor(d) || d < min || d > max)
            throw new Exception("'" + key + "' must be an integer in " + min + ".." + max);
        return (uint)d;
    }

    static Dictionary<string, object> Create(object id, Dictionary<string, object> c)
    {
        VddMode mode;
        mode.Width = UintArg(c, "w", MinWidth, MaxWidth, 0, true);
        mode.Height = UintArg(c, "h", MinHeight, MaxHeight, 0, true);
        mode.RefreshHz = UintArg(c, "hz", MinHz, MaxHz, 60, false);
        if (mode.Width % 2 != 0 || mode.Height % 2 != 0)
            throw new Exception("virtual display dimensions must be even");

        EnsureSoftwareDevice();
        using (SafeFileHandle device = OpenControlDevice())
        {
            CheckProtocol(device);
            VddMonitorOut result = IoctlIn<VddMode, VddMonitorOut>(device, IOCTL_ADD_MONITOR, mode);
            var display = new Dictionary<string, object> {
                { "W", (int)result.Mode.Width }, { "H", (int)result.Mode.Height },
                { "hz", (int)result.Mode.RefreshHz },
                { "name", "Belay Virtual Display Adapter" },
            };
            return new Dictionary<string, object> { { "id", id }, { "ok", true }, { "display", display } };
        }
    }

    static Dictionary<string, object> Destroy(object id)
    {
        // No driver, or no device, means nothing to destroy — that is success
        // for an idempotent teardown verb, matching the macOS helper.
        SafeFileHandle device = TryOpenControlDevice();
        if (device == null)
            return new Dictionary<string, object> { { "id", id }, { "ok", true }, { "destroyed", false } };
        using (device)
        {
            IoctlNone(device, IOCTL_REMOVE_MONITOR);
            return new Dictionary<string, object> { { "id", id }, { "ok", true }, { "destroyed", true } };
        }
    }

    static Dictionary<string, object> Status(object id)
    {
        SafeFileHandle device = TryOpenControlDevice();
        if (device == null)
        {
            return new Dictionary<string, object> {
                { "id", id }, { "ok", true }, { "active", false }, { "supported", false },
                { "reason", "BelayVDD driver not installed or not running (see docs/VIRTUAL-DISPLAY.md)" },
            };
        }
        using (device)
        {
            VddStatusOut status = IoctlOut<VddStatusOut>(device, IOCTL_STATUS);
            var reply = new Dictionary<string, object> {
                { "id", id }, { "ok", true },
                { "active", status.MonitorActive != 0 }, { "supported", true },
            };
            if (status.MonitorActive != 0)
            {
                reply["display"] = new Dictionary<string, object> {
                    { "W", (int)status.Mode.Width }, { "H", (int)status.Mode.Height },
                    { "hz", (int)status.Mode.RefreshHz },
                    { "name", "Belay Virtual Display Adapter" },
                };
            }
            return reply;
        }
    }

    // ---- device plumbing ---------------------------------------------------

    static void CheckProtocol(SafeFileHandle device)
    {
        uint protocol = IoctlOut<uint>(device, IOCTL_VERSION);
        if (protocol != ProtocolVersion)
            throw new Exception("BelayVDD protocol mismatch: driver speaks v" + protocol +
                                ", host expects v" + ProtocolVersion + " — reinstall the driver");
    }

    /// Every way we know of to reach the control device, best first.
    ///
    /// The device INTERFACE is authoritative: the driver always registers it,
    /// and its path is unique per devnode. The \\.\BelayVDD symbolic link is a
    /// convenience that can legitimately be missing — the name is global, so a
    /// device still tearing down owns it and the new one cannot claim it.
    /// Relying on the link alone made the host fail with "device did not
    /// appear" against a devnode that was actually healthy.
    static IEnumerable<string> CandidatePaths()
    {
        foreach (string p in DeviceInterfacePaths()) yield return p;
        yield return SymbolicLink;
    }

    /// Interface paths for GUID_DEVINTERFACE_BELAYVDD, present devices only.
    static List<string> DeviceInterfacePaths()
    {
        var result = new List<string>();
        try
        {
            Guid guid = InterfaceGuid;
            int len;
            // CR_SUCCESS == 0; flag 0 = CM_GET_DEVICE_INTERFACE_LIST_PRESENT
            if (CM_Get_Device_Interface_List_SizeW(out len, ref guid, null, 0) != 0 || len <= 1)
                return result;
            var buf = new char[len];
            if (CM_Get_Device_Interface_ListW(ref guid, null, buf, len, 0) != 0)
                return result;
            foreach (string s in new string(buf).Split('\0'))
                if (!string.IsNullOrEmpty(s)) result.Add(s);
        }
        catch (DllNotFoundException) { /* fall back to the symlink */ }
        catch (EntryPointNotFoundException) { }
        return result;
    }

    static SafeFileHandle TryOpenControlDevice()
    {
        foreach (string path in CandidatePaths())
        {
            SafeFileHandle h = CreateFileW(path, 0xC0000000 /* GENERIC_READ|WRITE */,
                0, IntPtr.Zero, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);
            if (!h.IsInvalid) return h;
            h.Dispose();
        }
        return null;
    }

    static SafeFileHandle OpenControlDevice()
    {
        // The software device may take a moment to start after creation, so a
        // few short retries — not an unbounded loop.
        int lastErr = 0;
        for (int attempt = 0; ; attempt++)
        {
            foreach (string path in CandidatePaths())
            {
                SafeFileHandle h = CreateFileW(path, 0xC0000000, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
                if (!h.IsInvalid) return h;
                lastErr = Marshal.GetLastWin32Error();
                h.Dispose();
                if (lastErr == 5) // ERROR_ACCESS_DENIED
                    throw new Exception("access to BelayVDD denied: the Belay host must run elevated " +
                                        "(the device is ACL'd to Administrators) — see docs/VIRTUAL-DISPLAY.md");
            }
            if (attempt >= 10)
                throw new Exception("BelayVDD device did not appear (win32 error " + lastErr + "). " +
                                    "Is the driver installed? See docs/VIRTUAL-DISPLAY.md");
            Thread.Sleep(200);
        }
    }

    // ---- software device creation (SwDeviceCreate) -------------------------
    //
    // The driver package alone gives Windows nothing to bind to: an indirect
    // display adapter is root-enumerated, so SOMETHING must create the devnode.
    // The host creates it here with SWDeviceLifetimeHandle, which is the
    // safety property that matters: when this process exits — cleanly or by
    // crash — Windows removes the device and every monitor with it. A remote
    // session can never leave a ghost display behind.

    static IntPtr swDevice = IntPtr.Zero;
    static readonly object swDeviceLock = new object();
    // The creation callback lives in BelayVddShim.dll, not here, so there is no
    // managed delegate to root. See EnsureSoftwareDevice for why.

    static void EnsureSoftwareDevice()
    {
        lock (swDeviceLock)
        {
            if (swDevice != IntPtr.Zero) return;

            // Why this goes through a native shim instead of calling
            // SwDeviceCreate directly from here:
            //
            // SwDeviceCreate requires a creation callback and pins the module
            // that OWNS that callback for the device's lifetime. A CLR delegate
            // is a runtime-generated thunk belonging to no loaded module, so
            // that lookup fails and the call returns 0x8007007E
            // (ERROR_MOD_NOT_FOUND) before the device is created and before the
            // callback ever runs. Verified on Windows 11 26200: the identical
            // call succeeds from native C++ and fails from .NET three different
            // ways (plain DllImport, raw-pointer struct, and GetProcAddress +
            // GetDelegateForFunctionPointer). A null callback is refused with
            // E_INVALIDARG, so there is no pure-managed way to make this call.
            //
            // BelayVddShim.dll exists solely to own that callback. It is built
            // by build-driver.ps1 and dropped beside this helper.
            IntPtr handle;
            int hr;
            try
            {
                // SW_DEVICE_CAPABILITIES (cfgmgr32.h): Removable = 0x1,
                // SilentInstall = 0x2, NoDisplayInUI = 0x4, DriverRequired = 0x8.
                // DriverRequired matters: without it the devnode comes up even
                // when no driver binds, so a missing or signature-blocked driver
                // would look like success and only fail later at CreateFile.
                hr = BelayVddShimCreate("BelayVDD", HardwareId, 0x1 | 0x2 | 0x8, 20000, out handle);
            }
            catch (DllNotFoundException)
            {
                throw new Exception(
                    "BelayVddShim.dll is missing next to BelayHost.exe. It is built by " +
                    "server/native/win-display/build-driver.ps1 — build the driver package " +
                    "first. See docs/VIRTUAL-DISPLAY.md");
            }
            catch (EntryPointNotFoundException)
            {
                throw new Exception(
                    "BelayVddShim.dll is present but out of date (BelayVddShimCreate not found). " +
                    "Rebuild it with server/native/win-display/build-driver.ps1");
            }

            if (hr != 0)
            {
                throw new Exception(Describe(
                    "BelayVDD device creation failed (driver missing or blocked by signing policy?)", hr));
            }

            swDevice = handle; // held for process lifetime: lifetime == handle
        }
    }

    /// Win32 error -> HRESULT, so Describe() can render it uniformly.
    static int HrFromWin32(int err)
    {
        if (err <= 0) return err;
        return unchecked((int)(0x80070000 | ((uint)err & 0xFFFF)));
    }

    /// Render an HRESULT so a failure is actionable instead of a bare sentence.
    /// `new Win32Exception(hr, message)` REPLACES the system text with `message`,
    /// so the code itself was being thrown away — the difference between "it
    /// didn't work" and "E_ACCESSDENIED: you are not elevated".
    static string Describe(string what, int hr)
    {
        string detail;
        try { detail = new Win32Exception(hr).Message; }
        catch { detail = "(no description)"; }

        string hint = "";
        switch ((uint)hr)
        {
            case 0x80070005: hint = " — access denied; the Belay host must run elevated"; break;
            case 0x80070057: hint = " — invalid argument; SW_DEVICE_CREATE_INFO layout or hardware id is wrong"; break;
            case 0x800705B4: hint = " — timeout waiting for the device to start"; break;
            case 0x800F0242:
            case 0x800B0109: hint = " — driver signature rejected; is test signing on and the cert trusted?"; break;
            case 0x8007000E: hint = " — out of memory"; break;
            case 0x80070490: hint = " — element not found; no driver matched hardware id Root\\BelayVDD"; break;
        }
        return what + " (hr=0x" + ((uint)hr).ToString("x8") + ": " + detail + ")" + hint;
    }

    // ---- IOCTL helpers -----------------------------------------------------

    static void IoctlNone(SafeFileHandle device, uint code)
    {
        uint returned;
        if (!DeviceIoControl(device, code, IntPtr.Zero, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero))
            throw new Exception(Describe("BelayVDD ioctl 0x" + code.ToString("x") + " failed", HrFromWin32(Marshal.GetLastWin32Error())));
    }

    static TOut IoctlOut<TOut>(SafeFileHandle device, uint code) where TOut : struct
    {
        int outSize = Marshal.SizeOf(typeof(TOut));
        IntPtr outBuf = Marshal.AllocHGlobal(outSize);
        try
        {
            uint returned;
            if (!DeviceIoControl(device, code, IntPtr.Zero, 0, outBuf, (uint)outSize, out returned, IntPtr.Zero))
                throw new Exception(Describe("BelayVDD ioctl 0x" + code.ToString("x") + " failed", HrFromWin32(Marshal.GetLastWin32Error())));
            if (returned < outSize)
                throw new Exception("BelayVDD ioctl 0x" + code.ToString("x") + " returned " + returned + " bytes, expected " + outSize);
            return (TOut)Marshal.PtrToStructure(outBuf, typeof(TOut));
        }
        finally { Marshal.FreeHGlobal(outBuf); }
    }

    static TOut IoctlIn<TIn, TOut>(SafeFileHandle device, uint code, TIn input)
        where TIn : struct where TOut : struct
    {
        int inSize = Marshal.SizeOf(typeof(TIn));
        int outSize = Marshal.SizeOf(typeof(TOut));
        IntPtr inBuf = Marshal.AllocHGlobal(inSize);
        IntPtr outBuf = Marshal.AllocHGlobal(outSize);
        try
        {
            Marshal.StructureToPtr(input, inBuf, false);
            uint returned;
            if (!DeviceIoControl(device, code, inBuf, (uint)inSize, outBuf, (uint)outSize, out returned, IntPtr.Zero))
                throw new Exception(Describe("BelayVDD ioctl 0x" + code.ToString("x") + " failed", HrFromWin32(Marshal.GetLastWin32Error())));
            if (returned < outSize)
                throw new Exception("BelayVDD ioctl 0x" + code.ToString("x") + " returned " + returned + " bytes, expected " + outSize);
            return (TOut)Marshal.PtrToStructure(outBuf, typeof(TOut));
        }
        finally { Marshal.FreeHGlobal(inBuf); Marshal.FreeHGlobal(outBuf); }
    }

    // ---- P/Invoke ----------------------------------------------------------

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, uint shareMode,
        IntPtr securityAttributes, uint creationDisposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool DeviceIoControl(SafeFileHandle device, uint ioControlCode,
        IntPtr inBuffer, uint inBufferSize, IntPtr outBuffer, uint outBufferSize,
        out uint bytesReturned, IntPtr overlapped);

    // SW_DEVICE_CREATE_INFO and SW_DEVICE_CREATE_CALLBACK are deliberately NOT
    // declared here any more. They only existed to call SwDeviceCreate from
    // managed code, which cannot work: see EnsureSoftwareDevice. The struct now
    // lives in BelayVddShim.cpp where the compiler lays it out natively.

    // BelayVddShim.dll — built by win-display/build-driver.ps1 and placed beside
    // BelayHost.exe. See EnsureSoftwareDevice for why SwDeviceCreate cannot be
    // called directly from managed code.
    [DllImport("BelayVddShim.dll", CharSet = CharSet.Unicode, CallingConvention = CallingConvention.StdCall)]
    static extern int BelayVddShimCreate(string instanceId, string hardwareId,
        uint capabilityFlags, uint timeoutMs, out IntPtr swDevice);

    [DllImport("BelayVddShim.dll", CallingConvention = CallingConvention.StdCall)]
    static extern void BelayVddShimClose(IntPtr swDevice);

    // Device interface enumeration. Unlike SwDeviceCreate these take no
    // callback, so they are safe to call straight from managed code.
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_Device_Interface_List_SizeW(out int length, ref Guid interfaceClass,
        string deviceId, int flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_Device_Interface_ListW(ref Guid interfaceClass, string deviceId,
        char[] buffer, int bufferLength, int flags);
}
