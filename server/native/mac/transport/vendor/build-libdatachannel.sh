#!/usr/bin/env bash
# Builds a static libdatachannel (+ its bundled deps) for the BELAY_WEBRTC_BUILD
# path and installs it under this directory as vendor/libdatachannel/{include,lib}.
#
# Reproducible by pinning: libdatachannel v0.23.1 (MPL 2.0), which builds its
# submodules libjuice (MPL 2.0), usrsctp (BSD-3-Clause), libsrtp (BSD-3-Clause,
# Cisco) and plog (MIT) in-tree. TLS/crypto comes from the system-installed
# OpenSSL (Apache 2.0) via Homebrew. All permissive/file-level-copyleft: static
# linking into the Belay helper is fine as long as the vendored sources stay
# unmodified and this script records where they came from (it does — the pin).
#
# Requirements: git, cmake (brew install cmake), openssl@3 (brew install openssl@3),
# Xcode Command Line Tools. Takes a few minutes; ~40 MB of build tree, and the
# result is ignored by git — every machine builds its own.
#
# Usage:  bash build-libdatachannel.sh            # arm64 + x86_64 universal
#         BELAY_LDC_ARCHS=arm64 bash build-libdatachannel.sh   # native only

set -euo pipefail

pin="v0.23.1"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="$here/libdatachannel"
work="$here/.build"
archs="${BELAY_LDC_ARCHS:-arm64;x86_64}"

for tool in git cmake; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not found (brew install $tool)" >&2; exit 1; }
done

openssl_root="${OPENSSL_ROOT_DIR:-$(brew --prefix openssl@3 2>/dev/null || true)}"
if [ -z "$openssl_root" ] || [ ! -d "$openssl_root" ]; then
  echo "error: OpenSSL not found. brew install openssl@3, or set OPENSSL_ROOT_DIR." >&2
  exit 1
fi

mkdir -p "$work"
if [ ! -d "$work/libdatachannel/.git" ]; then
  git clone --branch "$pin" --depth 1 --recurse-submodules --shallow-submodules \
    https://github.com/paullouisageneau/libdatachannel.git "$work/libdatachannel"
fi

cmake -S "$work/libdatachannel" -B "$work/out" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$archs" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DNO_EXAMPLES=ON -DNO_TESTS=ON \
  -DOPENSSL_ROOT_DIR="$openssl_root"
cmake --build "$work/out" --parallel

# Collect the static archives wherever the submodule builds dropped them.
mkdir -p "$prefix/lib" "$prefix/include"
cp -R "$work/libdatachannel/include/rtc" "$prefix/include/"
find "$work/out" -name '*.a' -exec cp {} "$prefix/lib/" \;

# build-mac.sh links: -ldatachannel-static -ljuice-static -lusrsctp -lsrtp2
for lib in libdatachannel-static.a libjuice-static.a libusrsctp.a libsrtp2.a; do
  [ -f "$prefix/lib/$lib" ] || echo "warning: expected $lib was not produced — check the cmake log" >&2
done

echo "Vendored static libdatachannel $pin into $prefix"
echo "Now: BELAY_WEBRTC_BUILD=1 bash ../../../build-mac.sh"
