import { wave } from './audio.ts'

/** Authored RIFF sampler metadata, unrelated to an SLI file. The sampler's
 * inclusive loop is deliberately the middle third of a three-part song. */
export function waveSamplerFile(samples: number[], rate: number, start: number, end: number,
  beforeData = false, invalidCount = false): Uint8Array {
  const pcm = wave(samples, rate, 2), sampler = new Uint8Array(68), view = new DataView(sampler.buffer)
  sampler.set([115, 109, 112, 108]); view.setUint32(4, 60, true)
  view.setUint32(8 + 28, invalidCount ? 2 : 1, true)
  view.setUint32(8 + 44, start, true); view.setUint32(8 + 48, end, true)
  const output = new Uint8Array(pcm.length + sampler.length)
  if (beforeData) { output.set(pcm.subarray(0, 36)); output.set(sampler, 36); output.set(pcm.subarray(36), 104) }
  else { output.set(pcm); output.set(sampler, pcm.length) }
  new DataView(output.buffer).setUint32(4, output.length - 8, true)
  return output
}
export const samplerSmallChannels = [
  [...Array<number>(20).fill(.25), ...Array<number>(20).fill(-.25), ...Array<number>(20).fill(.75)],
  [...Array<number>(20).fill(-.5), ...Array<number>(20).fill(.125), ...Array<number>(20).fill(-.625)],
] as const
const smallSamples = () => samplerSmallChannels[0].flatMap((sample, frame) => [sample, samplerSmallChannels[1][frame]!])
export const samplerSli = (end: number, start: number) => new TextEncoder().encode(
  `#2.00\nLink {From=${end};To=${start};Smooth=False;}\n`)
export function waveSamplerFiles(): Record<string, Uint8Array> {
  const before = waveSamplerFile(smallSamples(), 1000, 20, 39, true),
    after = waveSamplerFile(smallSamples(), 1000, 20, 39),
    invalid = waveSamplerFile(smallSamples(), 1000, 20, 39, true, true)
  return { 'sampler-before.wav': before, 'sampler-after.wav': after, 'sampler-ignored.wav': invalid,
    'sampler-sli.wav': after, 'sampler-sli.wav.sli': samplerSli(60, 40),
    'sampler-empty.wav': before, 'sampler-empty.wav.sli': new TextEncoder().encode('#2.00\n') }
}
export function waveSamplerGameFiles(): Record<string, Uint8Array> {
  const rate = 48000, section = 24000, samples: number[] = []
  for (let frame = 0; frame < section * 3; frame++) {
    const frequency = [500, 1000, 1500][Math.floor(frame / section)]!,
      value = Math.round(16384 * Math.sin(2 * Math.PI * frequency * frame / rate)) / 32768
    samples.push(value, -value)
  }
  const bytes = waveSamplerFile(samples, rate, section, section * 2 - 1, true)
  return { 'sampler-game.wav': bytes, 'sampler-phrase.wav': bytes,
    'sampler-phrase.wav.sli': samplerSli(section * 3, section * 2) }
}
export const waveSamplerSource = String.raw`
System.exitOnNoWindowStartup=false;
class SamplerSound extends WaveSoundBuffer {
 var states=[];
 function SamplerSound(){super.WaveSoundBuffer(null);}
 function onStatusChanged(value){states.add(value);}
}
var samplerSound=new SamplerSound();
function samplerStart(name,loop=true){samplerSound.open(name);samplerSound.looping=loop;samplerSound.play();return samplerSound.status;}
function samplerMenu(){
 global.samplerWindow=new Window();samplerWindow.caption="Whole song and explicit phrase";samplerWindow.setInnerSize(240,60);
 var root=new Layer(samplerWindow,null);samplerWindow.add(root);root.setSize(240,60);root.holdAlpha=false;root.fillRect(0,0,240,60,0xff102030);
 var whole=new Layer(samplerWindow,root),finish=new Layer(samplerWindow,root),phrase=new Layer(samplerWindow,root);
 samplerWindow.add(whole);samplerWindow.add(finish);samplerWindow.add(phrase);
 var buttons=[whole,finish,phrase];for(var i=0;i<3;i++){var b=buttons[i];b.setPos(i*80,0,76,60);b.holdAlpha=false;b.fillRect(0,0,76,60,0xff206040+i*0x101010);b.visible=true;}
 whole.onClick=function(){global.samplerStart("sampler-game.wav",true);global.Debug.message("sampler-whole");};
 finish.onClick=function(){global.samplerSound.samplePosition=36000;global.samplerSound.looping=false;global.Debug.message("sampler-finish");};
 phrase.onClick=function(){global.samplerStart("sampler-phrase.wav",false);global.samplerSound.samplePosition=48000;global.Debug.message("sampler-phrase");};
 samplerStart("sampler-game.wav",true);samplerWindow.visible=true;Debug.message("sampler-menu-ready");
}
Debug.message("sampler-source-ready");
`
