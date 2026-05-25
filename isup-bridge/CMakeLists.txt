cmake_minimum_required(VERSION 3.16)
project(isup-bridge VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# -------------------------------------------------------------------
# Hikvision SDK paths
# -------------------------------------------------------------------
set(HIK_SDK_ROOT "/opt/hikvision-sdk" CACHE PATH "Hikvision SDK root")
set(HIK_INCLUDE_DIR "${HIK_SDK_ROOT}/include")
set(HIK_LIB_DIR     "${HIK_SDK_ROOT}/lib")

# -------------------------------------------------------------------
# Find dependencies
# -------------------------------------------------------------------
find_package(Threads REQUIRED)

# hiredis (Redis C client)
find_library(HIREDIS_LIB hiredis REQUIRED)
find_path(HIREDIS_INCLUDE hiredis/hiredis.h REQUIRED)

# nlohmann/json — header only, bundled or system
find_path(JSON_INCLUDE nlohmann/json.hpp
    PATHS
        /usr/include
        /usr/local/include
        ${CMAKE_SOURCE_DIR}/../third_party/nlohmann
    REQUIRED)

# Hikvision SDK libraries
find_library(HIK_NET_LIB    HCNetSDK    PATHS "${HIK_LIB_DIR}" REQUIRED)
find_library(HIK_HPCNET_LIB hpr         PATHS "${HIK_LIB_DIR}")
find_library(HIK_CRYPTO_LIB crypto      PATHS "${HIK_LIB_DIR}" /usr/lib/x86_64-linux-gnu)
find_library(HIK_SSL_LIB    ssl         PATHS "${HIK_LIB_DIR}" /usr/lib/x86_64-linux-gnu)

# -------------------------------------------------------------------
# Sources
# -------------------------------------------------------------------
set(SOURCES
    src/main.cpp
    src/logger.cpp
    src/redis_client.cpp
    src/event_handler.cpp
    src/command_handler.cpp
    src/isup_server.cpp
)

add_executable(isup-bridge ${SOURCES})

# -------------------------------------------------------------------
# Include dirs
# -------------------------------------------------------------------
target_include_directories(isup-bridge PRIVATE
    ${HIK_INCLUDE_DIR}
    ${HIK_INCLUDE_DIR}/HCNetSDKCom
    ${HIREDIS_INCLUDE}
    ${JSON_INCLUDE}
    src
)

# -------------------------------------------------------------------
# Link
# -------------------------------------------------------------------
target_link_libraries(isup-bridge PRIVATE
    ${HIK_NET_LIB}
    ${HIREDIS_LIB}
    Threads::Threads
    $<$<BOOL:${HIK_CRYPTO_LIB}>:${HIK_CRYPTO_LIB}>
    $<$<BOOL:${HIK_SSL_LIB}>:${HIK_SSL_LIB}>
    dl
)

# SDK .so directory must be in rpath so the binary finds it at runtime
set_target_properties(isup-bridge PROPERTIES
    INSTALL_RPATH "${HIK_LIB_DIR}"
    BUILD_WITH_INSTALL_RPATH TRUE
)

# -------------------------------------------------------------------
# Compile options
# -------------------------------------------------------------------
target_compile_options(isup-bridge PRIVATE
    -Wall
    -Wextra
    -Wno-unused-parameter
    -O2
)

# -------------------------------------------------------------------
# Install
# -------------------------------------------------------------------
install(TARGETS isup-bridge DESTINATION /usr/local/bin)
install(FILES ${CMAKE_SOURCE_DIR}/../config.json
        DESTINATION /etc/hikvision-isup)

message(STATUS "HIK SDK root : ${HIK_SDK_ROOT}")
message(STATUS "hiredis      : ${HIREDIS_LIB}")
message(STATUS "HCNetSDK     : ${HIK_NET_LIB}")
