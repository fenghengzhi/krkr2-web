/** Stock KAGParser.cpp evaluates each entity at its live cursor (2192–2242).
 * A nested read can select another line before the outer attribute loop
 * continues. Expected text is authored here, independently of the TS lexer. */
export const kagEntityFiles = {
  'entity-menu.ks': '@choice title=&entityReadRoute()\n[route target=*selected] caption="Continue 7" score=7\n[done]\n',
  'entity-other.ks': '[route target=*replacement] caption=REPLACED score=9\n[done]\n',
  'entity-bad.ks': '@choice title=&entityReadRoute()\n[route target=*selected] caption=KEEP broken=&entityFailure()\n',
  'entity-lines.ks': '@mark value=FIRST\n@mark value=SECOND\n',
  'entity-entry.ks': '*entry\n[call storage=entity-chapter.ks target=*chapter]AFTER[done]\n',
  'entity-chapter.ks': '*chapter\n@choice title=&entityReadRoute()\n[route target=*selected] caption="Continue 7" score=7\n[return]\n',
}
export const kagEntityExpected: Readonly<Record<string, string>> = {
  'entity-next-line': 'route|*selected|chosen|Continue 7|7|1|2|0|1|done',
  'entity-reload': 'route|*replacement|chosen|REPLACED|9|entity-other.ks|1|0|done',
  'entity-line-view': '1|0|1|1|0|1|SECOND|2|1|SECOND|2|1',
  'entity-tail-error': 'entity-value|route|*selected|chosen|KEEP|1|1|Continue 7',
  'entity-bookmark': 'Continue 7|1|Continue 7|1|AFTER|0',
}
export const kagEntitySource = String.raw`
class EntityCursorParser extends KAGParser {
 function EntityCursorParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
}
var entityParser=void,entityMode="",entityReads=0,entityTaken=void;
function entityFailure(){throw new Exception("entity-value");}
function entityReadRoute(){
 global.entityReads++;if(entityReads>3)throw new Exception("Entity route exceeded its finite input bound");
 if(entityMode=="reload")entityParser.loadScenario("entity-other.ks");
 var row=entityParser.getNextTag();
 if(row===void || row.tagname!="route")throw new Exception("Entity expected an adjacent route record");
 global.entityTaken=row;return "chosen";
}
function entityNext(p){global.entityParser=p;global.entityReads=0;return p.getNextTag();}
function entityDrain(p){
 var text="";
 for(var i=0;i<40;i++){
  var row=p.getNextTag();if(row===void)throw new Exception("Missing entity return terminator");
  if(row.tagname=="done")return text;
  if(row.tagname!="ch")throw new Exception("Unexpected entity return tag");text+=row.text;
 }
 throw new Exception("Entity return exceeded its text bound");
}
function entityResume(p,data){
 p.restore(data);var row=entityNext(p),text=row.caption+"|"+p.callStackDepth;
 return text+"|"+entityDrain(p)+"|"+p.callStackDepth;
}
function kagEntityRun(id,p,q){
 var row,result;
 switch(id){
  case "entity-next-line":
   p.loadScenario("entity-menu.ks");row=entityNext(p);
   result=row.tagname+"|"+row.target+"|"+row.title+"|"+row.caption+"|"+row.score+"|"+int(row===entityTaken)+"|"+p.curLine+"|"+p.curPos;
   return result+"|"+int(p.curLineStr=='[route target=*selected] caption="Continue 7" score=7')+"|"+p.getNextTag().tagname;
  case "entity-reload":
   global.entityMode="reload";p.loadScenario("entity-menu.ks");row=entityNext(p);
   result=row.tagname+"|"+row.target+"|"+row.title+"|"+row.caption+"|"+row.score+"|"+p.curStorage+"|"+p.curLine+"|"+p.curPos;
   return result+"|"+p.getNextTag().tagname;
  case "entity-line-view":
   p.loadScenario("entity-lines.ks");p.getNextTag();q.assign(p);
   result=p.curLine+"|"+p.curPos+"|"+int(p.curLineStr=="@mark value=FIRST")+"|"+q.curLine+"|"+q.curPos+"|"+int(q.curLineStr==p.curLineStr);
   row=p.getNextTag();result+="|"+row.value+"|"+p.curLine+"|"+int(p.curLineStr=="@mark value=SECOND");
   row=q.getNextTag();return result+"|"+row.value+"|"+q.curLine+"|"+int(q.curLineStr==p.curLineStr);
  case "entity-tail-error":
   p.loadScenario("entity-bad.ks");
   var reason="missing-error";try{entityNext(p);}catch(e){reason=e.message;}
   result=reason+"|"+entityTaken.tagname+"|"+entityTaken.target+"|"+entityTaken.title+"|"+entityTaken.caption+"|"+int(entityTaken.broken===void)+"|"+p.curLine;
   p.loadScenario("entity-menu.ks");return result+"|"+entityNext(p).caption;
  case "entity-bookmark":
   p.loadScenario("entity-entry.ks");row=entityNext(p);result=row.caption+"|"+p.callStackDepth;
   var saved=p.store();(Dictionary.saveStruct incontextof saved)("entity-bookmark.tjs");
   return result+"|"+entityResume(q,Scripts.evalStorage("entity-bookmark.tjs"));
 }
 throw new Exception("Unknown entity cursor control");
}
function kagEntityObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 global.entityMode="";global.entityReads=0;global.entityTaken=void;
 try{p=new EntityCursorParser();q=new EntityCursorParser();result=kagEntityRun(id,p,q);}catch(e){failed=true;primary=e;}
 global.entityParser=void;global.entityTaken=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("entity-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Entity cursor cleanup: "+cleanup.join("|"));return result;
}
function kagEntityResumeFile(path){
 var p=void,result,failed=false,primary;global.entityMode="";
 try{p=new EntityCursorParser();result=entityResume(p,Scripts.evalStorage(path));}catch(e){failed=true;primary=e;}
 global.entityParser=void;global.entityTaken=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("entity-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagEntityGameSource = kagEntitySource + String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="entity";kag.saveDataLocation=System.dataPath;
var entityGameParser=new EntityCursorParser(),entityGameOption=void,entityGameVisits=0,entityGameRendered="";
entityGameParser.loadScenario("entity-menu.ks");entityGameOption=entityNext(entityGameParser);
if(entityGameOption===void || entityGameOption.caption!="Continue 7" || entityGameOption.score!="7" || entityGameOption.target!="*selected")
 throw new Exception("The nested route read lost its remaining attributes");
function entityGameState(){return [f.entityProgress,global.entityGameRendered,global.entityGameVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status,global.entityGameOption.caption,global.entityGameOption.score].join("|");}
function entityGameStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.entityProgress,saved.core.mainConductor.curLabel].join("|");}
Debug.message("entity-cursor-game-ready");
`
export const kagEntityStory = String.raw`[eval exp="f.entityProgress=0"]
*choice|Adjacent route records
[cm][hr][nowait]CHOOSE[endnowait]
[iscript]
global.entityGameRendered=global.kag.historyLayer.currentLine;global.entityGameVisits++;
[endscript]
[r][link target=&global.entityGameOption.target][emb exp=global.entityGameOption.caption][endlink]
[s]
*selected
[eval exp="f.entityProgress=int(global.entityGameOption.score)"]
[jump target=*checkpoint]
*checkpoint|Generated chapter
[cm][hr][nowait]CHAPTER [emb exp=f.entityProgress][endnowait]
[iscript]
global.entityGameRendered=global.kag.historyLayer.currentLine;global.entityGameVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.entityProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
`
