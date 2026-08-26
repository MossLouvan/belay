#!/usr/bin/env bash
#
# Build and install Tether on a physically connected iPhone.
#
# This replaces Expo Go. Expo Go is a single shared app that bundles one SDK
# version, so a project on the newest SDK cannot load until Apple finishes
# reviewing the matching Expo Go release — with both sides already on "latest"
# and nothing the user can do about it.
#
# It also cannot apply config plugins, because those modify the native project
# at build time and Expo Go is a pre-built binary. Tether depends on that:
# without the NSAppTransportSecurity keys from app.json, iOS blocks cleartext
# HTTP to a Tailscale address, which is exactly how you reach your computer
# from outside the house. In Expo Go that fix is silently inert.
#
# Usage:
#   npm run iphone            build, install and launch on the connected phone
#   npm run iphone -- --list  show connected devices without building
#
# First run only: unlock the phone, tap Trust, and pick your Apple ID team when
# Xcode asks. A free Apple ID works — it signs for 7 days, after which re-run
# this script. A paid Apple Developer account signs for a year instead.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--list" ]]; then
  echo "Connected devices:"
  xcrun xctrace list devices 2>/dev/null | sed -n '/^== Devices ==/,/^== /p' | grep -v "Simulator" || true
  exit 0
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "error: Xcode is required to build for a device." >&2
  echo "       Install it from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

# The native project is generated rather than committed (Expo's continuous
# native generation), so make sure it exists before handing off to the build.
if [[ ! -d ios ]]; then
  echo "==> No ios/ directory yet — generating it from app.json"
  npx expo prebuild --platform ios
fi

echo "==> Building and installing on the connected iPhone"
echo "    If this is the first run, unlock the phone and tap Trust when asked."
exec npx expo run:ios --device
