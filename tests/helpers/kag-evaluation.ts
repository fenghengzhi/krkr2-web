/** The same authored scenarios and literal observations run in the original
 * 2.32r2 SDK and the Web source/bytecode entry points. No parser result is used
 * to construct the expectations. KAGParser.cpp calls TVPExecuteExpression
 * without Owner at 1732/1765/1833/2188/2226; callbacks still receive Owner. */
export const kagEvaluationFiles = {
  'scope-entry.ks': '*start\n[macro name=scope][call storage=scope-chapter.ks target=*chapter][endmacro]\\\n[scope actor=Alice][done value=&kagEvalValue]\\\n',
  'scope-chapter.ks': '*chapter\n[emit formal=%actor value=&kagEvalValue]\\\n[if exp="kagEvalFlag"]G[else]P[endif][return]\\\n',
}
export const kagEvaluationExpected: Readonly<Record<string, string>> = {
  'expression-scope': 'GEI<global>[global]|parser|0',
  'expression-write': 'changed|changed|parser',
  'expression-macro': 'Alice|global|Alice|after|1',
  'expression-reentry': '<callback-global>|callback-global|callback-local|1|1',
  'expression-bookmark': 'Alice|before|Alice|restored|1|G<restored>|0|1',
}
export const kagEvaluationSource = String.raw`
var kagEvalValue="global",kagEvalFlag=true;
class EvaluationParser extends KAGParser {
  var kagEvalValue="parser",kagEvalFlag=false,body,nested,nestedValue="",scriptCalls=0,callbackOwner=false;
  function EvaluationParser(){super.KAGParser();debugLevel=tkdlNone;}
  function onScenarioLoad(name){return body;}
  function onScript(source,name,line){
    scriptCalls++;callbackOwner=this!==global;kagEvalValue="callback-local";
    global.kagEvalValue="callback-global";
    nestedValue=nested.getNextTag().value;
    Scripts.exec(source,name,line);
  }
}
function kagEvalDrain(parser){
  var output="",n=0,t;
  while((t=parser.getNextTag())!==void){
    if(++n>100)throw new Exception("KAG evaluation control exceeded tag budget");
    if(t.tagname=="ch")output+=t.text;
    else if(t.tagname=="r")output+="/";
    else output+="<"+t.value+">";
  }
  return output;
}
function kagEvaluateRun(id,p,q){
  var first,result,d;
  switch(id){
    case "expression-scope":
      p.body="[if exp='kagEvalFlag && this===global']G[else]P[endif][if exp=false]N[elsif exp=\"kagEvalValue=='global'\"]E[else]N[endif][ignore exp='!kagEvalFlag']I[endignore][emit cond='this===global' value=&kagEvalValue][emb exp=\"'['+kagEvalValue+']'\"]\\";
      p.loadScenario("scope-live.ks");
      return kagEvalDrain(p)+"|"+p.kagEvalValue+"|"+int(p.kagEvalFlag);
    case "expression-write":
      p.body="[emit value=&\"kagEvalValue='changed'\" cond=\"kagEvalValue=='changed'\"]\\";
      p.loadScenario("scope-live.ks");first=p.getNextTag().value;
      return first+"|"+global.kagEvalValue+"|"+p.kagEvalValue;
    case "expression-macro":
      p.body="[macro name=scope][emit formal=%actor value=&kagEvalValue cond=kagEvalFlag][emb exp=kagEvalValue][endmacro][scope actor=Alice]\\";
      p.loadScenario("scope-live.ks");first=p.getNextTag();
      result=first.formal+"|"+first.value+"|"+p.macroParams.actor;
      global.kagEvalValue="after";
      return result+"|"+kagEvalDrain(p)+"|"+int(p.macroParams===null);
    case "expression-reentry":
      global.kagEvalFlag=false;
      q.body="[emit value=&kagEvalValue cond='this===global']\\";q.loadScenario("scope-nested.ks");p.nested=q;
      p.body="[iscript]\nglobal.kagEvalFlag=true;\n[endscript]\n[emit value=&kagEvalValue cond=kagEvalFlag]\\";
      p.loadScenario("scope-live.ks");
      return kagEvalDrain(p)+"|"+p.nestedValue+"|"+p.kagEvalValue+"|"+p.scriptCalls+"|"+int(p.callbackOwner);
    case "expression-bookmark":
      global.kagEvalValue="before";global.kagEvalFlag=false;p.loadScenario("scope-entry.ks");
      first=p.getNextTag();result=first.formal+"|"+first.value;
      d=p.store();(Dictionary.saveStruct incontextof d)("scope-bookmark.tjs");
      global.kagEvalValue="restored";global.kagEvalFlag=true;
      q.restore(Scripts.evalStorage("scope-bookmark.tjs"));first=q.getNextTag();
      result+="|"+first.formal+"|"+first.value+"|"+q.callStackDepth;
      return result+"|"+kagEvalDrain(q)+"|"+q.callStackDepth+"|"+int(q.macroParams===null);
  }
  throw new Exception("Unknown KAG evaluation control");
}
function kagEvaluationRetire(p,q){
  var errors=[];
  try{if(isvalid p)invalidate p;}catch(e){errors.add(e.message);}
  try{if(isvalid q)invalidate q;}catch(e){errors.add(e.message);}
  return errors;
}
function kagEvaluateObserve(id){
  global.kagEvalValue="global";global.kagEvalFlag=true;
  var p=void,q=void,result,cleanup;
  try{p=new EvaluationParser();q=new EvaluationParser();result=kagEvaluateRun(id,p,q);}
  catch(error){
    cleanup=kagEvaluationRetire(p,q);
    if(cleanup.count)throw new Exception(error.message+" | KAG cleanup: "+cleanup.join(" | "));
    throw error;
  }
  cleanup=kagEvaluationRetire(p,q);
  if(cleanup.count)throw new Exception("KAG cleanup: "+cleanup.join(" | "));
  return result;
}
`
