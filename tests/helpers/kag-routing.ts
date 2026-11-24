/** Independent authored inputs for the original SDK's callback reentry rules.
 * All native loops are bounded by their callback or terminate at [done]. */
export const kagRoutingFiles = {
  'routing-start.ks': '[jump]OLD[done]\\\n',
  'routing-next.ks': '*dest\nNEW[done]\\\n',
  'routing-label.ks': '[jump]OLD[done]\\\n*dest\nLABEL[done]\\\n',
  'routing-retry.ks': '*again\n[jump]R[done]\\\n',
  'routing-target.ks': '[jump target=*first]OLD[done]\\\n*first\nFIRST[done]\\\n*other\nWRONG[done]\\\n',
  'routing-call.ks': '[call target=*sub]OLD[done]\\\n',
  'routing-call-next.ks': 'ZDATA[done]\\\n*sub\nS[return]\\\n',
}
export const kagRoutingExpected: Readonly<Record<string, string>> = {
  'routing-reload': 'NEW|routing-next.ks|*dest|1|routing-start.ks,routing-next.ks',
  'routing-label': 'LABEL|*dest|1',
  'routing-retry': 'R|2',
  'routing-target-copy': 'FIRST|*first|*other',
  'routing-call-reload': 'SDATA|routing-call-next.ks|0|1|routing-call.ks,routing-call-next.ks,routing-call-next.ks',
  'routing-clear': '1||interrupt|NEW',
}
export const kagRoutingSource = String.raw`
class RoutingParser extends KAGParser {
  var mode="",jumps=0,calls=0,changedTarget="",loaded=[];
  function RoutingParser(){super.KAGParser();debugLevel=tkdlNone;}
  function onScenarioLoaded(name){loaded.add(name);}
  function onJump(t){
    jumps++;
    if(jumps>3)throw new Exception("Routing callback exceeded its finite input bound");
    if(mode=="reload"){loadScenario("routing-next.ks");return true;}
    if(mode=="label"){goToLabel("*dest");return true;}
    if(mode=="retry"){if(jumps<2){goToLabel("*again");return true;}return false;}
    if(mode=="target-copy"){t.target="*other";changedTarget=t.target;return true;}
    if(mode=="clear"){clear();interrupt();return true;}
    return true;
  }
  function onCall(t){
    calls++;
    if(calls>2)throw new Exception("Routing call exceeded its finite input bound");
    if(mode=="call-reload")loadScenario("routing-call-next.ks");
    return true;
  }
}
function kagRoutingDrain(p){
  var out="",t,n=0;
  while((t=p.getNextTag())!==void){
    if(++n>100)throw new Exception("Routing text exceeded its tag bound");
    if(t.tagname=="done")return out;
    if(t.tagname=="ch")out+=t.text;
    else out+="<"+t.tagname+">";
  }
  return out;
}
function kagRoutingRun(id,p){
  var result;
  p.mode=id.substr(8);
  switch(p.mode){
    case "reload":
      p.loadScenario("routing-start.ks");result=kagRoutingDrain(p);
      return result+"|"+p.curStorage+"|"+p.curLabel+"|"+p.jumps+"|"+p.loaded.join(",");
    case "label":
      p.loadScenario("routing-label.ks");result=kagRoutingDrain(p);
      return result+"|"+p.curLabel+"|"+p.jumps;
    case "retry":
      p.loadScenario("routing-retry.ks");return kagRoutingDrain(p)+"|"+p.jumps;
    case "target-copy":
      p.loadScenario("routing-target.ks");result=kagRoutingDrain(p);
      return result+"|"+p.curLabel+"|"+p.changedTarget;
    case "call-reload":
      p.loadScenario("routing-call.ks");result=kagRoutingDrain(p);
      return result+"|"+p.curStorage+"|"+p.callStackDepth+"|"+p.calls+"|"+p.loaded.join(",");
    case "clear":
      p.loadScenario("routing-start.ks");result=int(p.getNextTag()===void)+"|"+p.curStorage;
      p.loadScenario("routing-next.ks");result+="|"+p.getNextTag().tagname;
      return result+"|"+kagRoutingDrain(p);
  }
  throw new Exception("Unknown routing control");
}
function kagRoutingObserve(id){
  var p=void,result;
  try{p=new RoutingParser();result=kagRoutingRun(id,p);}
  catch(error){
    try{if(isvalid p)invalidate p;}
    catch(cleanup){throw new Exception(error.message+" | KAG routing cleanup: "+cleanup.message);}
    throw error;
  }
  if(isvalid p)invalidate p;
  return result;
}
`
