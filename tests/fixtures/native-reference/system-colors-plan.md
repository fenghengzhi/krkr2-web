# Original SDK System.toActualColor: bounded observation plan

Status: authored, statically reviewed, and **not executed**. No local runtime,
PowerShell, SDK, build, test, browser, or probe was run to prepare this fixture.
This change touches reference fixtures and their hosted workflow only. It does
not implement a Web color resolver or change production/native bridge code.

The manually selected `system-colors` suite in `original-runtime.yml` creates
one owned SDK process on each GitHub-hosted `windows-2022` and `windows-2025`
runner. The existing 30-second process deadline, pinned archive/engine bytes,
explicit project directory, terminal status, and `if: always()` artifact upload
remain in place. Only that owned process can be stopped. There is no input,
window enumeration, keyboard/mouse hook, injection, foreground manipulation,
plugin, theme change, font workload, browser, or allocation stress.

## Inputs and evidence are separate

- `sdk.json` pins the official 2.32r2 distribution and engine bytes. Its exact
  source commit and bundled VCL build are **not assumed**.
- `system-colors-source.json` pins five original source files at
  `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788`, 2.32stable. The workflow
  downloads those raw sources into the artifact, checks each byte count/hash,
  and preserves both expected and actual download metadata. These files are
  read as reference data only and are not compiled or loaded by the SDK.
- `system-colors-cases.json` identifies 97 requested cases and separately labels
  their **static source expectations**. This is an input manifest, never an
  observed result file or a golden answer for unknown VCL behavior.
- `system-colors.tjs` is saved as an actual UTF-16 startup file; both authored
  source and generated startup bytes/hashes are preserved.
- `original-system-colors.ps1` records a separate runner palette and converts
  actual native event records to `system-colors-observations.json`. It does
  not assert or copy the manifest's expected colors into actual records.
- `system-colors.schema.json` describes both actual artifact types. Validation
  occurs on the hosted runner after writing each artifact, so malformed
  structured output is preserved if validation fails.

The artifact contains the case/source manifests, plan, schema, driver, authored
fixture, generated startup, five original raw source files, their hashes,
`system-palette.json`, raw `native-events.txt`, structured observations,
stdout/stderr, native logs, and workflow `status.json`. Run/head SHA, runner
image, OS, PowerShell process architecture, SDK file/product versions, script
version, process ID/exit/timeout state, and all input hashes remain explicit.
The PowerShell process architecture does not identify the SDK architecture.

## Matrix

The 97 cases consist of 25 public constants, 8 ordinary RGB values, 19 high-byte
and index/alias cases, 4 image-marker values passed specifically to
`System.toActualColor`, 14 integer-width cases, 3 conversion cases, 9 method
entry cases, and 15 tiny Layer cases.

High-byte inputs include 01/02/03/04/7f, negative-bit tags 81/ff/c0, different
middle bits with the same low byte, extra/unsupported indices, and unsigned
`0xffffffff`. Signed equivalents, values above 32 bits, integers above 2^53,
and min/max signed 64-bit values record their actual TJS input type/text before
calling the method. JSON keeps these input/result numbers as decimal **strings**
so it never silently rounds a 64-bit value.

Entry cases record missing arguments with used/discarded results, a getter
returning an octet with used/discarded results, object inputs, an extra evaluated
argument, a borrowed non-null receiver, and a null-bound method. Getter reads
are separately counted even when the call errors. The discarded call remains
a real TJS statement in the fixture; a helper does not accidentally request its
result. All return values and caught errors remain observations. A global setup
or logging error is fatal and prevents a complete result.

One private hidden Window owns one 2x2 Layer. Each pixel case resets it to raw
ARGB `0x57112233` and province zero, then samples main RGB, mask, and province at
(0,0). Cases distinguish `fillRect(clWindow)` under dfOpaque with each holdAlpha
value, dfAlpha, and dfAddAlpha; `setMainPixel` with clWindow and a high-byte 01
value; `colorRect` positive/zero/negative opacity branches; and mask/province
operations. No font or image decode is needed. The fixed source's dfMask
colorRect Boolean expression is recorded without silently correcting it.
A zero-opacity pixel result cannot itself prove whether a resolver was called.

## Native record format and completeness

The UTF-16/BOM native Array.save output contains exactly one record per case:

```text
case|id|outcome|inputType|inputText|resultType|resultText|effectCount|errorMessageEscaped
```

`outcome` is `returned` or `error`. Error text uses native TJS `String.escape()`
only to keep it on one physical line. The converter keeps that escaped string
without pretending it is JSON text or reversing unknown escaping. The error
field is last and may contain `|`; earlier fields in this fixed matrix cannot.
For Layer records, `resultText` is `mainRgbDecimal,maskDecimal,provinceDecimal`.
The original event bytes remain authoritative, with line numbers and a hash
linking the structured records back to them.

`observed` requires a zero process exit, no timeout, the source-mode/start/
scenario/version headers, one completion marker, exactly the requested IDs,
and no malformed, duplicate, missing, extra, or fatal records. A caught per-case
conversion error is still a valid recorded observation; it does not turn an
unknown input into an assumed successful color. Completion means the requested
matrix ran, **not** that it matches a Web implementation or every source
expectation. Result values are compared separately after the run.

Failure paths preserve partial native events and, once the driver is loaded,
write `incomplete` or `not-run` to a separate
`system-colors-observations.partial.json` where possible. This never overwrites
the first structured output, including a schema failure. A secondary
conversion failure is recorded separately and does not replace the original
failure. An interrupted, failed, queued, or unexecuted run is never a pass.
Existing modal/menu/dialog artifacts and historical results remain unchanged.

## Independent Win32 palette and later comparison

The only P/Invoke is read-only
[GetSysColor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsyscolor)
for indices 0 through 24 before SDK launch. Each entry preserves the original
DWORD/COLORREF as BGR hexadecimal/decimal, its red/green/blue channels, and the
explicit swapped `0xRRGGBB` value. This describes the current hosted runner,
not a timeless Windows palette and not the SDK's internal VCL algorithm.

After execution, compare all public constant results with that runner's RGB
entries, ordinary RGB identity, signed/unsigned/64-bit low-word pairs, high-byte
01/02/03/04 R/B behavior, middle-bit aliases, and invalid-index observations.
Then compare the small Layer results with the corresponding actual method
values and raw ARGB/byte cases. Record agreements and differences rather than
changing the fixture's unknown expectations into fake observed output.

This first reference suite executes TJS **source only**. It does not claim
original-SDK bytecode, Web bytecode, browser, drawText, loading color-key, live
theme-change, or full 32-bit-input coverage. Those remain separate work. The
candidate is frozen for review before any commit, push, or manual dispatch.
