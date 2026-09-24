# CLAUDE.md

## Project

VitaSurf (working name) is a PS Vita port of the NetSurf web browser. It uses NetSurf's framebuffer frontend with a Vita-specific libnsfb surface. JavaScript starts with NetSurf's existing Duktape engine; replacing it with QuickJS is a later phase.

Goal: usable browsing of ordinary sites (docs, wikis, forums, simple interactive pages) at 960x544 with buttons and touch.

Non-goals: heavy single-page web apps, WebGL, and DRM/EME. Do not add, stub, or work around DRM.

License: NetSurf is GPLv2, so this project is GPLv2. Every added library must be GPLv2-compatible (QuickJS is MIT, which is fine).

## Platform constraints

- CPU: 32-bit ARMv7 (Cortex-A9, NEON). Toolchain prefix `arm-vita-eabi-`. The compiler defines `__vita__`.
- Memory is the main constraint. The system has 512 MB total and the app gets only part of it. Set `_newlib_heap_size_user` explicitly, log free memory at startup and after each page load, and treat any unbounded cache as a bug. Try extended memory mode (`ATTRIBUTE2=12` in the SFO) only after basic boot works, and verify it on hardware.
- No JIT. Both Duktape and QuickJS are interpreters, so JS performance comes from doing less work, not from engine tricks.
- Screen: 960x544. Front touch reports coordinates at 1920x1088, so divide by 2.
- `app0:` is read-only. All writable data goes under `ux0:data/VitaSurf/`.

## Repository layout (target, adjust as the port takes shape)

```
CLAUDE.md
CMakeLists.txt            final link, SELF creation, VPK packaging
scripts/
  build-deps.sh           cross-build NetSurf libraries into $VITASDK/arm-vita-eabi
  build-netsurf.sh        build the framebuffer frontend for the Vita
deps/                     git submodules: netsurf, buildsystem, libnsfb, libcss,
                          libdom, libhubbub, libparserutils, libwapcaplet, libnsutils,
                          libnsbmp, libnsgif, libnspsl, libutf8proc, libnslog,
                          libsvgtiny, nsgenbind
patches/                  every change to upstream NetSurf code, as patch files
vita/
  surface/                libnsfb Vita surface (framebuffer to screen)
  input/                  buttons, touch, IME
  platform/               SceNet init, memory, paths, suspend/resume
sce_sys/                  icon0.png and LiveArea assets
resources/                NetSurf resources, cacert.pem, default Choices, bundled font
.github/workflows/        CI
```

The scripts do not exist yet. Create them in phase 1.

## Build

- Requires VITASDK with `$VITASDK` set. Install dependencies with vdpm: curl, openssl, zlib, libpng, libjpeg-turbo, freetype, and SDL2 if the surface uses it. Check exact package names in vdpm before scripting them.
- vdpm's FreeType has no brotli, so it refuses every WOFF2 font, and WOFF2 is what the web serves. `scripts/build-freetype-woff2.sh` builds brotli and then FreeType against it, over the top of vdpm's copies. Without it, an icon font renders as the ligature's name: openmediavault and Audiobookshelf both show that.
- vdpm's libjpeg-turbo is built with `-DWITH_SIMD=FALSE`, so every JPEG decodes in plain C. `scripts/build-libjpeg-simd.sh` rebuilds the same version with NEON over vdpm's copy. The startup log says whether NEON is on ("libjpeg SIMD flags").
- NetSurf and its libraries use NetSurf's make-based `buildsystem`, not CMake. Cross-compile them with the Vita toolchain as the host and install into `$VITASDK/arm-vita-eabi`. Confirm variable names (`HOST`, `PREFIX`, `TARGET`) against `deps/buildsystem` before changing scripts.
- Build NetSurf with `TARGET=framebuffer`. Put Vita-specific settings in a `Makefile.config` override instead of editing NetSurf's Makefiles.
- CMake handles only the final link and packaging, via `$VITASDK/share/vita.cmake` (`vita_create_self`, `vita_create_vpk`).
- TITLE_ID: `VSRF00001`.

Expected commands once the scripts exist:

```
./scripts/build-deps.sh
./scripts/build-netsurf.sh
cmake -B build -DCMAKE_TOOLCHAIN_FILE=$VITASDK/share/vita.toolchain.cmake
cmake --build build
```

## Phases

Each phase must work on real hardware before the next one starts.

1. Boot: statically linked framebuffer frontend, JavaScript disabled, renders a bundled local HTML page from `app0:`.
2. Networking: SceNet and SceNetCtl initialized, curl with OpenSSL, bundled `cacert.pem`, HTTPS pages load.
3. Input: D-pad link focus, stick scrolling, touch tap and drag, IME URL entry, back and forward.
4. JavaScript: enable Duktape, then measure memory and page-load time on a fixed set of test pages.
5. Persistence: cookies, history, bookmarks, and Choices under `ux0:data/VitaSurf/`.
6. QuickJS: add QuickJS bindings (a new nsgenbind output or hand-written bindings). Keep the Duktape build working for side-by-side comparison until QuickJS is clearly better.
7. Polish: bundled TrueType font via FreeType, page zoom, downloads, suspend/resume handling.

## Vita gotchas from earlier projects

- TITLE_ID must be exactly 4 uppercase letters followed by 5 digits. A wrong format fails installation at 95-97%.
- Never use `%zu` or other size_t/64-bit format specifiers. They print garbage on the 32-bit Vita. Use `%d` or `%u` with explicit casts.
- Vita3K can pass things that fail on hardware, especially IME and startup initialization. Hardware results are the source of truth.
- ARMv7 needs stricter alignment than x86, and the native harness cannot see it. A struct member wanting 8-byte alignment (a `uint64_t`) makes any cast to that struct from a less-aligned pointer an error under the Vita build's `-Werror=cast-align`, while the same code compiles clean natively because gcc only warns for the host's alignment rules. Check a touched file with `gcc -c -Wcast-align=strict -Werror` before pushing, and prefer two `uint32_t` to one `uint64_t` in a struct reached by a cast.
- IME is fragile. Call `sceCommonDialogSetConfigParam()` before showing dialogs and keep IME buffers static or otherwise long-lived. Some IME initialization changes break app loading, so change IME code carefully and regression-test on hardware.

## Browser-specific notes

- Paths: NetSurf assumes POSIX-style paths. Put all translation to `app0:` and `ux0:` in `vita/platform/`, not scattered through the code.
- Networking: initialize SceNet before any curl call. Point curl at the bundled CA file through NetSurf's `ca_bundle` option.
- Caches: set NetSurf's cache options (such as `memory_cache_size`) low by default and make them configurable.
- Main loop: NetSurf runs a single-threaded scheduler with poll-based fetching. Do not add threads unless there's a measured need. If you add any, set their stack sizes explicitly.
- Rendering: blit only damaged regions reported through libnsfb updates. Avoid uploading the full screen every frame when nothing changed.
- Suspend/resume: network connections drop on resume. Fail in-flight fetches cleanly and allow retry rather than hanging.
- Fonts: bundle a license-compatible TTF (for example DejaVu Sans). Keep NetSurf's internal bitmap font as a fallback.

## Default controls

| Input | Action |
|---|---|
| D-pad | Move focus between links and form fields |
| Left stick | Scroll |
| Cross | Activate focused element |
| Circle | Close dialog or menu |
| L / R | Back / forward |
| Triangle | Open URL bar (IME) |
| Square | Reload |
| Select | Toggle pointer mode (right stick moves a pointer) |
| Start | Menu: bookmarks, history, settings |
| Front touch | Tap to click, drag to scroll |

## Working rules

- NetSurf code is C99. Match NetSurf's style inside its tree and write Vita glue code in C.
- Keep upstream changes minimal. Record each one as a patch in `patches/` or guard it with `#ifdef __vita__`. Never edit submodules without recording the change.
- Log to `ux0:data/VitaSurf/log.txt`. Keep logging cheap and turn off verbose logging in release builds.
- When reporting that something works, say whether it was tested on Vita3K or real hardware.
- Commit messages: short, imperative mood.

## CI and releases

- GitHub Actions using the `vitasdk/vitasdk` Docker image. Build the VPK on every push and attach it to tagged releases.
- Release notes: no emojis or icons anywhere, including headers, tables, and bullets.
