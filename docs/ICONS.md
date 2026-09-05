# App Icons and Assets

## The Problem

Expo's `run:ios` and `prebuild` commands do NOT always refresh `AppIcon.appiconset` when only the source icon (`app/assets/icon.png`) has changed. This means:

1. You update `app/assets/icon.png` with a new design
2. You run `npm run iphone` or `npx expo run:ios`
3. The app installs, but **the home screen still shows the old icon**
4. The `ios/Belay/Images.xcassets/AppIcon.appiconset/` directory contains stale PNG files from the previous build

This is a known Expo limitation with continuous native generation (CNG): the build system assumes assets are stable across rebuilds and doesn't always regenerate derived files.

## The Solution

### Option 1: Force Clean Regeneration (Recommended)

Use the `--clean` flag to force `iphone.sh` to delete the `ios/` directory and regenerate from scratch:

```bash
cd app
npm run iphone -- --clean
```

This ensures:
- All AppIcon.appiconset PNG files are freshly derived from `assets/icon.png`
- Config plugins are reapplied
- The build starts from a known-good state

### Option 2: Manual Refresh

Run the dedicated icon refresh script:

```bash
cd app
bash scripts/refresh-icons.sh
```

Then build normally:

```bash
npm run iphone
```

### Option 3: Delete ios/ Directory

Manually remove the generated `ios/` directory before building:

```bash
cd app
rm -rf ios
npm run iphone
```

The `iphone.sh` script will automatically run `expo prebuild` when `ios/` is missing.

## Verifying the Icon File

Before regenerating, verify that `app/assets/icon.png` is a **proper PNG file**, not a JPEG with the wrong extension.

Check the file type:

```bash
file app/assets/icon.png
```

Should output:
```
app/assets/icon.png: PNG image data, 1024 x 1024, 8-bit/color RGB, non-interlaced
```

If it says `JPEG image data` instead, convert it:

```bash
cd app/assets
ffmpeg -i icon.png -frames:v 1 -y icon-fixed.png
mv icon-fixed.png icon.png
```

## Related Assets

The following files are also derived from or related to the main icon:

- **`splash-icon.png`** – Shown during app startup (also 1024×1024)
- **`favicon.png`** – Web version icon
- **`android-icon-foreground.png`** – Android adaptive icon foreground layer
- **`android-icon-monochrome.png`** – Android monochrome icon (for themed icons)
- **`android-icon-background.png`** – Android adaptive icon background

These are sourced independently in `app.json`. If you change the main icon, consider updating these as well for consistency.

## Why ios/ is Generated

Belay uses Expo's **continuous native generation (CNG)**:

- The `ios/` directory is NOT committed to git (see `.gitignore`)
- It is generated from `app.json` and config plugins at build time
- This is what allows Belay to use native modules and custom Info.plist keys without maintaining platform-specific code

The trade-off: derived files like AppIcon.appiconset are only regenerated when Expo decides they're stale, which doesn't always include icon changes.

## Expo's Icon Configuration

In `app.json`:

```json
{
  "expo": {
    "icon": "./assets/icon.png",
    "ios": {
      ...
    },
    "plugins": [
      [
        "expo-splash-screen",
        {
          "image": "./assets/splash-icon.png",
          "backgroundColor": "#0b0d12",
          "resizeMode": "contain"
        }
      ]
    ]
  }
}
```

Expo reads `icon` and generates all required sizes for `AppIcon.appiconset/`. The splash screen plugin does the same for `SplashScreen.imageset/`.

## References

- Expo CNG: https://docs.expo.dev/workflow/continuous-native-generation/
- Expo App Icons: https://docs.expo.dev/develop/user-interface/app-icons/
- Expo Splash Screens: https://docs.expo.dev/develop/user-interface/splash-screen/
