cmake_minimum_required(VERSION 3.18.1)
project(gg-mem C)

# Build gg-mem as an executable (not a shared lib)
add_executable(gg-mem gg-mem.c)

# Link against log (Android) — no other deps needed
target_link_libraries(gg-mem log)

# Optimization: small + fast
target_compile_options(gg-mem PRIVATE -O2 -fno-stack-protector)

# Install into assets after build via gradle task (see build.gradle)
