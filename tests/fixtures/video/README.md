# Generated video fixture

`colors.mp4` is a project-generated 64 × 48 H.264 video: 18 frames at 12 fps,
with red, green and blue spans of six frames each. It contains B-frames and an
MP4 edit list. BT.709 primaries, transfer characteristics and YUV matrix are
explicitly tagged, and the RGB-to-YUV conversion uses the same matrix.

`colors-sound.mp4` adds a project-generated stereo 440 Hz tone encoded as AAC,
to test video audio gain, balance, activation and cleanup.

Regenerate with `scripts/generate-video-fixtures.py` using optional PyAV and
NumPy. Regular tests use the checked-in file and need no native encoder.
