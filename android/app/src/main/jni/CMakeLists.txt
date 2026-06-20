cmake_minimum_required(VERSION 3.18.1)
project(gg-mem C)

add_executable(gg-mem gg-mem.c)

# Link against log only — no STL needed
target_link_libraries(gg-mem log)

# Suppress warnings-as-errors for implicit declarations (syscall wrappers)
target_compile_options(gg-mem PRIVATE
    -O2
    -Wno-implicit-function-declaration
    -Wno-int-conversion
)
