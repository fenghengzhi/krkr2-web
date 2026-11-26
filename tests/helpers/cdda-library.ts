import { readFileSync } from 'node:fs'
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
discWindow.caption="Two-disc game";discWindow.setInnerSize(400,80);discRoot.setSize(400,80);discRoot.holdAlpha=false;
discRoot.fillRect(0,0,400,80,0xff182838);
if(Storages.isExistentStorage(System.dataPath+"disc-choice.tjs")) {
  var loaded=[];loaded.load(System.dataPath+"disc-choice.tjs");discSaved=loaded[0];
}
function discSelect(name){
  discPlayer.open(name);discPlayer.looping=true;discPlayer.play();
  discLast=name+":"+discPlayer.totalTime;
  [name].save(System.dataPath+"disc-choice.tjs");discSaved=name;
  discRoot.fillRect(0,60,400,20,discPlayer.totalTime==2000?0xff336699:0xff995533);discWindow.update();
  Debug.message("disc-choice:"+discLast);
}
class DiscButton extends Layer {
  var selected;
  function DiscButton(x,text,name){super.Layer(discWindow,discRoot);selected=name;
    setPos(x,4);setSize(94,52);holdAlpha=false;fillRect(0,0,94,52,0xff285040);font.height=16;
    drawText(6,15,text,0xffffff,255,true);visible=true;}
  function onClick(){
    var track=selected;
    if(track=="lookup"){
      var drive=Storages.searchCD("kiriKiri_disc"),music=Storages.searchCD("Game Music"),absent=Storages.searchCD("unrelated album title");
      if((drive!=="D" && drive!=="E") || (music!=="D" && music!=="E") || drive===music || absent!=="")
        throw new Exception("Disc label lookup failed: "+[drive,music,absent].join("|"));
      Debug.message("disc-labels:"+drive+"|"+music);track=drive+":1";
    }
    global.discSelect(track);
  }
}
discButtons.add(new DiscButton(2,"Disc D","D:1"));
discButtons.add(new DiscButton(102,"Disc E","E:1"));
discButtons.add(new DiscButton(202,"Default","1"));
discButtons.add(new DiscButton(302,"Find disc","lookup"));
discRoot.visible=true;discWindow.add(discRoot);discWindow.visible=true;discWindow.update();
Debug.message("two-disc-ready:"+discSaved);
`,
    'First/disc.cue': 'FILE "audio.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n',
    'Second/disc.cue': 'TITLE "unrelated album title"\nFILE "audio.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n' +
      'FILE "data.iso" BINARY\n TRACK 02 MODE1/2048\n INDEX 01 00:00:00\n',
    'Second/data.iso': readFileSync(new URL('../../out/verification/disc-volumes/joliet.iso', import.meta.url)),
    'First/audio.wav': wave(Array.from({ length: rate * 2 * 2 }, (_, at) =>
      0.25 * Math.sin(2 * Math.PI * 440 * Math.floor(at / 2) / rate)), rate, 2),
    'Second/audio.wav': wave(Array.from({ length: rate * 3 * 2 }, (_, at) =>
      0.25 * Math.sin(2 * Math.PI * 880 * Math.floor(at / 2) / rate)), rate, 2),
  }).bytes
}
