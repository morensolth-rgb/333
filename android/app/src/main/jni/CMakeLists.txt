cmake_minimum_required(VERSION 3.22.1)

project("fridacapture" C)

# ── Source files ──────────────────────────────────────────────────────────────
add_library(
    fridacapture
    SHARED
    capture.c
)

# ── Include directories ───────────────────────────────────────────────────────
target_include_directories(fridacapture PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

# ── Link against Android system libs ─────────────────────────────────────────
find_library(log-lib log)

target_link_libraries(fridacapture
    ${log-lib}
)

# ── Compiler flags ────────────────────────────────────────────────────────────
target_compile_options(fridacapture PRIVATE
    -Wall
    -Wno-unused-parameter
    -O2
    -fvisibility=hidden
)
