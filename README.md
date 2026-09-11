# VitaSurf

VitaSurf is a port of the [NetSurf](https://www.netsurf-browser.org/) web
browser to the PlayStation Vita. It uses NetSurf's framebuffer frontend with
a Vita-specific libnsfb surface and targets ordinary sites (documentation,
wikis, forums, simple interactive pages) at 960x544 with buttons and touch.

The project is GPLv2, like NetSurf. See CLAUDE.md for the development plan
and the platform notes that every change has to respect.

## Status

Phase 1 (boot): the framebuffer frontend is linked statically with
JavaScript disabled and renders a bundled local page from `app0:`.
Networking, input, JavaScript, persistence and the rest follow in later
phases. Nothing has been verified on hardware yet.

## Building

Requirements: [VitaSDK](https://vitasdk.org/) with `VITASDK` set, plus
`make`, `pkg-config`, `perl`, `gperf`, `flex`, `bison`, `cmake` and host
development packages for zlib and libpng (NetSurf builds a few host tools).

    vdpm zlib bzip2 libpng libjpeg-turbo freetype openssl-1.1.1 curl expat
    git submodule update --init --recursive
    ./scripts/build-deps.sh
    ./scripts/build-netsurf.sh
    cmake -B build -DCMAKE_TOOLCHAIN_FILE=$VITASDK/share/vita.toolchain.cmake
    cmake --build build

The result is `build/VitaSurf.vpk`. Add `VITASURF_DEBUG=1` to the
environment of `build-netsurf.sh` and `-DVITASURF_DEBUG=ON` to CMake for a
build with verbose logging.

`VITASURF_NATIVE=1 ./scripts/build-deps.sh` and
`VITASURF_NATIVE=1 ./scripts/build-netsurf.sh` build the same libraries for
the host into `out/native`. This only exists to test the build scripts on a
Linux machine.

## Layout

    CMakeLists.txt        final link, SELF creation, VPK packaging
    scripts/              build-deps.sh, build-netsurf.sh, apply-patches.sh
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
`app0:`. All writable data goes under `ux0:data/VitaSurf/`, and the log is
`ux0:data/VitaSurf/log.txt`.

## Controls (phase 1)

| Input | Action |
|---|---|
| D-pad | Scroll |
| Left stick | Scroll |
| L / R | Page up / page down |
| Front touch | Tap and drag with the pointer |
| Select + Start | Quit |

The full control scheme in CLAUDE.md arrives with phase 3.
