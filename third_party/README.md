# Vendored sources

The project builds these sources directly. It does not link libraries from the neighboring `kirikiroid2-web` checkout or require vcpkg at build time.

| Directory | Source snapshot | License |
| --- | --- | --- |
| `tjs2/` | `kirikiroid2-web`, revision `6622499f70c3b30240d34d73d757c8adff45248f`, `cpp/core/tjs2/`; original file hashes in `tjs2/source.json` | See `tjs2/LICENSE` and source headers |
| `fmt/` | fmt 11.2.0, local vcpkg source snapshot | `fmt/LICENSE` |
| `oniguruma/` | Oniguruma 6.9.10, local vcpkg source snapshot | `oniguruma/COPYING` |
| `boost/` | Boost 1.88.0 UTF conversion headers and configuration dependency closure | `boost/LICENSE` |

Local changes to the TJS snapshot:

1. `tjsString.h` and `tjsConfig.cpp` include the specific Boost UTF conversion header instead of all Boost.Locale. No Boost binary library is required.
2. `tjsInterCodeExec.cpp` calls `krkr_vm_checkpoint` at instruction dispatch for cooperative scheduling and cancellation.
   Stack tracing in debug mode records owned instruction offsets before checkpoints instead of pointers to C++ stack locals. `tjsDebug.cpp/h` preserve native frame order and try-block collapsing without retaining an unwound Asyncify stack address. Deleting-object warnings are inside the frame cleanup boundary; `tjsError.cpp` preserves primary exceptions if debug output observers fail.
3. `tjsObject.cpp` skips user finalizers only during final whole-VM teardown, as reported by `krkr_vm_is_shutting_down`. Explicit script invalidation is unchanged.
4. The three native exception branches in `tjsInterCodeExec.cpp` preserve the primary exception if a console observer throws during diagnostic disassembly. The new console adapter uses native continuations; `Scripts.dump` temporarily collects the unchanged native dump into its own bounded UTF-16 sink without calling log observers during iteration.
5. `tjsScriptBlock.cpp` registers all four operand forms for compound assignment and increment/decrement bytecode export. The reference snapshot's table registered only the base forms, leaving member/property operands unconverted; the loader already handles all four. Hosted conformance compares source and exported execution across 64 operator/operand combinations.

The native adapter supplies `LogoTrace.h` with reference-project tracing disabled, and copies the reference project's no-op spdlog adapter. Runtime/host errors and user logs are carried by the new structured bridge; these adapters are not implementations of the full logging library.

fmt's `format.h` adds its missing `<cstdlib>` include for the bundled Emscripten/libc++ combination. Unused upstream build/test/docs files are omitted where possible. All required headers, parser grammars, generator inputs and regex sources are present locally.

Project-owned sample scripts and `examples/minimal/background.png` were created for this implementation; the image is a deterministic procedural PNG, with no external art or game assets.

Audio decoding also uses npm-pinned `@wasm-audio-decoders/ogg-vorbis` 0.1.20 and
`@wasm-audio-decoders/common` 9.0.7 from
[wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders), declared MIT.
Their libogg/libvorbis components use BSD-style licenses; the dependency
`codec-parser` 2.5.0 uses LGPL-3.0-or-later. The lockfile fixes all transitive
versions and integrity hashes. Unmodified notices and the codec-parser source
archive are distributed in `public/licenses/`; rebuilding with `npm ci` and
`npm run build` supports replacing the library. No native audio toolchain is
needed to run or build the application.

`tests/fixtures/audio/` contains project-generated sine waves. Its optional
Python authoring script is independent of the engine and regular test suite.

MP4 video metadata uses npm-pinned `mp4box` 2.4.1 from
[GPAC's MP4Box.js](https://github.com/gpac/mp4box.js/), under BSD-3-Clause.
Its notice is included in `public/licenses/mp4box-2.4.1.txt`. The library parses
container metadata in the session Worker; browser media APIs perform decoding.
The H.264/AAC video fixtures are generated test patterns, not game media.

TVP pixel blend arithmetic is adapted in TypeScript from the reference's
`tvpgl.cpp/.h` and `gl/blend_*` sources. W.Dee/contributor and Kenjo notices
are retained in `public/licenses/graphics-notices.txt`. The opt-in native
reference adapter only generates the hashed scalar fixture in
`tests/fixtures/blend-reference.*`; neither it nor the reference graphics
code is linked into the browser application.

The image-processing probe additionally extracts the original CPU box-filter
loop retained in `LayerBitmapIntf.cpp` and links `argb.cpp`. Its metadata records
the minimal ring-buffer/sentinel repairs needed to remove uninitialized reads
from that reference path. The Web implementation uses independent sliding sums;
the probe and extracted C++ code remain outside the shipped application.

The pure TypeScript TLG decoder follows the reference's TLG5/TLG6 algorithms
and SDS container. The same W.Dee/contributor graphics notices apply. Its
optional native probe extracts SaveTLG5/SaveTLG6 only to generate project-owned
pixel fixtures; source hashes, forced filter selection and minimal reference
repairs are recorded in `tests/fixtures/tlg-reference.json`. No native TLG
decoder or encoder is linked into the application.

The image-loading probe calls unmodified TVP scalar key/mask/matte functions;
its hashed fixture is `tests/fixtures/loading-reference.*`. PNG/GIF/BMP samples
are project-owned pixels authored with PyPNG/Pillow by the optional
`scripts/generate-image-fixtures.py`, with tool versions and hashes in
`tests/fixtures/image-reference.json`. Neither Python library is an application
dependency. PNG uses the browser's DecompressionStream; PNG filtering, GIF LZW
and palette retention are implemented in TypeScript from the format rules.

The TypeScript TLG encoders follow the TVP prediction, color-filter and entropy
format rules with their own bounded dictionary search and selection heuristic.
The same graphics notices apply. `tests/probes/image-writing-reference.ts`
extracts unmodified LoadTLG5/6 functions and links TVP kernels only to validate
Web-produced files; its allocator initializes the decoder's extra fetch padding.
PNG output is independently decoded with Pillow. Provenance and output/row hashes
are recorded in `tests/fixtures/image-writing-reference.json`.
