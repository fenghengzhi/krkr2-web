"""Generate project-owned video frames; requires optional PyAV and NumPy."""
from pathlib import Path
import av
import numpy as np

destination = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'video'
destination.mkdir(parents=True, exist_ok=True)
with av.open(str(destination / 'colors.mp4'), 'w') as output:
    stream = output.add_stream('libx264', rate=12)
    stream.width, stream.height, stream.pix_fmt = 64, 48, 'yuv420p'
    stream.codec_context.colorspace = 1
    stream.codec_context.color_primaries = 1
    stream.codec_context.color_trc = 1
    stream.codec_context.color_range = 1
    stream.options = {'crf': '12', 'preset': 'medium', 'g': '6'}
    for index in range(18):
        image = np.zeros((48, 64, 3), dtype=np.uint8)
        image[:, :, index // 6] = 255
        frame = av.VideoFrame.from_ndarray(image, format='rgb24')
        frame = frame.reformat(format='yuv420p', dst_colorspace='ITU709')
        frame.colorspace = 1
        for packet in stream.encode(frame):
            output.mux(packet)
    for packet in stream.encode():
        output.mux(packet)
print(destination / 'colors.mp4')

# A second movie exercises the media-element audio graph and autoplay unlock.
with av.open(str(destination / 'colors-sound.mp4'), 'w') as output:
    video = output.add_stream('libx264', rate=12)
    video.width, video.height, video.pix_fmt = 64, 48, 'yuv420p'
    video.codec_context.colorspace = 1
    video.codec_context.color_primaries = 1
    video.codec_context.color_trc = 1
    video.codec_context.color_range = 1
    video.options = {'crf': '12', 'preset': 'medium', 'g': '6'}
    audio = output.add_stream('aac', rate=48000)
    audio.layout = 'stereo'
    for index in range(18):
        image = np.zeros((48, 64, 3), dtype=np.uint8)
        image[:, :, index // 6] = 255
        frame = av.VideoFrame.from_ndarray(image, format='rgb24').reformat(format='yuv420p', dst_colorspace='ITU709')
        frame.colorspace = 1
        for packet in video.encode(frame):
            output.mux(packet)
        times = (np.arange(4000) + index * 4000) / 48000
        tone = (.25 * np.sin(2 * np.pi * 440 * times)).astype('float32')
        sound = av.AudioFrame.from_ndarray(np.vstack((tone, tone)), format='fltp', layout='stereo')
        sound.sample_rate = 48000
        sound.pts = index * 4000
        for packet in audio.encode(sound):
            output.mux(packet)
    for stream in (video, audio):
        for packet in stream.encode():
            output.mux(packet)
print(destination / 'colors-sound.mp4')
