import { wave } from './audio.ts'

export const waveFrequencyExpected = '8000,16000|16000,16000|0,16000|0,16000|8000,0|16000'

/** Pattern samples are exactly representable by the 16-bit source. The long
 * source permits real 4096-frame page crossings; browser tones separately
 * distinguish playback-rate reset from merely storing the public zero. */
export function waveFrequencyFiles(): Record<string, Uint8Array> {
  const pattern = [0.125, -0.25, 0.375, -0.5, 0.625, -0.75, 0.875, -1],
    samples = Array.from({ length: 24000 }, (_, index) => pattern[index % pattern.length]!)
  return {
    'frequency.wav': wave(samples, 8000),
    'frequency-other.wav': wave(samples, 16000),
    'frequency-loop.wav': wave(samples, 8000),
    'frequency-loop.wav.sli': new TextEncoder().encode("#2.00\nLink {From=8200;To=8192;Smooth=False;Condition=no;}\nLabel {Position=8194;Name='loop-mark';}"),
    'frequency-tone.wav': wave(Array.from({ length: 8000 }, (_, i) => 0.25 * Math.sin(2 * Math.PI * i / 16)), 8000),
    'frequency-other-tone.wav': wave(Array.from({ length: 16000 }, (_, i) => 0.25 * Math.sin(2 * Math.PI * 750 * i / 16000)), 16000),
  }
}

/** Also run by the pinned original SDK. Open/property observations need no
 * DirectSound device; actual Web PCM, page and loop checks are separate. */
export const waveFrequencySource = String.raw`
System.exitOnNoWindowStartup=false;
function waveFrequencyObserve(){
  var a=new WaveSoundBuffer(null),b=new WaveSoundBuffer(null),parts=[],result,primary,failed=false,cleanup;
  try{
    a.open("frequency.wav");b.open("frequency-other.wav");parts.add(a.frequency+","+b.frequency);
    a.frequency=16000;parts.add(a.frequency+","+b.frequency);
    a.frequency=0;parts.add(a.frequency+","+b.frequency);
    a.frequency=4294967296;parts.add(a.frequency+","+b.frequency);
    a.frequency=8000;b.frequency=0;parts.add(a.frequency+","+b.frequency);
    a.open("frequency-other.wav");parts.add(a.frequency);result=parts.join("|");
  }catch(e){primary=e;failed=true;}
  try{invalidate a;}catch(e){cleanup=e;}
  try{invalidate b;}catch(e){if(cleanup===void)cleanup=e;else Debug.message("frequency-cleanup:"+e.message);}
  if(failed){if(cleanup!==void)Debug.message("frequency-cleanup:"+cleanup.message);throw primary;}
  if(cleanup!==void)throw cleanup;
  return result;
}
class FrequencySound extends WaveSoundBuffer {
  var markers=[];
  function FrequencySound(){super.WaveSoundBuffer(null);}
  function onLabel(name){markers.add(name);}
}
Debug.message("wave-frequency-ready");
`
