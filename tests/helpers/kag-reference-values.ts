/** Authored inputs for KAGParser.cpp 1204–1221, 2080–2095 and 2194–2216:
 * Dictionary.assign and % parameters copy variants, not object contents.
 * Store/Restore use the same shallow rule (510–525, 747–773). */
export const kagReferenceFiles = {
  'references-direct.ks': '[macro name=relay][enter][emit value=%payload action=%action bytes=%bytes missing=%absent|fallback][endmacro][relay][done]\\\n',
  'references-nested.ks': '[macro name=inner][if exp=%depth][inner * depth=0][else][emit *][endif][endmacro][macro name=outer][enter][inner * depth=1][after value=%payload][endmacro][outer][done]\\\n',
  'references-call.ks': '*entry\n[macro name=scene][enter][call storage=references-chapter.ks target=*chapter value=%payload][after value=%payload][endmacro]\\\n[scene][done]\\\n',
  'references-chapter.ks': '*chapter\n[emit value=%payload action=%action bytes=%bytes][return]\\\n',
  'references-reentry.ks': '[macro name=relay][enter][emit value=%payload again=&referenceReenter()][endmacro][relay][done]\\\n',
  'references-error.ks': '[macro name=relay][enter][emit value=%payload fail=&referenceFail()][endmacro][relay][done]\\\n',
  'references-reserved.ks': '[macro name=relay][enter][emit *][endmacro][relay][done]\\\n',
  'references-empty.ks': '*entry\nX[done]\\\n',
}

export const kagReferenceExpected: Readonly<Record<string, string>> = {
  'references-direct': '1|1|1|1|2|2|fallback|1',
  'references-forward': '1|1|1|2|1|2|1',
  'references-store': '1|1|1|1|1|1|2|2|1|1',
  'references-file': '1|7|1|1|1|1|1',
  'references-reentry': '1|nested|1|1|1',
  'references-error': 'reference-stop|1|1',
  'references-reserved': '1|1|1|1',
  'references-omitted': 'keep|X|reference-bad-save|replacement|1|0',
}

export const kagReferenceSource = String.raw`
class ReferenceActor {
 var count=1;
 function advance(){count++;return count;}
}
class ReferenceParser extends KAGParser {
 var expected,seen=false,reenter=false;
 function ReferenceParser(){super.KAGParser();debugLevel=tkdlNone;}
 function onCall(tag){seen=tag.value===expected;return true;}
}
function referenceNext(p,name){
 var tag=p.getNextTag();
 if(tag===void || tag.tagname!=name)throw new Exception("Expected reference tag "+name);
 return tag;
}
function referenceFinish(p){
 for(var i=0;i<30;i++){var tag=p.getNextTag();if(tag===void)throw new Exception("Missing reference end");if(tag.tagname=="done")return;}
 throw new Exception("Reference scenario exceeded its tag bound");
}
function referenceSeed(p,name,value,action=void,bytes=void){
 p.loadScenario(name);referenceNext(p,"enter");
 p.macroParams.payload=value;p.macroParams.action=action;p.macroParams.bytes=bytes;
}
var referenceNested=void,referenceNestedValue=void,referenceNestedSeen=false;
function referenceReenter(){
 var tag=referenceNext(global.referenceNested,"emit");
 global.referenceNestedSeen=tag.value===global.referenceNestedValue;
 return "nested";
}
function referenceFail(){throw new Exception("reference-stop");}
function referenceCreateFile(path){
 var p=new ReferenceParser(),value=%[count:7],bytes=<%12 ab%>,result,failed=false,primary;
 try{
  referenceSeed(p,"references-call.ks",value,void,bytes);p.expected=value;
  referenceNext(p,"emit");var d=p.store();
  result=int(d.macroArgs[0].payload===value);
  (Dictionary.saveStruct incontextof d)(path);
 }catch(e){failed=true;primary=e;}
 try{invalidate p;}catch(e){if(failed)Debug.message("reference-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return string(result);
}
function referenceReadFile(path){
 var p=new ReferenceParser(),d=Scripts.evalStorage(path),result,failed=false,primary;
 try{
  p.restore(d);var tag=referenceNext(p,"emit");
  result=tag.value.count+"|"+int(tag.value===d.macroArgs[0].payload)+"|"+int(tag.bytes==<%12 ab%>)+"|"+p.callStackDepth;
  referenceFinish(p);result+="|"+p.callStackDepth+"|"+int(p.macroParams===null);
 }catch(e){failed=true;primary=e;}
 try{invalidate p;}catch(e){if(failed)Debug.message("reference-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
function kagReferenceRun(id,p,q){
 var actor=new ReferenceActor(),action=actor.advance,bytes=<%12 ab%>,value=%[count:1],tag,d,result;
 switch(id){
  case "references-direct":
   value.self=value;
   referenceSeed(p,"references-direct.ks",value,action,bytes);tag=referenceNext(p,"emit");
   result=int(tag.value===value)+"|"+int(tag.value.self===value)+"|"+int(tag.action===action)+"|"+int(tag.bytes===bytes);
   tag.value.count=2;result+="|"+tag.action()+"|"+value.count+"|"+tag.missing;
   referenceFinish(p);value.self=void;return result+"|"+int(p.macroParams===null);
  case "references-forward":
   value.self=value;
   referenceSeed(p,"references-nested.ks",value,action,bytes);var outer=p.macroParams;
   tag=referenceNext(p,"emit");result=int(tag.payload===value)+"|"+int(tag.action===action)+"|"+int(p.macroParams!==outer);
   tag.payload.count=2;result+="|"+tag.action();tag=referenceNext(p,"after");
   result+="|"+int(tag.value===value)+"|"+tag.value.count;referenceFinish(p);value.self=void;
   return result+"|"+int(p.macroParams===null);
  case "references-store":
   referenceSeed(p,"references-call.ks",actor,action,bytes);p.expected=actor;tag=referenceNext(p,"emit");d=p.store();
   result=int(p.seen)+"|"+int(tag.value===actor)+"|"+int(d.macroArgs[0]!==p.macroParams)+"|"+int(d.macroArgs[0].payload===actor);
   q.assign(p);result+="|"+int(q.macroParams.payload===actor);
   q.restore(d);tag=referenceNext(q,"emit");result+="|"+int(tag.action===action)+"|"+tag.action()+"|"+actor.count;
   referenceFinish(q);tag=referenceNext(p,"after");result+="|"+int(tag.value===actor);referenceFinish(p);
   return result+"|"+int(p.macroParams===null && q.macroParams===null);
  case "references-file":
   result=referenceCreateFile("reference-bookmark.tjs");d=Scripts.evalStorage("reference-bookmark.tjs");
   q.restore(d);tag=referenceNext(q,"emit");
   result+="|"+tag.value.count+"|"+int(tag.value===d.macroArgs[0].payload)+"|"+int(tag.bytes==bytes)+"|"+q.callStackDepth;
   referenceFinish(q);return result+"|"+int(q.callStackDepth==0)+"|"+int(q.macroParams===null);
  case "references-reentry":
   value.self=value;
   referenceSeed(q,"references-direct.ks",actor,action,bytes);
   global.referenceNested=q;global.referenceNestedValue=actor;global.referenceNestedSeen=false;
   referenceSeed(p,"references-reentry.ks",value);tag=referenceNext(p,"emit");
   result=int(tag.value===value)+"|"+tag.again+"|"+int(global.referenceNestedSeen);
   referenceFinish(p);referenceFinish(q);value.self=void;
   return result+"|"+int(p.macroParams===null)+"|"+int(q.macroParams===null);
  case "references-error":
   value.self=value;
   referenceSeed(p,"references-error.ks",value);
   try{p.getNextTag();throw new Exception("Reference failure was not delivered");}catch(e){result=e.message;}
   referenceSeed(p,"references-direct.ks",actor,action,bytes);tag=referenceNext(p,"emit");
   result+="|"+int(tag.value===actor);referenceFinish(p);value.self=void;
   return result+"|"+int(p.macroParams===null);
  case "references-reserved":
   value.self=value;
   referenceSeed(p,"references-reserved.ks",value);
   p.macroParams.__kagReference=value;p.macroParams.values=value;p.macroParams.references=value;
   tag=referenceNext(p,"emit");result=int(tag.__kagReference===value)+"|"+int(tag.values===value)+"|"+int(tag.references===value);
   referenceFinish(p);value.self=void;return result+"|"+int(p.macroParams===null);
  case "references-omitted":
   q.loadScenario("references-empty.ks");referenceNext(q,"ch");d=q.store();delete d.macros;delete d.macroArgs;
   q.macros.kept="keep";q.restore(d);result=q.macros.kept+"|"+referenceNext(q,"ch").text;
   referenceSeed(p,"references-direct.ks",actor,action,bytes);
   d.macros=%[kept:"replacement"];System.assignMessage("TVPKAGMalformedSaveData","reference-bad-save");
   try{p.restore(d);result+="|unexpected success";}catch(e){result+="|"+e.message;}
   return result+"|"+p.macros.kept+"|"+int(p.macroParams===null)+"|"+p.store().macroArgStackDepth;
 }
 throw new Exception("Unknown reference-value control");
}
function kagReferenceObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new ReferenceParser();q=new ReferenceParser();result=kagReferenceRun(id,p,q);}
 catch(e){failed=true;primary=e;}
 global.referenceNested=void;global.referenceNestedValue=void;
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("reference-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Reference cleanup: "+cleanup.join("|"));
 return result;
}
// taglist remains the explicitly supported Web ordering extension. It is not
// a discriminator for private transport, even when an actual parameter has it.
function referenceTaglistExtension(){
 var p=new ReferenceParser(),value=%[name:"kept"],result,failed=false,primary;
 try{
  referenceSeed(p,"references-reserved.ks",value);p.macroParams.taglist=value;p.macroParams.__kagReference=value;
  var tag=referenceNext(p,"emit");result=int(tag.taglist instanceof "Array")+"|"+int(tag.taglist.indexOf("taglist")>=0)+"|"+int(tag.__kagReference===value);
  referenceFinish(p);
 }catch(e){failed=true;primary=e;}
 try{invalidate p;}catch(e){if(failed)Debug.message("reference-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

/** Game-owned tags use the original Conductor handler dictionary. No original
 * parser/handler is replaced. The same actor and bound action survive nested
 * macro forwarding across two genuine player line waits. */
export const kagReferenceStory = String.raw`*references|An actor across macro calls
[cm][nowait]\
[macro name=inner][refstep value=%payload action=%action][endmacro]\
[macro name=outer][refseed][inner *][emb exp=global.refStoryText][endnowait][l][r][nowait][inner *][emb exp=global.refStoryText][endnowait][l][endmacro]\
[outer]\
[eval exp="global.refStoryPhase=3"]\
[s]
`

export const kagReferenceGameSource = String.raw`
class StoryReferenceActor {
 var count=0;
 function advance(){count++;return count;}
}
var refStoryActor=new StoryReferenceActor(),refStoryAction=refStoryActor.advance,refStoryText="",refStoryPhase=0;
kag.tagHandlers.refseed=function(tag){
 var mp=global.kag.conductor.macroParams;
 mp.payload=global.refStoryActor;mp.action=global.refStoryAction;
 return 0;
};
kag.tagHandlers.refstep=function(tag){
 if(tag.value!==global.refStoryActor || tag.action!==global.refStoryAction)
  throw new Exception("Story macro reference identity changed");
 global.refStoryPhase=tag.action();global.refStoryText="ACTOR "+global.refStoryActor.count;
 global.Debug.message("reference-story-step:"+global.refStoryPhase);
 return 0;
};
function referenceStoryState(){
 return global.refStoryPhase+"|"+global.refStoryActor.count+"|"+global.kag.historyLayer.currentLine+"|"+
  int(global.kag.clickWaiting)+"|"+global.kag.conductor.lastTagName+"|"+int(global.kag.conductor.macroParams===null);
}
Debug.message("reference-story-ready");
`
