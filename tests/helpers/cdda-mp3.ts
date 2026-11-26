import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Mp3Window { name: string; start: number; frames: number; file: string; bytes: number; sha256: string }
export interface Mp3Variant {
  complete: boolean
  name: string; file: string; bytes: number; sha256: string; frames: number
  decodedFrames: number; fullPcmSha256: string; windows: Mp3Window[]
}
export function mp3Reference() {
  const directory = resolve('out/verification/cdda-mp3'), manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as {
    schema: number; complete: boolean; commit: string; rate: number; channels: number; sourceFrames: number; variants: Mp3Variant[]
  }, hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  if (manifest.schema !== 1 || manifest.complete !== true || (process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA) ||
      manifest.rate !== 44100 || manifest.channels !== 2 || manifest.sourceFrames !== 5292137 ||
      manifest.variants.length !== 2 || manifest.variants.map((variant) => variant.name).sort().join(',') !== 'cbr,vbr')
    throw new Error('Incomplete hosted CUE MP3 reference')
  const files = new Map<string, Uint8Array>(), windows = new Map<string, Float32Array[]>()
  for (const variant of manifest.variants) {
    const expectedWindows = new Map<string, readonly [number, number]>([
      ['opening', [0, 88200]], ['change40', [1719900, 88200]], ['track2', [2601900, 132300]],
      ['change80', [3483900, 88200]], ['far100', [4410000, 88200]], ['tail', [5283945, 8192]],
    ] as const)
    if (variant.complete !== true || variant.file !== `${variant.name}.mp3` || variant.windows.length !== expectedWindows.size ||
        variant.decodedFrames !== manifest.sourceFrames || !/^[a-f0-9]{64}$/.test(variant.fullPcmSha256))
      throw new Error('Incomplete hosted MP3 variant: ' + variant.name)
    const bytes = readFileSync(resolve(directory, variant.file))
    if (bytes.length !== variant.bytes || hash(bytes) !== variant.sha256 || variant.frames !== manifest.sourceFrames || !variant.windows.length)
      throw new Error('MP3 fixture differs from hosted reference: ' + variant.name)
    files.set(variant.file, bytes)
    for (const window of variant.windows) {
      const expected = expectedWindows.get(window.name)
      if (!expected || window.start !== expected[0] || window.frames !== expected[1] ||
          window.file !== `${variant.name}-${window.name}.f32`)
        throw new Error('Unexpected MP3 reference window: ' + window.file)
      expectedWindows.delete(window.name)
      const raw = readFileSync(resolve(directory, window.file))
      if (raw.length !== window.bytes || raw.length !== window.frames * 8 || hash(raw) !== window.sha256 ||
          window.start < 0 || window.start + window.frames > variant.frames)
        throw new Error('MP3 reference window differs: ' + window.file)
      windows.set(window.file, [0, 1].map((channel) => Float32Array.from({ length: window.frames },
        (_, frame) => raw.readFloatLE(frame * 8 + channel * 4))))
    }
  }
  return { manifest, files, windows }
}

export const mp3Cue = 'FILE "cbr.mp3" MP3\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n INDEX 01 01:00:00\n' +
  'FILE "vbr.mp3" MP3\n TRACK 03 AUDIO\n INDEX 01 00:00:00\n TRACK 04 AUDIO\n INDEX 01 01:00:00\n'

export const mp3Program = String.raw`
var mp3Music=new CDDASoundBuffer(null),mp3Window=new Window(),mp3Track=0,mp3Serial=0,mp3Pauses=0;
mp3Window.caption="Compressed CD music";mp3Window.setInnerSize(400,60);
function mp3Choose(track){
 mp3Track=track;mp3Music.open("D:"+track);mp3Music.looping=true;mp3Music.paused=false;mp3Music.play();mp3Serial++;
 var state=[mp3Serial,track,mp3Music.status,mp3Music.totalTime].join(":");Debug.message("mp3-choice:"+state);return state;
}
function mp3Seek(){mp3Music.position=40000;Debug.message("mp3-seek:"+mp3Track);}
function mp3Loop(){mp3Music.position=mp3Music.totalTime-100;Debug.message("mp3-loop:"+mp3Track);}
function mp3Menu(){
 var root=new Layer(mp3Window,null);mp3Window.add(root);root.setSize(400,60);root.holdAlpha=false;root.fillRect(0,0,400,60,0xff182030);
 for(var i=0;i<5;i++){
  var key=new Layer(mp3Window,root);mp3Window.add(key);key.holdAlpha=false;key.setPos(i*80,0,76,60);
  key.fillRect(0,0,76,60,[0xff206040,0xff204870,0xff805020,0xff503070,0xff703030][i]);key.visible=true;
  if(i==0)key.onClick=function(){global.mp3Choose(global.mp3Track%4+1);};
  else if(i==1)key.onClick=function(){global.mp3Seek();};
  else if(i==2)key.onClick=function(){global.mp3Music.paused=!global.mp3Music.paused;global.mp3Pauses++;global.Debug.message("mp3-pause:"+global.mp3Pauses+":"+global.mp3Music.paused);};
  else if(i==3)key.onClick=function(){global.mp3Loop();};
  else key.onClick=function(){global.mp3Music.stop();global.Debug.message("mp3-stop:"+global.mp3Music.samplePosition);};
 }
 mp3Window.visible=true;Debug.message("mp3-ready");
}
mp3Menu();
`
export function mp3Game(binary: boolean, files: ReadonlyMap<string, Uint8Array>): Record<string, string | Uint8Array> {
  return { 'startup.tjs': binary
    ? 'Scripts.compileStorage("mp3.tjs",System.dataPath+"mp3.cjs",false,true,false);Scripts.execStorage(System.dataPath+"mp3.cjs");'
    : 'Scripts.execStorage("mp3.tjs");', 'mp3.tjs': mp3Program, 'disc.cue': mp3Cue,
    'cbr.mp3': files.get('cbr.mp3')!, 'vbr.mp3': files.get('vbr.mp3')! }
}
