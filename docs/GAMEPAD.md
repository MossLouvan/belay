# Gaming and controller passthrough

Gaming in the screen dock opens a sheet for Generic, Roblox, or Fortnite and a
Classic/Southpaw touch layout. Start gaming locks the iPhone in landscape,
keeps it awake, replaces desktop gestures and chrome with a labelled Exit
handle, and shows FPS plus host round-trip latency. Exit restores the previous
orientation lock, dock, HUD, pointer mode, zoom and stream preference. Preset
and layout are saved locally. Backgrounding or leaving the screen disconnects
input; returning to the foreground reconnects with a neutral state.

An Xbox, PlayStation, or extended MFi controller paired in iPhone Bluetooth
settings takes precedence over touch controls. Disconnect it to reveal the
sticks, ABXY, D-pad, shoulders, triggers, stick clicks, Start and Back/Select.
Fortnite adds Build/Edit controls when keyboard fallback is active; the Xbox
backend keeps its native ABXY build bindings. The module samples the newest complete
controller state at most once per display frame; touch gestures update
Reanimated shared state and sample on the UI thread. The socket sends full
binary state every 8 ms, with a small backpressure bound.

## Windows setup

1. Install the bus driver from the official
   [Nefarius ViGEmBus releases](https://github.com/nefarius/ViGEmBus/releases).
   Reboot if the installer requests it. This upstream project is archived;
   its final setup release removes its updater.
2. Place an **x64 `ViGEmClient.dll`** beside `server/native/BelayHost.exe`.
   The bus installer and the client DLL are separate requirements. Use the
   official [ViGEmClient SDK](https://github.com/nefarius/ViGEmClient) to obtain
   or build the client; Belay does not download drivers or ship a DLL here.
3. In `server/`, run `npm run build:native:win`, then start the host normally.
   `build.ps1` includes `BelayHostGamepad.cs`, using csc.exe and .NET Framework.
4. Enter Gaming. The readout should say **Xbox controller**. Run `joy.cpl` on
   Windows and check every axis/button before testing the game.

The virtual target is an Xbox 360 controller. The ViGEm path sends the game's
normal controller inputs without game-specific remapping. Roblox and Fortnite
can use their native Xbox controller bindings; individual Roblox experiences
and customized game bindings can differ. Game-generated rumble returns to the
physical phone-paired controller when Apple exposes its haptics. Controllers
with separate handle motors receive low/high separately; otherwise they use a
combined motor. Keymap mode has no game-generated rumble.

## Driverless fallback

Missing DLL, wrong DLL architecture, missing bus, or virtual-target failure
reports `gamepad: "unavailable"` with a reason in helper status and selects
`backend: "keymap"`. The host continues working. The app says **Keyboard /
mouse fallback**. Installing the driver/DLL and exiting/re-entering Gaming
re-probes it. `gamepadstatus` also exposes the backend and reason.

| Input | Generic keyboard/mouse mapping |
|---|---|
| Left stick | WASD, engage at 0.25 and release below 0.18 |
| Right stick | Relative mouse movement, 0.12 dead zone |
| A / B / X / Y | Space / Ctrl / R / F |
| RT / LT | Left / right mouse, engage above 0.12, release below 0.08 |
| LB / RB | Q / E |
| D-pad | Arrow keys |
| Start / Back (Select) | Esc / Tab |
| Roblox R3 | Shift press/release for Shift-lock |
| Fortnite D-pad up/down/left/right | Z / X / C / V (build pieces) |
| Fortnite Build / Edit | G / F |

These presets assume those keyboard bindings; customize the game's bindings
if necessary. They only change fallback mappings and touch layout. Build/Edit
use two app-only button bits that are stripped from the virtual Xbox report.

macOS uses the same keyboard/mouse fallback through `mac/Gamepad.swift` and
CGEvent. It requires Accessibility permission for the host launcher. Without
that grant it reports unavailable. No virtual controller is installed on macOS.
`build-mac.sh` discovers the Swift source through its existing glob.

## Transport and lifecycle

`/ws/gamepad` uses the normal paired-device ticket upgrade. It allows one owner
per host, admits only version-1 17-byte binary messages, drops duplicate/stale
uint32 sequences (including wraparound), caps receipt at 500 frames per one
second window, and coalesces to the newest sample on a 4 ms host tick. There is
no JSON input path on this socket. See [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

The helper receives `gamepadattach {preset}`, `gamepadstatus`,
`gamepaddetach`, and fire-and-forget `gamepad` state commands over stdin.
The latter skips normal response allocation on Windows; XUSB reports are
value structs and keymap SendInput uses reusable arrays. Rumble/status pushes
use the helper's shared stdout lock. The P/Invoke declarations follow the
[upstream client header](https://github.com/nefarius/ViGEmClient/blob/master/include/ViGEm/Client.h):
cdecl entrypoints, stdcall notification, and a 12-byte XUSB_REPORT passed by
value. Native resources and the rooted callback are released on detach.

Socket close, malformed input, helper failure, or 750 ms without accepted
frames ends the lease and releases inputs. A separate helper timer neutralizes
held state after 750 ms even if Node or capture stalls. New attachments reset
state. Gamepad bypasses the input floor's exclusive keyboard/pointer lease,
while updating remote activity timestamps for the idle probe. Only active
keymap samples and their release mark OS injection; neutral heartbeats do not
hide activity from a person using the host keyboard.

Gaming requests 1024 px / JPEG quality 35 / 30 FPS on the CPU/JPEG path, and
60 FPS on CPU H.264 or 120 FPS on the GPU H.264 path, matching the current
quality-availability ceiling. H.264 uses the data-saver bitrate ceiling;
changing Gaming mode retunes the active stream. The existing H.264 renderer
presents immediately, and JPEG replaces frames without adding a queue. The
H.264 path retains the host's capture dimensions (it has no width control in
its current start protocol). FPS is a request, not a throughput guarantee.
The displayed milliseconds are RTT, not measured glass-to-glass latency.

## iPhone build and device checks

`app/modules/belay-gamepad` is an Expo local module, matching `belay-stream`.
Expo autolinking resolves its pod and `BelayGamepadModule`; no manual Xcode
source registration is needed. This checkout has no generated `app/ios` tree.
`app/app.json` supplies `GCSupportedGameControllers` (ExtendedGamepad) and
`GCSupportsControllerUserInteraction` when the iOS project is generated.
Use a freshly built development/device app through the project's normal iOS
build flow; Expo Go cannot load this new Swift module.

On a real iPhone and Windows PC:

1. Start the rebuilt host, pair the phone, select Gaming and a preset.
2. Check landscape lock, hidden dock/cursors, the Exit handle and FPS/RTT.
3. With no controller, hold movement plus aim plus a trigger and ABXY at once.
   Check that every release/cancel stops its action. Test Classic/Southpaw and
   re-launch the app to verify saved layout.
4. Pair a physical controller. Check touch controls disappear, both stick Y
   directions are correct, triggers are analog, and all buttons reach joy.cpl.
5. Test Roblox/Fortnite controller input and rumble with ViGEm; then test the
   documented fallback bindings without the DLL, including Roblox R3 and
   Fortnite build/edit. Re-enter Gaming between backend changes.
6. While holding move/fire, turn Bluetooth off, background the phone, interrupt
   its network, stop the host, and reconnect. Verify held inputs release and
   rumble stops. Repeat Exit/re-entry quickly and rotate the phone afterward.
7. On macOS, check fallback both with and without Accessibility permission.

## Validation and remaining hardware checks

Pure tests cover packet round trips and cross-codec parity, invalid values,
sequence wrap, rate limiting, coalescing/backpressure, exclusive ownership,
attach/disconnect races, watchdog/helper failure, presets and layout geometry.
Run `cd app && npx tsc --noEmit && npm test` and the same command in `server/`.
The host test command uses Node's tsx import hook to avoid the tsx CLI's
unnecessary local IPC listener.

No C# build, CocoaPods installation, Xcode build, driver installation, or live
controller/game test was performed in the implementation sandbox. Swift syntax
parsing and Expo module discovery were checked. Real-device latency, rumble,
controller model compatibility, and game/anti-cheat acceptance still need the
checks above. Windows SendInput fallback inherits application elevation and
input-policy constraints. Touch-only builds without this native module do not
get its iOS idle-timer override.

The existing app root records a past Reanimated worklet-bridge crash on this
SDK. Touch Gaming loads its own gesture-handler root lazily, keeping that
bridge out of the normal desktop route until touch controls are shown. Verify
this path in the fresh device build before treating touch Gaming as released.
