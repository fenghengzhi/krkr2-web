import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Authored canonical WAVE planes. These weights are an explicit statement of
// the existing Web destination policy, independent of vorbisLayout/mixer code.
export const vorbisSpeakerCases = [
  { name: 'five', channels: 5, mask: 0x37, frequencies: [375, 750, 1125, 1500, 1875],
    weights: [[1, 0, .70710678, .70710678, 0], [0, 1, .70710678, 0, .70710678]] },
  { name: 'six-one', channels: 7, mask: 0x70f, frequencies: [375, 750, 1125, 80, 2250, 2625, 3000],
    weights: [[1, 0, .70710678, 0, .5, .70710678, 0], [0, 1, .70710678, 0, .5, 0, .70710678]] },
  { name: 'seven-one', channels: 8, mask: 0x63f, frequencies: [375, 750, 1125, 80, 1500, 1875, 2625, 3000],
    weights: [[1, 0, .70710678, 0, .70710678, 0, .5, 0], [0, 1, .70710678, 0, 0, .70710678, 0, .5]] },
] as const
export type VorbisSpeakerCase = typeof vorbisSpeakerCases[number]
interface Stored { file: string; bytes: number; sha256: string }
interface Reference { complete: boolean; rate: number; samples: number; fixtures: {
  name: string; mask: number; speakers: string[]; decodedStart: number; decodedFrames: number; shortBlock: number
  input: Stored; canonical: Stored; stereo: Stored
}[] }
export function loadVorbisSpeakers(entry: VorbisSpeakerCase) {
  const directory = resolve('out/verification/vorbis-speakers'),
    reference = JSON.parse(readFileSync(resolve(directory, 'reference.json'), 'utf8')) as Reference,
    fixture = reference.fixtures.find((fixture) => fixture.name === entry.name)
  if (!reference.complete || reference.rate !== 48000 || reference.samples !== 96000 || !fixture ||
      fixture.mask !== entry.mask || fixture.speakers.length !== entry.channels ||
      (fixture.decodedStart !== 0 && fixture.decodedStart !== fixture.shortBlock / 2) ||
      fixture.decodedStart + fixture.decodedFrames !== reference.samples)
    throw new Error(`Missing complete independent Vorbis speaker material: ${entry.name}`)
  const read = (stored: Stored) => {
    const bytes = new Uint8Array(readFileSync(resolve(directory, stored.file)))
    if (bytes.length !== stored.bytes || createHash('sha256').update(bytes).digest('hex') !== stored.sha256)
      throw new Error(`Vorbis speaker material changed: ${stored.file}`)
    return bytes
  }, planes = (stored: Stored, channels: number) => {
    const bytes = read(stored), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length !== fixture.decodedFrames * channels * 4) throw new Error('Vorbis reference length differs')
    return Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: fixture.decodedFrames },
      (_, at) => view.getFloat32((at * channels + channel) * 4, true)))
  }
  return { bytes: read(fixture.input), canonical: planes(fixture.canonical, entry.channels), stereo: planes(fixture.stereo, 2),
    decodedStart: fixture.decodedStart, decodedFrames: fixture.decodedFrames }
}
export function mixVorbisReference(entry: VorbisSpeakerCase, data: readonly Float32Array[]): Float32Array[] {
  return entry.weights.map((weights) => Float32Array.from({ length: data[0]!.length }, (_, at) =>
    weights.reduce<number>((sum, weight, channel) => sum + data[channel]![at]! * weight, 0)))
}
export function vorbisSpeakerFiles(): Record<string, Uint8Array> {
  return Object.fromEntries(vorbisSpeakerCases.flatMap((entry) => [
    [`${entry.name}.ogg`, loadVorbisSpeakers(entry).bytes],
    [`${entry.name}.ogg.sli`, new TextEncoder().encode("#2.00\nLink {From=72000;To=24000;Smooth=False;}\nLabel {Position=24000;Name='phrase';}\n")],
  ]))
}
export const vorbisSpeakerSource = String.raw`
System.exitOnNoWindowStartup=false;
var vorbisLabels=0,vorbisSelection=-1,vorbisSerial=0;
class SurroundVorbis extends WaveSoundBuffer {
 function SurroundVorbis(){super.WaveSoundBuffer(null);}
 function onLabel(name){if(name=="phrase")global.vorbisLabels++;}
}
var vorbisMusic=new SurroundVorbis();
function vorbisNext(){
 var names=["five","six-one","seven-one"];vorbisSelection=(vorbisSelection+1)%3;
 vorbisMusic.open(names[vorbisSelection]+".ogg");vorbisLabels=0;vorbisMusic.play();
 Debug.message("vorbis-track:"+(++vorbisSerial)+":"+names[vorbisSelection]);return vorbisMusic.channels+"|"+vorbisMusic.status;
}
function vorbisMenu(){
 global.vorbisWindow=new Window();vorbisWindow.caption="Surround Ogg music";vorbisWindow.setInnerSize(240,60);
 var root=new Layer(vorbisWindow,null);vorbisWindow.add(root);root.setSize(240,60);root.holdAlpha=false;root.fillRect(0,0,240,60,0xff102030);
 var next=new Layer(vorbisWindow,root),pause=new Layer(vorbisWindow,root),seek=new Layer(vorbisWindow,root);
 var buttons=[next,pause,seek];for(var i=0;i<3;i++){var b=buttons[i];vorbisWindow.add(b);b.setPos(i*80,0,76,60);b.holdAlpha=false;b.fillRect(0,0,76,60,0xff206040+i*0x101010);b.visible=true;}
 next.onClick=function(){global.vorbisNext();};
 pause.onClick=function(){global.vorbisMusic.paused=!global.vorbisMusic.paused;global.Debug.message("vorbis-pause:"+global.vorbisMusic.paused);};
 seek.onClick=function(){global.vorbisMusic.samplePosition=70000;global.Debug.message("vorbis-seek:"+global.vorbisSelection);};
 vorbisWindow.onKeyDown=function(key,shift){if(key==27){global.vorbisMusic.stop();global.Debug.message("vorbis-stopped");}};
 vorbisWindow.visible=true;Debug.message("vorbis-menu-ready");
}
Debug.message("vorbis-source-ready");
`
