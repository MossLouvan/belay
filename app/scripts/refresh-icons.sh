#!/usr/bin/env bash
#
# Force-refresh iOS AppIcon assets from app/assets/icon.png.
#
# Expo's `run:ios` and `prebuild` do NOT always regenerate AppIcon.appiconset
# when only the source icon changed, so a rebuild can ship stale assets. This
# script ensures a clean regeneration: it removes the ios/ directory entirely
# and runs `expo prebuild --platform ios` from scratch.
#
# Run this after updating app/assets/icon.png, before building for a device or
# simulator. The generated ios/ directory is excluded from git, so this is safe
# to run at any time.
#
# Usage:
#   bash scripts/refresh-icons.sh    # from the app/ directory

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f assets/icon.png ]]; then
  echo "error: assets/icon.png not found. Run this from the app/ directory." >&2
  exit 1
fi

echo "==> Verifying icon.png is a proper PNG (not JPEG with wrong extension)"
if ! file assets/icon.png | grep -q "PNG image data"; then
  echo "error: assets/icon.png is not a valid PNG file." >&2
  echo "       Current type: $(file assets/icon.png)" >&2
  echo "       Convert it with: ffmpeg -i assets/icon.png -frames:v 1 -y assets/icon-fixed.png && mv assets/icon-fixed.png assets/icon.png" >&2
  exit 1
fi

echo "==> Removing existing ios/ directory to force clean generation"
rm -rf ios

echo "==> Running expo prebuild for iOS"
npx expo prebuild --platform ios

echo "✓ iOS native project regenerated with fresh AppIcon assets"
echo ""
echo "Next steps:"
echo "  • Run 'npm run iphone' to build and install on a connected device"
echo "  • Run 'npm run simulator' to build and run in the iOS Simulator"
echo ""
echo "The AppIcon.appiconset is now derived from assets/icon.png."
