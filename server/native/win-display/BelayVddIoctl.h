// BelayVddIoctl.h — the control contract between the Belay host process and
// the BelayVDD indirect display driver. This header is the single source of
// truth: Driver.cpp validates against it, and BelayHostVirtualDisplay.cs
// mirrors these values by hand (C# cannot include it; keep them in sync).
//
// STATUS: WRITTEN-BUT-NOT-COMPILED. No Windows/WDK toolchain exists in the
// environment this was authored in. Build + verify steps: docs/VIRTUAL-DISPLAY.md.
//
// PROVENANCE / LICENSE: original code for Belay. The IOCTL surface is modeled
// on SudoVDA (MIT/CC0, github.com/SudoMaker/SudoVDA), itself derived from
// Microsoft's IddCx sample (MS-PL). All permissive; no copyleft anywhere in
// the lineage, so a proprietary Belay host build may ship this driver.

#pragma once

#ifdef _KERNEL_MODE
#error BelayVDD is a UMDF2 (user-mode) driver; do not build kernel-mode.
#endif

#include <winioctl.h>

// Device interface + symbolic link the host opens. The GUID is Belay's own
// (freshly generated for this project — NOT the sample driver's, so a stock
// IddSampleDriver on the same machine can never be confused for ours).
// {7f2a6b41-9c1e-4d0b-a2c5-58e1b0d4f9a3}
static const GUID GUID_DEVINTERFACE_BELAYVDD =
    { 0x7f2a6b41, 0x9c1e, 0x4d0b, { 0xa2, 0xc5, 0x58, 0xe1, 0xb0, 0xd4, 0xf9, 0xa3 } };

#define BELAYVDD_SYMLINK L"\\\\.\\BelayVDD"

// Custom device type in the user-defined range (0x8000+), as winioctl requires.
#define FILE_DEVICE_BELAYVDD 0x8b1a

// All IOCTLs demand FILE_WRITE_ACCESS: even "status" is gated, because the
// device object's SDDL (see Driver.cpp) restricts opens to SYSTEM and
// Administrators and there is no read-only consumer to serve.
#define BELAYVDD_CTL(idx) \
    CTL_CODE(FILE_DEVICE_BELAYVDD, 0x800 + (idx), METHOD_BUFFERED, FILE_WRITE_ACCESS)

#define IOCTL_BELAYVDD_VERSION        BELAYVDD_CTL(0) // out: BELAYVDD_VERSION_OUT
#define IOCTL_BELAYVDD_ADD_MONITOR    BELAYVDD_CTL(1) // in: BELAYVDD_MODE, out: BELAYVDD_MONITOR_OUT
#define IOCTL_BELAYVDD_REMOVE_MONITOR BELAYVDD_CTL(2) // no payload
#define IOCTL_BELAYVDD_STATUS         BELAYVDD_CTL(3) // out: BELAYVDD_STATUS_OUT

#define BELAYVDD_PROTOCOL_VERSION 1u

// Bounds are identical to server/src/virtual-display.ts and to the macOS
// helper's clamps: the boundary promise is one product-wide contract.
#define BELAYVDD_MIN_WIDTH   640u
#define BELAYVDD_MAX_WIDTH   7680u
#define BELAYVDD_MIN_HEIGHT  480u
#define BELAYVDD_MAX_HEIGHT  4320u
#define BELAYVDD_MIN_HZ      24u
#define BELAYVDD_MAX_HZ      240u

#pragma pack(push, 1)

typedef struct _BELAYVDD_MODE {
    UINT32 Width;     // BELAYVDD_MIN_WIDTH..MAX, even
    UINT32 Height;    // BELAYVDD_MIN_HEIGHT..MAX, even
    UINT32 RefreshHz; // BELAYVDD_MIN_HZ..MAX
} BELAYVDD_MODE, *PBELAYVDD_MODE;

typedef struct _BELAYVDD_VERSION_OUT {
    UINT32 Protocol;  // BELAYVDD_PROTOCOL_VERSION
} BELAYVDD_VERSION_OUT, *PBELAYVDD_VERSION_OUT;

typedef struct _BELAYVDD_MONITOR_OUT {
    BELAYVDD_MODE Mode;   // what the driver actually plumbed (== request today)
    UINT32 Connected;     // 1 once the arrival was reported to IddCx
} BELAYVDD_MONITOR_OUT, *PBELAYVDD_MONITOR_OUT;

typedef struct _BELAYVDD_STATUS_OUT {
    UINT32 Protocol;
    UINT32 MonitorActive; // 0 or 1 — BelayVDD exposes at most one monitor
    BELAYVDD_MODE Mode;   // zeroed when MonitorActive == 0
} BELAYVDD_STATUS_OUT, *PBELAYVDD_STATUS_OUT;

#pragma pack(pop)
