#!/usr/bin/env bash
#
# Every app and desktop icon from the one beluga mark (assets/beluga-mark.svg).
# Needs rsvg-convert (`brew install librsvg`). Run from anywhere:
#
#   bash app/scripts/build-icons.sh
#
# Then `bash app/scripts/refresh-icons.sh` before an iOS build (see docs/ICONS.md).

set -euo pipefail
cd "$(dirname "$0")/../.."

BG='#0b0d12'      # app.json backgroundColor
INK='#F5F5F7'     # dark theme text
TMP=$(mktemp -t belay-icon).svg; trap 'rm -f "$TMP"' EXIT
PATH_D=$(sed -E 's/.* d="([^"]+)".*/\1/' app/assets/beluga-mark.svg)

# icon NAME SIZE PX_OF_MARK FILL [BACKGROUND-SVG]
icon() {
  local out=$1 size=$2 mark=$3 fill=$4 ground=${5:-}
  local scale off
  scale=$(echo "$mark / 64" | bc -l)
  off=$(echo "($size - $mark) / 2" | bc -l)
  cat > "$TMP" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$size" height="$size" viewBox="0 0 $size $size">$ground
<path fill="$fill" transform="translate($off $off) scale($scale) translate(-2 -4)" d="$PATH_D"/></svg>
SVG
  rsvg-convert "$TMP" -o "$out"
}

SQUARE="<rect width='100%' height='100%' fill='$BG'/>"
icon app/assets/icon.png                     1024 640 "$INK" "$SQUARE"
icon app/assets/favicon.png                    64  48 "$INK" "$SQUARE"
icon app/assets/splash-icon.png              1024 720 "$INK"
icon app/assets/android-icon-foreground.png  1024 560 "$INK"
icon app/assets/android-icon-monochrome.png  1024 560 '#FFFFFF'
# macOS: the 824 px rounded tile on a transparent 1024 canvas (Apple's grid).
icon desktop/build/icon.png                  1024 540 "$INK" "<rect x='100' y='100' width='824' height='824' rx='185' fill='$BG'/>"
# Menu bar: black on transparent; the "Template" suffix lets macOS tint it.
icon desktop/build/trayTemplate.png            18  18 '#000000'
icon desktop/build/trayTemplate@2x.png         36  36 '#000000'
cp app/assets/beluga-mark.svg desktop/renderer/beluga-mark.svg
echo "icons: built from app/assets/beluga-mark.svg"
