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

## PlayStation controllers

DualSense (PS5) and DualShock 4 are recognized on both clients. The host still
receives the existing Xbox-compatible button layout; no binary protocol or
host controller-kind field is needed. Games using the Windows virtual Xbox
backend may therefore continue showing Xbox prompts.

On iPhone, pair the controller in Bluetooth settings and open Gaming. The
sheet detects the native controller profile and previews **✕ ○ □ △**, **L1 /
R1 / L2 / R2**, **Options / Create**. Choose **PlayStation** under Controller
glyph style to keep these labels for touch controls too; Auto follows the
connected controller. The choice is saved with the preset and touch layout.
Physical controllers continue to take precedence over touch controls.

Options maps to Start; Create (Share on DualShock 4) and a touchpad click map
to Back/Select. Start and Back always reach the game. Leaving Gaming is a
1.2-second hold on the small Exit button at the top center of the screen (it fills as
you hold; a tap does nothing). PS/Guide has no host bit, so holding it for the
same 1.2 seconds also exits. Belay requests
immediate Guide input, but iOS can reserve system gestures. Test the hold on
the actual phone/controller pair.

When a controller exposes a light, the phone sets it to the current
`theme.colors.accent` supplied from JS (`#3B82F6` in the default dark theme,
`#1D6FE0` in light). Detaching restores the previous light and Guide gesture
preference. Rumble uses separate left/right handle engines when supported,
otherwise the default engine. JS and the native sampler stop rumble after
750 ms without a refresh. Adaptive trigger resistance, touchpad gestures,
motion, speaker audio and PlayStation-specific haptic waveforms are not sent.

Phone device check: verify both stick directions, analog triggers, every face
button, Options/Create, touchpad click, short PS presses (no host input), and
the 1.2-second exit hold. Check the light, independent motor rumble, saved
glyph style after relaunch, unplug/reconnect, backgrounding and network loss.
Use a fresh native development build; Expo Go cannot load this module.

## From the desktop client

Pair or plug a controller into the Mac/PC running `desktop/`, connect to the
host, and open a **display** window. Its bottom chrome includes **Controller**
and a per-window **Gaming** toggle. Press a controller button if the browser
has not exposed the pad yet. The first connected pad is selected; a pad must
expose the browser's `standard` mapping. DualSense/DS4 show PlayStation face
glyphs; Xbox and generic pads show ABXY. The backend readout is **Xbox
controller**, **Keyboard / mouse fallback**, or **unavailable**; hover it for
the host's reason. Only one window/client can own a host's controller lane.
Turn Gaming off in the current owner before enabling it elsewhere.

Gaming retunes the existing JPEG socket to the phone's JPEG gaming preset:
1024 px, quality 35, 30 FPS. Turning it off restores 1600 px, quality 62,
24 FPS for that window. Reconnects retain the current choice. The desktop
does not currently decode the phone's H.264 path, so its 60/120 FPS presets
do not apply. Seamless per-application windows do not have this toggle.

The renderer polls `navigator.getGamepads()` on animation frames, switching
to a 4 ms interval while hidden. Electron background timer throttling is
disabled so the fallback can maintain the lease. Browser Y axes are inverted
before encoding the same 17-byte frame as the phone. Frames repeat for the
first 100 ms after a change, then quiet state sends a 250 ms keepalive. A
bounded socket buffer drops intermediate samples and always samples fresh.
Each attachment gets a new `/ws-ticket`; no bearer token is placed in the
gamepad URL. Guide is omitted from the desktop frame as well.

Host rumble remains normalized 0..1 on the wire. The desktop converts it to
byte-scale values and applies `dual-rumble` with independent strong/weak
magnitudes, guarded for missing or rejecting browser actuators. Effects last
500 ms and the host refreshes them every 250 ms. Exit, unplug and socket close
stop rumble and release input. Desktop light control and adaptive triggers
are outside the Web Gamepad API path used here.

Desktop device check: run `cd desktop && npm start`, pair with a Windows or
macOS host, open a display, and enable Gaming. On Windows/ViGEm, check
`joy.cpl` for buttons, analog triggers and all stick directions; then check
rumble in a game. Repeat with keyboard fallback. Minimize/restore the window,
unplug while holding movement/fire, interrupt the network, close the window,
and toggle Gaming quickly. Verify release, reconnect, the backend indicator,
and restoration of stream settings. Open a second display and confirm it
reports the busy controller until the first releases it.

## Windows setup

1. Install the bus driver from the official
   [Nefarius ViGEmBus releases](https://github.com/nefarius/ViGEmBus/releases),
   then **reboot**. The installer does not always ask, but the bus does not
   create devices until the next boot. The tell is the host reporting
   `Xbox target add failed (0xE0000007)` — ViGEm's "target not plugged in":
   the driver is installed and answers, but the virtual pad never appears.
   Reboot and re-enter Gaming. The upstream project is archived; its final
   setup release removes its updater.
2. Put an **x64 `ViGEmClient.dll`** beside `server/native/BelayHost.exe`.
   The bus installer and the client DLL are separate requirements, and no one
   ships the DLL prebuilt: the ViGEmClient GitHub releases carry no assets and
   neither NuGet package (`Nefarius.ViGEm.Client`, `Nefarius.ViGEmClient`)
   contains the native DLL (verified 2026-09-07). Either build
   [nefarius/ViGEmClient](https://github.com/nefarius/ViGEmClient) yourself or
   run `vcpkg install vigemclient:x64-windows` and copy the DLL out of the
   vcpkg `installed\x64-windows\bin` folder. Belay does not download drivers
   or ship a DLL here.
3. In `server/`, run `npm run build:native:win`, then start the host normally.
   `build.ps1` includes `BelayHostGamepad.cs`, using csc.exe and .NET Framework.
4. Enter Gaming. The readout should say **Xbox game input**. Run `joy.cpl` on
   Windows and check every axis/button before testing the game.

While Gaming is on, the host's own mouse and keyboard no longer pause remote
input. The old "person at the machine wins" freeze surfaced as *key failed:
someone is using this computer directly* for anyone playing from the phone
while sitting at the PC, so it is off by default. `BELAY_LOCAL_PRIORITY=1`
restores it (3 s freeze after any local input) for a machine somebody else
actually shares.

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

## The UDP fast path

While H.264 is carrying the picture, each report also goes out on the BWP
Input channel — the highest priority the transport has, ahead of any queued
video and unpaced. The WebSocket keeps the session: attach, hello, rumble and
the watchdog all live there, and both copies carry the same sequence number, so
the host keeps whichever arrives first and drops the other. Falling back to
JPEG is therefore seamless rather than a gap.

On iPhone the reports never touch the JavaScript thread: the controller module
posts each encoded frame straight to the stream session, which sends it from
the thread that owns the session handle. The UDP copy is sent before the
WebSocket's backpressure check, so a socket that is stalling — the condition
this path exists for — no longer stops reports reaching the host. The desktop
client has no BWP path and stays on the WebSocket.

Turn on the HUD while Gaming: `pad 125/s · UDP` means reports are taking the
channel. No row means the WebSocket is carrying them, which is the normal state
whenever the picture is JPEG. Neither is an error.

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

`gamepadHub.inject()` takes a report that arrived on the Input channel instead
and feeds it into the same session, so the newest sequence wins across both
wires and the watchdog counts both.

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

The UDP fast path is covered on the JavaScript side (same bytes on both wires,
inert without a channel, one call rather than a per-frame hop on the native
transport) and on the host side (`inject`, cross-transport sequence ordering).
Its Swift has not been compiled and no report has been watched arrive over UDP
on hardware: on the device, confirm the HUD's `pad` row appears while Gaming
with H.264, and that the controller keeps working when the stream drops to JPEG
and the row disappears.

PlayStation additions include desktop standard mapping, controller ID
detection, byte parity with the phone, sender timing/backpressure, rumble
scaling, mocked renderer ticket/socket/visibility lifecycle, glyph preferences
and menu layout, and one-shot Guide holds. Run:

```sh
cd desktop && npm test
cd ../app && npx tsc --noEmit && npm test
cd ../server && npx tsc --noEmit && node --import tsx --test test/*.test.ts src/*.test.mjs
```

The PS5 implementation check passed desktop tests, app tests, both TypeScript
checks, Swift syntax parsing and the controller sampler's iOS SDK typecheck.
The controller-specific host tests passed. The full host suite was attempted
but existing home-directory fixture writes and a local listener were denied
by the implementation sandbox; run it with normal local test permissions.
No live controller, native app build or Electron launch was used for these
checks. Hardware behavior, especially Bluetooth rumble and PS system-gesture
handling, remains to be verified using the device checks above.

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
