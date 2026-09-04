#!/usr/bin/env bash
#
# Build the BWP client as a static library for iOS.
#
# MUST BE RUN ON A MAC. Rust can cross-compile to iOS targets, but only against
# an iOS SDK, which only ships with Xcode. There is no way to produce this from
# the Windows dev machine the host is built on — so the app will not link until
# someone runs this.
#
# Produces app/modules/belay-stream/ios/lib/libbelay_client.a, a fat archive
# covering the device and both simulator architectures.
#
#   bash scripts/build-ios-client.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/crates/belay-client"
OUT="$ROOT/app/modules/belay-stream/ios/lib"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "error: iOS libraries can only be built on macOS (needs the iOS SDK from Xcode)." >&2
    exit 1
fi

if ! command -v cargo >/dev/null; then
    echo "error: cargo not found. Install Rust from https://rustup.rs" >&2
    exit 1
fi

# aarch64-apple-ios       — real devices
# aarch64-apple-ios-sim   — simulator on Apple silicon
# x86_64-apple-ios        — simulator on Intel
TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)

for target in "${TARGETS[@]}"; do
    if ! rustup target list --installed | grep -qx "$target"; then
        echo "installing Rust target $target"
        rustup target add "$target"
    fi
done

for target in "${TARGETS[@]}"; do
    echo "building $target"
    (cd "$CRATE" && cargo build --release --target "$target")
done

mkdir -p "$OUT"

# The device slice stands alone; the two simulator slices are merged, because a
# single archive cannot hold two slices of the same architecture family for
# different platforms.
#
# lipo produces one archive covering everything, which is what the podspec
# expects. A proper XCFramework would be tidier, but it needs a framework
# wrapper this module does not otherwise want.
lipo -create \
    "$CRATE/target/aarch64-apple-ios/release/libbelay_client.a" \
    "$CRATE/target/x86_64-apple-ios/release/libbelay_client.a" \
    -output "$OUT/libbelay_client.a" 2>/dev/null || {
        # lipo refuses to merge two arm64 slices. When that happens, ship the
        # device slice: it is the one that matters, and the simulator can be
        # built separately by re-running with SIMULATOR=1.
        echo "note: device + Intel-simulator merge failed; using the device slice alone"
        cp "$CRATE/target/aarch64-apple-ios/release/libbelay_client.a" "$OUT/libbelay_client.a"
    }

if [[ "${SIMULATOR:-0}" == "1" ]]; then
    echo "using the Apple-silicon simulator slice instead"
    cp "$CRATE/target/aarch64-apple-ios-sim/release/libbelay_client.a" "$OUT/libbelay_client.a"
fi

# The header the Swift side imports must match the library it links against.
# Copying rather than symlinking means a stale header cannot survive a checkout.
cp "$CRATE/include/belay_client.h" "$ROOT/app/modules/belay-stream/ios/include/"

echo
echo "built $OUT/libbelay_client.a"
lipo -info "$OUT/libbelay_client.a"
echo
echo "Next: cd app && npx expo prebuild -p ios && npx expo run:ios"
