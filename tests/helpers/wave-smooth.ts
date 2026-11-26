import { wave } from './audio.ts'

// Authored signed PCM16 values, independently evaluated from stock's Q32
// two-term floors. 8 samples cover 0..50%; 24 cover 50..100% (endpoint excluded).
export const smoothBefore = [16384, 14848, 13312, 11776, 10240, 8704, 7168, 5632]
export const smoothAfter = [4096, 3583, 3071, 2560, 2047, 1535, 1024, 511, -1, -512, -1025, -1537,
  -2048, -2561, -3073, -3584, -4097, -4609, -5120, -5633, -6145, -6656, -7169, -7681]
export const smoothShortAfter = [4096, 1024, -2048, -5120]
export const smoothCycle = [...smoothBefore, ...smoothAfter, ...Array<number>(40).fill(16384)]
export const smoothShortCycle = [...smoothBefore, ...smoothShortAfter, ...Array<number>(20).fill(-8192), ...Array<number>(40).fill(16384)]
export const smoothInside = [16384, 13312, 10240, 7168, ...smoothAfter]
export const smoothSamples = (values: readonly number[]) => values.map((sample) => sample / 32768)

export function waveSmoothFiles(): Record<string, Uint8Array> {
  const bytes = wave(Array.from({ length: 104 }, (_, at) => at < 32 ? -0.25 : 0.5), 1000),
    sidecar = (short: boolean, labels: boolean) => new TextEncoder().encode('#2.00\n' +
      'Link {From=80;To=8;Smooth=True;}\n' +
      (short ? 'Link {From=12;To=0;Condition=eq;CondVar=1;RefValue=1;}\n' : '') +
      (labels ? "Label {Position=76;Name='before';}\nLabel {Position=8;Name='jump';}\nLabel {Position=12;Name='after';}" : ''))
  return { 'smooth.wav': bytes, 'smooth.wav.sli': sidecar(false, true),
    'smooth-short.wav': bytes, 'smooth-short.wav.sli': sidecar(true, true),
    'smooth-listen.wav': bytes, 'smooth-listen.wav.sli': sidecar(false, false),
    'smooth-listen-short.wav': bytes, 'smooth-listen-short.wav.sli': sidecar(true, false) }
}
export const waveSmoothSource = String.raw`
System.exitOnNoWindowStartup=false;
class SmoothSound extends WaveSoundBuffer {
 var labelsSeen=[];
 function SmoothSound(){super.WaveSoundBuffer(null);}
 function onLabel(name){labelsSeen.add(name);}
}
Debug.message("wave-smooth-ready");
`
