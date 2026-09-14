# VitaSurf: PS Vita port of the NetSurf web browser.
#
# CMake only does the final link, SELF creation and VPK packaging. NetSurf
# and its libraries are built by the make-based scripts first:
#
#   ./scripts/build-deps.sh
#   ./scripts/build-netsurf.sh
#   cmake -B build -DCMAKE_TOOLCHAIN_FILE=$VITASDK/share/vita.toolchain.cmake
#   cmake --build build
#
# Licensed under the GNU General Public License version 2.

cmake_minimum_required(VERSION 3.16)

if(NOT DEFINED CMAKE_TOOLCHAIN_FILE)
    if(DEFINED ENV{VITASDK})
        set(CMAKE_TOOLCHAIN_FILE "$ENV{VITASDK}/share/vita.toolchain.cmake"
            CACHE PATH "toolchain file")
    else()
        message(FATAL_ERROR "Set VITASDK or pass -DCMAKE_TOOLCHAIN_FILE=\$VITASDK/share/vita.toolchain.cmake")
    endif()
endif()

project(VitaSurf VERSION 0.1.0 LANGUAGES C)

include("${VITASDK}/share/vita.cmake" REQUIRED)

set(VITA_APP_NAME "VitaSurf")
set(VITA_TITLEID  "VSRF00001")
# APP_VER must be XX.YY
if(PROJECT_VERSION_MAJOR LESS 10)
    set(VITA_VERSION "0${PROJECT_VERSION_MAJOR}.${PROJECT_VERSION_MINOR}${PROJECT_VERSION_PATCH}")
else()
    set(VITA_VERSION "${PROJECT_VERSION_MAJOR}.${PROJECT_VERSION_MINOR}${PROJECT_VERSION_PATCH}")
endif()

option(VITASURF_DEBUG "Verbose logging and debug symbols" OFF)
# The app has about 256 MB of user memory (the startup log shows 114 MB
# free beside a 128 MB heap). 176 MB leaves room for the main thread
# stack, the GPU contexts and the system dialogs.
set(VITASURF_HEAP_MB 176 CACHE STRING "newlib heap size in MB (_newlib_heap_size_user)")
set(VITASURF_BUILD_ID "local" CACHE STRING "Build identifier written to the log (CI run number)")
set(VITASURF_BUILD_SHA "" CACHE STRING "Short commit hash written to the log")
if(VITASURF_BUILD_SHA STREQUAL "")
    execute_process(
        COMMAND git rev-parse --short HEAD
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        OUTPUT_VARIABLE VITASURF_BUILD_SHA
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
    )
    if(VITASURF_BUILD_SHA STREQUAL "")
        set(VITASURF_BUILD_SHA "unknown")
    endif()
endif()
set(VITASURF_STACK_KB 4096 CACHE STRING "main thread stack size in KB")
# Must match the VITASURF_JS_ENGINE scripts/build-netsurf.sh was run with:
# quickjs (default) leaves the js_* symbols for vita/js/qjs.c and
# libquickjs.a (vdpm quickjs-ng), duktape builds NetSurf's engine into
# libnetsurf.a, no uses NetSurf's stub engine.
set(VITASURF_JS_ENGINE "quickjs" CACHE STRING "JavaScript engine: quickjs, duktape or no")
set_property(CACHE VITASURF_JS_ENGINE PROPERTY STRINGS quickjs duktape no)
if(NOT VITASURF_JS_ENGINE MATCHES "^(duktape|quickjs|no)$")
    message(FATAL_ERROR "VITASURF_JS_ENGINE must be duktape, quickjs or no, not '${VITASURF_JS_ENGINE}'")
endif()
set(NETSURF_STAGE "${CMAKE_SOURCE_DIR}/out/netsurf" CACHE PATH
    "Output of scripts/build-netsurf.sh (libnetsurf.a and resources/)")

# Extended memory mode (ATTRIBUTE2=12) is off until basic boot works on
# hardware; enable it with -DVITASURF_EXTENDED_MEMORY=ON afterwards.
option(VITASURF_EXTENDED_MEMORY "Request the extended memory budget" OFF)
set(VITA_MKSFOEX_FLAGS "${VITA_MKSFOEX_FLAGS} -d PARENTAL_LEVEL=1")
if(VITASURF_EXTENDED_MEMORY)
    set(VITA_MKSFOEX_FLAGS "${VITA_MKSFOEX_FLAGS} -d ATTRIBUTE2=12")
endif()

set(NETSURF_LIB "${NETSURF_STAGE}/libnetsurf.a")
if(NOT EXISTS "${NETSURF_LIB}")
    message(FATAL_ERROR "${NETSURF_LIB} not found: run ./scripts/build-deps.sh and ./scripts/build-netsurf.sh first")
endif()

set(SYSROOT "${VITASDK}/arm-vita-eabi")
set(NETSURF_LIBNSFB_SRC "${CMAKE_SOURCE_DIR}/deps/libnsfb")

# ---------------------------------------------------------------------------
# Executable
# ---------------------------------------------------------------------------
add_executable(${PROJECT_NAME}
    vita/platform/vita_main.c
    vita/platform/vita_platform.c
    # newlib's iconv_open() fails for every charset; this replaces it.
    vita/platform/vita_iconv.c
    # NetSurf file table: drive prefixes inside file: URLs.
    vita/platform/vita_file.c
    # SceNet and SceNetCtl bring-up.
    vita/platform/vita_net.c
    # NetSurf download table: files saved under ux0:data/VitaSurf/downloads.
    vita/platform/vita_download.c
    # Optional FlareSolverr client for Cloudflare browser checks.
    vita/platform/vita_flaresolverr.c
    vita/surface/vita.c
    vita/input/vita_input.c
    vita/input/vita_ime.c
    vita/input/vita_menu.c
)
if(VITASURF_JS_ENGINE STREQUAL "quickjs")
    if(NOT EXISTS "${VITASDK}/arm-vita-eabi/include/quickjs.h")
        message(FATAL_ERROR "quickjs.h not found: install it with 'vdpm quickjs-ng'")
    endif()
    # Hand-written QuickJS bindings implementing NetSurf's js.h, plus the
    # JavaScript half of them embedded as a NUL-terminated byte array.
    set(PRELUDE_JS "${CMAKE_SOURCE_DIR}/vita/js/prelude.js")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${PRELUDE_JS}")
    file(READ "${PRELUDE_JS}" PRELUDE_HEX HEX)
    string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," PRELUDE_BYTES "${PRELUDE_HEX}")
    file(WRITE "${CMAKE_BINARY_DIR}/generated/prelude_js.h"
        "/* generated from vita/js/prelude.js */\n"
        "static const unsigned char prelude_js[] = {${PRELUDE_BYTES}0x00};\n")
    target_sources(${PROJECT_NAME} PRIVATE vita/js/qjs.c)
    target_include_directories(${PROJECT_NAME} PRIVATE "${CMAKE_BINARY_DIR}/generated")
endif()

target_include_directories(${PROJECT_NAME} PRIVATE
    vita/platform
    vita/surface
    vita/input
    # vita_input.c uses the framebuffer frontend's headers and NetSurf's
    # html box tree.
    ${CMAKE_SOURCE_DIR}/deps/netsurf/frontends
    ${CMAKE_SOURCE_DIR}/deps/netsurf/include
    # vita_file.c uses NetSurf's utils/file.h.
    ${CMAKE_SOURCE_DIR}/deps/netsurf
    ${CMAKE_SOURCE_DIR}/deps/netsurf/include
    # The surface is compiled against libnsfb's internal headers.
    ${NETSURF_LIBNSFB_SRC}/include
    ${NETSURF_LIBNSFB_SRC}/src
)

# -g keeps line tables in the ELF artifact (they are not loadable, so the
# VPK does not grow) so crash offsets resolve to file:line in CI.
target_compile_options(${PROJECT_NAME} PRIVATE
    -std=gnu99 -Wall -Wextra -Wmissing-prototypes -O2 -g
    -ffunction-sections -fdata-sections
)
target_compile_definitions(${PROJECT_NAME} PRIVATE
    VITASURF_HEAP_MB=${VITASURF_HEAP_MB}
    VITASURF_STACK_KB=${VITASURF_STACK_KB}
    VITASURF_BUILD_ID="${VITASURF_BUILD_ID}"
    VITASURF_BUILD_SHA="${VITASURF_BUILD_SHA}"
    VITASURF_JS_ENGINE="${VITASURF_JS_ENGINE}"
)
if(VITASURF_DEBUG)
    target_compile_definitions(${PROJECT_NAME} PRIVATE VITASURF_DEBUG=1)
endif()

# NetSurf's main() is reached through __wrap_main (vita/platform/vita_main.c).
# libnetsurf.a and libnsfb.a are pulled in whole: NetSurf's object files
# reference each other through operation tables, and libnsfb surfaces
# register themselves with constructors.
# vita-elf-create appends the SCE module data right after the text segment
# and refuses to build when the data segment starts inside that space. The
# gap the linker leaves depends on the text size modulo 64 KB, so some
# builds had a few hundred bytes there. The Vita linker script adds
# __sce_headroom bytes before aligning the data segment ("optional headroom
# for SCE metadata" in the toolchain's patch); 64 KB makes the gap at least
# that in every layout.
target_link_options(${PROJECT_NAME} PRIVATE
    -Wl,--wrap=main
    -Wl,-q
    -Wl,--gc-sections
    # The C runtime reads these two weakly, so --gc-sections is entitled
    # to drop the definitions and leave its own defaults behind. Naming
    # them as link roots keeps them: without this the main thread ran on
    # the 256 KB default stack instead of VITASURF_STACK_KB.
    -Wl,--undefined=sceUserMainThreadStackSize
    -Wl,--undefined=_newlib_heap_size_user
    -Wl,--defsym,__sce_headroom=0x10000
)

set(VITASURF_JS_LIBS)
if(VITASURF_JS_ENGINE STREQUAL "quickjs")
    # quickjs-ng (MIT), from vdpm.
    set(VITASURF_JS_LIBS quickjs)
endif()

target_link_libraries(${PROJECT_NAME}
    -Wl,--whole-archive
    ${NETSURF_LIB}
    ${SYSROOT}/lib/libnsfb.a
    -Wl,--no-whole-archive
    -Wl,--start-group
    css dom hubbub parserutils wapcaplet nsutils nsbmp nsgif svgtiny nspsl nslog utf8proc
    ${VITASURF_JS_LIBS}
    # libcurl pulls in zstd; the mbedTLS package is built with pthread mutexes.
    curl mbedtls mbedx509 mbedcrypto zstd expat
    # libvita2d (MIT) puts the page on screen through the GPU so that the
    # system IME dialog can draw over it.
    vita2d png jpeg freetype z bz2 pthread m
    -Wl,--end-group
    SceGxm_stub
    SceDisplay_stub
    SceCtrl_stub
    SceTouch_stub
    SceAppUtil_stub
    ScePower_stub
    SceSysmodule_stub
    SceNet_stub
    SceNetCtl_stub
    SceCommonDialog_stub
    SceIme_stub
    SceProcessmgr_stub
    SceSysmem_stub
    SceAppMgr_stub
)

# ---------------------------------------------------------------------------
# SELF and VPK
# ---------------------------------------------------------------------------
vita_create_self(eboot.bin ${PROJECT_NAME} UNSAFE)

file(GLOB NETSURF_RESOURCE_FILES "${NETSURF_STAGE}/resources/*")
set(VPK_FILES)
# Bundled DejaVu fonts (Bitstream Vera licence, see resources/fonts/LICENSE).
file(GLOB VITASURF_FONT_FILES "${CMAKE_SOURCE_DIR}/resources/fonts/*.ttf")
foreach(font ${VITASURF_FONT_FILES})
    get_filename_component(name "${font}" NAME)
    list(APPEND VPK_FILES FILE "${font}" "resources/fonts/${name}")
endforeach()
foreach(res ${NETSURF_RESOURCE_FILES})
    get_filename_component(name "${res}" NAME)
    list(APPEND VPK_FILES FILE "${res}" "resources/${name}")
endforeach()

vita_create_vpk(${PROJECT_NAME}.vpk ${VITA_TITLEID} eboot.bin
    VERSION ${VITA_VERSION}
    NAME    ${VITA_APP_NAME}
    FILE sce_sys/icon0.png                        sce_sys/icon0.png
    FILE sce_sys/pic0.png                         sce_sys/pic0.png
    FILE sce_sys/livearea/contents/bg.png         sce_sys/livearea/contents/bg.png
    FILE sce_sys/livearea/contents/startup.png    sce_sys/livearea/contents/startup.png
    FILE sce_sys/livearea/contents/template.xml   sce_sys/livearea/contents/template.xml
    # VitaSurf resources override nothing in NetSurf's set; Choices and the
    # home page are ours, cacert.pem is the Mozilla CA bundle for phase 2.
    FILE resources/Choices                        resources/Choices
    FILE resources/vitasurf.html                  resources/vitasurf.html
    FILE resources/jstest.html                    resources/jstest.html
    FILE resources/cacert.pem                     resources/cacert.pem
    ${VPK_FILES}
)
