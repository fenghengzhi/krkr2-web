# KRKR2 PhaseVocoder algorithm reference

The TypeScript `src/engine/media/phase-vocoder.ts`, `audio-filter-chain.ts`,
`audio-segments.ts`, and `filtered-wave-source.ts` adapt the built-in KRKR2
PhaseVocoder, segment queue, and filtered-source loop decoder from
**2.32stable**, fixed upstream commit
[`dec49af97e174d31059c3ccd7efc700ba3c6b788`](https://github.com/krkrz/krkr2/tree/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable).
This project uses W.Dee and contributors' source and algorithm under the
**Kirikiri original license** offered by that revision. This is an altered
implementation, not an original KRKR2 binary or an endorsement by its authors.

Original notice:

```text
Risa [りさ] alias 吉里吉里3 [kirikiri-3]
stands for "Risa Is a Stagecraft Architecture"
Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors
See details of license at "license.txt"
```

The full original license bytes and a separately identified UTF-8 reading copy
are distributed in `public/licenses/phase-vocoder/`; the upstream GPL alternative
is retained there as well. Original source bytes, including their copyright
notices, are preserved in `original/`. Their upstream paths are
`kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/`, with both NAS files under
`cpu/`. These reference files are **not compiled into the application**.

| Original file          | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| PhaseVocoderDSP.cpp    | `1d1dee8ab59dd1730cbd96114396efa16fba2d700c7e8130333b3caa6220f8d5` |
| PhaseVocoderDSP.h      | `aa5afe4d6f1b546f1c6e8335551b9ec6ffb2200dd031e8e10a62004a1e842ec5` |
| PhaseVocoderFilter.cpp | `dbd426f6734293985459c518c1490358c579de73367b9189a5c38521f32cb134` |
| pv_def.nas             | `df2416d0de2c2fcad70cdc1ae765d4b9acdf7a5c1d57dabcfd42e3f5f02fe1c8` |
| pv_sse.nas             | `a7bc565e5b330d5ecb05b4039cc9f8e5b2410fa1c8f50f4edd06ba5731ccdfc9` |
| WaveSegmentQueue.cpp   | `1c090f8bdd4bf3babc293431b8bcb8369f278b57fee39468ce18a0fe8d8a2d61` |
| WaveSegmentQueue.h     | `ebc0ea825b82585b3e9708e0495b8c71dc106325fb0e62f1caf1f38760d7b30c` |
| WaveLoopManager.cpp    | `9bf9d7339317927c82e8f21aa5cd06cce3e3d0fb15fbfc80aa8f0c0001e38a78` |
| WaveLoopManager.h      | `400423c87b938ce5934a306bf43305fac6503c49db9eef7ceff47639cdf97eb8` |

## Adaptation and numeric boundary

- The input/output hop rules, Vorbis-I window, target-bin gather interpolation,
  independent channel phases, output normalization and no-extra-drain EOF policy
  follow the fixed source. Pitch one still performs the FFT pipeline.
- `fft.ts` is a new project-owned radix-2 complex FFT. It does not incorporate
  the NAS real FFT. Its positive forward exponent and normalized negative
  inverse exponent are explicit. The inverse normalization is compensated by
  `N/2` before applying the original rounded synthesis window.
- The adaptation uses JavaScript `Math` trigonometric functions and double
  precision scratch arithmetic, rather than the original scalar/SSE approximate
  trigonometric functions. Input/output storage and parameter setters use
  float32. This is **not a bit-identical native PCM claim**; numerical/native
  comparisons require recorded hosted evidence.
- Source frequency in the phase kernel is measured in bins: the common
  `sampleRate/N` factor in analysis and synthesis cancels. Playback sample-rate
  conversion remains outside the filter.
- Windows and phase/ring buffers allocate lazily on the first nonzero input.
  Each `process` call accepts at most one input hop, performs at most one FFT per
  channel, and returns borrowed output storage. Memory depends on the window
  and channel count, not source duration. Reset clears both history and EOF.
- Pending window changes take effect at reset/first input; pitch/time/overlap
  change future hops. The current and pending windows must both admit a live
  parameter change before it is committed.
- Nonfinite/nonpositive float32 parameters and output hops outside `2..N` are
  rejected before DSP allocation. These are documented Web execution limits,
  not invented native setter bounds. Finite input and finite PCM output are
  also checked. No historical unsafe allocation or stalled-hop reproduction is
  included.
- A final nonzero short input hop is padded to `Hi`; an empty read terminates
  without processing further windows. No additional tail is fabricated. For
  fixed parameters and whole borrowed-hop consumption, output frame count is
  `max(0, ceil(inputFrames/Hi) - N/Hi + 1) * Ho`. This is a deterministic Web
  streaming contract based on the native stop-before-Process path, not a claim
  of measured equivalence for all native consumer request sizes.

All executable verification is restricted to GitHub-hosted Actions. The
presence of reference files or tests does not establish a passing result.
