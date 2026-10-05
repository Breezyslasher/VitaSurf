# WAMR's interpreter as a static library for the WebAssembly JS API
# (vita/js/wasm.c). scripts/build-wamr.sh configures this for the Vita,
# or natively with VITASURF_NATIVE=1 for the test harness.
#
# Only the fast interpreter: the Vita has no JIT. The proposals browsers
# ship that modern toolchains emit are on (bulk memory, reference types,
# multi-value, sign extension, non-trapping conversions, extended const,
# tail calls); threads, WASI, AOT and the built-in libc are off, because
# a page's module gets its imports from JavaScript.
cmake_minimum_required(VERSION 3.14)
project(vitasurf_wamr C ASM)

set(WAMR_ROOT_DIR ${CMAKE_CURRENT_LIST_DIR}/../../deps/wamr)
set(SHARED_PLATFORM_CONFIG ${CMAKE_CURRENT_LIST_DIR}/platform/shared_platform.cmake)
set(WAMR_BUILD_PLATFORM vita)
if(NOT DEFINED WAMR_BUILD_TARGET)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
        set(WAMR_BUILD_TARGET X86_64)
    elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
        set(WAMR_BUILD_TARGET AARCH64)
    else()
        # the Vita toolchain compiles Thumb-2 with hard float
        set(WAMR_BUILD_TARGET THUMBV7_VFP)
    endif()
endif()

set(WAMR_BUILD_INTERP 1)
set(WAMR_BUILD_FAST_INTERP 1)
set(WAMR_BUILD_AOT 0)
set(WAMR_BUILD_JIT 0)
set(WAMR_BUILD_FAST_JIT 0)
set(WAMR_BUILD_LIBC_BUILTIN 0)
set(WAMR_BUILD_LIBC_WASI 0)
set(WAMR_BUILD_LIB_PTHREAD 0)
set(WAMR_BUILD_THREAD_MGR 0)
set(WAMR_BUILD_SHARED_MEMORY 0)
set(WAMR_BUILD_MULTI_MODULE 0)
set(WAMR_BUILD_BULK_MEMORY 1)
set(WAMR_BUILD_REF_TYPES 1)
set(WAMR_BUILD_TAIL_CALL 1)
set(WAMR_BUILD_EXTENDED_CONST_EXPR 1)
set(WAMR_BUILD_SIMD 0)
set(WAMR_BUILD_MEMORY64 0)
set(WAMR_BUILD_GC 0)
set(WAMR_BUILD_EXCE_HANDLING 0)
set(WAMR_BUILD_MINI_LOADER 0)
# the memory a module declares is the memory it gets
set(WAMR_BUILD_SHRUNK_MEMORY 0)
set(WAMR_BUILD_DUMP_CALL_STACK 0)
set(WAMR_BUILD_INSTRUCTION_METERING 0)

include(${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake)

# glue.c reaches into WAMR's structures, so it is built with its settings
add_library(vitawamr STATIC ${WAMR_RUNTIME_LIB_SOURCE}
    ${CMAKE_CURRENT_LIST_DIR}/glue.c)
target_include_directories(vitawamr PRIVATE ${CMAKE_CURRENT_LIST_DIR})
target_compile_options(vitawamr PRIVATE -O2 -ffunction-sections -fdata-sections)
