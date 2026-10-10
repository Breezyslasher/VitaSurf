# VitaSurf

VitaSurf is a port of the [NetSurf](https://www.netsurf-browser.org/) web
browser to the PlayStation Vita. It uses NetSurf's framebuffer frontend with
a Vita-specific libnsfb surface and targets ordinary sites (documentation,
wikis, forums, simple interactive pages) at 960x544 with buttons and touch.

The project is GPLv2, like NetSurf. CLAUDE.md holds the development plan and
the platform notes every change has to respect; every change to upstream
code is a patch in `patches/`.

## Features

- HTTP and HTTPS through libcurl with mbedTLS, HTTP/2, and the bundled CA file.
- JavaScript on quickjs-ng with hand-written DOM bindings: fetch and
  XMLHttpRequest, WebSocket, Workers, iframes, shadow DOM, native Intl,
  `crypto.subtle`, and WebAssembly on WAMR's interpreter.
- Modern CSS: flexbox, grid, custom properties, transforms, filters,
  gradients, `@container`, `@layer`, `:has()` and web fonts.
- Cookies, history, bookmarks and settings saved under `ux0:data/VitaSurf/`.
- Page zoom, downloads, and a file browser (Files in the Start menu).

Sites behind Cloudflare's browser check can be handed to a
[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) server on your
network: put its URL (for example `http://192.168.1.20:8191/v1`) in
`ux0:data/VitaSurf/flaresolverr`.

Load times against Sony's own browser are in `docs/benchmarks.md`.

## Building

Requires [VitaSDK](https://vitasdk.org/) with `VITASDK` set, plus `make`,
`pkg-config`, `perl`, `gperf`, `flex`, `bison`, `cmake` and host zlib and
libpng development packages. `.github/workflows/build.yml` is the reference.

    vdpm zlib bzip2 libpng libjpeg-turbo freetype zstd mbedtls curl-mbedtls expat libvita2d libwebp
    git submodule update --init --recursive
    for s in freetype-woff2 libjpeg-simd curl-http2 quickjs wamr deps netsurf; do
        ./scripts/build-$s.sh
    done
    cmake -B build -DCMAKE_TOOLCHAIN_FILE=$VITASDK/share/vita.toolchain.cmake
    cmake --build build

The result is `build/VitaSurf.vpk`. `VITASURF_DEBUG=1` for
`build-netsurf.sh` with `-DVITASURF_DEBUG=ON` for CMake gives verbose
logging; `VITASURF_NATIVE=1` builds the libraries for the host into
`out/native` to test the scripts.

## Debugging on the device

The log is `ux0:data/VitaSurf/log.txt`. Empty files in `ux0:data/VitaSurf/`
switch on extras: `verbose` for NetSurf's verbose logging, `dumplayout` to
log the first boxes of each page.

## Layout

    CMakeLists.txt        final link, SELF creation, VPK packaging
    scripts/              dependency, NetSurf and patch scripts
    deps/                 NetSurf and its libraries as git submodules
    patches/              every change to upstream code
    vita/surface/         libnsfb surface: display and input polling
    vita/input/           focus, scrolling, buttons, IME
    vita/platform/        paths, logging, networking, heap, entry point
    vita/js/              QuickJS bindings and the JavaScript prelude
    vita/netsurf/         NetSurf Makefile.config for the Vita
    resources/            default Choices, home page, CA bundle, fonts
    sce_sys/              LiveArea assets

## Controls

| Input | Action |
|---|---|
| D-pad | Move focus between links and form fields |
| Cross | Activate the focused element, or click at the pointer |
| Circle | Stop loading, drop focus, close the keyboard |
| Left stick | Scroll |
| Right stick | Move the pointer |
| L / R | Back / forward |
| Triangle | Enter a web address or search terms |
| Square | Reload |
| Select | Toggle pointer mode |
| Start | Menu: bookmarks, history, downloads, files, zoom and settings |
| Front touch | Tap to click, drag to scroll |
| Select + Start | Quit |
