# Mac handoff — build the standalone Tether iPhone app

**Who this is for:** a Claude Code session (or a person) running on the owner's **Mac**.
The rest of Tether was set up on the Windows PC; this is the one step that *must*
happen on macOS, because building a real iOS app needs **Xcode**.

**Goal:** install Tether as a proper standalone app on the iPhone — its own
home-screen icon, **not** loaded through Expo Go. Expo Go cannot apply Tether's
config plugins (notably `NSAppTransportSecurity`, which is what lets iOS reach
the PC over a Tailscale `100.x` address on plain HTTP), so a development /
standalone build is required. See [`docs/IOS.md`](docs/IOS.md) for the full "why".

---

## Prerequisites (on the Mac)
1. **Xcode** installed from the App Store, then run once:
   `sudo xcode-select -s /Applications/Xcode.app`
2. The **iPhone plugged into the Mac** with a cable, **unlocked**; tap **Trust** when asked.
3. An **Apple ID** added in Xcode → Settings → Accounts.
   - A **free** Apple ID works — it signs the app for **7 days** (re-run to refresh).
   - A **paid** Apple Developer account ($99/yr) signs for a **year** (permanent-feeling).
4. **Node 18+** and **git**.

## Build & install — one command
```bash
git clone https://github.com/MossLouvan/tether.git   # skip if already cloned
cd tether/app
npm install
npm run iphone        # prebuilds ios/ and runs `expo run:ios --device`
```
- First run: choose your Apple ID **Team** when Xcode prompts. If you hit a signing
  error, open the generated `app/ios/*.xcworkspace` in Xcode once, set
  **Signing & Capabilities → Team**, then re-run `npm run iphone`.
- `npm run iphone -- --list` shows connected devices without building.

## After it installs
- Tether appears on the home screen. Open it → **add a computer** → enter the PC's
  Tailscale address **`100.82.170.69`** → it pairs with **no code**.
  (Install the **Tailscale** app on the iPhone and sign in to the same account first,
  so the phone can reach that address from anywhere.)
- Verify on the **Screen** tab: a tap should land the mouse exactly where you tap;
  try the fullscreen box in the top-right corner.

## Free (7-day) vs permanent
- **Free Apple ID:** works, but stops opening after ~7 days — just re-run
  `npm run iphone` to refresh the signature.
- **Paid ($99/yr):** lasts a year; you can also use `eas build` / TestFlight for an
  install-by-link version — see [`docs/IOS.md`](docs/IOS.md).

---

## ⚠️ IMPORTANT — delete this file once the app is installed
This handoff exists **only** to bridge the Windows → Mac step. As soon as the
standalone app is successfully built and installed on the iPhone, **delete this
file and commit the deletion** so it doesn't linger in the repo:
```bash
git rm MAC_HANDOFF.md
git commit -m "Remove Mac build handoff — standalone iOS app installed"
git push
```
Do **not** commit the generated `app/ios/` directory — it is gitignored on purpose.


---

## Also on the Mac: verify the native helper still builds

Two pieces of Swift were written on the Windows PC, where **swiftc does not
exist**, and have never been compiled:

1. **Display identity** — `DisplayIdentity.swift`, plus the `screens` list and
   per-screen input in `main.swift` / `Input.swift` / `Displays.swift`.
2. **Seamless windows** — `WindowList.swift`, the `windows` / `capturewindow` /
   `focuswindow` commands in `main.swift`, `ImageOutput.scaled`, and the
   `window` pointer target in `Input.swift`. The Windows half of the same change was compiled and
its output checked against real monitors; the macOS half needs the same here.

```bash
cd tether/server
npm run build:native:mac          # must succeed; AppKit was added to the flags
echo '{"id":1,"cmd":"info"}' | ./native/TetherHostMac
```

The `info` reply should now contain a `screens` array, one entry per display,
each carrying `index`, geometry, `primary`, and identity fields (`device`,
`adapter`, `monitor`, `id`, `builtin`, `vendor`, `model`). Check that:

- the built-in panel reports `"builtin": true` and a `monitor` like
  `"Built-in Retina Display"`;
- with a virtual display running (DeskPad or BetterDisplay — see
  [`docs/VIRTUAL-MONITOR.md`](docs/VIRTUAL-MONITOR.md)), that display's name
  appears, and `/screen/info` marks it `"virtualDisplay": true`;
- picking a non-primary monitor in the phone app's Screen tab now captures *and*
  clicks on that monitor — per-screen input is new on macOS, and getting it
  wrong sends clicks to the wrong display rather than failing loudly.

If `NSScreen.screens` comes back empty in a plain command-line process, the
`monitor` field will be null and virtual displays will stop being recognised by
name on macOS. That is the one risk worth checking first.

### Then the seamless-window commands

```bash
echo '{"id":1,"cmd":"windows"}' | ./native/TetherHostMac
```

Expect one entry per real window — Safari, Terminal, Mail — and *not* menu bar
items, the Dock, or tooltips (those live on CoreGraphics layers other than 0 and
are filtered out). Then capture one by its id:

```bash
echo '{"id":2,"cmd":"capturewindow","window":"<id>","w":900,"q":70}'   | ./native/TetherHostMac
```

Things to check, in the order they are likely to bite:

- **`AXValueGetValue` and the generic `axValue` helper in `WindowList.swift`**
  are the least certain code in the file — a compile error here is expected
  before it is right. The `value as! AXValue` cast is guarded by a
  `CFGetTypeID` check, so it should not trap, but Swift may want the generic
  spelled differently.
- **`CGWindowListCreateImage` is deprecated** in macOS 14. It should still
  compile (with a warning) and still work with Screen Recording granted. If a
  future macOS removes it, the replacement is
  `SCScreenshotManager.captureImage(contentFilter:configuration:)` with an
  `SCContentFilter(desktopIndependentWindow:)` — which needs the deployment
  target raised from 13.0 to 14.0.
- **Window titles are empty without Screen Recording.** That is macOS policy,
  not a bug; the app name still shows.
- **`focuswindow` needs Accessibility** and matches the window by position and
  size, because AX cannot address a window by CGWindowID. If raising picks the
  wrong window of an app with several the same size, that match is why.

Then drive it from the desktop client (`cd desktop && npm start`) against this
Mac as the host, and check that clicks land in the right window — the pointer is
normalized against the *window* now, so a mapping mistake sends clicks to the
wrong place rather than failing loudly. See
[`docs/SEAMLESS-WINDOWS.md`](docs/SEAMLESS-WINDOWS.md).
