/** Fixed KAGParser.cpp writes tagname at 1556 and each attribute at 2241.
 * Later expressions use that same returned Dictionary; these controls run
 * unchanged in the stock SDK and the actual Web TJS VM. */
export const kagLiveFiles = {
  'live-read.ks': '@seed\n@choice label=NEXT score=7 echo=&liveRead() later=TAIL cond="liveHeld.score==7 && liveHeld.echo==\'NEXT:7\'"\n',
  'live-write.ks': '@seed\n@choice old=remove label=BEFORE edit=&liveEdit() caption=&liveHeld.label later=tail\n',
  'live-condition.ks': '@seed\n[if exp="liveCondition()"]\n@choice label=YES\n[else]\n@choice label=NO\n[endif][done]\n',
  'live-syntax.ks': '@seed\n[choice label=KEEP score=12 broken=\'\n',
  'live-throw.ks': '@seed\n@choice label=KEEP changed=&liveThrow() later=NO\n',
  'live-forward.ks': '[macro name=m][mark][choice old=drop * label=&liveHeld.actor.name copy=%actor][endmacro][m tail=END][done]\n',
  'live-entry.ks': '*entry\n[call storage=live-chapter.ks target=*chapter]AFTER[done]\n',
  'live-chapter.ks': '*chapter\n@seed\n@choice label=RESUME score=7 caption=&liveCaption()\n[return]\n',
}
export const kagLiveExpected: Readonly<Record<string, string>> = {
  'live-read': 'choice:NEXT:7:1|NEXT:7|TAIL|1',
  'live-write': 'choice|AFTER|written|AFTER|1|1|ACTOR|tail',
  'live-condition': 'if|YES|1|1|done|0',
  'live-errors': 'live-tag-syntax|choice|KEEP|12|1|live-tag-exception|choice|KEEP|yes|1|1|NEXT:7',
  'live-forward': 'ACTOR|END|1|1|done|1',
  'live-bookmark': 'RESUME 7|1|RESUME 7|1|AFTER|0',
}
export const kagLiveSource = String.raw`
class LiveTagParser extends KAGParser {
 function LiveTagParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
}
class LiveTagActor {
 var name="ACTOR";
 function speak(){return name;}
}
class LiveTagDrop {
 function finalize(){global.liveReleased++;}
}
var liveHeld=void,liveActor=void,liveSeen="",liveReleased=0;
function liveRead(){
 global.liveSeen=liveHeld.tagname+":"+liveHeld.label+":"+liveHeld.score+":"+int(liveHeld.later===void);
 return liveHeld.label+":"+liveHeld.score;
}
function liveEdit(){
 liveHeld.label="AFTER";delete liveHeld.old;liveHeld.actor=liveActor;liveHeld.action=liveActor.speak;
 return "written";
}
function liveCondition(){global.liveSeen=liveHeld.tagname;liveHeld.scratch=new LiveTagDrop();return liveHeld.tagname=="if";}
function liveThrow(){liveHeld.changedByScript="yes";throw new Exception("live-tag-exception");}
function liveCaption(){
 if(liveHeld.tagname!="choice" || liveHeld.score!="7")throw new Exception("Current choice fields were not published");
 return liveHeld.label+" "+liveHeld.score;
}
function liveSeed(p,file){p.loadScenario(file);global.liveHeld=p.getNextTag();if(liveHeld.tagname!="seed")throw new Exception("Missing live tag seed");}
function liveDrain(p){
 var text="";
 for(var i=0;i<30;i++){
  var tag=p.getNextTag();if(tag===void)throw new Exception("Missing live return terminator");
  if(tag.tagname=="done")return text;
  if(tag.tagname!="ch")throw new Exception("Unexpected live return tag");text+=tag.text;
 }
 throw new Exception("Live return exceeded its tag bound");
}
function liveResume(p,data){
 p.restore(data);global.liveHeld=p.getNextTag();
 if(liveHeld.tagname!="seed")throw new Exception("Bookmark did not restore chapter seed");
 var row=p.getNextTag(),result=row.caption+"|"+p.callStackDepth;
 return result+"|"+liveDrain(p)+"|"+p.callStackDepth;
}
function kagLiveRun(id,p,q){
 var row,result,firstError="",secondError="";
 switch(id){
  case "live-read":
   liveSeed(p,"live-read.ks");row=p.getNextTag();
   return liveSeen+"|"+row.echo+"|"+row.later+"|"+int(row===liveHeld);
  case "live-write":
   liveSeed(p,"live-write.ks");global.liveActor=new LiveTagActor();row=p.getNextTag();
   return row.tagname+"|"+row.label+"|"+row.edit+"|"+row.caption+"|"+int(row.old===void)+"|"+int(row.actor===liveActor)+"|"+row.action()+"|"+row.later;
  case "live-condition":
   global.liveReleased=0;
   liveSeed(p,"live-condition.ks");row=p.getNextTag();result=liveSeen+"|"+row.label+"|"+int(row.scratch===void);
   return result+"|"+liveReleased+"|"+p.getNextTag().tagname+"|"+p.store().IfLevel;
  case "live-errors":
   System.assignMessage("TVPKAGSyntaxError","live-tag-syntax");
   liveSeed(p,"live-syntax.ks");try{p.getNextTag();}catch(e){firstError=e.message;}
   result=firstError+"|"+liveHeld.tagname+"|"+liveHeld.label+"|"+liveHeld.score+"|"+int(liveHeld.broken===void);
   liveSeed(p,"live-throw.ks");try{p.getNextTag();}catch(e){secondError=e.message;}
   result+="|"+secondError+"|"+liveHeld.tagname+"|"+liveHeld.label+"|"+liveHeld.changedByScript+"|"+int(liveHeld.changed===void)+"|"+int(liveHeld.later===void);
   liveSeed(p,"live-read.ks");return result+"|"+p.getNextTag().echo;
  case "live-forward":
   p.loadScenario("live-forward.ks");global.liveHeld=p.getNextTag();
   if(liveHeld.tagname!="mark")throw new Exception("Missing macro injection point");
   global.liveActor=new LiveTagActor();p.macroParams.actor=liveActor;row=p.getNextTag();
   result=row.label+"|"+row.tail+"|"+int(row.old===void)+"|"+int(row.copy===liveActor);
   return result+"|"+p.getNextTag().tagname+"|"+int(p.macroParams===null);
  case "live-bookmark":
   p.loadScenario("live-entry.ks");global.liveHeld=p.getNextTag();
   if(liveHeld.tagname!="seed")throw new Exception("Missing chapter seed");
   row=p.getNextTag();result=row.caption+"|"+p.callStackDepth;
   var saved=p.store();(Dictionary.saveStruct incontextof saved)("live-bookmark.tjs");
   return result+"|"+liveResume(q,Scripts.evalStorage("live-bookmark.tjs"));
 }
 throw new Exception("Unknown live tag control");
}
function kagLiveObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new LiveTagParser();q=new LiveTagParser();result=kagLiveRun(id,p,q);}catch(e){failed=true;primary=e;}
 global.liveHeld=void;global.liveActor=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("live-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Live tag cleanup: "+cleanup.join("|"));return result;
}
function kagLiveResumeFile(path){
 var p=void,result,failed=false,primary;
 try{p=new LiveTagParser();result=liveResume(p,Scripts.evalStorage(path));}catch(e){failed=true;primary=e;}
 global.liveHeld=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("live-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagLiveGameMenu = '@seed\n@choice label=ROUTE score=7 caption=&liveGameCaption() cond="liveHeld.target==\'*selected\' && liveHeld.caption==\'ROUTE 7\'"\n@choice label=WRONG score=0 target=*wrong caption=WRONG\n'
export const kagLiveGameSource = kagLiveSource + String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="live";kag.saveDataLocation=System.dataPath;
var liveGameParser=new LiveTagParser(),liveGameChoice=void,liveGameVisits=0,liveGameRendered="";
function liveGameCaption(){liveHeld.target="*selected";return liveCaption();}
liveSeed(liveGameParser,"live-game-menu.ks");liveGameChoice=liveGameParser.getNextTag();
if(liveGameChoice===void || liveGameChoice.caption!="ROUTE 7" || liveGameChoice.target!="*selected")
 throw new Exception("The generated choice lost its live attributes");
function liveGameState(){return [f.liveProgress,global.liveGameRendered,global.liveGameVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status,global.liveGameChoice.caption,global.liveGameChoice.target].join("|");}
function liveGameStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.liveProgress,saved.core.mainConductor.curLabel].join("|");}
Debug.message("live-tag-game-ready");
`
export const kagLiveStory = String.raw`[eval exp="f.liveProgress=0"]
*choice|Live generated choice
[cm][hr][nowait]CHOOSE[endnowait]
[iscript]
global.liveGameRendered=global.kag.historyLayer.currentLine;global.liveGameVisits++;
[endscript]
[r][link target=&global.liveGameChoice.target][emb exp=global.liveGameChoice.caption][endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[eval exp="f.liveProgress=int(global.liveGameChoice.score)"]
[jump target=*checkpoint]
*checkpoint|Live choice chapter
[cm][hr][nowait]CHAPTER [emb exp=f.liveProgress][endnowait]
[iscript]
global.liveGameRendered=global.kag.historyLayer.currentLine;global.liveGameVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.liveProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
*wrong
[eval exp="throw new Exception('The rejected menu branch ran')"]
`
