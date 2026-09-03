#!/usr/bin/env bash
# Compiles the macOS native helper into server/native/BelayHostMac.
#
# Mirrors build.ps1: it uses only tooling already on the machine. `swiftc` ships
# with the Xcode Command Line Tools (xcode-select --install), so there is no
# package manager, no Xcode project and no dependency to restore.
#
# Produces a universal binary (arm64 + x86_64) when both slices compile, so the
# same build works on Apple silicon and Intel. If a slice fails the script falls
# back to the native architecture only rather than failing the whole build.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_dir="$here/mac"
out="$here/BelayHostMac"
# ScreenCaptureKit needs 12.3; SCContentFilter/SCStreamConfiguration options used
# here are all available by 13.0, which is also the oldest macOS worth targeting.
deployment_target="13.0"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install the Xcode Command Line Tools:" >&2
  echo "         xcode-select --install" >&2
  exit 1
fi

shopt -s nullglob
sources=("$src_dir"/*.swift)
shopt -u nullglob
if [ ${#sources[@]} -eq 0 ]; then
  echo "error: no Swift sources found in $src_dir" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# AppKit is here only for NSScreen.localizedName in DisplayIdentity.swift —
# the one display fact CoreGraphics does not expose.
common_flags=(-O -swift-version 5 -framework ScreenCaptureKit -framework CoreGraphics
              -framework ImageIO -framework ApplicationServices -framework CoreMedia
              -framework CoreVideo -framework UniformTypeIdentifiers -framework AppKit)

# ── WebRTC path (opt-in, HARDWARE-GATED) ─────────────────────────────────────
# The default build deliberately globs only the top-level mac/*.swift, so
# mac/encode/ (VideoEncoder.swift) and mac/transport/ (libdatachannel shim) are
# EXCLUDED and the shipping helper is unchanged. Set BELAY_WEBRTC_BUILD=1 to
# fold them in — this path is NOT yet verified (it needs a prebuilt static
# libdatachannel archive and has not been compiled end-to-end; see
# docs/WEBRTC-SLICE.md). It is wired here so enabling it is a build-flag change,
# not a script rewrite.
if [ "${BELAY_WEBRTC_BUILD:-}" = "1" ]; then
  echo "note: BELAY_WEBRTC_BUILD=1 — folding in the hardware-gated WebRTC encoder/transport (UNVERIFIED)" >&2
  shopt -s nullglob
  sources+=("$src_dir"/encode/*.swift "$src_dir"/transport/*.swift)
  shopt -u nullglob
  # VideoEncoder needs VideoToolbox; the transport shim needs libdatachannel and
  # its deps (libjuice/usrsctp/srtp2 + OpenSSL's libcrypto/libssl), a C++
  # runtime, and the bridging header that exposes belay_transport.h to Swift.
  # Vendor libdatachannel as a static build under mac/transport/vendor/ — run
  # mac/transport/vendor/build-libdatachannel.sh once to produce it (the one
  # place ARCHITECTURE.md's "no dependency to restore" claim bends; it is
  # fetched/built by that script, never restored by a package manager).
  : "${LIBDATACHANNEL_ROOT:=$src_dir/transport/vendor/libdatachannel}"
  if [ ! -f "$LIBDATACHANNEL_ROOT/lib/libdatachannel-static.a" ]; then
    echo "error: static libdatachannel not found at $LIBDATACHANNEL_ROOT/lib/." >&2
    echo "       Run: bash $src_dir/transport/vendor/build-libdatachannel.sh" >&2
    echo "       (or set LIBDATACHANNEL_ROOT to an existing static build)" >&2
    exit 1
  fi
  # -D BELAY_WEBRTC_BUILD compiles in the Swift-side gated seams (the webrtc
  # verb in main.swift, the encoder push sink in Capture.swift, WebRTCSession).
  # The C++ shim is compiled separately per-arch by clang++ (swiftc does not
  # compile C++ sources) and handed to swiftc as an object file to link.
  common_flags+=(-D BELAY_WEBRTC_BUILD
                 -framework VideoToolbox
                 -import-objc-header "$src_dir/transport/belay-bridging.h"
                 -L "$LIBDATACHANNEL_ROOT/lib"
                 -ldatachannel-static -ljuice-static -lusrsctp -lsrtp2
                 -lssl -lcrypto -lc++)
fi

build_slice() {
  local arch="$1"
  local dest="$work/BelayHostMac.$arch"
  local extra_objects=()
  if [ "${BELAY_WEBRTC_BUILD:-}" = "1" ]; then
    local shim_obj="$work/belay_transport.$arch.o"
    clang++ -c -std=c++17 -O2 -arch "$arch" \
      -mmacosx-version-min="$deployment_target" \
      -DBELAY_HAVE_LIBDATACHANNEL -DRTC_ENABLE_MEDIA=1 \
      -I "$LIBDATACHANNEL_ROOT/include" \
      -o "$shim_obj" "$src_dir/transport/belay_transport.cpp" \
      2>"$work/$arch.log" || return 1
    extra_objects+=("$shim_obj")
  fi
  swiftc "${common_flags[@]}" \
    -target "$arch-apple-macos$deployment_target" \
    -o "$dest" "${sources[@]}" ${extra_objects[@]+"${extra_objects[@]}"} 2>>"$work/$arch.log" || return 1
  echo "$dest"
}

native_arch="$(uname -m)"
slices=()
failed=()
for arch in arm64 x86_64; do
  if slice="$(build_slice "$arch")"; then
    slices+=("$slice")
  else
    failed+=("$arch")
    if [ "$arch" = "$native_arch" ]; then
      echo "error: build failed for the native architecture ($arch):" >&2
      cat "$work/$arch.log" >&2
      exit 1
    fi
    echo "warning: skipping $arch slice (see error below); the binary will not be universal" >&2
    sed 's/^/  /' "$work/$arch.log" >&2
  fi
done

if [ ${#slices[@]} -gt 1 ]; then
  lipo -create -output "$out" "${slices[@]}"
else
  cp "${slices[0]}" "$out"
fi
chmod +x "$out"

# Ad-hoc signature. macOS identifies a binary for TCC (Screen Recording,
# Accessibility) by its code signature, and an ad-hoc signature is keyed to the
# binary's own content hash (CDHash) rather than to a stable Team ID. So this
# does NOT make a grant survive rebuilds: any rebuild that changes a single byte
# produces a new CDHash and the user has to re-tick the checkbox. What it does
# buy is a valid identity for one built binary — the grant sticks across runs,
# moves and copies of that exact build instead of being re-evaluated each launch.
# Surviving rebuilds would need a stable signing identity (a Developer ID).
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$out" >/dev/null 2>&1 || \
    echo "warning: ad-hoc codesign failed; permissions may need re-granting after each rebuild" >&2
fi

echo "Built $out ($(lipo -archs "$out" 2>/dev/null || echo "$native_arch"))"
if [ ${#failed[@]} -gt 0 ]; then
  echo "Note: architectures skipped: ${failed[*]}"
fi
