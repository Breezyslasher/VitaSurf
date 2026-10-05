# The Vita platform layer for WAMR (see platform_internal.h). Picked up
# through SHARED_PLATFORM_CONFIG, so WAMR's tree has no vita directory.

set (PLATFORM_SHARED_DIR ${CMAKE_CURRENT_LIST_DIR})

add_definitions(-DBH_PLATFORM_VITA)

include_directories(${PLATFORM_SHARED_DIR})
include_directories(${SHARED_DIR}/platform/include)

set (PLATFORM_SHARED_SOURCE ${PLATFORM_SHARED_DIR}/vita_platform.c)

file (GLOB header ${SHARED_DIR}/platform/include/*.h)
LIST (APPEND RUNTIME_LIB_HEADER_LIST ${header})
