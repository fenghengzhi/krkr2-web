import { wave } from './audio.ts'

export function cddaGame(binary: boolean): Record<string, string | Uint8Array> {
  const rate = 44100, firstFrames = rate * 2, secondFrames = rate
  return {
    'startup.tjs': binary
      ? 'Scripts.compileStorage("disc-player.tjs",System.dataPath+"disc-player.cjs",false,true,false);Scripts.execStorage(System.dataPath+"disc-player.cjs");'
      : 'Scripts.execStorage("disc-player.tjs");',
    'disc-player.tjs': `
System.exitOnNoWindowStartup=false;
var cd=new CDDASoundBuffer(null);
function cdOpen(name){cd.open(name);return [cd.status,cd.totalTime,cd.samplePosition,cd.channels,cd.bits].join(",");}
function cdSeek(ms){cd.position=ms;return cd.samplePosition;}
function cdPlay(loop){cd.looping=loop;cd.paused=false;cd.play();return cd.status;}
Debug.message("disc-player-ready");
`,
    'disc.cue': 'FILE "audio/disc.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n INDEX 01 00:02:00\n',
    // Two distinct stereo signals make a wrong track offset audible even when
    // its time, length and playback status all look plausible.
    'audio/disc.wav': wave(Array.from({ length: (firstFrames + secondFrames) * 2 }, (_, i) =>
      i < firstFrames * 2 ? (i % 2 ? -0.125 : 0.25) : (i % 2 ? 0.375 : -0.5)), rate, 2),
  }
}
