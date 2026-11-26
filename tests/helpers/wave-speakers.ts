/** Independent authored speaker impulses. Legacy physical order is taken
 * from fixed WaveImpl.cpp's six-channel conversion, not the product decoder.
 * Stereo expectations use the existing Web mixer policy, not a claim about
 * a Windows device's multichannel/downmix coefficients. */
export const waveSpeakerCases = [
  { name: 'front-left', legacy: [0.5, 0, 0, 0, 0, 0], masked: [0.5, 0, 0, 0, 0, 0], stereo: [0.5, 0] },
  { name: 'front-right', legacy: [0, 0, 0.5, 0, 0, 0], masked: [0, 0.5, 0, 0, 0, 0], stereo: [0, 0.5] },
  { name: 'center', legacy: [0, 0.5, 0, 0, 0, 0], masked: [0, 0, 0.5, 0, 0, 0], stereo: [0.35355339, 0.35355339] },
  { name: 'back-left', legacy: [0, 0, 0, 0.5, 0, 0], masked: [0, 0, 0, 0, 0.5, 0], stereo: [0.35355339, 0] },
  { name: 'back-right', legacy: [0, 0, 0, 0, 0.5, 0], masked: [0, 0, 0, 0, 0, 0.5], stereo: [0, 0.35355339] },
  { name: 'low-frequency', legacy: [0, 0, 0, 0, 0, 0.5], masked: [0, 0, 0, 0.5, 0, 0], stereo: [0, 0] },
] as const

/** Writes interleaved physical channel bytes as supplied. No channel sorting. */
export function speakerWave(rows: readonly (readonly number[])[], options: {
  bits?: 8 | 16 | 24 | 32; floating?: boolean; mask?: number; frames?: number; rate?: number
} = {}): Uint8Array {
  const bits = options.bits ?? 16, floating = options.floating ?? false,
    channels = rows[0]!.length, frames = options.frames ?? rows.length, rate = options.rate ?? 1000,
    extensible = options.mask !== undefined, formatLength = extensible ? 40 : 18,
    dataAt = 20 + formatLength + 8, bytes = new Uint8Array(dataAt + frames * channels * bits / 8),
    view = new DataView(bytes.buffer), tag = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at)
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  view.setUint32(16, formatLength, true); view.setUint16(20, extensible ? 0xfffe : floating ? 3 : 1, true)
  view.setUint16(22, channels, true); view.setUint32(24, rate, true)
  view.setUint32(28, rate * channels * bits / 8, true); view.setUint16(32, channels * bits / 8, true)
  view.setUint16(34, bits, true); view.setUint16(36, extensible ? 22 : 0, true)
  if (extensible) {
    view.setUint16(38, bits, true); view.setUint32(40, options.mask!, true)
    bytes.set([floating ? 3 : 1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 44)
  }
  tag(dataAt - 8, 'data'); view.setUint32(dataAt - 4, bytes.length - dataAt, true)
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const value = rows[frame % rows.length]![channel]!, at = dataAt + (frame * channels + channel) * bits / 8
    if (floating) view.setFloat32(at, value, true)
    else if (bits === 8) bytes[at] = value * 128 + 128
    else if (bits === 16) view.setInt16(at, value * 32768, true)
    else if (bits === 24) {
      const integer = value * 8388608
      bytes[at] = integer & 255; bytes[at + 1] = (integer >> 8) & 255; bytes[at + 2] = (integer >> 16) & 255
    } else view.setInt32(at, value * 2147483648, true)
  }
  return bytes
}

export function waveSpeakerFiles(frames = 32000): Record<string, Uint8Array> {
  return Object.fromEntries(waveSpeakerCases.flatMap((row) => [
    [`${row.name}-legacy.wav`, speakerWave([row.legacy], { frames })],
    [`${row.name}-masked.wav`, speakerWave([row.masked], { frames, mask: 0x3f })],
  ]))
}

export const waveSpeakerSource = String.raw`
System.exitOnNoWindowStartup=false;
var speakerSound=new WaveSoundBuffer(null),speakerSelection=-1;
var speakerNames=["front-left","front-right","center","back-left","back-right","low-frequency"];
function speakerOpen(name){speakerSound.open(name);speakerSound.looping=true;speakerSound.play();return speakerSound.channels+":"+speakerSound.status;}
function speakerNext(){
 speakerSelection++;if(speakerSelection>=12)speakerSelection=0;
 var name=speakerNames[int(speakerSelection/2)]+(speakerSelection%2?"-masked.wav":"-legacy.wav");
 speakerOpen(name);Debug.message("speaker-selection:"+speakerSelection+":"+name);
}
function speakerMenu(){
 global.speakerWindow=new Window();speakerWindow.caption="Speaker routing";speakerWindow.setInnerSize(160,60);
 var root=new Layer(speakerWindow,null);speakerWindow.add(root);root.setSize(160,60);root.holdAlpha=false;root.fillRect(0,0,160,60,0xff102030);
 var next=new Layer(speakerWindow,root);speakerWindow.add(next);next.setPos(0,0,76,60);next.holdAlpha=false;next.fillRect(0,0,76,60,0xff208060);next.visible=true;
 var pause=new Layer(speakerWindow,root);speakerWindow.add(pause);pause.setPos(84,0,76,60);pause.holdAlpha=false;pause.fillRect(0,0,76,60,0xff406080);pause.visible=true;
 next.onClick=function(){global.speakerNext();};pause.onClick=function(){global.speakerSound.paused=!global.speakerSound.paused;global.Debug.message("speaker-pause:"+global.speakerSound.paused);};
 speakerWindow.visible=true;Debug.message("speaker-buttons-ready");
}
Debug.message("speaker-source-ready");
`
