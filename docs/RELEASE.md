# Releasing Belay.app and Belay-Setup.exe

The one-download host lives in `desktop/`: Electron runs the host agent
(`server/`, compiled) as a child, shows it in the menu bar, draws the pairing
QR and walks through the macOS permissions. `npx belay-host` and the
`com.belay.host` LaunchAgent keep working for developers; the app refuses to
start a second host on the same port and says why.

Everything secret comes from the environment. Nothing in the repo names a
certificate, a password or a tenant.

## What a release produces

| File | From | Linked by |
|---|---|---|
| `Belay-mac-universal.dmg` | `npm run dist:mac` | gobelay.com/get → `releases/latest/download/Belay-mac-universal.dmg` |
| `Belay-mac-universal.zip` + `latest-mac.yml` | same build | electron-updater (macOS updates install from the zip) |
| `Belay-Setup.exe` + `latest.yml` | `npm run dist:win` (on Windows) | gobelay.com/get and electron-updater |

The host staged into the app (`desktop/scripts/stage-host.mjs`) needs the
native helper **already built**: `server/native/BelayHostMac` (universal, from
`bash server/native/build-mac.sh` on a Mac with the Xcode CLT) and
`server/native/BelayHost.exe` (`native/build.ps1` on Windows). The stage script
never compiles them.

## 0. Local unsigned build (no accounts needed)

```bash
cd server && npm install && bash native/build-mac.sh
cd ../desktop && npm install
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
open release/mac-universal/Belay.app
curl -s http://127.0.0.1:8787/health
```

Unsigned builds work on the building Mac only. Sequoia shows no "Open
anyway" for an unsigned download, so this is for you, not for users. Stop the
LaunchAgent host first (`npm run autostart -- remove` in `server/`) or set
`BELAY_PORT=8790` before opening the app; it will not run two hosts on one
port.

## 1. macOS: Developer ID certificate (once)

Team ID `ML796XDM9U`, Individual account; no Organization account is needed
for Developer ID or notarization.

1. developer.apple.com → Certificates → **+** → *Developer ID Application*.
   Create a CSR with Keychain Access (Certificate Assistant → Request a
   Certificate From a Certificate Authority, "Saved to disk"). Upload it,
   download the `.cer`, double-click it into the login keychain.
2. Check it is usable: `security find-identity -v -p codesigning` lists
   `Developer ID Application: <your name> (ML796XDM9U)`.
3. For CI, export it: Keychain Access → right-click the cert → Export as
   `.p12` with a password. Then `base64 -i cert.p12 | pbcopy` and set
   `CSC_LINK` (the base64) and `CSC_KEY_PASSWORD` as repository secrets.
   Locally, electron-builder finds the keychain identity on its own.

## 2. macOS: notarization credentials (once)

1. appleid.apple.com → Sign-In and Security → **App-Specific Passwords** →
   generate one named "belay notarize".
2. Export, locally or as CI secrets:

   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="ML796XDM9U"
   ```

   `desktop/electron-builder.config.mjs` turns notarization on exactly when
   all three are set. electron-builder submits with `notarytool`, waits, and
   staples the ticket; the DMG and the zip are both notarized.
3. Verify the result: `spctl -a -vv release/mac-universal/Belay.app` says
   `source=Notarized Developer ID`, and
   `xcrun stapler validate release/Belay-mac-universal.dmg` passes.

First notarization of a new bundle id sometimes sits in Apple's queue for an
hour. `xcrun notarytool history --apple-id ... --team-id ...` shows it.

The hardened runtime entitlements are in `desktop/build/entitlements.mac.plist`
(JIT for V8, library validation off for the helper, audio input for system
audio capture). After the first notarized build ships, apply for the
**Persistent Content Capture** entitlement so macOS 15 stops re-asking for
Screen Recording every month: developer.apple.com → Contact Us → Entitlement
request, bundle id `com.gobelay.app`.

## 3. Windows: Azure Trusted Signing (once)

Individual accounts qualify (Entra Verified ID identity check); Basic tier,
about $10/month. No hardware token.

1. Azure portal → create a **Trusted Signing account** (name it, say, `belay`;
   region East US → endpoint `https://eus.codesigning.azure.net`).
2. Complete **Identity validation** (Individual) and create a **Certificate
   profile** of type *Public Trust*, name `belay`. Note the Subject (`CN=...`)
   it assigns; that is the publisher name.
3. Entra ID → App registrations → new app "belay-signing" → create a client
   secret. On the Trusted Signing account, give that app the role
   **Trusted Signing Certificate Profile Signer**.
4. Export on the Windows build machine or CI:

   ```powershell
   $env:AZURE_TENANT_ID="..."
   $env:AZURE_CLIENT_ID="..."
   $env:AZURE_CLIENT_SECRET="..."
   $env:AZURE_SIGNING_ACCOUNT="belay"
   $env:AZURE_SIGNING_PROFILE="belay"
   $env:AZURE_SIGNING_ENDPOINT="https://eus.codesigning.azure.net"
   $env:AZURE_SIGNING_PUBLISHER="CN=<subject from step 2>"
   ```

   The config enables `azureSignOptions` only when the three `AZURE_*`
   credentials are present; otherwise the exe is unsigned (fine for a local
   test, not for a release — SmartScreen will block it).
5. `npm run dist:win` on Windows (the helper and the NSIS installer are built
   there). `signtool verify /pa release\Belay-Setup.exe` confirms the signature.

## 4. Publishing to GitHub Releases (every release)

electron-updater reads `latest-mac.yml` / `latest.yml` from the newest
GitHub release of `MossLouvan/belay`, so the version in `desktop/package.json`
is what users update to.

```bash
cd desktop
npm version 0.2.0 --no-git-tag-version     # bump, commit it
git commit -am "chore(desktop): 0.2.0" && git tag desktop-v0.2.0 && git push --tags
# macOS, with the APPLE_* and CSC_* env above:
GH_TOKEN=<token with repo scope> npm run dist:mac -- --publish always
# Windows, with the AZURE_* env above:
$env:GH_TOKEN="..."; npm run dist:win -- --publish always
```

`--publish always` uploads the dmg, zip, exe and both `latest*.yml` to a
**draft** release named after the version. Open it on GitHub, write the notes,
publish it. The `releases/latest/download/…` links gobelay.com uses resolve
only once the release is published and not a pre-release.

Running apps pick the update up on their next launch (`checkForUpdatesAndNotify`
in `desktop/main.js`), download the zip/exe, and install when the user quits.
On macOS this only works for a signed build; an unsigned app logs the refusal
and keeps running.

## Checklist before publishing

- `cd server && npm test`, `cd desktop && npm test` green.
- Fresh Mac (or a new user account): drag to Applications, open, no Gatekeeper
  dialog; menu bar icon appears; QR scans from the phone; Screen Recording and
  Accessibility prompts name **Belay**; the Screen tab works after the
  relaunch button; "Start at login" ticked itself after the first link.
- `npm run autostart -- status` in `server/` reports *not installed* on the
  test Mac, so the app is the only host.
