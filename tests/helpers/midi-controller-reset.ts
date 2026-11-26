import { midi } from './audio.ts'

/** MIDIImpl.cpp 495–515 resends scaled CC7=100 after in-score CC121;
 * StartPlay 932–953 sends CC121=0. The older Windows GS device preserves
 * channel volume/pan for value 0, resetting them only for a nonzero value:
 * https://microsoft.github.io/MIDI/kb/in-box-general-midi-synth/#compatible-mode
 * These authored scores express that distinction without reading synth state. */
export function midiControllerResetFile(value: 0 | 1, explicit = false, channel = 0): Uint8Array {
  const cc = 0xb0 + channel, on = 0x90 + channel, off = 0x80 + channel
  return midi([[
    0, 0xc0 + channel, 80, 0, cc, 7, 32, 0, cc, 10, 0, 0, cc, 11, 32, 0, on, 69, 100,
    ...(explicit ? [20, cc, 7, 100, 0, cc, 11, 127, ...(value ? [0, cc, 10, 64] : [])] : [20, cc, 121, value]),
    20, off, 69, 0, 0, 0xff, 0x2f, 0,
  ]], 100)
}
export function midiLatePanFile(initialPan?: number): Uint8Array {
  return midi([[
    0, 0xc0, 80, ...(initialPan === undefined ? [] : [0, 0xb0, 10, initialPan]),
    0, 0x90, 69, 100, 40, 0xb0, 10, 0, 0, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
  ]], 100)
}
export const midiControllerFiles = () => ({
  'reset-zero.mid': midiControllerResetFile(0), 'reset-zero-explicit.mid': midiControllerResetFile(0, true),
  'reset-one.mid': midiControllerResetFile(1), 'reset-one-explicit.mid': midiControllerResetFile(1, true),
  'pan-late.mid': midiLatePanFile(), 'pan-explicit.mid': midiLatePanFile(0),
  // Ten-minute held lead, with no score controller that could overwrite a
  // real game button's raw messages during the browser captures.
  'reset-long.mid': midi([[
    0, 0xc0, 80, 0, 0xb0, 7, 32, 0, 0xb0, 10, 0, 0, 0xb0, 11, 32,
    0, 0x90, 69, 100, 0xa3, 0x94, 0x00, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
  ]]),
})

export const midiControllerSource = String.raw`
System.exitOnNoWindowStartup=false;
var controllerMusic=new MIDISoundBuffer(null);
function controllerStart(name,loop){controllerMusic.open(name);controllerMusic.looping=loop;controllerMusic.play();return controllerMusic.status;}
function controllerZero(){MIDISoundBuffer.midiOut(<% b0 79 00 %>);Debug.message("controller-zero");}
function controllerOne(){MIDISoundBuffer.midiOut(<% b0 79 01 %>);Debug.message("controller-one");}
function controllerStop(){controllerMusic.stop();Debug.message("controller-stopped");}
function controllerPlay(){controllerMusic.play();Debug.message("controller-replayed");}
function controllerMenu(){
 global.controllerWindow=new Window();controllerWindow.caption="MIDI stereo controller reset";controllerWindow.setInnerSize(320,60);
 var root=new Layer(controllerWindow,null);controllerWindow.add(root);root.setSize(320,60);root.holdAlpha=false;root.fillRect(0,0,320,60,0xff183048);
 for(var i=0;i<4;i++){
  var b=new Layer(controllerWindow,root);controllerWindow.add(b);b.setPos(i*80,0,78,60);b.holdAlpha=false;
  b.fillRect(0,0,78,60,0xff285038+i*0x101010);b.visible=true;b.action=i;
  b.onClick=function(){if(this.action==0)global.controllerZero();else if(this.action==1)global.controllerOne();else if(this.action==2)global.controllerStop();else global.controllerPlay();};
 }
 global.controllerStart("reset-long.mid",false);controllerWindow.visible=true;Debug.message("controller-menu-ready");
}
Debug.message("controller-source-ready");
`
