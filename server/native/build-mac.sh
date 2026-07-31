#!/usr/bin/env bash
# Compiles the macOS native helper into server/native/TetherHostMac.
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
out="$here/TetherHostMac"
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

common_flags=(-O -swift-version 5 -framework ScreenCaptureKit -framework CoreGraphics
              -framework ImageIO -framework ApplicationServices -framework CoreMedia
              -framework CoreVideo -framework UniformTypeIdentifiers)

build_slice() {
  local arch="$1"
  local dest="$work/TetherHostMac.$arch"
  swiftc "${common_flags[@]}" \
    -target "$arch-apple-macos$deployment_target" \
    -o "$dest" "${sources[@]}" 2>"$work/$arch.log" || return 1
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
