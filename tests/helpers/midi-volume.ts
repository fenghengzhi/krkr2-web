import { midi } from './audio.ts'

// Authored integer controls from MIDIImpl::SetVolume/SetVolume2 and its CC7
// rewrite. The reference files carry the final 7-bit channel value directly.
export const midiVolumeCases = [
  { name: 'full', volume: 100000, volume2: 100000, channel: 100, buffer: 127, output: 100 },
  { name: 'half', volume: 50000, volume2: 100000, channel: 100, buffer: 63, output: 49 },
  { name: 'half-full-channel', volume: 50000, volume2: 100000, channel: 127, buffer: 63, output: 63 },
  { name: 'combined', volume: 33333, volume2: 66667, channel: 100, buffer: 28, output: 22 },
  { name: 'below-full', volume: 99999, volume2: 99999, channel: 100, buffer: 126, output: 99 },
  { name: 'quiet', volume: 790, volume2: 100000, channel: 100, buffer: 1, output: 0 },
  { name: 'quiet-full-channel', volume: 790, volume2: 100000, channel: 127, buffer: 1, output: 1 },
  { name: 'next-step', volume: 1580, volume2: 100000, channel: 100, buffer: 2, output: 1 },
] as const

/** A ten-minute held ordinary SMF note (576000 ticks at the default tempo).
 * Program 48 has no decay in the Web bank;
 * this is a software-instrument control, not a native sound-font assertion. */
export const midiVolumeFile = (cc = 100) => midi([[
  0, 0xc0, 48, 0, 0xb0, 7, cc, 0, 0x90, 69, 100,
  0xa3, 0x94, 0x00, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
]], 480)

export const midiVolumeFiles = () => Object.fromEntries([
  [ 'midi-volume.mid', midiVolumeFile() ],
  ...midiVolumeCases.flatMap((entry) => [
    [`midi-volume-${entry.name}.mid`, midiVolumeFile(entry.channel)],
    [`midi-reference-${entry.name}.mid`, midiVolumeFile(entry.output)],
  ]),
]) as Record<string, Uint8Array>

export const midiVolumePublicExpected = '50000,66667|0,0|100000,100000'
export const midiVolumeSource = String.raw`
System.exitOnNoWindowStartup=false;
class VolumeMidi extends MIDISoundBuffer {
 var completed=0;
 function VolumeMidi(){super.MIDISoundBuffer(null);}
 function onFadeCompleted(){completed++;global.Debug.message("midi-volume-fade:"+completed);}
}
function midiVolumePublicControls(){
 var w=new VolumeMidi(),result,primary,failed=false;
 try{
  w.volume=4295017296;w.volume2=4295033963;result=w.volume+","+w.volume2;
  w.volume=2147483648;w.volume2=-1;result+="|"+w.volume+","+w.volume2;
  w.volume=2147483647;w.volume2=100001;result+="|"+w.volume+","+w.volume2;
 }catch(e){failed=true;primary=e;}
 try{invalidate w;}catch(e){if(failed)Debug.message("midi-volume-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
Debug.message("midi-volume-ready");
`
