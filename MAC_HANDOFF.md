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
