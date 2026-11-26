/** Stock KAGParser.cpp 2193–2226 reads each %name with PropGet(0).
 * Dictionary.assign (the * form and bookmarks) keeps property objects raw.
 * All expected strings below are authored independently of the Web parser. */
export const kagParameterFiles = {
  'parameter-read.ks': '[macro name=m][mark][choice first=%caption score=%score second=%caption blank=%blank|fallback absent=%absent|missing][endmacro][m][done]\n',
  'parameter-forward.ks': '[macro name=inner][inside][choice * copy=%caption][endmacro][macro name=outer][mark][inner *][endmacro][outer][done]\n',
  'parameter-types.ks': '[macro name=m][mark][emit actor=%actor action=%action number=%number bytes=%bytes nothing=%nothing][endmacro][m][done]\n',
  'parameter-throw.ks': '[macro name=m][mark][choice first=KEEP broken=%broken later=NO][endmacro][m][done]\n',
  'parameter-entry.ks': '*entry\n[macro name=relay][call storage=parameter-chapter.ks target=*chapter][endmacro][relay]AFTER[done]\n',
  'parameter-chapter.ks': '*chapter\n[mark][choice caption=%caption score=%score][return]\n',
}
export const kagParameterExpected: Readonly<Record<string, string>> = {
  'parameter-read': 'ROUTE 7|7|ROUTE 8|fallback|missing|caption:7,score:7,caption:8,blank|1|choice:8|done|1',
  'parameter-forward': '0|1|1|ROUTE 7|caption:7|ROUTE 7|caption:7,caption:7|done|1',
  'parameter-types': '1|PLAYER|Real|1|1|1|actor,action,number,bytes,nothing|done',
  'parameter-throw': 'parameter-getter|choice|KEEP|yes|1|1|broken|done',
  'parameter-bookmark': 'ROUTE 7|7|1|ROUTE 7|7|1|AFTER|0',
}
export const kagParameterSource = String.raw`
class ParameterParser extends KAGParser {
 function ParameterParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
}
class ParameterActor {var name="PLAYER";function speak(){return name;}}
var parameterReads=[],parameterValue=7,parameterHeld=void,parameterActor=void;
property parameterCaption {getter(){
 global.parameterReads.add("caption:"+global.parameterValue);
 if(global.parameterHeld!==void)global.parameterHeld.touched=global.parameterHeld.tagname+":"+global.parameterValue;
 return "ROUTE "+global.parameterValue;
}}
property parameterScore {getter(){global.parameterReads.add("score:"+global.parameterValue);return global.parameterValue++;}}
property parameterBlank {getter(){global.parameterReads.add("blank");return void;}}
property parameterTarget {getter(){global.parameterReads.add("target");return global.parameterValue==7?"*selected":"*wrong";}}
property parameterObject {getter(){global.parameterReads.add("actor");return global.parameterActor;}}
property parameterAction {getter(){global.parameterReads.add("action");return global.parameterActor.speak;}}
property parameterReal {getter(){global.parameterReads.add("number");return -0.0;}}
property parameterBytes {getter(){global.parameterReads.add("bytes");return <%12 ab%>;}}
property parameterNull {getter(){global.parameterReads.add("nothing");return null;}}
property parameterBroken {getter(){
 global.parameterReads.add("broken");global.parameterHeld.changed="yes";
 throw new Exception("parameter-getter");
}}
function parameterSeed(p,file){
 global.parameterReads=[];global.parameterValue=7;global.parameterHeld=void;
 p.loadScenario(file);global.parameterHeld=p.getNextTag();
 if(parameterHeld.tagname!="mark")throw new Exception("Missing property macro seed");
 var mp=p.macroParams;
 &mp.caption=&global.parameterCaption;&mp.score=&global.parameterScore;&mp.blank=&global.parameterBlank;
}
function parameterDrain(p){
 var text="";
 for(var i=0;i<30;i++){
  var row=p.getNextTag();if(row===void)throw new Exception("Missing property macro terminator");
  if(row.tagname=="done")return text;
  if(row.tagname!="ch")throw new Exception("Unexpected property macro return tag");text+=row.text;
 }
 throw new Exception("Property macro return exceeded its bound");
}
function parameterResume(p,data){
 p.restore(data);var mark=p.getNextTag();
 if(mark.tagname!="mark")throw new Exception("Property bookmark did not resume the chapter");
 var row=p.getNextTag(),result=row.caption+"|"+row.score+"|"+p.callStackDepth;
 return result+"|"+parameterDrain(p)+"|"+p.callStackDepth;
}
function kagParameterRun(id,p,q){
 var row,result,mp;
 if(id=="parameter-read"){
  parameterSeed(p,"parameter-read.ks");row=p.getNextTag();
  result=[row.first,row.score,row.second,row.blank,row.absent,parameterReads.join(","),int(row===parameterHeld),row.touched].join("|");
  return result+"|"+p.getNextTag().tagname+"|"+int(p.macroParams===null);
 }
 if(id=="parameter-forward"){
  parameterSeed(p,"parameter-forward.ks");var outer=p.macroParams;
  row=p.getNextTag();if(row.tagname!="inside")throw new Exception("Missing forwarded macro seed");
  result=parameterReads.count+"|"+int((&p.macroParams.caption)===(&outer.caption));
  row=p.getNextTag();result+="|"+int((&row.caption)===(&outer.caption))+"|"+row.copy+"|"+parameterReads.join(",");
  result+="|"+row.caption+"|"+parameterReads.join(",");
  return result+"|"+p.getNextTag().tagname+"|"+int(p.macroParams===null);
 }
 if(id=="parameter-types"){
  parameterSeed(p,"parameter-types.ks");global.parameterActor=new ParameterActor();mp=p.macroParams;
  &mp.actor=&global.parameterObject;&mp.action=&global.parameterAction;&mp.number=&global.parameterReal;
  &mp.bytes=&global.parameterBytes;&mp.nothing=&global.parameterNull;
  row=p.getNextTag();result=[int(row.actor===parameterActor),row.action(),typeof row.number,int(1/row.number<0),int(row.bytes==<%12 ab%>),int(row.nothing===null),parameterReads.join(",")].join("|");
  return result+"|"+p.getNextTag().tagname;
 }
 if(id=="parameter-throw"){
  parameterSeed(p,"parameter-throw.ks");mp=p.macroParams;&mp.broken=&global.parameterBroken;
  var reason="not-thrown";try{p.getNextTag();}catch(e){reason=e.message;}
  result=[reason,parameterHeld.tagname,parameterHeld.first,parameterHeld.changed,int(parameterHeld.broken===void),int(parameterHeld.later===void),parameterReads.join(",")].join("|");
  parameterSeed(p,"parameter-read.ks");p.getNextTag();
  return result+"|"+p.getNextTag().tagname;
 }
 if(id=="parameter-bookmark"){
  parameterSeed(p,"parameter-entry.ks");row=p.getNextTag();result=row.caption+"|"+row.score+"|"+p.callStackDepth;
  // Author saves the evaluated choice, not executable properties. The
  // following chapter bookmark is a native, fresh-VM serializable value.
  mp=p.macroParams;&mp.caption=row.caption;&mp.score=row.score;delete mp.blank;
  var saved=p.store();(Dictionary.saveStruct incontextof saved)("parameter-bookmark.tjs");
  return result+"|"+parameterResume(q,Scripts.evalStorage("parameter-bookmark.tjs"));
 }
 throw new Exception("Unknown parameter property control");
}
function kagParameterObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new ParameterParser();q=new ParameterParser();result=kagParameterRun(id,p,q);}catch(e){failed=true;primary=e;}
 global.parameterHeld=void;global.parameterActor=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("parameter-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Property macro cleanup: "+cleanup.join("|"));return result;
}
function kagParameterResumeFile(path){
 var p=void,result,failed=false,primary;
 try{p=new ParameterParser();result=parameterResume(p,Scripts.evalStorage(path));}catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("parameter-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagParameterGameMenu = '[macro name=route][mark][choice caption=%caption target=%target score=%score][endmacro][route][done]\n'
export const kagParameterGameSource = kagParameterSource + String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="parameter";kag.saveDataLocation=System.dataPath;
var parameterGameParser=new ParameterParser(),parameterGameChoice=void,parameterGameVisits=0,parameterGameRendered="";
parameterSeed(parameterGameParser,"parameter-game-menu.ks");
var parameterGameArgs=parameterGameParser.macroParams;&parameterGameArgs.target=&global.parameterTarget;
parameterGameChoice=parameterGameParser.getNextTag();
if(parameterGameChoice.caption!="ROUTE 7" || parameterGameChoice.target!="*selected" || parameterGameChoice.score!==7 || parameterReads.join(",")!="caption:7,target,score:7")
 throw new Exception("Dynamic macro properties did not produce the player choice");
function parameterGameState(){return [f.parameterProgress,global.parameterGameRendered,global.parameterGameVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status,global.parameterGameChoice.caption,global.parameterGameChoice.target,global.parameterReads.join(",")].join("|");}
function parameterGameStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.parameterProgress,saved.core.mainConductor.curLabel].join("|");}
Debug.message("parameter-game-ready");
`
export const kagParameterStory = String.raw`[eval exp="f.parameterProgress=0"]
*choice|Dynamic macro choice
[cm][nowait]CHOOSE[endnowait]
[iscript]
global.parameterGameRendered=global.kag.historyLayer.currentLine;global.parameterGameVisits++;
[endscript]
[r][link target=&global.parameterGameChoice.target][emb exp=global.parameterGameChoice.caption][endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[eval exp="f.parameterProgress=int(global.parameterGameChoice.score)"]
[jump target=*checkpoint]
*checkpoint|Property choice chapter
[cm][nowait]CHAPTER [emb exp=f.parameterProgress][endnowait]
[iscript]
global.parameterGameRendered=global.kag.historyLayer.currentLine;global.parameterGameVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.parameterProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
*wrong
[eval exp="throw new Exception('The wrong property-generated route ran')"]
`
