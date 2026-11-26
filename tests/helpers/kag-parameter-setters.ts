/** KAGParser.cpp 2234 uses PropSetByVS(TJS_MEMBERENSURE), while * uses
 * Dictionary.assign's raw property copy. These ordinary property controls
 * are shared unchanged by the stock SDK and both Web script paths. */
export const kagSetterFiles = {
  'setter-order.ks': '[macro name=m][mark][choice before=DROP * score=7 score=9 plain=first plain=last caption=&setterHeld.caption tail=END][endmacro][m][done]\n',
  'setter-name.ks': '[macro name=m][mark][choice * tail=END][endmacro][m][done]\n',
  'setter-plain-name.ks': '@seed\n@choice rename=&setterRename() * tail=END\n',
  'setter-values.ks': '[macro name=m][mark][choice * input=%actor input=%number input=%bytes][endmacro][m][done]\n',
  'setter-error.ks': '[macro name=m][mark][choice first=KEEP * broken=7 later=NO][endmacro][m][done]\n',
  'setter-entry.ks': '*entry\n[macro name=relay][call storage=setter-chapter.ks target=*chapter][endmacro][relay]AFTER[done]\n',
  'setter-chapter.ks': '*chapter\n[mark][choice * score=7 caption=&setterHeld.caption][return]\n',
}
export const kagSetterExpected: Readonly<Record<string, string>> = {
  'setter-order': '9|ROUTE 9|*selected|choice|7,9|1|1|last|END|done|1',
  'setter-name': 'choice|choice|1|END|choice|renamed|END',
  'setter-values': 'Object,Real,Octet|1|Real|1|1|1|done',
  'setter-error': 'setter-error|choice|yes|1|1|1|7|9|done',
  'setter-bookmark': '7|ROUTE 7|1|1|7|ROUTE 7|1|AFTER|0',
}
export const kagSetterSource = String.raw`
class SetterParser extends KAGParser {
 function SetterParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
}
class SetterModel {
 var score=0,writes=[],names=[],values=[],valueTypes=[],label="unset";
 property points {
  getter(){return score;}
  setter(value){
   score=int(value);writes.add(string(score));
   global.setterHeld.caption="ROUTE "+score;global.setterHeld.target="*selected";
   global.setterHeld.recorded=global.setterHeld.tagname;
  }
 }
 property tag {
  getter(){return label;}
  setter(value){label=string(value);names.add(label);}
 }
 property input {
  getter(){return values.count?values[values.count-1]:void;}
  setter(value){valueTypes.add(typeof value);values.add(value);}
 }
 property broken {
  getter(){return score;}
  setter(value){score=int(value);global.setterHeld.changed="yes";throw new Exception("setter-error");}
 }
}
var setterHeld=void,setterModel=void;
function setterSeed(p,file){
 global.setterHeld=void;global.setterModel=new SetterModel();
 p.loadScenario(file);global.setterHeld=p.getNextTag();
 if(setterHeld.tagname!="mark")throw new Exception("Missing setter macro seed");
 var args=p.macroParams;&args.score=&global.setterModel.points;
}
function setterRename(){global.setterHeld.tagname="changed";return "renamed";}
function setterDrain(p){
 var text="";
 for(var i=0;i<30;i++){
  var row=p.getNextTag();if(row===void)throw new Exception("Missing setter return terminator");
  if(row.tagname=="done")return text;
  if(row.tagname!="ch")throw new Exception("Unexpected setter return tag");text+=row.text;
 }
 throw new Exception("Setter return exceeded its bound");
}
function setterResume(p,data){
 p.restore(data);global.setterHeld=p.getNextTag();
 if(setterHeld.tagname!="mark")throw new Exception("Setter bookmark did not resume chapter");
 var row=p.getNextTag(),result=row.score+"|"+row.caption+"|"+p.callStackDepth;
 return result+"|"+setterDrain(p)+"|"+p.callStackDepth;
}
function kagSetterRun(id,p,q){
 var row,result,args;
 if(id=="setter-order"){
  setterSeed(p,"setter-order.ks");row=p.getNextTag();
  result=[row.score,row.caption,row.target,row.recorded,setterModel.writes.join(","),int((&row.score)===(&setterModel.points)),int(row.before===void),row.plain,row.tail].join("|");
  return result+"|"+p.getNextTag().tagname+"|"+int(p.macroParams===null);
 }
 if(id=="setter-name"){
  setterSeed(p,"setter-name.ks");args=p.macroParams;&args.tagname=&setterModel.tag;
  row=p.getNextTag();result=[row.tagname,setterModel.names.join(","),int((&row.tagname)===(&setterModel.tag)),row.tail].join("|");
  p.loadScenario("setter-plain-name.ks");global.setterHeld=p.getNextTag();row=p.getNextTag();
  return result+"|"+row.tagname+"|"+row.rename+"|"+row.tail;
 }
 if(id=="setter-values"){
  setterSeed(p,"setter-values.ks");args=p.macroParams;
  var actor=%[name:"PLAYER"],bytes=<%12 ab%>;args.actor=actor;args.number=-0.0;args.bytes=bytes;
  &args.input=&setterModel.input;row=p.getNextTag();
  result=[setterModel.valueTypes.join(","),int(setterModel.values[0]===actor),typeof setterModel.values[1],int(1/setterModel.values[1]<0),int(setterModel.values[2]==bytes),int((&row.input)===(&setterModel.input))].join("|");
  return result+"|"+p.getNextTag().tagname;
 }
 if(id=="setter-error"){
  setterSeed(p,"setter-error.ks");args=p.macroParams;&args.broken=&setterModel.broken;
  var reason="not-thrown";try{p.getNextTag();}catch(e){reason=e.message;}
  result=[reason,setterHeld.tagname,setterHeld.changed,int(setterHeld.first===void),int(setterHeld.later===void),int((&setterHeld.broken)===(&setterModel.broken)),setterModel.score].join("|");
  setterSeed(p,"setter-order.ks");row=p.getNextTag();return result+"|"+row.score+"|"+p.getNextTag().tagname;
 }
 if(id=="setter-bookmark"){
  setterSeed(p,"setter-entry.ks");row=p.getNextTag();
  result=row.score+"|"+row.caption+"|"+p.callStackDepth;
  var saved=p.store();result+="|"+int((&saved.macroArgs[0].score)===(&setterModel.points));
  // Persist ordinary evaluated state; executable properties remain an
  // in-memory binding, just as in the original Dictionary save format.
  &saved.macroArgs[0].score=row.score;saved.macroArgs[0].caption=row.caption;
  (Dictionary.saveStruct incontextof saved)("setter-bookmark.tjs");
  return result+"|"+setterResume(q,Scripts.evalStorage("setter-bookmark.tjs"));
 }
 throw new Exception("Unknown setter control");
}
function kagSetterObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new SetterParser();q=new SetterParser();result=kagSetterRun(id,p,q);}catch(e){failed=true;primary=e;}
 global.setterHeld=void;global.setterModel=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("setter-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Setter cleanup: "+cleanup.join("|"));return result;
}
function kagSetterResumeFile(path){
 var p=void,result,failed=false,primary;
 try{p=new SetterParser();result=setterResume(p,Scripts.evalStorage(path));}catch(e){failed=true;primary=e;}
 global.setterHeld=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("setter-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagSetterGameMenu = '[macro name=route][mark][choice * score=7 caption=&setterHeld.caption][endmacro][route][done]\n'
export const kagSetterGameSource = kagSetterSource + String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="setter";kag.saveDataLocation=System.dataPath;
var setterGameParser=new SetterParser(),setterGameChoice=void,setterGameVisits=0,setterGameRendered="";
setterSeed(setterGameParser,"setter-game-menu.ks");setterGameChoice=setterGameParser.getNextTag();
if(setterGameChoice.caption!="ROUTE 7" || setterGameChoice.target!="*selected" || setterGameChoice.score!==7 || setterModel.writes.join(",")!="7")
 throw new Exception("The forwarded macro setter did not prepare the player choice");
function setterGameState(){return [f.setterProgress,global.setterGameRendered,global.setterGameVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status,global.setterGameChoice.caption,global.setterGameChoice.target,global.setterModel.writes.join(",")].join("|");}
function setterGameStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.setterProgress,saved.core.mainConductor.curLabel].join("|");}
Debug.message("setter-game-ready");
`
export const kagSetterStory = String.raw`[eval exp="f.setterProgress=0"]
*choice|Forwarded setter choice
[cm][nowait]CHOOSE[endnowait]
[iscript]
global.setterGameRendered=global.kag.historyLayer.currentLine;global.setterGameVisits++;
[endscript]
[r][link target=&global.setterGameChoice.target][emb exp=global.setterGameChoice.caption][endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[eval exp="f.setterProgress=int(global.setterGameChoice.score)"]
[jump target=*checkpoint]
*checkpoint|Setter choice chapter
[cm][nowait]CHAPTER [emb exp=f.setterProgress][endnowait]
[iscript]
global.setterGameRendered=global.kag.historyLayer.currentLine;global.setterGameVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.setterProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
*wrong
[eval exp="throw new Exception('The wrong setter-generated route ran')"]
`
