/** Authored controls shared by the original 2.32r2 SDK and actual Web TJS.
 * KAGParser.cpp: Push/Pop/ClearMacroArgs 1200–1244, assign 404–432,
 * Store 510–525 and Restore 730–779. Expectations are independent literals. */
export const kagMacroSlotFiles = {
  'slots-flat.ks': '*entry\n[macro name=slot][emit actor=%actor][endmacro]\\\n[slot actor=A][slot actor=B][done]\\\n',
  'slots-b.ks': '[slot actor=B][done]\\\n',
  'slots-nested.ks': '*entry\n[macro name=inner][emit actor=%actor][endmacro]\\\n[macro name=outer][enter actor=%actor][inner actor=one][inner actor=two][leave actor=%actor][endmacro]\\\n[outer actor=A][outer actor=B][done]\\\n',
  'slots-call.ks': '*entry\n[macro name=scene][call storage=slots-chapter.ks target=*chapter][endmacro]\\\n[scene actor=A][scene actor=B][done]\\\n',
  'slots-chapter.ks': '*chapter\n[emit actor=%actor][return]\\\n',
}

export const kagMacroSlotExpected: Readonly<Record<string, string>> = {
  'slots-reuse': 'A|B|1|1|1|B',
  'slots-nested': 'A|one|two|1|1|A|B|1|one|1|1',
  'slots-reset': '1|B|1|1|A|1|A|retained|1',
  'slots-store-active': '1|1|A|0|0|1|A',
  'slots-assign': '1|1|A|copy|2|1|1|1|A|B|1|1',
  'slots-bookmark': 'A|B|A|1|A|1|1|B|1|1',
  'slots-self-assign': '1|0|0|1|A',
}

export const kagMacroSlotSource = String.raw`
class MacroSlotParser extends KAGParser {
  function MacroSlotParser(){super.KAGParser();debugLevel=tkdlNone;}
}
function kagSlotNext(p,name){
  var t=p.getNextTag();
  if(t===void || t.tagname!=name)throw new Exception("Expected macro-slot tag "+name);
  return t;
}
function kagSlotFinish(p){
  for(var i=0;i<40;i++){
    var t=p.getNextTag();
    if(t===void)throw new Exception("Missing macro-slot end tag");
    if(t.tagname=="done")return;
  }
  throw new Exception("Macro-slot control exceeded tag budget");
}
function kagMacroSlotRun(id,p,q){
  var first,second,outer,inner,d,s,result;
  switch(id){
    case "slots-reuse":
      p.loadScenario("slots-flat.ks");result=kagSlotNext(p,"emit").actor;
      first=p.macroParams;first.extra="temporary";
      result+="|"+kagSlotNext(p,"emit").actor+"|"+int(first===p.macroParams)+"|"+int(first.extra===void);
      kagSlotFinish(p);return result+"|"+int(p.macroParams===null)+"|"+first.actor;
    case "slots-nested":
      p.loadScenario("slots-nested.ks");result=kagSlotNext(p,"enter").actor;outer=p.macroParams;
      result+="|"+kagSlotNext(p,"emit").actor;inner=p.macroParams;
      result+="|"+kagSlotNext(p,"emit").actor+"|"+int(inner===p.macroParams)+"|"+int(inner!==outer);
      result+="|"+kagSlotNext(p,"leave").actor;
      if(p.macroParams!==outer)throw new Exception("Nested macro did not return to its outer slot");
      result+="|"+kagSlotNext(p,"enter").actor+"|"+int(outer===p.macroParams);
      result+="|"+kagSlotNext(p,"emit").actor+"|"+int(inner===p.macroParams);
      kagSlotFinish(p);return result+"|"+int(p.macroParams===null);
    case "slots-reset":
      p.loadScenario("slots-flat.ks");kagSlotNext(p,"emit");first=p.macroParams;
      p.popMacroArgs();result=int(p.macroParams===null);
      p.loadScenario("slots-b.ks");result+="|"+kagSlotNext(p,"emit").actor+"|"+int(first===p.macroParams);
      p.clearCallStack();result+="|"+int(p.macroParams===null);
      p.loadScenario("slots-flat.ks");result+="|"+kagSlotNext(p,"emit").actor+"|"+int(first===p.macroParams);
      first.actor="retained";p.clear();p.loadScenario("slots-flat.ks");
      result+="|"+kagSlotNext(p,"emit").actor+"|"+first.actor+"|"+int(first!==p.macroParams);
      return result;
    case "slots-store-active":
      p.loadScenario("slots-nested.ks");kagSlotNext(p,"enter");
      kagSlotNext(p,"emit");kagSlotNext(p,"emit");kagSlotNext(p,"leave");
      d=p.store();result=d.macroArgs.count+"|"+d.macroArgStackDepth+"|"+d.macroArgs[0].actor;
      kagSlotFinish(p);s=p.store();result+="|"+s.macroArgs.count+"|"+s.macroArgStackDepth;
      q.assign(p);return result+"|"+int(q.macroParams===null)+"|"+d.macroArgs[0].actor;
    case "slots-assign":
      // Both parsers have a live slot before assignment. Only the destination
      // slot is replaced; contained objects retain native shallow identity.
      p.loadScenario("slots-flat.ks");kagSlotNext(p,"emit");first=p.macroParams;first.shared=%[value:1];
      q.loadScenario("slots-flat.ks");kagSlotNext(q,"emit");second=q.macroParams;second.actor="old-copy";
      q.assign(p);result=int(q.macroParams!==first)+"|"+int(q.macroParams.shared===first.shared);
      q.macroParams.actor="copy";q.macroParams.shared.value=2;
      result+="|"+first.actor+"|"+q.macroParams.actor+"|"+first.shared.value+"|"+int(second.actor=="old-copy");
      q.clear();result+="|"+int(q.macroParams===null)+"|"+int(first===p.macroParams)+"|"+first.actor;
      result+="|"+kagSlotNext(p,"emit").actor+"|"+int(first===p.macroParams)+"|"+int(first.shared===void);
      return result;
    case "slots-bookmark":
      p.loadScenario("slots-call.ks");result=kagSlotNext(p,"emit").actor;first=p.macroParams;
      d=p.store();(Dictionary.saveStruct incontextof d)("slot-bookmark.tjs");
      result+="|"+kagSlotNext(p,"emit").actor+"|"+d.macroArgs[0].actor+"|"+int(first===p.macroParams);
      p.restore(Scripts.evalStorage("slot-bookmark.tjs"));
      result+="|"+kagSlotNext(p,"emit").actor+"|"+int(first!==p.macroParams)+"|"+p.callStackDepth;
      result+="|"+kagSlotNext(p,"emit").actor+"|"+int(first!==p.macroParams);
      kagSlotFinish(p);return result+"|"+int(p.macroParams===null);
    case "slots-self-assign":
      // Native operator= clears MacroArgs before reading ref's depth. Do not
      // continue the now-unbalanced expansion; clear safely after observing.
      p.loadScenario("slots-flat.ks");kagSlotNext(p,"emit");first=p.macroParams;p.assign(p);d=p.store();
      result=int(p.macroParams===null)+"|"+d.macroArgStackDepth+"|"+d.macroArgs.count+"|"+int(isvalid first)+"|"+first.actor;
      p.clear();return result;
  }
  throw new Exception("Unknown macro-slot control");
}
function kagMacroSlotRetire(p,q){
  var errors=[];
  try{if(p!==void && isvalid p)invalidate p;}catch(e){errors.add(e.message);}
  try{if(q!==void && isvalid q)invalidate q;}catch(e){errors.add(e.message);}
  return errors;
}
function kagMacroSlotObserve(id){
  var p=void,q=void,result,cleanup;
  try{p=new MacroSlotParser();q=new MacroSlotParser();result=kagMacroSlotRun(id,p,q);}
  catch(error){
    cleanup=kagMacroSlotRetire(p,q);
    if(cleanup.count)throw new Exception(error.message+" | KAG macro-slot cleanup: "+cleanup.join(" | "));
    throw error;
  }
  cleanup=kagMacroSlotRetire(p,q);
  if(cleanup.count)throw new Exception("KAG macro-slot cleanup: "+cleanup.join(" | "));
  return result;
}
`
