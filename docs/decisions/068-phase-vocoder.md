# 068 — Built-in PhaseVocoder and the WaveSoundBuffer filter chain

Status: implementation frozen after source-review corrections; no execution result is recorded for this slice.
All executable verification belongs on GitHub-hosted Actions runners. Local source
inspection is not a passing test, and earlier audio/Pad/Storages results do not
verify this change.

## Contract and scope

The reference is the `kirikiri2/branches/2.32stable` subtree at
[`dec49af97e174d31059c3ccd7efc700ba3c6b788`](https://github.com/krkrz/krkr2/tree/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable).
`ScriptMgnIntf.cpp` registers `WaveSoundBuffer.PhaseVocoder` directly; it is a
built-in class and belongs to the nonplugin scope. Arbitrary external native
filter interfaces remain outside this slice. The archived source audit lives in
`out/verification/phase-vocoder/contract.md`, with original byte hashes and a
separate UTF-8 reading copy. Its source conclusions are not native PCM observations.

This change uses native TJS class/instance identity for script values and a shared
TypeScript streaming DSP for headless audio and the production AudioWorklet. A
native pointer is never sent through a Web protocol. The read-only `interface`
property is an opaque identifier; only native-slot validation can connect a
PhaseVocoder. A user object that returns the same number cannot impersonate one.

## Script state and connection lifetime

The initial properties are `window=4096`, `overlap=0`, `pitch=1.0`, and `time=1.0`.
Window accepts powers of two from 64 through 32768; overlap accepts 0, 2, 4, 8, 16,
or 32. Native integer conversion precedes the enumerated checks. Pitch and time
are converted to float32 and returned as TJS real values.

Each sound keeps its mutable `filters` Array. `open` snapshots its order and holds
the connected objects strongly. Subsequent Array edits only affect a later open;
the active objects continue to supply live pitch/time/overlap changes. The signal
passes through SLI first and then each filter in array order. Two filters remain
two DSP stages rather than a product of parameters.

Snapshot construction runs on the normal TJS stack. It reads Array count once,
then each indexed value and its `interface` property once in order. A negative
property status skips an unreadable interface; a getter exception propagates.
Getter side effects can change later indexed reads, but cannot extend the fixed
count or bypass the native instance check. Only the completed strong snapshot
crosses the suspended host boundary, which performs no script getter calls.

One instance can have only one connected source, including while its sound is
stopped. Duplicate instances in the same chain and reuse by another open sound
are rejected. Failed construction releases only the new connection attempt.
Unload, reopen, sound retirement, and session shutdown clear the chain. Stop and
seek reset DSP history without releasing filter ownership. Explicit script
invalidation cannot free an instance retained by an active chain.

The native implementation stores a new window immediately but only reads it when
creating a DSP after first decode or reset. This follows `PhaseVocoderFilter.cpp`
and `WaveImpl.cpp`; the older HTML description only mentions open. Ordinary
parameter updates retain already buffered PCM and do not rebuild the window.

## Signal and timeline

Time is a **duration multiplier**. Pitch changes frequency independently, while
`WaveSoundBuffer.frequency` resamples the resulting signal after the chain. For
window N and effective overlap O, the input hop is N/O and output hop is
`trunc(inputHop * float32(time)) & ~1`. Automatic overlap is 2 when time is at most
0.2, 4 through 1.2, and 8 above that. The actual duration ratio is output/input hop.
The property getter still returns the requested float32 value.
Those thresholds compare the stored float32 with the original double literals:
the usual float32 representation of decimal 0.2 lies slightly above 0.2, and that
of 1.2 lies slightly above 1.2. Thus exact decimal input at those boundaries can
select the following overlap tier; this is a source-derived rule, not a newly
measured native observation.

The DSP performs forward FFT, phase-difference frequency analysis, target-bin
gather with linear interpolation of magnitude and frequency, inverse FFT, and
overlap-add through the original Vorbis-I window. Even unity pitch/time goes
through the DSP. JavaScript trigonometric functions and a portable FFT implement
the mathematical algorithm; they do not reproduce the original approximate
scalar/SSE routines bit for bit. No measured native-to-Web error bound is claimed.
Source smooth crossfades retain their two-part geometry and prepared PCM across
reads. Their Float32 output uses JavaScript arithmetic, which can differ by a
sample quantization step from the original integer-PCM ramps or float32 ratio
accumulation; their structural tests are not native sample-equality evidence.

The mixer separates the source decoder cursor, per-stage filtered queues, and
audible output cursor. Filtered-source SLI decode selects and freezes the next
link boundary and decode unit before evaluating that unit's expressions. The
expressions can select later units; they cannot retroactively change the current
unit's link choice or already buffered PCM. The wrapper preserves the original
4N input-ring request boundaries: crossing its end makes two upstream decode
requests, including after a live overlap change. Each fragment is independently
zero padded after a short read. Source-position spans and labels travel with PCM
and are scaled at every stage using cumulative integer endpoint truncation. Labels are
delivered only when the final output consumes their offsets. DSP lookahead must
not advance `samplePosition` or emit an early `onLabel`.

Label offsets deliberately use normalized Web output positions. The fixed source
has a different multi-unit rule: a `Decode(16)` that reads source 0 through 7,
jumps from 8 to 32, and sees label 33 calculates offset 17 by adding both `written`
and the queue's existing length; the actual output offset is 9. Web uses 9 and
adds a read-entry queue baseline when a second ring fragment appends to a nonempty
queue. It does not reproduce the related unsorted-label `Dequeue`/`pop_front`
quirks. This is an explicit, still-open native compatibility difference derived
from the fixed source, not a result calibrated against an executed SDK probe.
The segment scaling rules do not imply complete native label-metadata equivalence.

SLI loop transitions preserve the streaming DSP, including its phase history.
Explicit seek or playback reset discards stale PCM and label queues and changes
the event epoch. Pause retains state without consuming PCM. Gain, pan, fades, and
the device frequency act on the final output. Metadata such as totalTime remains
defined in source samples, rather than the expanded filtered duration.

There is a deliberate seek difference while an individual sound is paused. The
fixed Windows implementation can move only LoopManager while retaining already
buffered device PCM; Web seek clears the old phase/PCM/labels even while paused,
so resuming starts at the requested position. The tests assert this Web behavior,
not an observed equivalence to Windows paused seek. At natural filtered EOF,
consumed labels are queued first, then the public source position returns to zero
and the ended event uses the existing epoch. Filter ownership remains connected.
An explicit post-EOF seek selects a later replay position. Dropped overlap tail
is not reported as played source data.

These SLI decode-unit and natural-EOF position changes apply to the filtered
source path. The existing unfiltered renderer retains its older per-sample link
selection and end-position behavior; aligning those remaining boundaries is
separate work and is not claimed by this slice.
The filtered reader also retains the project's existing expression parser.
Noncanonical forms such as an operand after `++`/`--`, and signed operand tokens,
still differ from the fixed native tokenizer/evaluator and remain a separate
compatibility item.

The reference has no general EOF drain: it pads a short nonempty input request but
stops processing when an input request returns zero real frames, then consumes
only ready complete output hops. The implementation must record this policy and
must not promise `sourceLength * time` output frames or invent a full tail flush.

## Web bounds and protocol

An unconnected object preserves the original unchecked float32 pitch/time
storage. Before connection or processing, the Web execution domain requires
finite positive values and an even output hop from 2 through N. A connected
parameter assignment commits only after the complete audio-chain update is
acknowledged; rejection leaves the previous script setting intact. These checks
are a Web safety boundary, not an assertion that the original setters checked them.
There is no unsafe native NaN/negative/zero-hop reproduction and no silent DSP
bypass, automatic window reduction, or successful truncated substitute.

The native snapshot reads at most 16 Array entries. A session admits at most 256
PhaseVocoder instances, four connected stages per sound, and 16 connected stages
overall. The shared 64 MiB filter storage reservation covers DSP work, input and
output staging, the final two playback blocks, and prepared source crossfades;
the existing decoded-PCM
budget remains independently 128 MiB. Active and pending windows both contribute
to the reservation, so a window change cannot conceal retained larger buffers.

Each 128 output-frame quantum shares a budget of 256 filter feed calls, 262144
source frames, 524288 source-control steps, and 16777216 weighted FFT units
(`channels * N * log2(N)`). Control steps include SLI link searches, label work,
and boundary traversal. Larger headless render requests scale these limits with
their number of quanta. A budget error stops the affected mixer voice and reports
an audio error through the existing Session failure path; it does not silently
bypass a filter. Each timeline queue separately
limits live segments and labels to 4096 entries; these JavaScript objects are
not claimed as part of the DSP byte count.

Worker protocol 19 includes the value-only filter descriptions and ordered
parameter updates. The native manifest and direct runtime require
`nativePhaseVocoder: 1`; older kernels cannot silently omit the class. Existing
TJS ABI 5 and the independent font ABI remain unchanged.

## Verification plan and remaining limits

The first source-review draft had three confirmed defects. A dynamic increase in
output hop retained overlap that the native implementation clears before the
current frame; an expression could change a link choice within an already chosen
SLI decode request; natural filtered EOF retained the last mapped position instead
of returning zero. These review findings are preserved here. Their corrections
and bounded regression definitions are source changes, not passing execution
evidence. No original native unsafe allocation or parameter reproduction is used.
The follow-up review also corrected input-ring fragment request boundaries and
short-read padding, nonempty-queue label baselines, and the independent raw
decoder cursor retained after a prepared smooth crossfade. The label-offset
normalization difference above remains intentional rather than being marked fixed.

The slice defines 81 new Node cases: 18 native identity/snapshot cases, 16 real
Session/VM integration cases, 14 DSP numerical cases, and 33 mixer/timeline cases.
These include known waveforms and independent spectral measurements. Seven new
browser definitions expand to 21 project cases before capability skips. The browser
capture node observes the emitted production mixer module in a real audio graph;
it does not replace AudioContext, the mixer processor, or DSP samples. Application
cases also exercise real Worker startup under Asyncify and supported JSPI with
source and bytecode.

No tests, build, typecheck, browser probe, or native execution have been run
locally. Hosted run IDs, actual case counts, failures, skips, and artifacts will
be appended after the next combined batch. Until then all new cases are unrun.
This slice does not complete all remaining nonplugin KRKR2 compatibility work.
