#!/usr/bin/env bash
#
# Build the BWP client for iOS.
#
# MUST BE RUN ON A MAC. Rust cross-compiles to iOS targets, but only against an
# iOS SDK, which ships only with Xcode. There is no way to produce this from the
# Windows machine the host is built on, so the app will not link until someone
# runs this.
#
# Produces app/modules/belay-stream/ios/lib/BelayClient.xcframework.
#
#   bash scripts/build-ios-client.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/crates/belay-client"
MODULE="$ROOT/app/modules/belay-stream/ios"
OUT="$MODULE/lib"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "error: iOS libraries can only be built on macOS (needs the iOS SDK from Xcode)." >&2
    exit 1
fi

for tool in cargo rustup xcodebuild lipo; do
    command -v "$tool" >/dev/null || { echo "error: $tool not found on PATH" >&2; exit 1; }
done

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

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# The two SIMULATOR slices merge into one archive — they are different
# architectures for the same platform, which is exactly what lipo is for. The
# device slice must stay separate: it is arm64 like the Apple-silicon simulator,
# and an archive cannot hold two arm64 slices.
mkdir -p "$STAGE/sim"
lipo -create \
    "$CRATE/target/aarch64-apple-ios-sim/release/libbelay_client.a" \
    "$CRATE/target/x86_64-apple-ios/release/libbelay_client.a" \
    -output "$STAGE/sim/libbelay_client.a"

# Headers go into the XCFramework so the modulemap resolves wherever it is
# consumed from.
mkdir -p "$STAGE/headers"
cp "$CRATE/include/belay_client.h" "$STAGE/headers/"
cp "$MODULE/include/module.modulemap" "$STAGE/headers/"

rm -rf "$OUT/BelayClient.xcframework"
mkdir -p "$OUT"

xcodebuild -create-xcframework \
    -library "$CRATE/target/aarch64-apple-ios/release/libbelay_client.a" -headers "$STAGE/headers" \
    -library "$STAGE/sim/libbelay_client.a" -headers "$STAGE/headers" \
    -output "$OUT/BelayClient.xcframework"

# Keep the module's own copy of the header in step with the library it links
# against. A stale header against a changed ABI is a crash, not a build error.
cp "$CRATE/include/belay_client.h" "$MODULE/include/"

echo
echo "built $OUT/BelayClient.xcframework"
find "$OUT/BelayClient.xcframework" -maxdepth 1 -mindepth 1 -type d -exec basename {} \;
echo
echo "Next: cd app && npx expo prebuild -p ios && npx expo run:ios"
