# Installing on your iPhone

Use a **development build**. It is the only option that fully works for Tether,
and the section below explains why before covering the alternatives.

## Option A — development build (recommended, free)

Needs a Mac with Xcode. Plug the iPhone in and run:

```bash
cd app
npm run iphone
```

First run only: unlock the phone, tap **Trust**, and pick your Apple ID when
Xcode asks. A free Apple ID is fine.

The app then installs and launches like any other app, and Metro connects for
live reload exactly as it did under Expo Go.

### Why not Expo Go

Expo Go is the obvious first choice and it does not work here, for two separate
reasons. Both are worth knowing, because the failure looks like something you
did wrong when it isn't.

**1. It is one app bundling one SDK version.** When a new Expo SDK is released,
the Expo Go build on the App Store must itself be updated and reviewed before it
can open projects on that SDK. During that window a project on the newest SDK
simply cannot load, and there is nothing to fix: your project is on `latest`,
Expo Go is on `latest`, and they still disagree. The error claims something
needs updating when both sides are already current.

**2. It cannot apply config plugins**, and Tether depends on them. Config
plugins modify the *native* project at build time; Expo Go is a pre-built
binary, so it ignores them. In Expo Go all of this is silently inert:

| Config | What it does | In Expo Go |
|---|---|---|
| `NSAppTransportSecurity` | Lets iOS reach a Tailscale (`100.x`) address over plain HTTP | **ignored** |
| `expo-build-properties` | Android cleartext | **ignored** |
| `expo-splash-screen` | The splash image | ignored |
| `orientation: "default"` | Landscape on the Screen tab | ignored |

The first is not cosmetic. Without those keys iOS blocks cleartext HTTP to
`100.64.0.0/10` — exactly the range Tailscale assigns — so **reaching your
computer from outside the house cannot work under Expo Go at all**. See
[`TRANSPORT-SECURITY.md`](TRANSPORT-SECURITY.md).

A development build has no such gap: it is your app, with your SDK and your
native config compiled in. It also stops breaking every time Expo ships a new
SDK, because nothing is negotiated at runtime any more.

### The one catch: 7-day signing

A **free** Apple ID signs an app for 7 days. After that it refuses to launch
until re-signed — re-run `npm run iphone`, which takes under a minute and keeps
your paired computers.

An **Apple Developer account** ($99/yr) raises that to a year and unlocks
over-the-air installs, so the cable is never needed again. Worth it if the
weekly re-sign becomes annoying; not worth it just to get started.

### Useful commands

```bash
npm run iphone -- --list   # list connected devices
npm run simulator          # run in the iOS Simulator (no phone, no signing)
```

`ios/` is generated from `app.json` and is gitignored. Delete it and it
regenerates. Edit `app.json`, never the Xcode project directly, or changes are
lost on the next prebuild.

## Option B — TestFlight (to share it with other people)

Produces a genuine `.ipa` and lets you invite testers. Needs an
[Apple Developer account](https://developer.apple.com/) ($99/yr) and
[EAS](https://docs.expo.dev/eas/) (free tier is fine).

```bash
cd app
npm install -g eas-cli
eas login
eas build --platform ios --profile preview
eas submit --platform ios --latest
```

EAS builds in the cloud, so this works whether your Tether host is a Mac or a
Windows PC. Then add yourself as a TestFlight tester in
[App Store Connect](https://appstoreconnect.apple.com/) and install from the
TestFlight app. `eas.json` already has `preview` (internal distribution) and
`production` profiles.

Cloud credits for AWS, Azure or similar cannot help with any of this: iOS builds
require Apple code signing, which only Apple sells. Renting a macOS instance to
build on is possible but strictly worse than using a Mac you already have.

## Option C — Expo Go

Only viable if you pin the project back to whichever SDK the installed Expo Go
bundles, and even then anywhere-access will not work, for the reason above.
Listed for completeness, not recommended.

```bash
cd app && npx expo start
```

Then scan the QR with the Camera app.

## Bundle identifier

The app is `com.mosslouvan.tether` in `app.json`. Change it to your own
reverse-domain id before an EAS build if you like; it must be unique across the
App Store.
