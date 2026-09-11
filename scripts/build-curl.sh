#!/usr/bin/env bash
# Rebuild libcurl against the OpenSSL in the VitaSDK sysroot.
#
# vdpm's curl package is compiled against the OpenSSL 1.0.2 API, but the
# vitasdk image ships (and VitaSurf uses) openssl-1.1.1, so linking the
# packaged libcurl fails with missing SSL_library_init and friends. This
# script builds the same curl release with the same options as the vdpm
# recipe, against whatever OpenSSL is installed, and installs it over the
# packaged copy.
#
# Usage: ./scripts/build-curl.sh
#
# Set CURL_VERSION to override the release. Does nothing in native mode.
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/vita-env.sh"

if [ "${VITASURF_NATIVE:-0}" = "1" ]; then
    echo "build-curl.sh: native build uses the host libcurl, nothing to do"
    exit 0
fi

CURL_VERSION="${CURL_VERSION:-8.17.0}"
WORK="$VITASURF_ROOT/out/curl"
SRC="$WORK/curl-$CURL_VERSION"
TARBALL="$WORK/curl-$CURL_VERSION.tar.xz"
URL="https://curl.se/download/curl-$CURL_VERSION.tar.xz"

mkdir -p "$WORK"

if [ ! -f "$TARBALL" ]; then
    echo "==== downloading $URL"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 4 --retry-all-errors -o "$TARBALL" "$URL"
    else
        wget -O "$TARBALL" "$URL"
    fi
fi

if [ ! -d "$SRC" ]; then
    tar -C "$WORK" -xf "$TARBALL"
fi

echo "==== building curl $CURL_VERSION against $($NS_PKGCONFIG --modversion openssl 2>/dev/null || echo 'unknown') OpenSSL"
cmake -S "$SRC" -B "$SRC/build-vita" \
    -DCMAKE_TOOLCHAIN_FILE="$VITASDK/share/vita.toolchain.cmake" \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCURL_USE_OPENSSL=ON \
    -DBUILD_CURL_EXE=OFF -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
    -DENABLE_IPV6=OFF -DCURL_DISABLE_SOCKETPAIR=ON \
    -DHAVE_FCNTL_O_NONBLOCK=OFF -DENABLE_THREADED_RESOLVER=OFF \
    -DBUILD_LIBCURL_DOCS=OFF -DBUILD_MISC_DOCS=OFF -DENABLE_CURL_MANUAL=OFF \
    -DCURL_CA_BUNDLE="app0:/resources/cacert.pem" -DCURL_USE_LIBPSL=OFF
# newlib declares pipe2() but does not implement it; the vdpm recipe strips
# the detected HAVE_PIPE2 the same way.
sed -i '/HAVE_PIPE2/d' "$SRC/build-vita/lib/curl_config.h"
cmake --build "$SRC/build-vita" -j"$JOBS"
cmake --install "$SRC/build-vita"

echo "==== installed libcurl $($NS_PKGCONFIG --modversion libcurl)"
