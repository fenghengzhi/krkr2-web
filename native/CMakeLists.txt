cmake_minimum_required(VERSION 3.25)
project(krkr2_web_modules LANGUAGES C CXX)
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with the Emscripten toolchain")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_TEST OFF CACHE BOOL "" FORCE)
set(INSTALL_DOCUMENTATION OFF CACHE BOOL "" FORCE)
set(FMT_TEST OFF CACHE BOOL "" FORCE)
set(FMT_INSTALL OFF CACHE BOOL "" FORCE)
set(TJS_VARIANT "asyncify" CACHE STRING "asyncify or jspi")
if(TJS_VARIANT STREQUAL "jspi")
  add_compile_options(-fwasm-exceptions)
else()
  add_compile_options(-fexceptions)
endif()
add_subdirectory(../third_party/fmt fmt EXCLUDE_FROM_ALL)
add_subdirectory(../third_party/oniguruma oniguruma EXCLUDE_FROM_ALL)
find_package(BISON 3.8.2 REQUIRED)
find_package(Python3 COMPONENTS Interpreter REQUIRED)
set(TJS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/tjs2")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/parser")
foreach(NAME tjs tjsdate tjspp)
  add_custom_command(
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/parser/${NAME}.tab.cpp" "${CMAKE_CURRENT_BINARY_DIR}/parser/${NAME}.tab.hpp"
    COMMAND "${BISON_EXECUTABLE}" "${TJS_ROOT}/bison/${NAME}.y"
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/parser"
    DEPENDS "${TJS_ROOT}/bison/${NAME}.y" VERBATIM)
  list(APPEND PARSERS "${CMAKE_CURRENT_BINARY_DIR}/parser/${NAME}.tab.cpp")
endforeach()
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/parser/tjsDateWordMap.inc"
  COMMAND "${Python3_EXECUTABLE}" "${TJS_ROOT}/script/create_world_map.py" "${CMAKE_CURRENT_BINARY_DIR}/parser/tjsDateWordMap.inc"
  WORKING_DIRECTORY "${TJS_ROOT}/script"
  DEPENDS "${TJS_ROOT}/script/create_world_map.py" VERBATIM)
file(GLOB TJS_SOURCES CONFIGURE_DEPENDS "${TJS_ROOT}/*.cpp")
add_executable(tjs ${TJS_SOURCES} ${PARSERS} "${CMAKE_CURRENT_BINARY_DIR}/parser/tjsDateWordMap.inc" tjs2/bridge.cpp tjs2/scripts.cpp tjs2/bytecode.cpp)
option(KRKR_TEST_ALLOCATION_FAILURES "Build a non-release allocator fault diagnostic" OFF)
if(KRKR_TEST_ALLOCATION_FAILURES)
  target_sources(tjs PRIVATE tjs2/diagnostics/allocation-faults.cpp)
endif()
target_include_directories(tjs PRIVATE "${TJS_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}/parser" tjs2/include ../third_party/boost/include)
target_compile_definitions(tjs PRIVATE BOOST_ALL_NO_LIB TJS_TEXT_OUT_CRLF)
target_link_libraries(tjs PRIVATE fmt::fmt onig)
target_link_options(tjs PRIVATE
  --no-entry
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sEXPORT_NAME=createTjs"
  "-sENVIRONMENT=web,worker,node" "-sALLOW_MEMORY_GROWTH=1"
  "-sSTACK_SIZE=2097152" "-sINITIAL_MEMORY=16777216" "-sMAXIMUM_MEMORY=536870912"
  "-sFILESYSTEM=0" "-sEXPORTED_FUNCTIONS=['_malloc','_free']"
  "-sINCOMING_MODULE_JS_API=['locateFile','wasmBinary']"
  "-sEXPORTED_RUNTIME_METHODS=['ccall','HEAPU8','HEAPU16','HEAPU32']")
if(TJS_VARIANT STREQUAL "jspi")
  target_link_options(tjs PRIVATE -fwasm-exceptions "-sJSPI=1" "-sJSPI_EXPORTS=['krkr_execute','krkr_invoke','krkr_compile']")
elseif(TJS_VARIANT STREQUAL "asyncify")
  target_link_options(tjs PRIVATE -fexceptions "-sDISABLE_EXCEPTION_CATCHING=0" "-sASYNCIFY=1" "-sASYNCIFY_STACK_SIZE=1048576")
else()
  message(FATAL_ERROR "Unknown TJS_VARIANT: ${TJS_VARIANT}")
endif()
set_target_properties(tjs PROPERTIES SUFFIX ".mjs")
