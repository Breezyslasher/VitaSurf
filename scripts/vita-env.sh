# Shared environment for the VitaSurf build scripts. Source this file.
#
# Two modes:
#   default            cross-compile with VitaSDK ($VITASDK must be set)
#   VITASURF_NATIVE=1  build for the host with the host toolchain, into
#                      out/native. This exists to test the build scripts on
#                      a Linux machine; the result is a normal NetSurf
#                      framebuffer build, not a Vita binary.

VITASURF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export VITASURF_ROOT

NSSHARED="$VITASURF_ROOT/deps/buildsystem"
export NSSHARED

JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"

# Host tools every mode needs.
for tool in make pkg-config perl gperf flex bison; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "error: $tool is required but not installed" >&2
        exit 1
    fi
done

if [ "${VITASURF_NATIVE:-0}" = "1" ]; then
    NS_HOST=""
    NETSURF_HOST="$(uname -s)"
    PREFIX="$VITASURF_ROOT/out/native"
    TARGET_CC="${CC:-cc}"
    TARGET_AR="${AR:-ar}"
    TARGET_CXX="${CXX:-c++}"
    export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    NS_PKGCONFIG="pkg-config"
    NETSURF_PKG_CONFIG="pkg-config"
else
    if [ -z "${VITASDK:-}" ] || [ ! -x "$VITASDK/bin/arm-vita-eabi-gcc" ]; then
        echo "error: VITASDK is not set or $VITASDK/bin/arm-vita-eabi-gcc is missing" >&2
        exit 1
    fi
    export PATH="$VITASDK/bin:$PATH"
    NS_HOST="arm-vita-eabi"
    NETSURF_HOST="vita"
    PREFIX="$VITASDK/arm-vita-eabi"
    TARGET_CC="$VITASDK/bin/arm-vita-eabi-gcc"
    TARGET_AR="$VITASDK/bin/arm-vita-eabi-ar"
    TARGET_CXX="$VITASDK/bin/arm-vita-eabi-g++"
    # The wrapper limits pkg-config to the VitaSDK sysroot so host libraries
    # such as SDL are never detected.
    NS_PKGCONFIG="$VITASDK/bin/arm-vita-eabi-pkg-config"
    NETSURF_PKG_CONFIG="$NS_PKGCONFIG"
fi

export NS_HOST NETSURF_HOST PREFIX TARGET_CC TARGET_AR TARGET_CXX NS_PKGCONFIG NETSURF_PKG_CONFIG JOBS

# Arguments common to every NetSurf buildsystem invocation.
ns_make_args() {
    printf '%s\n' \
        "PREFIX=$PREFIX" \
        "NSSHARED=$NSSHARED" \
        "VARIANT=release" \
        "PKGCONFIG=$NS_PKGCONFIG" \
        "CC=$TARGET_CC" \
        "AR=$TARGET_AR" \
        "CXX=$TARGET_CXX" \
        "Q=@"
    if [ -n "$NS_HOST" ]; then
        printf '%s\n' "HOST=$NS_HOST"
    fi
}
