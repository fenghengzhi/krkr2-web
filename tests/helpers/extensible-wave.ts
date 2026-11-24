/** Independently write signed left-aligned PCM. The optional dirty padding
 * exercises decoders that accidentally count padding as signal. */
export function extensibleWave(containerBits: 16 | 24 | 32, bits: number, dirtyPadding = false): Uint8Array {
  const frames = 4800, channels = 2, sampleBytes = containerBits / 8, align = channels * sampleBytes,
    size = frames * align, bytes = new Uint8Array(68 + size), view = new DataView(bytes.buffer),
    text = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset)
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 40, true)
  view.setUint16(20, 0xfffe, true); view.setUint16(22, channels, true)
  view.setUint32(24, 48000, true); view.setUint32(28, 48000 * align, true)
  view.setUint16(32, align, true); view.setUint16(34, containerBits, true)
  view.setUint16(36, 22, true); view.setUint16(38, bits, true); view.setUint32(40, 3, true)
  bytes.set([1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 44)
  text(60, 'data'); view.setUint32(64, size, true)
  for (let i = 0; i < frames * channels; i++) {
    let sample = (i % 2 ? -0.5 : 0.25) * 2 ** (containerBits - 1) + (dirtyPadding ? 2 ** (containerBits - bits) - 1 : 0)
    for (let j = 0; j < sampleBytes; j++) {
      bytes[68 + i * sampleBytes + j] = sample & 255
      sample >>= 8
    }
  }
  return bytes
}

export const wavePrecisionFiles = () => {
  const foreign = extensibleWave(24, 20)
  foreign[59] ^= 1
  return { '12-in-16.wav': extensibleWave(16, 12), '20-in-24.wav': extensibleWave(24, 20),
    '24-in-32.wav': extensibleWave(32, 24), 'foreign-guid.wav': foreign }
}

export const wavePrecisionScript = `
System.exitOnNoWindowStartup=false;
var precisionArmed=false;
class PrecisionWave extends WaveSoundBuffer {
  function PrecisionWave(){super.WaveSoundBuffer(null);}
  function onStatusChanged(s){if(s=="stop" && global.precisionArmed){global.precisionArmed=false;Debug.message("precision-ended");}}
}
var precisionWave=new PrecisionWave();
function precisionOpen(name){precisionWave.open(name);return [precisionWave.bits,precisionWave.channels,
  precisionWave.frequency,precisionWave.totalTime,precisionWave.samplePosition,precisionWave.status].join(",");}
function precisionPlay(){global.precisionArmed=true;precisionWave.play();return "started";}
function precisionError(){try{precisionWave.open("foreign-guid.wav");return "opened";}catch(e){return e.message;}}
Debug.message("precision-ready");
`
export const wavePrecisionGame = (binary: boolean) => ({
  ...wavePrecisionFiles(), 'precision.tjs': wavePrecisionScript,
  'startup.tjs': binary ? 'Scripts.compileStorage("precision.tjs","savedata/precision.cjs",false,true,false);Scripts.execStorage("savedata/precision.cjs");' :
    'Scripts.execStorage("precision.tjs");',
})
