# Original Pad/source observations

Status: authored, not executed. No Pad observation is claimed until a hosted run has complete raw records and process evidence. This suite is selected manually as `pad` in `original-runtime.yml`; it uses the existing pinned SDK archive/executable and one owned process per `windows-2022` / `windows-2025`, with a 30-second process deadline. It has no bytecode, Web runtime, browser, or full-regression claim.

`pad-cases.json` is the ordered case inventory and contains static source expectations. `pad-source.json` pins the independent source reference. Neither supplies observed values or decides a case PASS. The original binary's exact source and VCL build remain unknown. The workflow archives and hashes each input, the generated UTF-16LE startup script, original output bytes, SDK versions, runner image metadata, source files, process exit/timeout, and structured records.

## Scope and bounds

- Read all 24 defaults before any setters, including actual font name and OS-selected coordinates. Do not impose DFM coordinates as the oracle.
- Keep at most two Pads, both hidden, and resize to 160 × 120 after the first default snapshot. No game Window, external/global input, screenshot, hook, injection, clipboard, save/open dialog, plugin, giant font/text/geometry, repeated native constructor, or last-reference throwing-finalizer path.
- Sample empty/ASCII/LF/CRLF/lone CR/tail breaks/blank lines/NUL/Unicode text, numeric/void string conversion, bool versus integer font-style conversion, small positive/negative/zero height and size, ordinary RGB, hidden opacity values -1 / 0 / 128 / 255 / 256, valid border/scrollbar enums, small geometry, status text and instance independence.
- File names are assigned only as strings; no save/open method is invoked. Ordinary native logging into the owned temporary project is the only fixture output I/O.
- Exercise direct empty `finalize`, deliberate throwing finalizer during explicit `invalidate`, strongly held object inspection, nonthrowing replacement and retry, then explicit cleanup. The fixture keeps both global Pad references throughout and replaces any deliberate throwing finalizer before terminal cleanup.

## Text and results

Each native event uses `case|id|outcome|resultType|resultUnits|inputType|inputUnits|errorUnits`. Scalar values are converted with TJS `string()` and serialized as decimal UTF-16 units using the original `#(text.charAt(i))` operation. Arrays' lengths are the exact recorded string lengths; empty arrays are empty strings. No logging code-page/newline interpretation is needed. A `returned` record and an `error` record have disjoint payloads.

Text cases also record the actual TJS input units before assignment. A NUL literal might already be truncated by TJS string construction; if so, this case cannot prove where Pad would truncate an embedded NUL. Unicode output is this runner's actual ANSI/RichEdit round trip, not a promise of Unicode preservation. The read-only `GetACP` and `GetDpiForSystem` metadata come from the PowerShell host. Its DPI does not establish SDK process DPI awareness or VCL scaling; actual font height/size pairs answer the latter questions only for sampled values.

Font pair strings are `height,size`; geometry pairs are `width,height` or `left,top`, as recorded in the case inventory. `fontColor` setter completion and subsequent getters expose the source's background getter bug; without a rendering observation, this suite **does not prove the actual painted foreground color**. Opacity values determine which documented compile-time branch these particular distribution bytes exhibit.

## Completeness and retained failures

The parser requires exactly one record for every declared case, unique ids, one start/scenario/mode/version/completion marker, no unknown or malformed lines, no fatal fixture/cleanup error, no timeout, and process exit 0. Both returned values and per-case errors remain observations and are counted separately; neither means conformance. A deliberate finalizer error remains an error record rather than being rewritten as a pass.

Setup failures, missing records, malformed output, timeout, cancellation and unexecuted cases are not successful observations. Raw `native-events.txt`, stdout/stderr/engine logs and `status.json` remain available through `always()` artifact upload. Failed conversion writes its first JSON before schema validation; the `finally` recovery writes `pad-observations.partial.json` separately and preserves the original error. No retries are embedded in this suite.

Only GitHub-hosted Actions may execute these files. The current task intentionally does not commit, push or dispatch them; the parent task reviews and schedules the bounded observations with its next batch.
