# Installing on your iPhone

There are three ways to get Tether onto an iPhone, from easiest to most
"real app". All use the same code in `app/`.

## Option A — Expo Go (fastest, no Apple account needed)

1. Install **Expo Go** from the App Store.
2. On the PC: `cd app && npx expo start`.
3. Scan the QR code with the Camera app.

The app runs inside Expo Go. This is the quickest way to use it day to day and
needs no build. The only limits are Expo Go's — you can't change the native
bundle id or ship it to others.

## Option B — TestFlight (a real installable app, needs Apple Developer)

This produces a genuine `.ipa` your iPhone installs like any App Store app, and
that you can invite others to via TestFlight. Requires an
[Apple Developer account](https://developer.apple.com/) ($99/yr) and
[EAS](https://docs.expo.dev/eas/) (free tier is fine).

```powershell
cd app
npm install -g eas-cli
eas login
eas build:configure
eas build --platform ios --profile preview
```

EAS builds in the cloud (no Mac required). When it finishes:

```powershell
eas submit --platform ios --latest
```

Then in [App Store Connect](https://appstoreconnect.apple.com/) add yourself as
a TestFlight tester and install from the TestFlight app on the phone. A starter
`eas.json` with a `preview` (internal distribution) and `production` profile is
already in `app/`.

## Option C — Local development build (needs a Mac)

If you have a Mac with Xcode:

```bash
cd app
npx expo run:ios --device
```

This installs a dev build directly to a plugged-in iPhone.

---

## Which should you use?

- **Just want to use it yourself, today:** Option A.
- **Want a permanent icon on your home screen / share with a friend:** Option B.
- **Have a Mac and want to iterate on native code:** Option C.

## bundle identifier

The app is configured as `com.mosslouvan.tether` in `app.json`. Change this to
your own reverse-domain id before an EAS build if you like; it must be unique
across the App Store.
