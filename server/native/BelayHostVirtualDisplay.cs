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

    static SafeFileHandle TryOpenControlDevice()
    {
        SafeFileHandle h = CreateFileW(SymbolicLink, 0xC0000000 /* GENERIC_READ|WRITE */,
            0, IntPtr.Zero, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); return null; }
        return h;
    }

    static SafeFileHandle OpenControlDevice()
    {
        // The software device may take a moment to start after creation, so a
        // few short retries — not an unbounded loop.
        for (int attempt = 0; ; attempt++)
        {
            SafeFileHandle h = CreateFileW(SymbolicLink, 0xC0000000, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (!h.IsInvalid) return h;
            int err = Marshal.GetLastWin32Error();
            h.Dispose();
            if (err == 5) // ERROR_ACCESS_DENIED
                throw new Exception("access to BelayVDD denied: the Belay host must run elevated " +
                                    "(the device is ACL'd to Administrators) — see docs/VIRTUAL-DISPLAY.md");
            if (attempt >= 10)
                throw new Exception("BelayVDD device did not appear (win32 error " + err + "). " +
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
    // Rooted for the life of the process: Windows may invoke the callback
    // again on device restarts, and a collected delegate is a native callback
    // into freed memory.
    static SW_DEVICE_CREATE_CALLBACK swDeviceCallback;

    static void EnsureSoftwareDevice()
    {
        lock (swDeviceLock)
        {
            if (swDevice != IntPtr.Zero) return;

            var created = new ManualResetEvent(false);
            int createResult = -1;
            swDeviceCallback = delegate(IntPtr device, int hrCreate, IntPtr context, string instanceId)
            {
                createResult = hrCreate;
                created.Set();
            };
            SW_DEVICE_CREATE_CALLBACK callback = swDeviceCallback;

            var info = new SW_DEVICE_CREATE_INFO();
            info.cbSize = Marshal.SizeOf(typeof(SW_DEVICE_CREATE_INFO));
            info.pszInstanceId = "BelayVDD";
            info.pszzHardwareIds = HardwareId + "\0\0";
            info.pszzCompatibleIds = null;
            info.pszDeviceDescription = "Belay Virtual Display Adapter";
            // SW_DEVICE_CAPABILITIES flags (cfgmgr32.h):
            //   Removable = 0x1, SilentInstall = 0x2, NoDisplayInUI = 0x4,
            //   DriverRequired = 0x8.
            // DriverRequired is 0x8, NOT 0x2 — asking for 0x2 alone requests a
            // silent install and lets the devnode come up with no driver bound,
            // so a missing/unsigned BelayVdd.sys would look like success and
            // then fail later at CreateFile with a confusing "device not found".
            // Removable lets the device be torn down cleanly on SwDeviceClose.
            info.CapabilityFlags = 0x1 | 0x2 | 0x8;

            IntPtr handle;
            int hr = SwDeviceCreate("BelayVDD", "HTREE\\ROOT\\0", ref info, 0, IntPtr.Zero, callback, IntPtr.Zero, out handle);
            if (hr != 0) throw new Win32Exception(hr, "SwDeviceCreate failed");

            if (!created.WaitOne(15000))
            {
                SwDeviceClose(handle);
                throw new Exception("timed out waiting for the BelayVDD device to start — " +
                                    "is the driver installed and signed? See docs/VIRTUAL-DISPLAY.md");
            }
            if (createResult != 0)
            {
                SwDeviceClose(handle);
                throw new Win32Exception(createResult, "BelayVDD device creation failed (driver missing or blocked by signing policy?)");
            }
            swDevice = handle; // held for process lifetime: lifetime == handle
        }
    }

    // ---- IOCTL helpers -----------------------------------------------------

    static void IoctlNone(SafeFileHandle device, uint code)
    {
        uint returned;
        if (!DeviceIoControl(device, code, IntPtr.Zero, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "BelayVDD ioctl 0x" + code.ToString("x") + " failed");
    }

    static TOut IoctlOut<TOut>(SafeFileHandle device, uint code) where TOut : struct
    {
        int outSize = Marshal.SizeOf(typeof(TOut));
        IntPtr outBuf = Marshal.AllocHGlobal(outSize);
        try
        {
            uint returned;
            if (!DeviceIoControl(device, code, IntPtr.Zero, 0, outBuf, (uint)outSize, out returned, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "BelayVDD ioctl 0x" + code.ToString("x") + " failed");
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
                throw new Win32Exception(Marshal.GetLastWin32Error(), "BelayVDD ioctl 0x" + code.ToString("x") + " failed");
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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SW_DEVICE_CREATE_INFO
    {
        public int cbSize;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszInstanceId;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszzHardwareIds;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszzCompatibleIds;
        public IntPtr pContainerId;
        public uint CapabilityFlags;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszDeviceDescription;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszDeviceLocation;
        public IntPtr pSecurityDescriptor;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode)]
    delegate void SW_DEVICE_CREATE_CALLBACK(IntPtr swDevice, int createResult, IntPtr context,
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInstanceId);

    [DllImport("cfgmgr32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern int SwDeviceCreate(string enumeratorName, string parentDeviceInstance,
        ref SW_DEVICE_CREATE_INFO createInfo, uint propertyCount, IntPtr properties,
        SW_DEVICE_CREATE_CALLBACK callback, IntPtr context, out IntPtr swDevice);

    [DllImport("cfgmgr32.dll")]
    static extern void SwDeviceClose(IntPtr swDevice);
}
