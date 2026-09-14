# Audio clock and decoding boundary

`SoundService` owns TJS objects and callback validity in the session Worker.
`AudioMixer` is a pure TypeScript renderer shared by the headless backend and
AudioWorklet. Playback state, source sample positions, loop links, labels, pan,
gain and fades advance on rendered audio samples, independently of page frames.

`WaveSoundBuffer` and `MIDISoundBuffer` use this path for actual playback.
`CDDASoundBuffer` can consume an imported audio resource, but physical CD track
names, disc images and CUE mapping remain unimplemented. MIDI uses a procedural
synthesizer with basic instrument families, percussion and controllers; it is
not a General MIDI sample bank or a reproduction of a specific MIDI device.

The page creates and unlocks `AudioContext`, loads the worklet and connects its
output. Session commands travel over a dedicated `MessagePort`; PCM channel
buffers transfer ownership through the page to the worklet. The audio UI offers
explicit activation and mute, so autoplay suspension does not block script
loading. Focus mode maps minimization to document visibility and deactivation
to page focus. Wave global gain/focus mute do not change MIDI/CDDA gain.

WAVE PCM and MIDI parse in TypeScript in the session Worker. Vorbis uses the
pinned `@wasm-audio-decoders/ogg-vorbis` 0.1.20 decoder in that same Worker;
it does not spawn the package's optional worker. The decoder is loaded only
when needed, checks the stream's channel/sample budget, feeds bounded encoded
chunks into preallocated PCM, and frees its WASM instance after decoding.
Other browser-supported encodings use `decodeAudioData` on the page. For MPEG,
Opus and compressed WAVE, recognized source rates select an `OfflineAudioContext`
at that rate; unknown-rate formats cannot use sample-based SLI metadata.

This split follows measured behavior. The generated Vorbis fixture has 11,025
stereo frames at 44,100 Hz. Direct browser decoding returned 10,897 frames in
Chromium/WebKit and 11,025 in Firefox in the local verification run; WebKit's PCM
also differed in alignment. The portable decoder preserves all 11,025 frames
in all three browsers, including a label at frame 11,000. Evidence is in the
audio conformance/browser tests; the exploratory native-decoder report is
`out/verification/audio-codecs.json`. The [Web Audio specification](https://www.w3.org/TR/webaudio/#dom-baseaudiocontext-decodeaudiodata)
requires decoding to resample to the context rate, so output-device rate must
not become the game's source sample clock. Decoder provenance is recorded in
[third-party sources](../../third_party/README.md); its upstream is
[wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders).

SLI links apply at their source positions independently of EOF looping.
Resampling visits intervening labels and links, including flag expressions and
short loops. Indexed `flags` uses a narrow native dispatch proxy so reads,
writes and increments can suspend on the TJS stack until audio acknowledges
them. `labels` preserves dictionary identity until a new stream opens.

Explicit status changes invoke callbacks before the script method returns.
Natural completion, labels and fade completion enter the session event queue;
playback epochs reject events from stopped/replaced streams. Fade steps use
the reference sound buffer's 60 ms beat; individual pause freezes source
position while session pause freezes both playback and fade. Cyclic links and
processor failures reach session diagnostics; shutdown closes ports, the
worklet and AudioContext and releases retained callbacks.

Remaining work includes playback while decoding with backpressure, streaming
seeks, exact native smooth-link/filter behavior, full MIDI timbres/controllers,
CD track mapping, broader codec/channel fixtures, and implicit garbage
collection of sound objects. PCM retained by the mixer is capped at 128 MiB;
decoding/browser allocations have additional transient overhead. Current
loading still prepares the whole stream before playback. Browser-decoded MPEG
and Opus are not claimed to have bit-exact native trimming or PCM alignment.

The public API reference is [WaveSoundBuffer](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_WaveSoundBuffer.html)
and [MIDISoundBuffer](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_MIDISoundBuffer.html).
Reference source inspection used `SoundBufferBaseIntf.cpp`, `WaveIntf.cpp`,
`WaveLoopManager.cpp` and the matching implementation files in the adjacent
checkout. No game music is included; the compressed test tones are generated
by this project's optional fixture-authoring script.
