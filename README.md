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
bundled local page from `app0:`. Phase 2 (networking) is complete and
verified on hardware: SceNet and SceNetCtl are initialised before NetSurf
starts, libcurl uses mbedTLS with the bundled CA file, and HTTP and HTTPS
pages load. Phase 3 (input) is in progress: the control scheme below is
implemented and awaiting hardware testing. JavaScript, persistence and
the rest follow.

## Building

Requirements: [VitaSDK](https://vitasdk.org/) with `VITASDK` set, plus
`make`, `pkg-config`, `perl`, `gperf`, `flex`, `bison`, `cmake` and host
development packages for zlib and libpng (NetSurf builds a few host tools).

    vdpm zlib bzip2 libpng libjpeg-turbo freetype zstd mbedtls curl-mbedtls expat libvita2d
    git submodule update --init --recursive
    ./scripts/build-deps.sh
    ./scripts/build-netsurf.sh
    cmake -B build -DCMAKE_TOOLCHAIN_FILE=$VITASDK/share/vita.toolchain.cmake
    cmake --build build

The result is `build/VitaSurf.vpk`. TLS comes from mbedTLS (dual licensed
Apache-2.0 or GPL-2.0-or-later) through vdpm's `curl-mbedtls` package. The
OpenSSL 1.1.1 port was tried first: it creates a pthread read-write lock for
every BIO and X509 object, and on hardware those allocations started failing
after a few hundred locks, so curl could never load the CA bundle. mbedTLS
only needs a handful of mutexes. Add `VITASURF_DEBUG=1` to the
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
    scripts/              build-deps.sh, build-netsurf.sh, apply-patches.sh
    deps/                 NetSurf and its libraries as git submodules
    patches/              every change to upstream code, as patch files
    vita/surface/         libnsfb surface: display buffer and input polling
    vita/platform/        paths, logging, system initialisation, entry point
    vita/netsurf/         NetSurf Makefile.config for the Vita
    resources/            default Choices, home page, CA bundle, DejaVu fonts
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

## Controls

| Input | Action |
|---|---|
| D-pad | Move focus between links and form fields |
| Cross | Activate the focused element, or click at the pointer |
| Circle | Stop loading, drop focus, close the keyboard |
| Left stick | Scroll, speed follows deflection |
| Right stick | Move the pointer |
| L / R | Back / forward |
| Triangle | Enter a web address or search terms |
| Tap or Cross on a text field | Opens the system keyboard for that field |
| Square | Reload |
| Select | Toggle pointer mode: the D-pad nudges the pointer instead |
| Start | Menu (not implemented yet) |
| Front touch | Tap to click, drag to scroll |
| Select + Start | Quit |

The surface (`vita/surface/vita.c`) turns buttons into libnsfb key events
and exposes the sticks and touch drags as state. The input layer
(`vita/input/`) is called from two small hooks in the framebuffer
frontend: one before the toolkit dispatches a key, for buttons that act
on the whole browser, and one in the browser widget, for the D-pad and
Cross. Link focus walks the page's box tree for links and form controls,
picks the nearest one in the pressed direction, scrolls it into view and
draws an outline over the display. Text entry uses the system IME dialog,
falling back to NetSurf's on-screen keyboard if the dialog cannot start.
When a form field takes the caret right after a tap or an activation, the
keyboard opens for it with the field's current text and the result is
typed into the field.

The display goes through libvita2d (MIT): the page is copied into a
screen-sized GPU texture and drawn when it changes. System dialogs such
as the IME keyboard refuse to start unless GXM is initialised and draw
themselves through the common dialog update each frame, so a plain
framebuffer cannot show them. Damaged regions are still the only thing
copied; the GPU draw is one textured quad.
