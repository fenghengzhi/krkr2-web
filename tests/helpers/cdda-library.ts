import { wave } from './audio.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

/** Author-created discs share a track number but have different lengths and tones. */
export function cddaLibraryGame(binary: boolean) {
  const rate = 44100
  return xp3Fixture({
    'startup.tjs': binary
      ? 'Scripts.compileStorage("disc-game.tjs",System.dataPath+"disc-game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"disc-game.cjs");'
      : 'Scripts.execStorage("disc-game.tjs");',
    'disc-game.tjs': String.raw`
var discWindow=new Window(),discRoot=new Layer(discWindow,null),discPlayer=new CDDASoundBuffer(null);
var discButtons=[],discLast="ready",discSaved="none";
discWindow.caption="Two-disc game";discWindow.setInnerSize(300,80);discRoot.setSize(300,80);
discRoot.fillRect(0,0,300,80,0xff182838);
if(Storages.isExistentStorage(System.dataPath+"disc-choice.tjs")) {
  var loaded=[];loaded.load(System.dataPath+"disc-choice.tjs");discSaved=loaded[0];
}
function discSelect(name){
  discPlayer.open(name);discPlayer.looping=true;discPlayer.play();
  discLast=name+":"+discPlayer.totalTime;
  [name].save(System.dataPath+"disc-choice.tjs");discSaved=name;
  discRoot.fillRect(0,60,300,20,discPlayer.totalTime==2000?0xff336699:0xff995533);discWindow.update();
  Debug.message("disc-choice:"+discLast);
}
class DiscButton extends Layer {
  var selected;
  function DiscButton(x,text,name){super.Layer(discWindow,discRoot);selected=name;
    setPos(x,4);setSize(94,52);fillRect(0,0,94,52,0xff285040);font.height=16;
    drawText(6,15,text,0xffffff,255,true);visible=true;}
  function onClick(){global.discSelect(selected);}
}
discButtons.add(new DiscButton(2,"Disc D","D:1"));
discButtons.add(new DiscButton(102,"Disc E","E:1"));
discButtons.add(new DiscButton(202,"Default","1"));
discRoot.visible=true;discWindow.add(discRoot);discWindow.visible=true;discWindow.update();
Debug.message("two-disc-ready:"+discSaved);
`,
    'First/disc.cue': 'FILE "audio.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n',
    'Second/disc.cue': 'FILE "audio.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n',
    'First/audio.wav': wave(Array.from({ length: rate * 2 * 2 }, (_, at) =>
      0.25 * Math.sin(2 * Math.PI * 440 * Math.floor(at / 2) / rate)), rate, 2),
    'Second/audio.wav': wave(Array.from({ length: rate * 3 * 2 }, (_, at) =>
      0.25 * Math.sin(2 * Math.PI * 880 * Math.floor(at / 2) / rate)), rate, 2),
  }).bytes
}
