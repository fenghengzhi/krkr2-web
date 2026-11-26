import { midi } from './audio.ts'

/** The stock MIDIImpl passes CC126/127 unchanged. Device expectations here
 * follow Microsoft's documented older Windows GS profile, not every WinMM
 * device: https://microsoft.github.io/MIDI/kb/in-box-general-midi-synth/#compatible-mode
 * Reference scores use ordinary note-off/damper/all-sound-off messages and
 * never need the mono/poly implementation to decide their audible notes. */
export type MidiChannelMode = 'poly' | 'mono' | 'sustain' | 'restored'
export function midiChannelModeFile(mode: MidiChannelMode, explicit = false, channel = 0, long = false): Uint8Array {
  const cc = 0xb0 + channel, on = 0x90 + channel, off = 0x80 + channel,
    mono = mode === 'mono' || mode === 'sustain'
  return midi([[
    0, 0xc0 + channel, 80,
    ...(mode !== 'poly' ? [0, cc, explicit ? 120 : 126, 0] : []),
    ...(mode === 'restored' ? [0, cc, explicit ? 120 : 127, 0] : []),
    ...(mode === 'sustain' ? [0, cc, 64, 127] : []),
    0, on, 69, 100,
    ...(mode === 'sustain' ? [10, off, 69, 0, 10] : [20]),
    ...(explicit && mono ? (mode === 'sustain'
      ? [cc, 64, 0, 0, cc, 64, 127, 0]
      : [off, 69, 0, 0]) : []),
    on, 76, 100,
    // A velocity-zero note-on for an unrelated key is a note-off, not a
    // new mono voice. Long game scores keep the two authored notes here.
    10, on, 77, 0,
    ...(long ? [0x87, 0xa9, 0x22] : [0x81, 0x2a]), // remaining 599.85 s / .85 s
    cc, 120, 0, 0, 0xff, 0x2f, 0,
  ]], 100)
}
export function midiLateMonoFile(initialMono = false): Uint8Array {
  return midi([[
    0, 0xc0, 80, ...(initialMono ? [0, 0xb0, 126, 0] : []),
    0, 0x90, 69, 100, 0, 0x90, 76, 100,
    40, 0xb0, 126, 0, 0, 0xff, 0x2f, 0,
  ]], 100)
}
export const midiChannelModeFiles = () => Object.fromEntries(
  (['poly', 'mono', 'sustain', 'restored'] as const).flatMap((mode) => [
    [`${mode}.mid`, midiChannelModeFile(mode)],
    [`${mode}-reference.mid`, midiChannelModeFile(mode, true)],
    [`${mode}-long.mid`, midiChannelModeFile(mode, false, 0, true)],
  ]),
) as Record<string, Uint8Array>

export const midiChannelModeSource = String.raw`
System.exitOnNoWindowStartup=false;
var modeMusic=new MIDISoundBuffer(null), modeStep=0;
function modeStart(name,loop){modeMusic.open(name);modeMusic.looping=loop;modeMusic.play();return modeMusic.status;}
function modeNext(){
 if(modeStep>=3)return;
 modeStep++;
 var names=["poly","mono","sustain","restored"];
 modeStart(names[modeStep]+"-long.mid",false);
 Debug.message("channel-mode-step:"+modeStep+":"+modeMusic.status);
}
function modeMenu(){
 global.modeWindow=new Window();modeWindow.caption="MIDI solo and chord";modeWindow.setInnerSize(160,60);
 var root=new Layer(modeWindow,null);modeWindow.add(root);root.setSize(160,60);root.holdAlpha=false;root.fillRect(0,0,160,60,0xff183048);
 var next=new Layer(modeWindow,root);modeWindow.add(next);next.setPos(0,0,160,60);next.holdAlpha=false;next.fillRect(0,0,160,60,0xff486038);next.visible=true;
 next.onClick=function(){global.modeNext();};
 modeWindow.onKeyDown=function(key,shift){if(key==VK_ESCAPE){global.modeMusic.stop();Debug.message("channel-mode-stopped");}};
 global.modeStart("poly-long.mid",false);modeWindow.visible=true;Debug.message("channel-mode-ready");
}
Debug.message("channel-mode-source-ready");
`
