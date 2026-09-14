"""Generate test tones, with no game or third-party music assets.

Optional fixture authoring tool; not part of the engine or npm test runtime.
Requires Python, numpy and soundfile (libsndfile with Vorbis/MPEG support).
"""
from pathlib import Path
import numpy as np
import soundfile as sf

destination = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'audio'
destination.mkdir(parents=True, exist_ok=True)
rate = 44100
samples = np.arange(rate // 4) / rate
tone = .3 * np.sin(2 * np.pi * 440 * samples)
stereo = np.column_stack((tone, tone))
for name, container, subtype in [('tone.ogg', 'OGG', 'VORBIS'), ('tone.mp3', 'MP3', 'MPEG_LAYER_III')]:
    sf.write(destination / name, stereo, rate, format=container, subtype=subtype)
    print(name, sf.info(destination / name))
