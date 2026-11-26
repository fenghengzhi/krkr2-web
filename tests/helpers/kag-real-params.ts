/** Original KAGParser % substitution copies the TJS variant. An integral
 * real remains Real; expression/string conversion is performed by TJS. */
const realFields = 'whole=%whole negative=%negative positive=%positive fraction=%fraction large=%large integer=%integer text=%text'
export const kagRealFiles = {
  'real-direct.ks': `[macro name=relay][enter][emit ${realFields}][endmacro][relay][done]\n`,
  'real-forward.ks': `[macro name=inner][emit ${realFields}][endmacro][macro name=outer][enter][inner *][after whole=%whole][endmacro][outer][done]\n`,
  'real-expression.ks': '[macro name=relay][enter][emb exp=%negative]|[emb exp=%positive]|[emb exp=%fraction][if exp=%fraction]Y[else]N[endif][endmacro][relay][done]\n',
  'real-entry.ks': '*entry\n[macro name=relay][enter][call storage=real-chapter.ks target=*chapter]AFTER[endmacro]\n[relay][done]\n',
  'real-chapter.ks': `*chapter\n[emit ${realFields}][return]\n`,
  'real-error.ks': '[macro name=relay][enter][emit whole=%whole fail=&kagRealThrow()][endmacro][relay][done]\n',
}
export const kagRealDescription = 'Real,Real,Real,Real,Real,Integer,String|1|-0.0|+0.0|0.125|1|0|1'
export const kagRealExpected: Readonly<Record<string, string>> = {
  'reals-direct': kagRealDescription + '|1',
  'reals-forward': kagRealDescription + '|Real|1|1',
  'reals-expression': '-0.0|+0.0|0.125Y|1',
  'reals-bookmark': kagRealDescription + '|AFTER|0|1',
  'reals-error': 'real-argument-error|Real|' + kagRealDescription + '|1',
}
export const kagRealSource = String.raw`
class RealParamParser extends KAGParser {
 function RealParamParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
}
function realNext(p,name){
 var tag=p.getNextTag();if(tag===void || tag.tagname!=name)throw new Exception("Expected real parameter tag "+name);
 return tag;
}
function realDrain(p){
 var text="";
 for(var i=0;i<100;i++){
  var tag=p.getNextTag();if(tag===void)throw new Exception("Missing real parameter end");
  if(tag.tagname=="done")return text;
  if(tag.tagname!="ch")throw new Exception("Unexpected real parameter tag "+tag.tagname);
  text+=tag.text;
 }
 throw new Exception("Real parameter control exceeded its bound");
}
function realSeed(p,file){
 p.loadScenario(file);realNext(p,"enter");var mp=p.macroParams;
 mp.whole=1.0;mp.negative=-0.0;mp.positive=0.0;mp.fraction=0.125;
 mp.large=18446744073709551616.0;mp.integer=1;mp.text="1";
}
function realDescribe(tag){
 return [typeof tag.whole,typeof tag.negative,typeof tag.positive,typeof tag.fraction,typeof tag.large,typeof tag.integer,typeof tag.text].join(",")+
  "|"+string(tag.whole)+"|"+string(tag.negative)+"|"+string(tag.positive)+"|"+string(tag.fraction)+
  "|"+int(tag.large===18446744073709551616.0)+"|"+int(tag.whole===tag.integer)+"|"+int(tag.whole==tag.integer);
}
function kagRealThrow(){throw new Exception("real-argument-error");}
function kagRealRun(id,p,q){
 var tag,result;
 switch(id){
  case "reals-direct":
   realSeed(p,"real-direct.ks");result=realDescribe(realNext(p,"emit"));realNext(p,"done");
   return result+"|"+int(p.macroParams===null);
  case "reals-forward":
   realSeed(p,"real-forward.ks");result=realDescribe(realNext(p,"emit"));p.macroParams.whole=2.0;
   tag=realNext(p,"after");result+="|"+(typeof tag.whole)+"|"+string(tag.whole);realNext(p,"done");
   return result+"|"+int(p.macroParams===null);
  case "reals-expression":
   realSeed(p,"real-expression.ks");result=realDrain(p);return result+"|"+int(p.macroParams===null);
  case "reals-bookmark":
   realSeed(p,"real-entry.ks");realNext(p,"emit");var saved=p.store();
   (Dictionary.saveStruct incontextof saved)("real-bookmark.tjs");
   q.restore(Scripts.evalStorage("real-bookmark.tjs"));result=realDescribe(realNext(q,"emit"));
   result+="|"+realDrain(q)+"|"+q.callStackDepth+"|"+int(q.macroParams===null);realDrain(p);return result;
  case "reals-error":
   realSeed(p,"real-error.ks");
   try{p.getNextTag();result="unexpected success";}catch(e){result=e.message;}
   result+="|"+(typeof p.macroParams.whole);p.clear();
   realSeed(p,"real-direct.ks");result+="|"+realDescribe(realNext(p,"emit"));realNext(p,"done");
   return result+"|"+int(p.macroParams===null);
 }
 throw new Exception("Unknown real parameter control");
}
function kagRealObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new RealParamParser();q=new RealParamParser();result=kagRealRun(id,p,q);}catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("reals-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Real parameter cleanup: "+cleanup.join("|"));
 return result;
}
function kagRealResume(path){
 var p=void,result,failed=false,primary;
 try{
  p=new RealParamParser();p.restore(Scripts.evalStorage(path));result=realDescribe(realNext(p,"emit"));
  result+="|"+realDrain(p)+"|"+p.callStackDepth+"|"+int(p.macroParams===null);
 }catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("reals-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagRealStory = String.raw`*reals|Computed game values
[cm]
[macro name=inner][realstep amount=%amount rate=%rate zero=%zero][endmacro]
[macro name=outer][realseed][inner *][nowait][emb exp=global.realStoryText][endnowait][l][r][eval exp="mp.amount+=1.0"][inner *][nowait][emb exp=global.realStoryText][endnowait][l][endmacro]
[outer]
[eval exp="global.realStoryPhase=3"]
[s]
`
export const kagRealGameSource = String.raw`
var realStoryPhase=0,realStoryText="",realStoryTypes="";
kag.tagHandlers.realseed=function(tag){
 var mp=global.kag.conductor.macroParams;
 mp.amount=4.0/4;mp.rate=1.0/8;mp.zero=-0.0;
 return 0;
};
kag.tagHandlers.realstep=function(tag){
 if(typeof tag.amount!="Real" || typeof tag.rate!="Real" || typeof tag.zero!="Real" || string(tag.zero)!="-0.0")
  throw new Exception("Story macro changed a computed real value");
 global.realStoryPhase++;
 global.realStoryTypes=[typeof tag.amount,typeof tag.rate,typeof tag.zero].join(",");
 global.realStoryText="TOTAL "+string(tag.amount)+" RATE "+string(tag.rate)+" ZERO "+string(tag.zero);
 global.Debug.message("real-story-step:"+global.realStoryPhase);
 return 0;
};
function realStoryState(){
 return global.realStoryPhase+"|"+global.realStoryTypes+"|"+global.kag.historyLayer.currentLine+"|"+
  int(global.kag.clickWaiting)+"|"+global.kag.conductor.lastTagName+"|"+int(global.kag.conductor.macroParams===null);
}
Debug.message("real-story-ready");
`
