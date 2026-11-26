import { kagEvaluationFiles, kagEvaluationExpected, kagEvaluationSource } from './kag-evaluation.ts'
import { kagRoutingFiles, kagRoutingExpected, kagRoutingSource } from './kag-routing.ts'
import { kagMacroSlotFiles, kagMacroSlotExpected, kagMacroSlotSource } from './kag-macro-slots.ts'
import { kagEmbeddingFiles, kagEmbeddingExpected, kagEmbeddingSource } from './kag-embedding.ts'

/** Shared TJS controls for the 2.32r2 SDK and the Web runtime. The SDK
 * produces its own macro bookmark from a real call into another storage. */
export const kagFiles = {
  'entry.ks': '*start\n[macro name=scene][call storage=chapter.ks target=*chapter][endmacro]\\\n[scene actor=Alice][finished]\\\n',
  'chapter.ks': '*chapter\n[observe actor=%actor]\\\n[return]\\\n',
  'empty.ks': '',
  ...kagEvaluationFiles,
  ...kagRoutingFiles,
  ...kagMacroSlotFiles,
  ...kagEmbeddingFiles,
}

export const kagExpected: Readonly<Record<string, string>> = {
  'shared-cache': 'AAAAB', 'cache-lru': 'AAY', 'failed-load-lru': 'empty:<empty.ks>|A',
  'compact': 'AAB', 'callback-bypass': 'VDVX',
  'assign-flags': 'Y|interrupt|0|1', 'alias-collision': 'Y|Z',
  'active-macro': 'Alice|Alice|1|Alice|live|1|Alice|live|finished|0|1',
  'legacy-bookmark': 'Alice|1|Alice|legacy|1|Alice|legacy|finished|0|1', 'lost-return': 'lost-position',
  'forward-current': 'Alice|new|1', 'call-cursor': 'Y|0|16', 'syntax-cursor': 'bad-tag|0|13',
  'attribute-before-error': 'bad-tag|1',
  'empty-file': 'empty:<empty.ks>', 'empty-callback': 'empty:<>',
  'empty-label': 'first-label', 'missing-label': 'missing:<chapter.ks>:<*absent>',
  'inline-eof': 'no-endscript', 'macro-label': 'label-or-script', 'macro-script': 'label-or-script',
  'stray-endmacro': 'bad-tag', 'empty-if': 'bad-tag', 'macro-underflow': 'bad-tag',
  'bad-lexer': 'bad-tag', 'return-underflow': 'no-call', 'erase-unknown': 'no-macro:<missing>',
  'bad-save-depth': 'bad-save', 'assign-object': 'bad-parser', 'changed-holder': 'changed:<*absent>:<chapter.ks>',
  ...kagEvaluationExpected,
  ...kagRoutingExpected,
  ...kagMacroSlotExpected,
  ...kagEmbeddingExpected,
}

export const kagControlSource = String.raw`
System.exitOnWindowClose=false;
class RefParser extends KAGParser {
  var body, watch=false, loadedArgs="", veto=false, callAt="";
  function RefParser(){super.KAGParser();debugLevel=tkdlNone;}
  function onScenarioLoad(n){
    if(watch && macroParams!==null) loadedArgs=callStackDepth+"|"+macroParams.actor+"|"+macroParams.extra;
    return body;
  }
  function onCall(t){if(veto){callAt=curLine+"|"+curPos;return false;}return true;}
}
function kagHolders(){
  System.assignMessage("TVPKAGNoLine","empty:<%1>");
  System.assignMessage("TVPKAGCannotOmmitFirstLabelName","first-label");
  System.assignMessage("TVPKAGLabelNotFound","missing:<%1>:<%2>");
  System.assignMessage("TVPKAGInlineScriptNotEnd","no-endscript");
  System.assignMessage("TVPLabelOrScriptInMacro","label-or-script");
  System.assignMessage("TVPKAGSyntaxError","bad-tag");
  System.assignMessage("TVPKAGCallStackUnderflow","no-call");
  System.assignMessage("TVPKAGReturnLostSync","lost-position");
  System.assignMessage("TVPUnknownMacroName","no-macro:<%1>");
  System.assignMessage("TVPKAGMalformedSaveData","bad-save");
  System.assignMessage("TVPKAGSpecifyKAGParser","bad-parser");
}
function kagFirst(p,n){p.loadScenario(n);return string(p.getNextTag().text);}
function kagSavePoint(){
  var p=new RefParser();p.loadScenario("entry.ks");
  if(p.getNextTag().actor!="Alice" || p.callStackDepth!=1)throw new Exception("missing original macro call");
  p.macroParams.extra="live";
  return p.store();
}
function kagResumePoint(d){
  var q=new RefParser();q.watch=true;q.restore(d);
  var restored=q.getNextTag().actor+"|"+q.callStackDepth+"|"+q.macroParams.actor+"|"+q.macroParams.extra+"|"+q.loadedArgs;
  return restored+"|"+q.getNextTag().tagname+"|"+q.callStackDepth+"|"+int(q.macroParams===null);
}
function kagObserve(id){
  if(id.indexOf("expression-")==0){try{return kagEvaluateObserve(id);}catch(e){return e.message;}}
  if(id.indexOf("routing-")==0){try{return kagRoutingObserve(id);}catch(e){return e.message;}}
  if(id.indexOf("slots-")==0){try{return kagMacroSlotObserve(id);}catch(e){return e.message;}}
  if(id.indexOf("embedding-")==0){try{return kagEmbeddingObserve(id);}catch(e){return e.message;}}
  kagHolders();
  var p=new RefParser(),q=new RefParser(),r=new RefParser(),n="case-live.ks",result="",d;
  p.clear();
  try {
    switch(id){
      case "shared-cache":
        ["A"].save(n); result=kagFirst(p,n); ["B"].save(n);
        result+=kagFirst(p,n); result+=kagFirst(q,n); q.clear();
        result+=kagFirst(p,n); return result+kagFirst(r,n);
      case "cache-lru":
        for(var i=0;i<9;i++) ["A"].save("lru"+i+".ks");
        for(var j=0;j<8;j++) kagFirst(p,"lru"+j+".ks");
        ["X"].save("lru0.ks");["Y"].save("lru1.ks");
        result=kagFirst(p,"lru0.ks");kagFirst(p,"lru8.ks");
        return result+kagFirst(p,"lru0.ks")+kagFirst(p,"lru1.ks");
      case "failed-load-lru":
        for(var k=0;k<8;k++){var file="full"+k+".ks";["A"].save(file);kagFirst(p,file);}
        ["B"].save("full0.ks");try{p.loadScenario("empty.ks");}catch(e){result=e.message;}
        return result+"|"+kagFirst(p,"full0.ks");
      case "compact":
        ["A"].save(n);result=kagFirst(p,n);["B"].save(n);System.doCompact(clIdle);
        result+=kagFirst(q,n);System.doCompact(clDeactivate);return result+kagFirst(r,n);
      case "callback-bypass":
        ["D"].save(n);p.body="V";result=kagFirst(p,n)+kagFirst(q,n);
        p.body="X";result+=kagFirst(p,n);p.loadScenario("callback-other.ks");return result+kagFirst(p,n);
      case "assign-flags":
        p.body="[if exp=false]N[endif]Y";p.loadScenario(n);p.processSpecialTags=false;p.interrupt();
        q.assign(p);result=q.getNextTag().text+"|"+p.getNextTag().tagname;
        return result+"|"+int(p.processSpecialTags)+"|"+int(q.processSpecialTags);
      case "alias-collision":
        p.body="*a\nX\n*a\nY\n*a:2\nZ";p.loadScenario(n);p.goToLabel("*a:2");result=p.getNextTag().text;
        p.goToLabel("*a:2:2");return result+"|"+p.getNextTag().text;
      case "active-macro":
        d=kagSavePoint();
        if(!(d.macroArgs[0] instanceof "Dictionary")) return "unexpected bookmark macro arguments";
        return d.macroArgs[0].actor+"|"+kagResumePoint(d);
      case "legacy-bookmark":
        d=kagSavePoint();d.macroArgs[0]=["tagname","scene","actor","Alice","extra","legacy"];
        delete d.macroArgNames;return kagResumePoint(d);
      case "lost-return":
        d=kagSavePoint();d.callStack[0].orgLineStr="changed calling line";kagResumePoint(d);break;
      case "forward-current":
        p.body="[macro name=m][mark][emit old=before *][endmacro][m actor=Alice]";p.loadScenario(n);
        p.getNextTag();p.macroParams.extra="new";var t=p.getNextTag();return t.actor+"|"+t.extra+"|"+int(t.old===void);
      case "call-cursor":
        p.body="X[call target=*z]Y";p.veto=true;p.loadScenario(n);p.getNextTag();
        return p.getNextTag().text+"|"+p.callAt;
      case "syntax-cursor":
        p.body="X[t a='broken";p.loadScenario(n);p.getNextTag();
        try{p.getNextTag();}catch(e){return e.message+"|"+p.curLine+"|"+p.curPos;}break;
      case "attribute-before-error":
        global.kagControlCount=0;p.body="[emit v=&'global.kagControlCount+=1' broken='";p.loadScenario(n);
        try{p.getNextTag();}catch(e){return e.message+"|"+global.kagControlCount;}break;
      case "empty-file": p.loadScenario("empty.ks");break;
      case "empty-callback": p.body="";p.loadScenario(n);break;
      case "missing-label": p.loadScenario("chapter.ks");p.goToLabel("*absent");break;
      case "changed-holder":
        p.loadScenario("chapter.ks");System.assignMessage("TVPKAGLabelNotFound","changed:<%2>:<%1>");p.goToLabel("*absent");break;
      case "macro-underflow": p.popMacroArgs();break;
      case "bad-save-depth": p.loadScenario("chapter.ks");d=p.store();d.macroArgStackDepth=1;q.restore(d);break;
      case "assign-object": p.assign(%[]);break;
      default:
        var src=%["empty-label"=>"*|title\nA", "inline-eof"=>"@iscript\n1;",
          "macro-label"=>"@macro name=m\n*label\nA", "macro-script"=>"@macro name=m\n@iscript\n1;\n@endscript",
          "stray-endmacro"=>"[endmacro]", "empty-if"=>"[if]", "bad-lexer"=>"[tag a='unterminated",
          "return-underflow"=>"[return]", "erase-unknown"=>"[erasemacro name=missing]"];
        p.body=src[id];p.loadScenario(n);p.getNextTag();
    }
    return "unexpected success";
  }catch(e){return e.message;}
}
` + kagEvaluationSource + kagRoutingSource + kagMacroSlotSource + kagEmbeddingSource
