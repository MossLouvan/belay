# Gaming and controller passthrough

September 2026: see [gaming research and validation](GAMING-RESEARCH.md) for the
new desktop H.264 path, current checks, and remaining real-device requirements.
Windows setup can be performed with `server/scripts/setup-controller.ps1 -InstallDriver`;
then run `node server/scripts/probe-gamepad.mjs` to verify the target through XInput.
The driver step requires administrator approval.

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
to Back/Select. PS/Guide has no host bit: hold it for one second to exit Gaming
on the phone. The visible Exit control remains available. Belay requests
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
the one-second exit hold. Check the light, independent motor rumble, saved
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

Display windows now prefer hardware H.264 over encrypted UDP through the native
desktop receiver and local WebCodecs decoder. Gaming requests 60 FPS and the
20 Mbps adaptive ceiling. Build the receiver with `cargo build --release
--manifest-path crates/belay-client/Cargo.toml`, or use the Windows installation
script. Startup/decode failures fall back to JPEG at 1600 px, quality 65,
30 FPS. Turning Gaming off restores the normal JPEG preference (1600 px,
quality 62, 24 FPS) and uses the 10 Mbps H.264 profile when available.
Mac hosts and seamless per-application windows retain their JPEG path.

The renderer polls `navigator.getGamepads()` on animation frames. Hiding the
window closes the controller lane and releases input: Chromium may stop
sampling hidden pages, so repeating its cached state can leave buttons held.
Returning reconnects with a fresh ticket. Browser Y axes are inverted
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

Gaming requests 1600 px / JPEG quality 65 / 30 FPS on the JPEG path and
60 FPS with a 20 Mbps adaptive ceiling on H.264. High refresh is an explicit
performance-setting choice. The H.264 path retains the host capture dimensions;
there is no capture-width control in its current start protocol. FPS is a
request, not a throughput guarantee. Displayed milliseconds are RTT, not
measured glass-to-glass latency.

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

## Prior implementation validation notes

The following records earlier implementation passes. The current pass and
remaining hardware checks are recorded in [GAMING-RESEARCH.md](GAMING-RESEARCH.md).

Pure tests cover packet round trips and cross-codec parity, invalid values,
sequence wrap, rate limiting, coalescing/backpressure, exclusive ownership,
attach/disconnect races, watchdog/helper failure, presets and layout geometry.
Run `cd app && npx tsc --noEmit && npm test` and the same command in `server/`.
The host test command uses Node's tsx import hook to avoid the tsx CLI's
unnecessary local IPC listener.

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
