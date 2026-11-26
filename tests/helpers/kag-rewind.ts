/** KAGParser.cpp 915–963: install onScenarioLoad's result, then Rewind,
 * then onScenarioLoaded. Rewind (995–1012) resets temporary parse state. */
export const kagRewindFiles = {
  'rewind-probe.ks': '[macro name=aux][if exp=true][probe value=%value][endif][endmacro][aux value=AUX][done]\\\n',
  'rewind-excluded.ks': '[if exp=rewindExclude()]HIDDEN[endif][done]\\\n',
  'rewind-entry.ks': '*entry\n[macro name=scene][call storage=rewind-main.ks][endmacro]\\\n[if exp=true][scene value=PLAYER]AFTER[else]WRONG[endif][done]\\\n',
  'rewind-lines.ks': 'A\\\nB\nC[p]\nD[done]\n',
}
export const kagRewindExpected: Readonly<Record<string, string>> = {
  'rewind-macro': 'probe,1,1,-1|none,0,0,-1|value|fallback|VISIBLE|1',
  'rewind-excluded': 'interrupt,0,1,1|none,0,0,-1|VISIBLE',
  'rewind-call': 'probe,2,1,-1|PLAYER,1,0,-1|PLAYER|1|AFTER|0|1',
  'rewind-after': 'A|B|2|1',
  'rewind-lines': 'AB/C<p>D|A\\BC<p>D',
}
export const kagRewindSource = String.raw`
var rewindActive=void;
function rewindExclude(){global.rewindActive.interrupt();return false;}
class RewindParser extends KAGParser {
 var mode="",before="",after="",taken="",loaded=0;
 function RewindParser(){super.KAGParser();debugLevel=tkdlNone;}
 function onScenarioLoad(name){
  if(name!="rewind-main.ks")return;
  if(mode=="after")return "AB[done]";
  global.rewindActive=this;
  loadScenario(mode=="excluded"?"rewind-excluded.ks":"rewind-probe.ks");
  var tag=getNextTag(),state=store();
  before=tag.tagname+","+state.macroArgStackDepth+","+state.IfLevel+","+state.ExcludeLevel;
  if(mode=="call")return "[emit value=%value][return]";
  if(mode=="excluded")return "VISIBLE[done]";
  return "[emit value=%value|fallback]VISIBLE[done]";
 }
 function onScenarioLoaded(name){
  if(name!="rewind-main.ks")return;
  loaded++;var state=store();
  after=(macroParams===null?"none":macroParams.value)+","+state.macroArgStackDepth+","+state.IfLevel+","+state.ExcludeLevel;
  if(mode=="after")taken=getNextTag().text;
 }
}
function rewindDrain(p){
 var result="";
 for(var i=0;i<80;i++){
  var tag=p.getNextTag();if(tag===void)throw new Exception("Rewind scenario ended before done");
  if(tag.tagname=="done")return result;
  if(tag.tagname=="ch")result+=tag.text;
  else if(tag.tagname=="r")result+="/";
  else result+="<"+tag.tagname+">";
 }
 throw new Exception("Rewind control exceeded its tag bound");
}
function kagRewindRun(id,p){
 var result,tag;p.mode=id.substr(7);
 if(p.mode=="lines"){
  p.loadScenario("rewind-lines.ks");result=rewindDrain(p);p.ignoreCR=true;p.loadScenario("rewind-lines.ks");
  return result+"|"+rewindDrain(p);
 }
 p.loadScenario(p.mode=="call"?"rewind-entry.ks":"rewind-main.ks");
 if(p.mode=="after"){
  tag=p.getNextTag();result=p.taken+"|"+tag.text+"|"+p.curPos+"|"+p.loaded;rewindDrain(p);return result;
 }
 if(p.mode=="excluded")return p.before+"|"+p.after+"|"+rewindDrain(p);
 tag=p.getNextTag();result=p.before+"|"+p.after+"|"+tag.value;
 if(p.mode=="call")result+="|"+p.callStackDepth;
 result+="|"+rewindDrain(p);
 if(p.mode=="call")result+="|"+p.callStackDepth;
 return result+"|"+int(p.macroParams===null);
}
function kagRewindObserve(id){
 var p=void,result,failed=false,primary;
 try{p=new RewindParser();result=kagRewindRun(id,p);}catch(e){failed=true;primary=e;}
 global.rewindActive=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("rewind-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

/** These game-owned hooks use the original KAGMainWindow scenario-filter
 * API. The auxiliary tags are inspected, never dispatched to game handlers. */
export const kagRewindGameFiles = {
  'first.ks': '*start|Dynamic chapter\n[cm]\n[macro name=scene][call storage=virtual-chapter.ks][endmacro]\n[scene value=PLAYER]\n[eval exp="global.rewindGamePhase=3"]\n[s]\n',
  'rewind-game-probe.ks': '[macro name=aux][if exp=true][probe value=%value][endif][endmacro]\n[aux value=AUX]\n',
  'virtual-chapter.ks': '[iscript]\nthrow new Exception("The scenario filter was not used");\n[endscript]\n',
}
const chapter = String.raw`*chapter|Generated chapter
[nowait][emb exp=mp.value][endnowait]
[eval exp="global.rewindGamePhase=1"]
[l]
[r][nowait]CONTINUE [emb exp=mp.value][endnowait]
[eval exp="global.rewindGamePhase=2"]
[l]
[return]
`
export const kagRewindGameSource = `var rewindGameChapter=${JSON.stringify(chapter)};` + String.raw`
var rewindGamePhase=0,rewindGameBefore="",rewindGameAfter="";
kag.onConductorScenarioLoad=function(name){
 if(name!="virtual-chapter.ks")return true;
 var p=global.kag.conductor;
 p.loadScenario("rewind-game-probe.ks");var tag=p.getNextTag(),state=p.store();
 if(tag.tagname!="probe")throw new Exception("Missing dynamic chapter probe");
 global.rewindGameBefore=tag.value+","+state.macroArgStackDepth+","+state.IfLevel;
 return global.rewindGameChapter;
};
kag.onConductorScenarioLoaded=function(name){
 if(name=="virtual-chapter.ks"){
  var p=global.kag.conductor,state=p.store();
  global.rewindGameAfter=p.macroParams.value+","+state.macroArgStackDepth+","+state.IfLevel;
 }
 return true;
};
function rewindGameState(){
 var k=global.kag,p=k.conductor;
 return global.rewindGamePhase+"|"+k.historyLayer.currentLine+"|"+int(k.clickWaiting)+"|"+p.lastTagName+"|"+
  p.callStackDepth+"|"+int(p.macroParams===null)+"|"+global.rewindGameBefore+"|"+global.rewindGameAfter;
}
Debug.message("rewind-game-ready");
`
