#!/usr/bin/env bash
# Replace vdpm's libcurl with one that speaks HTTP/2.
#
# vdpm's curl-mbedtls is built without nghttp2, and vdpm has no nghttp2
# package, so every https fetch went over HTTP/1.1: six connections to a
# host at most, each a TLS handshake of about a second on the Vita, and
# the rest of a page's requests queued behind them. GitHub's asset host
# alone was asked for forty modules at once; a hardware log had 75
# fetches waiting 70 s in all for a free slot. Over HTTP/2 they share
# one connection (content/fetchers/curl.c asks for it).
#
# So: build nghttp2's library, then the same curl as vdpm's package
# (version and options from its VITABUILD) with nghttp2 added, both into
# the VitaSDK sysroot over the top of vdpm's copy. Sources are release
# tarballs checked against their SHA-256.
#
# Usage: ./scripts/build-curl-http2.sh
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/vita-env.sh"

if [ -n "${VITASURF_NATIVE:-}" ]; then
    echo "build-curl-http2.sh: host builds use the system libcurl" >&2
    exit 0
fi

NGHTTP2_VER="${NGHTTP2_VER:-1.68.0}"
NGHTTP2_SHA256="${NGHTTP2_SHA256:-5511d3128850e01b5b26ec92bf39df15381c767a63441438b25ad6235def902c}"
CURL_VER="${CURL_VER:-8.22.0}"
CURL_SHA256="${CURL_SHA256:-f7ef3ae8a22e521f289803fe93543eb64c329b58aa73a9e224dfd915a2a5f4f7}"
TOOLCHAIN="$VITASDK/share/vita.toolchain.cmake"

[ -f "$TOOLCHAIN" ] || { echo "no $TOOLCHAIN -- is VITASDK set?" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
    local url="$1" out="$2" sum="$3"
    curl -fsSL --retry 4 --retry-delay 2 -o "$out" "$url"
    if [ -n "$sum" ]; then
        echo "$sum  $out" | sha256sum -c - >/dev/null || {
            echo "checksum mismatch for $url" >&2
            exit 1
        }
    fi
}

echo "==== nghttp2 $NGHTTP2_VER"
fetch "https://github.com/nghttp2/nghttp2/releases/download/v$NGHTTP2_VER/nghttp2-$NGHTTP2_VER.tar.xz" \
    "$work/nghttp2.tar.xz" "$NGHTTP2_SHA256"
tar -xf "$work/nghttp2.tar.xz" -C "$work"
# The library only: no tools, no examples, no documentation, and static,
# as everything the Vita links is.
cmake -S "$work/nghttp2-$NGHTTP2_VER" -B "$work/nghttp2-build" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_POSITION_INDEPENDENT_CODE=OFF \
    -DENABLE_LIB_ONLY=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_STATIC_LIBS=ON \
    -DENABLE_DOC=OFF \
    -DBUILD_TESTING=OFF
cmake --build "$work/nghttp2-build" -j"$JOBS"
cmake --install "$work/nghttp2-build"
no_pic_relocations "$PREFIX/lib/libnghttp2.a"

echo "==== curl $CURL_VER with nghttp2"
fetch "https://github.com/curl/curl/releases/download/curl-${CURL_VER//./_}/curl-$CURL_VER.tar.xz" \
    "$work/curl.tar.xz" "$CURL_SHA256"
tar -xf "$work/curl.tar.xz" -C "$work"
# HTTP/2's flow-control windows, sized for a desktop: 10 MB a connection
# and up to 10 MB a stream, with a pool that keeps as many 16 KB chunks
# as fit the connection window for reuse. A stream NetSurf pauses (its
# fetches hold data for a busy page) has its window's worth sent and
# kept in curl, so on a Vita that is memory gone for nothing. 2 MB and
# 1 MB still let a connection run far faster than its Wi-Fi.
h2c="$work/curl-$CURL_VER/lib/http2.c"
grep -q '^#define H2_CONN_WINDOW_SIZE     (10 \* 1024 \* 1024)' "$h2c" &&
grep -q '^#define H2_STREAM_WINDOW_SIZE_MAX   (10 \* 1024 \* 1024)' "$h2c" || {
    echo "curl $CURL_VER's HTTP/2 window sizes are not where this" \
         "script expects them; check lib/http2.c" >&2
    exit 1
}
sed -i -e 's/^#define H2_CONN_WINDOW_SIZE     (10 \* 1024 \* 1024)/#define H2_CONN_WINDOW_SIZE     (2 * 1024 * 1024)/' \
       -e 's/^#define H2_STREAM_WINDOW_SIZE_MAX   (10 \* 1024 \* 1024)/#define H2_STREAM_WINDOW_SIZE_MAX   (1024 * 1024)/' \
    "$h2c"
# vdpm's curl-mbedtls options, with nghttp2 required rather than looked
# for, and brotli left out: the sysroot has brotli's decoder now
# (build-freetype-woff2.sh), and curl would pick it up and want it
# linked, where NetSurf only ever asks for gzip.
cmake -S "$work/curl-$CURL_VER" -B "$work/curl-build" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_CURL_EXE=OFF -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
    -DENABLE_IPV6=OFF -DCURL_DISABLE_SOCKETPAIR=ON \
    -DHAVE_FCNTL_O_NONBLOCK=OFF -DENABLE_THREADED_RESOLVER=OFF \
    -DBUILD_LIBCURL_DOCS=OFF -DBUILD_MISC_DOCS=OFF -DENABLE_CURL_MANUAL=OFF \
    -DCURL_CA_BUNDLE="vs0:data/external/cert/CA_LIST.cer" \
    -DCURL_USE_LIBPSL=OFF -DCURL_USE_MBEDTLS=ON -DHAVE_PIPE2=0 \
    -DCMAKE_DISABLE_FIND_PACKAGE_Threads=ON \
    -DUSE_NGHTTP2=ON -DCURL_BROTLI=OFF
grep -q '^#define USE_NGHTTP2 1' "$work/curl-build/lib/curl_config.h" || {
    echo "curl $CURL_VER was configured without nghttp2" >&2
    exit 1
}
cmake --build "$work/curl-build" -j"$JOBS"
cmake --install "$work/curl-build"
no_pic_relocations "$PREFIX/lib/libcurl.a"

echo "curl $CURL_VER with HTTP/2 (nghttp2 $NGHTTP2_VER) installed in $PREFIX"
