import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Recording { name: string; codec: string; bytes: number; sha256: string; decodedSha256: string }
export function aiffReference() {
  const directory = resolve('out/verification/cdda-aiff'), raw = readFileSync(resolve(directory, 'source.s16le')),
    hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    record = JSON.parse(readFileSync(resolve(directory, 'reference.json'), 'utf8')) as {
      complete: boolean; frames: number; rate: number; channels: number; rawSha256: string; variants: Recording[]
    }
  if (!record.complete || record.frames !== 132300 || record.rate !== 44100 || record.channels !== 2 ||
      raw.length !== record.frames * 4 || hash(raw) !== record.rawSha256 || record.variants.length !== 4)
    throw new Error('Incomplete hosted CD audio reference')
  const expected = new Map([['disc.aiff', 'pcm_s24be'], ['disc-le.aifc', 'pcm_s16le'],
    ['disc-f32.aifc', 'pcm_f32be'], ['disc-f64.aifc', 'pcm_f64be']])
  const files = new Map<string, Buffer>()
  for (const item of record.variants) {
    if (expected.get(item.name) !== item.codec || !expected.delete(item.name))
      throw new Error('Unexpected or duplicate AIFF reference: ' + item.name)
    const bytes = readFileSync(resolve(directory, item.name))
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256 || item.decodedSha256 !== record.rawSha256)
      throw new Error('Hosted AIFF fixture differs: ' + item.name)
    files.set(item.name, bytes)
  }
  return { record, files, raw }
}

export const discCue = 'FILE "music/disc.aiff" AIFF\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n INDEX 01 00:02:00\n' +
  'FILE "music/disc-le.aifc" AIFF\n TRACK 03 AUDIO\n INDEX 01 00:00:00\n TRACK 04 AUDIO\n INDEX 01 00:02:00\n'

const discProgram = String.raw`
var discMusic=new CDDASoundBuffer(null),discWindow=new Window();
discWindow.caption="CD track selection";discWindow.setInnerSize(320,64);
function discChoose(number){
 discMusic.open("D:"+number);discMusic.looping=true;discMusic.paused=false;discMusic.play();
 var result=[number,discMusic.status,discMusic.totalTime,discMusic.bits].join(":");
 Debug.message("cd-choice:"+result);return result;
}
function discMenu(){
 var root=new Layer(discWindow,null);discWindow.add(root);root.setSize(320,64);
 root.holdAlpha=false;root.fillRect(0,0,320,64,0xff101820);
 for(var i=0;i<4;i++){
  var key=new Layer(discWindow,root);discWindow.add(key);key.setPos(i*80,0,76,64);
  key.holdAlpha=false;key.fillRect(0,0,76,64,[0xff104860,0xff784020,0xff306040,0xff605070][i]);
  key.track=i+1;key.onClick=function(){global.discChoose(this.track);};key.visible=true;
 }
 discWindow.visible=true;Debug.message("cd-select-ready");
}
discMenu();
`
export function aiffGame(binary: boolean, files: ReadonlyMap<string, Buffer>): Record<string, string | Uint8Array> {
  return { 'startup.tjs': binary
    ? 'Scripts.compileStorage("disc.tjs",System.dataPath+"disc.cjs",false,true,false);Scripts.execStorage(System.dataPath+"disc.cjs");'
    : 'Scripts.execStorage("disc.tjs");', 'disc.tjs': discProgram, 'disc.cue': discCue,
    'music/disc.aiff': files.get('disc.aiff')!, 'music/disc-le.aifc': files.get('disc-le.aifc')! }
}
