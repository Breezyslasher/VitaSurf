# CLAUDE.md

## Project

VitaSurf (working name) is a PS Vita port of the NetSurf web browser. It uses NetSurf's framebuffer frontend with a Vita-specific libnsfb surface. JavaScript starts with NetSurf's existing Duktape engine; replacing it with QuickJS is a later phase.

Goal: usable browsing of ordinary sites (docs, wikis, forums, simple interactive pages) at 960x544 with buttons and touch.

Non-goals: heavy single-page web apps, WebGL, and DRM/EME. Do not add, stub, or work around DRM.

License: NetSurf is GPLv2, so this project is GPLv2. Every added library must be GPLv2-compatible (QuickJS is MIT, which is fine).

## Platform constraints

- CPU: 32-bit ARMv7 (Cortex-A9, NEON). Toolchain prefix `arm-vita-eabi-`. The compiler defines `__vita__`.
- Memory is the main constraint. The system has 512 MB total and the app gets only part of it. Set `_newlib_heap_size_user` explicitly, log free memory at startup and after each page load, and treat any unbounded cache as a bug. The newlib heap is sized at startup from the memory then free, less a reserve (`vita/platform/vita_heap.c`), so `_newlib_heap_size_user` is only its fallback. Extended memory mode (`ATTRIBUTE2=12` in the SFO) is verified on hardware and is on in every build (`VITASURF_EXTENDED_MEMORY`, default ON).
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
- QuickJS is built from `deps/libquickjs` (quickjs-ng v0.14.0, the version vdpm ships) by `scripts/build-quickjs.sh`, not taken from vdpm. Stock quickjs-ng keeps a copy of every function's source, nested functions included, which is 35-47% of the memory compiling a large bundle takes; patch 0243 makes a script's functions share one copy. The startup log says which build is in use ("functions share their script's source").
- A page's scripts and modules are compiled with `JS_EVAL_FLAG_LAZY_FUNCTIONS` (patch 0358, `QJS_LAZY` in `vita/js/qjs.c`): the whole script is still parsed, so its syntax errors are reported when it loads, but a function's body gets bytecode only on its first call (`js_lazy_compile`), with the closure variables it was created with. While one is compiled, the functions inside it are skipped to their end, not parsed: the first parse keeps where each body inside a lazy function ends and the names it uses from outside, in its script's source blob (`JSLazyMemo`, patch 0363), so a skip seeks to the end instead of tokenizing the body again at every level of nesting; the tokenizer (`js_lazy_skip_body`) is the fallback for a script read from the cache. Not the prelude, which is kept without its source. Cache entries are serialised when the page goes quiet or closes, so they hold the functions the page called compiled. The load event line in the log says how many functions were compiled on first call and how long that took. To check a compiler change, `scripts/compile-corpus.sh` compares eager bytecode; lazy mode must report the same errors on the corpus.
- WebAssembly runs on WAMR's fast interpreter from `deps/wamr` (2.4.5), built by `scripts/build-wamr.sh` into `libvitawamr.a` with `vita/wasm/glue.c`, which reaches into WAMR's structures and so is built with its settings. The platform layer is `vita/wasm/platform`, picked up through `SHARED_PLATFORM_CONFIG`, so WAMR's tree has no Vita directory. Patch 0246 links imports per instance for the JS API (`vita/js/wasm.c`, `vita/js/wasm.js`).
- The Intl files (`intl_core.js` to `intl.js`) are not in the prelude every page runs: CMake embeds them as a unit of their own, which runs the first time a page touches `Intl` or a locale method (`vita/js/lazy.js` leaves lazy properties in their place; QuickJS's `JS_DefineLazyProperty` is patch 0322). A new install target in a unit needs a row in `lazy.js`. The log says when a unit ran and what touched it ("qjs: intl ... on first use of").
- `Intl.DateTimeFormat` is native, for every locale and calendar ICU has, as V8 has it: `vita/js/intl.js` (V8's reading of the options, SimpleDateFormat), `intl_pattern.js` (ICU's resource fallback, DateTimePatternGenerator, DateFormatSymbols), `intl_zone.js` (ICU's zoneinfo64 and zone names), `intl_calendar.js` (the other calendars, and the algorithmic numbering systems some patterns use) and `intl_range.js` (formatRange, DateIntervalFormat); `vita/js/intl.c` only reads the pack. The data is in `resources/intl.pak`, from the ICU data release `gen-intl-numbers.mjs` takes as its second argument, through `scripts/gen-intl-dates.mjs` and `scripts/gen-intl-zones.mjs`, which read genrb text with `scripts/icu-res.mjs` and ICU's locale fallback tables from `scripts/icu-fallback.json` (`scripts/gen-icu-fallback.mjs` takes them from `localefallback_data.h` in ICU's source). `scripts/gen-intl-tests.mjs` writes `tests/dom/intl-datetimeformat.html`, and its `cases(true)` checks about 140,000 cases under Node. Regenerate the pack and the page together, under the Node whose ICU the data release is, and say which ICU, CLDR and tz versions in the commit.
- `Intl.NumberFormat` and `Intl.PluralRules` are native too (`vita/js/intl_number.js`, on `intl_core.js`), for every locale ICU has, and so are `Intl.RelativeTimeFormat` and `Intl.DisplayNames` (`vita/js/intl_names.js`, on `intl_number.js`); `scripts/gen-intl-names-tests.mjs` writes their page, `tests/dom/intl-names.html`, the same way. `Intl.Locale` is native as well (`vita/js/intl_tags.js`), and every Intl constructor's locales go through its canonical form (CLDR's aliases, as ICU applies them); its `getTimeZones` reads the zone index `scripts/gen-intl-zones.mjs` writes, as ICU enumerates a region's canonical zones, its `getCollations` the types of ICU's collation data, and its `getTextInfo` follows `uloc_isRightToLeft` with CLDR's script metadata; `scripts/gen-intl-tags-tests.mjs` writes `tests/dom/intl-locale.html`, and its `cases(true)` checks every alias and likely-subtags key under Node. `Intl.ListFormat` and `Intl.DurationFormat` are native (`vita/js/intl_list.js`); `scripts/gen-intl-list-tests.mjs` writes `tests/dom/intl-list.html` and must run under a Node with `Intl.DurationFormat` (24 or later) whose ICU has the same CLDR version. `Intl.Collator` and `localeCompare` are native (`vita/js/intl_collator.js`): ICU's root collation and every locale's tailoring, built offline by `scripts/gen-intl-collation.mjs` from the ICU data release whose version Node's ICU has (`icu4c-<version>-data.zip`, passed to `gen-intl-numbers.mjs` as a second argument; without it the pack has no collation and the prelude's code-unit Collator stays). `scripts/gen-intl-collator-tests.mjs` writes `tests/dom/intl-collator.html`, and its `cases(true)` checks every locale and collation type under Node. `Intl.Segmenter` is native (`vita/js/intl_segmenter.js`): `scripts/gen-intl-segmenter.mjs` compiles ICU's break rules (`brkitr/rules`) into state tables the way ICU's rule builder does, with the properties they name from `unidata/ppucd.txt`, and packs ICU's word dictionaries; the runtime is a port of ICU's `handleNext`, break cache and dictionary engines (`dictbe.cpp`). It reads the same ICU data directory, which must hold the whole zip (`brkitr`, `coll`, `locales`, `unidata`). `scripts/gen-intl-segmenter-tests.mjs` writes `tests/dom/intl-segmenter.html`. Their data is `resources/intl.pak`, generated by `scripts/gen-intl-numbers.mjs` from CLDR's JSON packages (at the CLDR version Node's ICU has) and from ICU itself where ICU departs from CLDR's JSON; `intl.c` reads one locale's entry when a page first asks for it. `scripts/gen-intl-number-tests.mjs` writes `tests/dom/intl-numberformat.html` from Node's ICU, and its `cases(true)` holds the implementation against about 55,000 cases under Node. Regenerate the pack and the page together, under the Node whose ICU the CLDR version matches.
- vdpm's curl-mbedtls has no nghttp2, so every https fetch went over HTTP/1.1, six connections to a host at a time, each a TLS handshake of about a second. `scripts/build-curl-http2.sh` builds nghttp2 and the same curl with it over vdpm's copy, with HTTP/2's flow-control windows cut to 2 MB a connection and 1 MB a stream. The fetcher asks for HTTP/2 over TLS, and a host that answers over it gets up to 24 fetches at once as streams on its connection (patch 0362). The page summary's "net:" line says how many transfers came over HTTP/2.
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
6. QuickJS: add QuickJS bindings (a new nsgenbind output or hand-written bindings). Done; the Duktape build was kept for comparison until QuickJS was clearly better, and has been removed.
7. Polish: bundled TrueType font via FreeType, page zoom, downloads, suspend/resume handling.

## Vita gotchas from earlier projects

- TITLE_ID must be exactly 4 uppercase letters followed by 5 digits. A wrong format fails installation at 95-97%.
- Never use `%zu` or other size_t/64-bit format specifiers. They print garbage on the 32-bit Vita. Use `%d` or `%u` with explicit casts.
- Vita3K can pass things that fail on hardware, especially IME and startup initialization. Hardware results are the source of truth.
- ARMv7 needs stricter alignment than x86, and the native harness cannot see it. A struct member wanting 8-byte alignment (a `uint64_t`) makes any cast to that struct from a less-aligned pointer an error under the Vita build's `-Werror=cast-align`, while the same code compiles clean natively because gcc only warns for the host's alignment rules. Check a touched file with `gcc -c -Wcast-align=strict -Werror` before pushing, and prefer two `uint32_t` to one `uint64_t` in a struct reached by a cast.
- IME is fragile. Call `sceCommonDialogSetConfigParam()` before showing dialogs and keep IME buffers static or otherwise long-lived. Some IME initialization changes break app loading, so change IME code carefully and regression-test on hardware.

## Browser-specific notes

- Paths: NetSurf assumes POSIX-style paths. Put all translation to `app0:` and `ux0:` in `vita/platform/`, not scattered through the code.
- Networking: initialize SceNet before any curl call. Point curl at the bundled CA file through NetSurf's `ca_bundle` option. curl has no threaded resolver (vdpm's options), so it must never look a name up itself: `vita/platform/vita_resolve.c` looks hosts up on threads of their own, and the fetcher (patch 0392) and WebSockets hold a connection back until the address is known and hand it to curl with `CURLOPT_RESOLVE`. The log's "dns:" lines say which lookups were slow or failed, and the SceNet error.
- Cookies follow RFC 6265 as browsers do (patch 0396): `document.cookie` neither reads nor writes HttpOnly cookies (`urldb_set_cookie_from_script`), a `Domain` without its leading dot still covers subdomains, and a `Path` that is not the request's is kept. Parsing follows Chrome (patch 0398): a comma does not end a cookie, `Max-Age` wins over `Expires`, and a Secure cookie from a page that is not https, `__Secure-` or `__Host-` without what they need, `SameSite=None` without Secure, and a name and value over 4096 bytes are refused (`tests/cookies/cookie-rules-server.py`). SameSite is not enforced on cross-site requests, and host-only cookies with a path are filed under the request's port. The log's "cookie:" lines name each cookie set or refused and why, and the cookie names a 401, 403, 429 or 503 request sent; never values. `tests/cookies/cookie-server.py` is the test. `urldb_iterate_cookies` visits every path node, not only the leaves (patch 0397), so a host's domain cookies are walked too. The Start menu's "Clear this site's cookies" removes every cookie a request to the page's host would carry and logs each one's name, domain and path.
- Caches: set NetSurf's cache options (such as `memory_cache_size`) low by default and make them configurable.
- Main loop: NetSurf runs a single-threaded scheduler with poll-based fetching. Do not add threads unless there's a measured need. If you add any, set their stack sizes explicitly.
- Rendering: blit only damaged regions reported through libnsfb updates. Avoid uploading the full screen every frame when nothing changed.
- Suspend/resume: network connections drop on resume. Fail in-flight fetches cleanly and allow retry rather than hanging.
- Fonts: bundle a license-compatible TTF (for example DejaVu Sans). Keep NetSurf's internal bitmap font as a fallback.
- Shadow DOM: a shadow root is a libdom DocumentFragment its host owns (patch 0387), so document lookups do not see into it. Box construction, event paths (composed, retargeted) and `isConnected` cross to the host. Each author sheet in the selection context carries the tree its element is in (`css_select_ctx_append_sheet_scoped`, `nscss_tree_scope`), and its rules match only elements of that tree, so page rules stop at shadow roots and a `<link>` sheet in a shadow root styles that tree alone. A shadow tree's `<style>` is rewritten in `prelude.js` under `tag:-vita-host` for a custom element host, or `[data-vs-s~=key]:-vita-host` for a built-in one, so identical sheets are parsed once; only a compound with that marker steps out of the tree, to the first host (patch 0388). `::part()` follows `exportparts` (`part_host` in NetSurf's `css/select.c`).
- Style reads: while the document or a sheet has changed since the boxes were styled (`style_stale` in `vita/js/qjs.c`), getComputedStyle selects again against `html_select_ctx_now`, which parses changed `<style>` text there and then; a sheet whose element has left the document leaves the cascade (patch 0391). A geometry read (offsetWidth, getBoundingClientRect, elementFromPoint, computed width and height) runs the scheduled relayout first (`layout_flush`), but only when the outermost entry into script came from a timer, a fetch or a script element: an event NetSurf dispatches from input keeps pointers into the box tree and form controls, and reads the last layout. A whole-tree rebuild is forced only while the page's last rebuild cost 60 ms or less, and at most 400 ms of forced layout per entry; the IntersectionObserver reads without forcing.
- Input events: a tap sends pointerdown and mousedown on press, then pointerup, mouseup and a click on release, from where the pointer is (`fire_dom_pointer_event`, patch 0394); `html_pointer_current` carries the position to `wrap_event`. Every listener of an event NetSurf dispatches gets one object, which the prelude makes a trusted PointerEvent, MouseEvent, KeyboardEvent or FocusEvent (`__vitaNativeEvent`, kept until `js_event_cleanup`). After a click nothing cancelled, a checkbox or radio NetSurf set gets input and change, and a label, summary or popover button runs its activation in the prelude (`js_activate`, `__vitaActivate`). A click in a frame is the frame document's alone.
- Units: the build uses 96 dpi and a 12pt (16px) default font, as browsers do (`content/handlers/css/css.c`, `desktop/options.h`). NetSurf's 90 dpi made em and rem sizes 15/16 of what pages asked while px came out right, and a rem inside calc() 17px. A variable web font is set to the weight asked for (`font_freetype.c`); its default instance can be its thinnest.

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
