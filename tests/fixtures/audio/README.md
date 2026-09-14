# Generated audio fixtures

`tone.ogg` and `tone.mp3` encode the same 250 ms, 440 Hz sine wave, stereo at
44,100 Hz. They contain no game assets or recorded performances.

Regenerate with `scripts/generate-audio-fixtures.py` using Python, NumPy and
SoundFile. The encoded files are checked in, so running the test suite does not
require Python or native encoders. Codec output bytes may vary with libsndfile
versions; tests verify sample rate, sound output and event positions.
