/** KAG MainWindow.storeFlags sets mainConductor.macros=void when saveMacros
 * is false. KAGParser.cpp Restore only assigns a non-void macro snapshot. */
export const kagOptionalMacroFiles = {
  'optional-entry.ks': '*entry\n[macro name=speak][emit value=stored][endmacro]\\\n[macro name=route][call storage=optional-sub.ks target=*sub][endmacro]\\\n[route actor=A][speak][done]\\\n',
  'optional-sub.ks': '*sub\n[seen actor=%actor][return]\\\n',
}
export const kagOptionalMacroExpected: Readonly<Record<string, string>> = {
  'optional-macros-live': 'A|1|A|current|0|1',
  'optional-macros-new-parser': '1|current|extra|A|current|0|1',
  'optional-macros-absent': 'A|current|extra|0|1',
  'optional-macros-present': 'A|stored|1|A|speak|1|0',
}
export const kagOptionalMacroSource = String.raw`
class OptionalMacroParser extends KAGParser {
 var watching=false,loadedMacro="";
 function OptionalMacroParser(){super.KAGParser();debugLevel=tkdlNone;}
 function onScenarioLoad(name){if(watching)loadedMacro=macros.speak;}
}
function optionalMacroNext(p,name){
 var t=p.getNextTag();
 if(t===void || t.tagname!=name)throw new Exception("Expected optional-macro tag "+name);
 return t;
}
function optionalMacroSave(p){
 p.loadScenario("optional-entry.ks");
 if(optionalMacroNext(p,"seen").actor!="A")throw new Exception("Missing active macro argument");
 return p.store();
}
function optionalMacroResume(p){
 var result=optionalMacroNext(p,"seen").actor+"|"+optionalMacroNext(p,"emit").value;
 optionalMacroNext(p,"done");return result+"|"+p.callStackDepth+"|"+int(p.macroParams===null);
}
function kagOptionalMacroRun(id,p,q){
 var d=optionalMacroSave(p),result,original;
 switch(id){
  case "optional-macros-live":
   d.macros=void;original=p.macros;p.macros.speak="[emit value=current][macropop]";
   p.restore(d);return d.macroArgs[0].actor+"|"+int(original===p.macros)+"|"+optionalMacroResume(p);
  case "optional-macros-new-parser":
   d.macros=void;(Dictionary.saveStruct incontextof d)("optional-macros.tjs");
   q.macros.speak="[emit value=current][macropop]";q.macros.extra="extra";original=q.macros;q.watching=true;
   q.restore(Scripts.evalStorage("optional-macros.tjs"));
   result=int(original===q.macros)+"|"+(q.loadedMacro=="[emit value=current][macropop]"?"current":"wrong")+"|"+q.macros.extra;
   return result+"|"+optionalMacroResume(q);
  case "optional-macros-absent":
   delete d.macros;q.macros.speak="[emit value=current][macropop]";q.macros.extra="extra";
   q.restore(d);result=optionalMacroNext(q,"seen").actor+"|"+optionalMacroNext(q,"emit").value+"|"+q.macros.extra;
   optionalMacroNext(q,"done");return result+"|"+q.callStackDepth+"|"+int(q.macroParams===null);
  case "optional-macros-present":
   q.macros.speak="[emit value=current][macropop]";q.macros.extra="extra";q.restore(d);
   result=optionalMacroNext(q,"seen").actor+"|"+optionalMacroNext(q,"emit").value+"|"+int(q.macros.extra===void);
   optionalMacroNext(q,"done");d.macros=%[];q.macros.extra="extra";q.restore(d);
   result+="|"+optionalMacroNext(q,"seen").actor+"|"+optionalMacroNext(q,"speak").tagname+"|"+int(q.macros.extra===void);
   optionalMacroNext(q,"done");return result+"|"+q.callStackDepth;
 }
 throw new Exception("Unknown optional-macro control");
}
function kagOptionalMacroRetire(p,q){
 var errors=[];
 try{if(p!==void && isvalid p)invalidate p;}catch(e){errors.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){errors.add(e.message);}
 return errors;
}
function kagOptionalMacroObserve(id){
 var p=void,q=void,result,cleanup;
 try{p=new OptionalMacroParser();q=new OptionalMacroParser();result=kagOptionalMacroRun(id,p,q);}
 catch(error){
  cleanup=kagOptionalMacroRetire(p,q);
  if(cleanup.count)throw new Exception(error.message+" | KAG optional-macro cleanup: "+cleanup.join(" | "));
  throw error;
 }
 cleanup=kagOptionalMacroRetire(p,q);
 if(cleanup.count)throw new Exception("KAG optional-macro cleanup: "+cleanup.join(" | "));
 return result;
}
`

// Original KAG3 ignores physical newlines; backslash suffixes are not needed.
export const kagOptionalMacroStory = String.raw`[macro name=word]OLD[endmacro]
*checkpoint|Current macro definitions
[cm][hr][nowait][word][endnowait]
[iscript]
global.optionalVisits++;
global.optionalRendered=global.kag.historyLayer.currentLine;
[endscript]
[r][link target=*save]Save[endlink] / [link target=*load]Load updated[endlink] / [link target=*end]Continue[endlink]
[s]
*save
[save place=0 ask=false]
[iscript]
global.optionalSaved=true;
[endscript]
[jump target=*checkpoint]
*load
[iscript]
global.kag.conductor.macros.word="NEW[macropop]";
[endscript]
[load place=0 ask=false]
*end
[cm][hr][nowait]DONE[endnowait]
[iscript]
global.optionalRendered=global.kag.historyLayer.currentLine;
global.optionalDone=true;
Debug.message("optional-macro-story-finished");
[endscript]
[s]
`

/** Only this authored observer is compiled in the bytecode browser variant.
 * The game uses the original public save/load tags and savable-label hooks. */
export const kagOptionalMacroGameSource = String.raw`
global.kag.saveMacros=false;
var optionalVisits=0,optionalSaved=false,optionalRendered="",optionalDone=false;
function optionalStoryState(){
 return [global.optionalVisits,global.optionalRendered,int(global.optionalSaved),global.kag.currentLabel,
  global.kag.current.numLinks,global.kag.conductor.status,int(global.optionalDone)].join("|");
}
function optionalStoredState(){
 var k=global.kag,mode="";
 if(k.saveThumbnail)mode="o"+k.calcThumbnailSize().size;
 var d=Scripts.evalStorage(k.getBookMarkFileNameAtNum(0),mode);
 return [int(d.core.mainConductor.macros===void),d.core.mainConductor.curLabel,
  d.core.mainConductor.macroArgs.count,int(k.saveMacros)].join("|");
}
Debug.message("optional-macro-observer-ready");
`
