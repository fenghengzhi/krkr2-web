/** Original KAGParser.cpp 1818–1918: emb escapes text unconditionally,
 * consumes its delimiter before evaluation, and resumes at the live cursor.
 * Authored scenarios/literal outcomes are shared with the unchanged SDK. */
export const kagEmbeddingFiles = {
  'emb-next.ks': 'NEXT[done]\\\n',
  'emb-call.ks': '*entry\n[macro name=scene][call storage=emb-chapter.ks target=*chapter][endmacro]\\\n[scene name="[A][r]"]NEXT[done]\\\n',
  'emb-chapter.ks': '*chapter\n[emb exp=embParser.macroParams.name escape=&false][return]\\\n',
}

export const kagEmbeddingExpected: Readonly<Record<string, string>> = {
  'embedding-text': '[r]|[r]|[r]|3',
  'embedding-cursor-error': 'A|[|18|3|X]Z|emb-value|18|Z',
  'embedding-consume': '[X]Q|B|17|1',
  'embedding-reload': '[X]NEXT|emb-next.ks|17|1',
  'embedding-macros': '[A][r]/B|1|custom|0|1',
  'embedding-line-command': '16|2|1|X]Q|16|2|1|X]Q',
  'embedding-raw-tag': 'emb|embAt()|false|0',
  'embedding-bookmark': '[|1|[A][r]|[A][r]NEXT|0|1',
}

export const kagEmbeddingSource = String.raw`
var embParser=void,embValue="[X]",embCalls=0,embPosition=0,embMode="",embTaken="";
class EmbeddingParser extends KAGParser {
 var body;
 function EmbeddingParser(){super.KAGParser();debugLevel=tkdlNone;}
 function onScenarioLoad(name){return body;}
}
function embAt(){
 global.embCalls++;global.embPosition=global.embParser.curPos;
 if(global.embMode=="fail")throw new Exception("emb-value");
 if(global.embMode=="take")global.embTaken=global.embParser.getNextTag().text;
 if(global.embMode=="reload"){global.embParser.body=void;global.embParser.loadScenario("emb-next.ks");}
 return global.embValue;
}
function kagEmbeddingDrain(p){
 var result="";
 for(var i=0;i<128;i++){
  var t=p.getNextTag();
  if(t===void)throw new Exception("Embedding scenario ended before done");
  if(t.tagname=="done")return result;
  if(t.tagname=="ch")result+=t.text;
  else if(t.tagname=="r")result+="/";
  else throw new Exception("Unexpected embedding tag: "+t.tagname);
 }
 throw new Exception("Embedding scenario exceeded its tag budget");
}
function kagEmbeddingRun(id,p,q){
 var result,t,d,reason="missing-error";
 switch(id){
  case "embedding-text":
   global.embValue="[r]";
   p.body="[emb exp=embAt() escape=false]|[emb exp=embAt() escape=0]|[emb exp=embAt() escape=&false][done]\\";
   p.loadScenario("emb-live.ks");return kagEmbeddingDrain(p)+"|"+global.embCalls;
  case "embedding-cursor-error":
   p.body="A[emb exp=embAt()]Z[done]\\";p.loadScenario("emb-live.ks");result=p.getNextTag().text;
   result+="|"+p.getNextTag().text+"|"+global.embPosition+"|"+p.curPos+"|"+kagEmbeddingDrain(p);
   global.embMode="fail";p.loadScenario("emb-live.ks");p.getNextTag();
   try{p.getNextTag();}catch(e){reason=e.message;}
   return result+"|"+reason+"|"+p.curPos+"|"+p.getNextTag().text;
  case "embedding-consume":
   global.embMode="take";p.body="[emb exp=embAt()]BQ[done]\\";p.loadScenario("emb-live.ks");
   return kagEmbeddingDrain(p)+"|"+global.embTaken+"|"+global.embPosition+"|"+global.embCalls;
  case "embedding-reload":
   global.embMode="reload";p.body="[emb exp=embAt()]OLD[done]\\";p.loadScenario("emb-live.ks");
   return kagEmbeddingDrain(p)+"|"+p.curStorage+"|"+global.embPosition+"|"+global.embCalls;
  case "embedding-macros":
   p.body="[macro name=say][emb exp=embParser.macroParams.name escape=&false][endmacro][macro name=br][r][endmacro][say name='[A][r]'][br]B[done]\\";
   p.loadScenario("emb-live.ks");result=kagEmbeddingDrain(p)+"|"+int(p.macroParams===null);
   p.clear();p.body="[macro name=emb][emit value=custom][endmacro][emb exp=embAt()][done]\\";
   p.loadScenario("emb-shadow.ks");t=p.getNextTag();
   if(t.tagname!="emit")throw new Exception("A macro named emb did not expand its real tag body");
   result+="|"+t.value+"|"+global.embCalls;kagEmbeddingDrain(p);
   return result+"|"+int(p.macroParams===null);
  case "embedding-line-command":
   p.body="@emb exp=embAt()\nQ[done]\\";p.loadScenario("emb-live.ks");t=p.getNextTag();
   if(t.text!="[")throw new Exception("Missing line-command character");
   result=global.embPosition+"|"+p.curPos+"|"+int(p.curLineStr=="[[X]\\")+"|"+kagEmbeddingDrain(p);
   p.ignoreCR=true;p.loadScenario("emb-live.ks");t=p.getNextTag();
   if(t.text!="[")throw new Exception("Missing ignoreCR line-command character");
   return result+"|"+global.embPosition+"|"+p.curPos+"|"+int(p.curLineStr=="[[X]")+"|"+kagEmbeddingDrain(p);
  case "embedding-raw-tag":
   p.processSpecialTags=false;p.body="[emb exp=embAt() escape=false][done]\\";p.loadScenario("emb-live.ks");t=p.getNextTag();
   return t.tagname+"|"+t.exp+"|"+t.escape+"|"+global.embCalls;
  case "embedding-bookmark":
   p.loadScenario("emb-call.ks");result=p.getNextTag().text;d=p.store();
   result+="|"+int(d.lineBufferUsing)+"|"+d.macroArgs[0].name;
   (Dictionary.saveStruct incontextof d)("emb-bookmark.tjs");q.restore(Scripts.evalStorage("emb-bookmark.tjs"));
   global.embParser=q;return result+"|"+kagEmbeddingDrain(q)+"|"+q.callStackDepth+"|"+int(q.macroParams===null);
 }
 throw new Exception("Unknown embedding control");
}
function kagEmbeddingRetire(p,q){
 global.embParser=void;var errors=[];
 try{if(p!==void && isvalid p)invalidate p;}catch(e){errors.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){errors.add(e.message);}
 return errors;
}
function kagEmbeddingObserve(id){
 var p=void,q=void,result,cleanup;
 global.embValue="[X]";global.embCalls=0;global.embPosition=0;global.embMode="";global.embTaken="";
 try{p=new EmbeddingParser();q=new EmbeddingParser();global.embParser=p;result=kagEmbeddingRun(id,p,q);}
 catch(error){
  cleanup=kagEmbeddingRetire(p,q);
  if(cleanup.count)throw new Exception(error.message+" | KAG embedding cleanup: "+cleanup.join(" | "));
  throw error;
 }
 cleanup=kagEmbeddingRetire(p,q);
 if(cleanup.count)throw new Exception("KAG embedding cleanup: "+cleanup.join(" | "));
 return result;
}
`

/** Game-owned scenario plus observer; the original KAG framework is untouched.
 * A literal player name containing [r] must not execute a return tag. Original
 * KAG3 Config uses ignoreCR=true, where a trailing backslash is visible text. */
export const kagEmbeddingStory = String.raw`*emb_start|Embedded player name
[cm][nowait]
[macro name=sayname][emb exp=mp.text escape=&false][endmacro]
[sayname text="[A][r]"][endnowait]
[iscript]
global.embStoryPhase=1;
[endscript]
[l]
[r][nowait][emb exp="'NEXT [B]'" escape=false][endnowait]
[iscript]
global.embStoryPhase=2;
[endscript]
[l]
[iscript]
global.embStoryPhase=3;
Debug.message("emb-story-finished");
[endscript]
[s]
`

export const kagEmbeddingGameSource = String.raw`
var embStoryPhase=0;
function embStoryState(){
 return global.embStoryPhase+"|"+global.kag.historyLayer.currentLine+"|"+
  int(global.kag.clickWaiting)+"|"+int(global.kag.lineBreak.visible)+"|"+global.kag.conductor.lastTagName;
}
Debug.message("emb-story-observer-ready");
`
