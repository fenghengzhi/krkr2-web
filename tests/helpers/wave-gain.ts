import { wave } from './audio.ts'

/** Independent fixed WaveImpl table entries and integer-control vectors.
 * The input PCM is L=+0.5, R=-0.25; no production gain helper is imported. */
export interface WaveGainCase {
  name: string; volume: number; volume2: number; globalVolume: number; pan: number
  attenuation: readonly [number, number]
  stored?: readonly [number, number, number, number]
}
export const waveGainCases: readonly WaveGainCase[] = [
  { name: 'full', volume: 100000, volume2: 100000, globalVolume: 100000, pan: 0, attenuation: [0, 0] },
  { name: 'half', volume: 50000, volume2: 100000, globalVolume: 100000, pan: 0, attenuation: [-1505, 0] },
  { name: 'same-half-bucket', volume: 50999, volume2: 100000, globalVolume: 100000, pan: 0, attenuation: [-1505, 0] },
  { name: 'previous-bucket', volume: 49999, volume2: 100000, globalVolume: 100000, pan: 0, attenuation: [-1549, 0] },
  { name: 'right', volume: 100000, volume2: 100000, globalVolume: 100000, pan: 50000, attenuation: [0, 1505] },
  { name: 'left', volume: 100000, volume2: 100000, globalVolume: 100000, pan: -50999, attenuation: [0, -1505] },
  { name: 'substep-pan', volume: 100000, volume2: 100000, globalVolume: 100000, pan: -999, attenuation: [0, 0] },
  { name: 'three-controls', volume: 80009, volume2: 75009, globalVolume: 50009, pan: 50000, attenuation: [-2614, 1505] },
  { name: 'truncate-before-silence', volume: 2009, volume2: 99999, globalVolume: 100000, pan: 0, attenuation: [-10000, 0] },
  { name: 'truncate-before-global', volume: 50009, volume2: 99999, globalVolume: 40009, pan: 0, attenuation: [-3606, 0] },
  { name: 'first-bucket', volume: 1999, volume2: 100000, globalVolume: 100000, pan: 0, attenuation: [-10000, 0] },
  { name: 'second-bucket', volume: 2000, volume2: 100000, globalVolume: 100000, pan: 0, attenuation: [-8494, 0] },
  { name: 'narrowed', volume: 4295017296, volume2: 4295067296, globalVolume: 4295067296, pan: 4294992296,
    stored: [50000, 100000, 100000, 25000], attenuation: [-1505, 624] },
]
export const waveGainReadback = (row: WaveGainCase) =>
  [...(row.stored ?? [row.volume, row.volume2, row.globalVolume, row.pan])].join(',')
export const waveGainSamples = (row: WaveGainCase): readonly [number, number] => {
  const amplitude = (db: number) => db <= -10000 ? 0 : 10 ** (db / 2000),
    volume = amplitude(row.attenuation[0]), pan = row.attenuation[1]
  return [Math.fround(0 + 0.5 * volume * (pan > 0 ? amplitude(-pan) : 1)),
    Math.fround(0 + -0.25 * volume * (pan < 0 ? amplitude(pan) : 1))]
}
export const waveGainFiles = () => ({
  'gain.wav': wave(Array.from({ length: 64000 }, (_, at) => at % 2 ? -0.25 : 0.5), 1000, 2),
})
export const waveGainPublicExpected = '50000,100000,100000,25000|0,0,0'
export const waveGainSource = String.raw`
System.exitOnNoWindowStartup=false;
function waveGainPublicControls(){
 var old=WaveSoundBuffer.globalVolume,w=new WaveSoundBuffer(null),result,primary,failed=false,cleanup;
 try{
  w.volume=4295017296;w.volume2=4295067296;WaveSoundBuffer.globalVolume=4295067296;w.pan=4294992296;
  result=[w.volume,w.volume2,WaveSoundBuffer.globalVolume,w.pan].join(",");
  w.volume=4294967295;w.volume2=4294967296;WaveSoundBuffer.globalVolume=-4294967296;
  result+="|"+[w.volume,w.volume2,WaveSoundBuffer.globalVolume].join(",");
 }catch(e){primary=e;failed=true;}
 try{WaveSoundBuffer.globalVolume=old;}catch(e){cleanup=e;}
 try{invalidate w;}catch(e){if(cleanup===void)cleanup=e;else Debug.message("gain-cleanup:"+e.message);}
 if(failed){if(cleanup!==void)Debug.message("gain-cleanup:"+cleanup.message);throw primary;}
 if(cleanup!==void)throw cleanup;return result;
}
var gainSound;
function waveGainStart(){gainSound=new WaveSoundBuffer(null);gainSound.open("gain.wav");gainSound.looping=true;gainSound.play();return gainSound.status;}
function waveGainSet(v,v2,gv,pan){gainSound.volume=v;gainSound.volume2=v2;WaveSoundBuffer.globalVolume=gv;gainSound.pan=pan;return [gainSound.volume,gainSound.volume2,WaveSoundBuffer.globalVolume,gainSound.pan].join(",");}
function waveGainClose(){invalidate gainSound;WaveSoundBuffer.globalVolume=100000;return "closed";}
Debug.message("wave-gain-ready");
`
