# Video presentation and lifetime

`VideoService` owns the TJS `VideoOverlay` objects, settings, layer references and
callback validity. The page-side `WebVideoHost` owns media elements, object URLs,
audio graph connections and video frame callbacks. A dedicated MessagePort
connects them. The video object participates in Window's managed-object lifetime;
explicit invalidation and whole-session stop release its resources.

Overlay mode displays a media element above the game canvas, with geometry
derived from the logical Window size, zoom and layer offset. Mixer mode adds
movie alpha against an explicit background color. Layer mode reads actual RGBA
frames into the engine's existing bitmap model and can update both assigned
layers. Layer dimensions follow the video. This retains TJS pixel access and
the existing WebGL renderer at the cost of a GPU-to-CPU readback.

Frame delivery uses `requestVideoFrameCallback` and the media presentation time.
Only one layer-frame message per video remains unacknowledged; the page transfers
the next frame after the engine has processed the previous one. Slow scripts can
drop visual frames, without accumulating an unbounded pixel queue. Period and
completion events are separate from this visual-frame backpressure. Closing or
replacing a stream changes the playback epoch so obsolete callbacks cannot
overwrite it. Cancel aborts pending media waits, releases sources and lets a
suspended TJS call unwind; an unhandled engine error now uses the same terminal
cleanup path.

MP4 metadata is parsed in the session Worker by pinned `mp4box` 2.4.1. The adapter
validates box/sample budgets, applies edit lists and orders composition times,
including B-frames. Absolute frame seeks and period/segment settings use this
index. Formats without a supported index can still use browser time-based
playback, but frame-index operations fail explicitly. They do not use a guessed
FPS or `presentedFrames` as an absolute frame number. See the primary references:
[MP4Box.js](https://github.com/gpac/mp4box.js/),
[ISO BMFF byte streams](https://www.w3.org/TR/mse-byte-stream-format-isobmff/), and
[video frame callbacks](https://wicg.github.io/video-rvfc/).

Video audio feeds the existing Web Audio output through per-channel gain nodes.
The game's video volume and balance are distinct from Wave global gain; the
player's mute control affects both. Autoplay rejection leaves an explicit
“播放视频” activation button, rather than hanging the script's play call. Session
pause freezes the media element while preserving its logical play state.

The local fixtures are generated H.264 MP4 files, with and without AAC audio.
They exercise B-frames, edit lists, first/tail frames, prepare callbacks, seeks,
two simultaneous layer targets, overlay zoom, mixer alpha, segment/period events,
audio output and shutdown in Chromium, Firefox and WebKit. Explicit BT.709 tags
and a matching RGB-to-YUV conversion are necessary: the original untagged fixture
produced different color matrices in WebKit and the other browsers. Browser
color conversion for arbitrary untagged, wide-gamut or HDR content remains to be
verified.

This is a first video path, not full krmovie compatibility. Remaining work:

- MPEG-I/WMV and other legacy codecs unavailable to the browser; WebCodecs or
  dedicated decoders where required. Flash remains outside this media path.
- WebM/other container frame indexes, complete edit/fragment cases and alternate
  audio/video-track selection. The current backend supports default audio track
  or muting; it does not claim arbitrary track switching.
- `setMixingLayer`, native color-control ranges/filters and full mixer semantics.
- Native event-order differences around prepare, paused seeks and segment-loop
  boundaries. Media-element seeking and compositor callbacks do not guarantee
  sample-accurate or gapless video segment loops.
- Range-backed long videos, caches, frame/readback performance, background policy
  and implicit garbage collection. Imported video bytes are currently loaded
  before open, with a 128 MiB retained-resource budget and 4096-pixel dimensions.

The public behavior reference is
[VideoOverlay](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_VideoOverlay.html);
source inspection also used `VideoOvlIntf.cpp` and `impl/VideoOvlImpl.cpp` in the
adjacent reference checkout. The unchanged KAG Movie class constructs and the
template reaches its first scenario. The subsequent [input implementation](006-input-routing.md)
also runs a short KAG dialogue, history and choice flow. Full video and game
compatibility remain subject to the limitations above.
