// Display identity for the Windows helper.
//
// `Screen.AllScreens` gives geometry and nothing else: every monitor is an
// anonymous rectangle called `\.\DISPLAY2`. That is enough to capture a
// monitor, but not to answer the question the desktop client asks — "which of
// these is the virtual display I can take over, and which is the screen a human
// is sitting in front of?"
//
// Windows answers it through EnumDisplayDevices, which is queried at two
// levels for the same device name:
//
//   adapter level (device = null, iDevNum = the adapter's ordinal)
//     DeviceString -> the GPU: "NVIDIA GeForce RTX 4070", "Parsec Virtual
//     Display Adapter", "IddSampleDriver Device".
//
//   monitor level (device = "\.\DISPLAY2", iDevNum = 0)
//     DeviceString -> the panel: "Generic PnP Monitor".
//     DeviceID with EDD_GET_DEVICE_INTERFACE_NAME -> the hardware instance
//     path, e.g. "\?\ROOT#iddsampledriver#0000#{e6f07b5f-...}". The `ROOT#`
//     prefix is the tell: a real panel enumerates under `DISPLAY#`, while a
//     software display has no bus to hang off and lands under the root device.
//
// This class reports all three strings verbatim and classifies nothing. The
// "is it virtual?" heuristic lives in TypeScript (`server/src/displays.ts`)
// where it is unit-testable and can be corrected without a recompile — the
// helper's job is to observe, not to judge.

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

static class DisplayIdentity
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

    /// Ask for the device *interface* path in DeviceID rather than the legacy
    /// hardware id. Only the interface path carries the `ROOT#` enumerator that
    /// distinguishes a software display from a panel on a real output.
    const uint EDD_GET_DEVICE_INTERFACE_NAME = 0x00000001;

    static DISPLAY_DEVICE Empty()
    {
        var d = new DISPLAY_DEVICE();
        d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        return d;
    }

    /// The adapter whose DeviceName matches `deviceName`, or null.
    ///
    /// Adapters are enumerated by ordinal with no way to ask for one by name,
    /// so this is a scan. The list is a handful of entries and `info` is not on
    /// a hot path, so the loop costs nothing worth caching.
    static string AdapterFor(string deviceName)
    {
        var dd = Empty();
        for (uint i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++)
        {
            if (dd.DeviceName == deviceName) return dd.DeviceString;
            dd = Empty();
        }
        return null;
    }

    /// Identity strings for one monitor, keyed as the wire protocol expects.
    ///
    /// Every probe is individually best-effort: a driver that refuses to answer
    /// one query yields a null for that field rather than costing the caller
    /// the whole `info` reply, which is the difference between a screen that
    /// cannot be labelled and a Screen tab that cannot load.
    public static Dictionary<string, object> Describe(string deviceName)
    {
        string adapter = null, monitor = null, id = null;
        try { adapter = AdapterFor(deviceName); } catch (Exception) { }
        try
        {
            var dd = Empty();
            if (EnumDisplayDevices(deviceName, 0, ref dd, EDD_GET_DEVICE_INTERFACE_NAME))
            {
                monitor = dd.DeviceString;
                id = dd.DeviceID;
            }
        }
        catch (Exception) { }

        return new Dictionary<string, object> {
            { "device", deviceName },
            { "adapter", adapter },
            { "monitor", monitor },
            { "id", id },
        };
    }
}
