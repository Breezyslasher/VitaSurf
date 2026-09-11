# VitaSurf

VitaSurf is a port of the [NetSurf](https://www.netsurf-browser.org/) web
browser to the PlayStation Vita. It uses NetSurf's framebuffer frontend with
a Vita-specific libnsfb surface and targets ordinary sites (documentation,
wikis, forums, simple interactive pages) at 960x544 with buttons and touch.

The project is GPLv2, like NetSurf. See CLAUDE.md for the development plan
and the platform notes that every change has to respect.

## Status

Phase 1 (boot) is complete and verified on real hardware: the framebuffer
frontend is linked statically with JavaScript disabled and renders the
bundled local page from `app0:`. Phase 2 (networking) is in progress:
SceNet and SceNetCtl are initialised before NetSurf starts, libcurl is
built against OpenSSL 1.1.1 with the bundled CA file, and the home page
links to test sites. Input, JavaScript, persistence and the rest follow.

## Building

Requirements: [VitaSDK](https://vitasdk.org/) with `VITASDK` set, plus
`make`, `pkg-config`, `perl`, `gperf`, `flex`, `bison`, `cmake` and host
development packages for zlib and libpng (NetSurf builds a few host tools).

    vdpm zlib bzip2 libpng libjpeg-turbo freetype zstd openssl-1.1.1 curl expat
    git submodule update --init --recursive
    ./scripts/build-curl.sh
    ./scripts/build-deps.sh
    ./scripts/build-netsurf.sh
    cmake -B build -DCMAKE_TOOLCHAIN_FILE=$VITASDK/share/vita.toolchain.cmake
    cmake --build build

The result is `build/VitaSurf.vpk`. The curl step exists because vdpm's curl package is
linked against the OpenSSL 1.0.2 API while the toolchain ships 1.1.1. Add `VITASURF_DEBUG=1` to the
environment of `build-netsurf.sh` and `-DVITASURF_DEBUG=ON` to CMake for a
build with verbose logging. Creating an empty file named `verbose` in
`ux0:data/VitaSurf/` turns NetSurf's verbose logging on at runtime in any
build; the log also starts with a self-test of the path and clock
assumptions the port relies on.

`VITASURF_NATIVE=1 ./scripts/build-deps.sh` and
`VITASURF_NATIVE=1 ./scripts/build-netsurf.sh` build the same libraries for
the host into `out/native`. This only exists to test the build scripts on a
Linux machine.

## Layout

    CMakeLists.txt        final link, SELF creation, VPK packaging
    scripts/              build-curl.sh, build-deps.sh, build-netsurf.sh, apply-patches.sh
    deps/                 NetSurf and its libraries as git submodules
    patches/              every change to upstream code, as patch files
    vita/surface/         libnsfb surface: display buffer and input polling
    vita/platform/        paths, logging, system initialisation, entry point
    vita/netsurf/         NetSurf Makefile.config for the Vita
    resources/            default Choices, home page, CA bundle
    sce_sys/              LiveArea assets

## How the pieces fit

NetSurf's libraries are cross-compiled with NetSurf's own make-based
buildsystem and installed into the VitaSDK sysroot. NetSurf itself is built
with `TARGET=framebuffer` into a static library instead of an executable.
CMake compiles the Vita glue, links everything with `-Wl,--wrap=main` so
`vita/platform/vita_main.c` runs before NetSurf's `main()`, and packages the
VPK.

Paths: NetSurf is compiled with drive-less resource paths such as
`/resources`, which VitaSDK's C library resolves against the current drive,
`app0:`. A Vita file table in `vita/platform/vita_file.c` keeps drive
prefixes intact when paths pass through file: URLs. All writable data goes
under `ux0:data/VitaSurf/`, and the log is `ux0:data/VitaSurf/log.txt`.

Two VitaSDK newlib gaps are worked around in `vita/platform/`: `iconv_open`
fails for every charset, so libparserutils is built with its own codecs and
`vita_iconv.c` supplies the conversions NetSurf itself needs; and
`PATH_MAX`, `endian.h` and `sys/mman.h` are missing, handled by
`vita_compat.h` and two small patches.

## Controls (phase 1)

| Input | Action |
|---|---|
| D-pad | Scroll |
| Left stick | Scroll |
| L / R | Page up / page down |
| Front touch | Tap and drag with the pointer |
| Select + Start | Quit |

The full control scheme in CLAUDE.md arrives with phase 3.
