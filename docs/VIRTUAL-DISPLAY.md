# Virtual display driver

Belay-owned virtual displays: the host renders at the client's exact
resolution and refresh rate, decoupled from any physical monitor. This is
what lets a phone or iPad get a native-resolution desktop from a headless
machine, and what Parsec/Apollo users know as "the host matches my screen".

This is a different feature from [VIRTUAL-MONITOR.md](VIRTUAL-MONITOR.md).
That doc is about *detecting* virtual displays other tools created; this one
is about Belay *creating and destroying its own*, on request, at a
client-chosen mode. Both coexist: a display Belay creates is classified by
the same `displays.ts` logic as any other (its names contain "Virtual", and
on Windows it enumerates under `ROOT#`, so both signals fire).

Everything here is **opt-in behind `BELAY_VIRTUAL_DISPLAY=1`** and additive.
With the flag off (the default), the routes refuse with a pointer to this
doc, the native helpers are never asked, and the default capture path is
byte-for-byte what it was.

## Honest status

| Piece | Status |
| --- | --- |
| `server/src/virtual-display.ts` (flag, validation) | Implemented, unit-tested, typechecked |
| `/screen/virtual-display` routes (GET/POST/DELETE) | Implemented, behind the flag |
| `native.ts` `virtualdisplay` verbs | Implemented (degrades to a clean error on old helpers) |
| macOS `VirtualDisplay.swift` (CGVirtualDisplay) | **Implemented, compiled and runtime-verified** on this machine: created 1280x720@60 and 1920x1080@120 displays, observed them in the OS display list as "Belay Virtual Display", destroyed them, observed removal |
| Windows driver `server/native/win-display/` | **BUILDS, INSTALLS AND LOADS.** On Windows 11 26200 (Hyper-V guest, test signing on): builds, passes `infverif /u`, test-signs, `pnputil` installs it, the UMDF host loads it together with `iddcx.dll`, and the devnode reports `CM_PROB_NONE`. **No monitor plumbed yet** — see "What still fails" |
| `BelayVddShim.cpp` (native SwDeviceCreate shim) | **Implemented and verified.** Creates the devnode; closing the handle removes it |
| Windows host side `BelayHostVirtualDisplay.cs` | **COMPILES AND RUNS.** Device creation, teardown, the no-driver degradation path, and both validation rejections (out-of-range and odd dimensions) are verified. The IOCTL layer is not |
| Driver signing / WHQL / attestation | **Not done, cannot be done from here** — see "Signing for release" |

### What still fails

Every IOCTL returns **`0x80070032` (ERROR_NOT_SUPPORTED)** — `VERSION`,
`STATUS` and `REMOVE_MONITOR` alike — against a device that is healthy
(`CM_PROB_NONE`) with the driver loaded. The control codes are not reaching
`BelayVddIoDeviceControl`.

Leading suspect is the `IndirectKmd` upper filter, which BelayVdd.inf must
install for IddCx and which sits above the UMDF stack: it may be rejecting
control codes it does not recognise before WUDFRd can forward them. Ruled out
already: a secondary queue with `WdfDeviceConfigureRequestDispatching` is
worse, not better — the framework refuses it and `DeviceAdd` fails outright
(UMDF host reports `0xD0200204`). A default queue is correct and is what
SudoVDA uses.

So the driver runs, but nothing has yet asked it for a monitor: mode commit,
swap-chain drain and monitor arrival remain unverified.

### Secure Boot blocks the last step

A test-signed driver cannot load while Secure Boot is enabled:
`bcdedit /set testsigning on` is refused with *"The value is protected by
Secure Boot policy and cannot be modified or deleted."* Secure Boot must be
turned off in UEFI firmware setup first.

**If BitLocker protects the system volume, suspend it before changing Secure
Boot**, or the next boot will demand the 48-digit recovery key:

```powershell
# elevated; resumes automatically after the next two boots
manage-bde -protectors -disable C: -RebootCount 2
```

Then: reboot into UEFI setup, disable Secure Boot, boot, and run
`bcdedit /set testsigning on` (elevated) followed by one more reboot. A
"Test Mode" watermark on the desktop confirms it took.

## Fork-vs-build decision and license survey

Surveyed (September 2026):

| Project | What it is | License | Verdict for a proprietary host |
| --- | --- | --- | --- |
| [Microsoft IddCx sample](https://github.com/microsoft/Windows-driver-samples/tree/main/video/IndirectDisplay) | Canonical indirect display driver sample | **MS-PL** (permissive, non-copyleft) | Usable; but plugs in a fixed fake monitor at boot, no runtime control surface |
| [SudoVDA](https://github.com/SudoMaker/SudoVDA) | VDD built for Apollo (Sunshine fork): per-client resolution/refresh, add/remove at stream start/stop | **MIT / CC0** (author offers "least restrictive") | Best functional fit; permissive |
| [VirtualDrivers/Virtual-Display-Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver) | Popular general-purpose VDD | **MIT** | Usable; but modes come from config/registry, not a per-session control call — wrong shape for "match the client" |
| [nomi-san/parsec-vdd](https://github.com/nomi-san/parsec-vdd) | MIT control library driving **Parsec's own signed driver** | Library MIT; **driver binary proprietary** (Parsec's, not redistributable) | Ruled out: we may not ship Parsec's driver |
| Sunshine | Streams whatever display exists; historically tells users to install a VDD themselves. Apollo (the fork) bundles SudoVDA | n/a | Confirms the SudoVDA-style architecture is the production-proven one |
| [DeskPad](https://github.com/Stengo/DeskPad) (macOS) | Single-purpose CGVirtualDisplay app | **MIT** | Reference for the private-API surface |

**Decision: build Belay's own driver in the SudoVDA/Microsoft-sample
architecture (a "scaffold informed by the fork target"), not a verbatim
fork.** Reasons:

1. **License**: the whole usable lineage (MS-PL sample → MIT/CC0 SudoVDA) is
   permissive, so either path is legal for a proprietary host. No GPL
   appears anywhere; parsec-vdd is excluded because the *driver binary* is
   Parsec's property regardless of the MIT wrapper.
2. **Surface area**: SudoVDA carries features Belay does not want (multi-
   monitor pools, EDID synthesis, HDR plumbing). A driver is attack surface
   and audit surface; Belay's needs one monitor, one mode list, four IOCTLs.
   Less inherited code is less to re-audit after every upstream drift.
3. **Hardening is easier to prove on a small surface**: our device object is
   ACL'd (`D:P(A;;GA;;;SY)(A;;GA;;;BA)`) - applied by the PnP manager from the
   INF's `.HW` section, since UMDF2 has no `WdfDeviceInitAssignSDDLString` -
   every IOCTL is
   `METHOD_BUFFERED` with exact-size and field-range validation, unknown
   control codes are rejected, and the HWID (`Root\BelayVDD`), interface
   GUID and symbolic link are all Belay's own — no collision or confusion
   with a stock sample driver on the same machine.
4. Provenance is recorded in every file header so a future license audit
   takes minutes.

On macOS there is no driver to fork at all: every product uses the private
`CGVirtualDisplay` CoreGraphics API. Belay reaches it dynamically (ObjC
runtime lookups), so the helper keeps building even if Apple removes it —
the failure mode is a structured runtime error, never a broken build.
DeskPad (MIT) and Chromium's `virtual_display_mac_util.mm` (BSD-3-Clause)
served as behavioural references; no code was copied.

## How it fits together

```
client → POST /screen/virtual-display {width,height,refreshHz}   (Bearer auth)
       → virtual-display.ts validates (flag on? ints? bounds? even?)
       → native.ts: {cmd:"virtualdisplay", action:"create", w,h,hz}
       → macOS: VirtualDisplay.swift → CGVirtualDisplay        (verified)
         Windows: BelayHostVirtualDisplay.cs → SwDeviceCreate(Root\BelayVDD)
                  → \\.\BelayVDD IOCTL_ADD_MONITOR → IddCx monitor arrival
       → the new display shows up in GET /screen/info, classified virtual
       → client opens it with the normal capture path (unchanged)
DELETE /screen/virtual-display tears it down; so does helper/host exit.
```

Lifetime safety on both platforms is structural, not best-effort:

- macOS: the display exists only while the helper holds the object; a crash
  removes it. (Observed: removal is asynchronous, ~1–4s after destroy.)
- Windows: the devnode is created with `SwDeviceCreate` and a process-held
  handle; when the host exits or crashes, Windows removes the device and
  its monitors. No ghost displays.

Bounds (identical in TS, Swift and the driver): width 640–7680 even,
height 480–4320 even, refresh 24–240 Hz, default 60.

## Using it on macOS (works today)

```bash
cd server && npm run build:native:mac       # rebuild the helper
BELAY_VIRTUAL_DISPLAY=1 npm start
# then, with a paired token:
curl -X POST -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"width":2360,"height":1640,"refreshHz":60}' http://localhost:8787/screen/virtual-display
curl -H "Authorization: Bearer <token>" http://localhost:8787/screen/info   # see it
curl -X DELETE -H "Authorization: Bearer <token>" http://localhost:8787/screen/virtual-display
```

Caveats: `CGVirtualDisplay` is private API — a macOS update can break it at
runtime (status then reports `supported:false`). The display is created at
`hiDPI 0` (exact pixels); a Retina mode is future work.

## Windows runbook (build → sign → install → verify)

Nothing below has been executed. Do it in order, on a machine you can
afford to break, before any user sees this.

### 1. Build

- Install Visual Studio 2022, the Windows SDK, and the matching WDK +
  "Windows Driver Kit" VS extension.
- `powershell -File server\native\win-display\build-driver.ps1 -Platform x64`
- The script builds `BelayVdd.dll`, runs `infverif /v /u` on the INF (the
  Universal ruleset, matching `DriverTargetPlatform`), runs Inf2Cat, and
  **test-signs** the DLL and the catalog. Run it elevated so it can also put
  the throwaway cert in `LocalMachine\Root` and `LocalMachine\TrustedPublisher`;
  unelevated it prints the two `Import-Certificate` commands instead.

This has now been executed successfully, using VS2022 **Build Tools** (workload
`Microsoft.VisualStudio.Workload.VCTools`), Windows 11 SDK 26100, and WDK
10.0.26100. Note that since VS 17.11 the WDK's Visual Studio integration is a
VS *component*, not a VSIX inside the WDK MSI - without it MSBuild has no
`WindowsUserModeDriver10.0` platform toolset:

```powershell
winget install --id Microsoft.WindowsWDK.10.0.26100 -e
# then, elevated. PowerShell's --% stop-parsing token is required: without it
# the VS installer silently ignores every argument and exits 87.
& "$env:ProgramFiles(x86)\Microsoft Visual Studio\Installer\setup.exe" --% modify --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" --add Component.Microsoft.Windows.DriverKit.BuildTools --quiet --norestart
```
- Also rebuild the helper: `powershell -File server\native\build.ps1`
  (now includes `BelayHostVirtualDisplay.cs` — equally never compiled).

### 2. Install (test machine)

```bat
bcdedit /set testsigning on   & reboot
pnputil /add-driver server\native\win-display\dist\x64\BelayVdd\BelayVdd.inf /install
```

`pnputil` accepts the package even before test signing is on (verified: it
registers as `oem<N>.inf`, signer "BelayVDD Test Cert (DO NOT SHIP)"). What
test signing gates is whether the device can actually *start*. And
`bcdedit /set testsigning on` is itself refused while Secure Boot is enabled -
see "Secure Boot blocks the last step" above.

### 3. Verify — every line, in order

1. `pnputil /enum-drivers` lists BelayVdd; Device Manager shows no error 52
   (signing) after reboot.
2. Start the host elevated with `BELAY_VIRTUAL_DISPLAY=1`.
3. `POST /screen/virtual-display {"width":1920,"height":1080,"refreshHz":60}`
   → Settings → Display shows a new 1920x1080 monitor.
4. `GET /screen/info` → the new screen's `id` contains `ROOT#BelayVDD` and
   `virtualDisplay: true`.
5. Change resolution: POST 2560x1440@120 → the same monitor switches mode
   (replace, never a second monitor).
6. `DELETE` → monitor gone. Kill the host process hard → device gone
   (SwDevice lifetime).
7. Negative: run the host non-elevated → create fails with the elevation
   message. Send `{"width":641,...}` → 400 from Node; craft a raw IOCTL with
   width 999999 → `STATUS_INVALID_PARAMETER` from the driver.
8. Soak: create/destroy 50x in a loop; watch for UMDF host process leaks
   (`WUDFHost.exe` count) and desktop stalls.

### 4. Signing for release (required, not optional)

Test signing does not leave the lab. Shipping requires:

1. An **EV code-signing certificate** for the publisher.
2. A **Microsoft Hardware Dev Center (Partner Center)** account; submit the
   driver for **attestation signing** (Win10+ only) or full **WHQL/HLK**
   testing for broader coverage.
3. Ship the Microsoft-signed package; installation then needs no test mode.

Until that is done the Windows side of this feature is developer-only, and
the docs/UI must say so. Do not fake it with kernel-mode-signing
workarounds; they are a support and security disaster.

## Files

- `server/src/virtual-display.ts`, `server/test/virtual-display.test.ts`
- `server/src/native.ts`, `server/src/index.ts` (verbs + routes)
- `server/native/mac/VirtualDisplay.swift`, wired in `mac/main.swift`
- `server/native/win-display/` — `BelayVddIoctl.h`, `Driver.h`, `Driver.cpp`,
  `BelayVdd.inf`, `BelayVdd.vcxproj`, `build-driver.ps1`
- `server/native/BelayHostVirtualDisplay.cs`, wired in `BelayHost.cs` and
  `build.ps1`
