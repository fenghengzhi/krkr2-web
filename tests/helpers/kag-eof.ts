/** Fixed KAGParser.cpp 1393–1416 checks initial EOF before DicClear, while
 * the loop still clears before advancing a blank/unterminated final line.
 * These ordinary scenarios run unchanged in the original SDK and the VM. */
export const kagEofFiles = {
  'eof-choice.ks': '@choice label=CONTINUE target=*picked\n',
  'eof-next.ks': '@choice label=AFTER target=*end\n',
  'eof-blank.ks': '@choice label=CONTINUE target=*picked\n\n',
  'eof-inline.ks': '[choice label=CONTINUE target=*picked]',
  'eof-bad.ks': "[choice broken='\n",
  'eof-finalize.ks': '@choice label=FIRST\nSECOND\n',
}
export const kagEofExpected: Readonly<Record<string, string>> = {
  'eof-line': 'choice|CONTINUE|*picked|1|1|retained|1|interrupt|1|choice|AFTER|1',
  'eof-blank': '1|0|after|1|0',
  'eof-clear': '1|CONTINUE|retained|1|AFTER|1',
  'eof-error': '1|1|1|AFTER',
  'eof-finalize': '1:0|interrupt|1:0|1|S',
  'eof-owned-finalize': 'S|1|1|1:1|interrupt|1:1|1|E',
}
export const kagEofSource = String.raw`
class EofParser extends KAGParser {
 function EofParser(){super.KAGParser();debugLevel=tkdlNone;}
}
var eofFinalizeParser=void,eofFinalizeAt="";
class EofTagValue {
 function finalize(){
  var p=global.eofFinalizeParser;
  global.eofFinalizeAt=p.curLine+":"+p.curPos;
  p.interrupt();
 }
}
// Historical implicit-release probe. Stock 147/148 retained a reference past
// DicClear (its register pool does not clear every returned frame). Keep that
// original comparison visible; the owned control below fixes the release site.
function eofAttachValue(tag){tag.payload=new EofTagValue();}
function eofFieldCount(value){
 var fields=[],count=0;fields.assign(value);
 // taglist is the existing Web-only ordering metadata, not a stock field.
 for(var i=0;i<fields.count;i+=2)if(fields[i]!="taglist")count++;
 return count;
}
function kagEofRun(id,p){
 var held,next,result,failed=false;
 p.loadScenario("eof-choice.ks");held=p.getNextTag();held.user="retained";
 switch(id){
  case "eof-line":
   result=held.tagname+"|"+held.label+"|"+held.target;
   result+="|"+int(p.getNextTag()===void)+"|"+int(p.getNextTag()===void)+"|"+held.user;
   p.interrupt();result+="|"+int(p.getNextTag()===void);
   p.loadScenario("eof-next.ks");next=p.getNextTag();result+="|"+next.tagname+"|"+int(next===held);
   next=p.getNextTag();return result+"|"+next.tagname+"|"+next.label+"|"+int(next.user===void);
  case "eof-blank":
   p.ignoreCR=true;p.loadScenario("eof-blank.ks");held=p.getNextTag();
   result=int(p.getNextTag()===void)+"|"+eofFieldCount(held);
   held.user="after";p.getNextTag();result+="|"+held.user;
   p.loadScenario("eof-inline.ks");held=p.getNextTag();
   return result+"|"+int(p.getNextTag()===void)+"|"+eofFieldCount(held);
  case "eof-clear":
   p.clear();result=int(p.getNextTag()===void)+"|"+held.label+"|"+held.user;
   p.loadScenario("eof-next.ks");next=p.getNextTag();
   return result+"|"+int(next===held)+"|"+held.label+"|"+int(held.user===void);
  case "eof-error":
   p.loadScenario("eof-bad.ks");try{p.getNextTag();}catch(error){failed=true;}
   result=int(failed)+"|"+eofFieldCount(held);
   p.loadScenario("eof-next.ks");next=p.getNextTag();return result+"|"+int(next===held)+"|"+held.label;
  case "eof-finalize":
   p.loadScenario("eof-finalize.ks");held=p.getNextTag();
   global.eofFinalizeParser=p;global.eofFinalizeAt="";eofAttachValue(held);
   next=p.getNextTag();result=global.eofFinalizeAt+"|"+next.tagname+"|"+p.curLine+":"+p.curPos+"|"+int(next===held);
   return result+"|"+p.getNextTag().text;
  case "eof-owned-finalize":
   p.loadScenario("eof-finalize.ks");held=p.getNextTag();
   global.eofFinalizeParser=p;global.eofFinalizeAt="";
   var owned=new EofTagValue();held.payload=owned;
   next=p.getNextTag();result=next.text+"|"+int(held.payload===void)+"|"+int(isvalid owned);
   invalidate owned;
   result+="|"+global.eofFinalizeAt;next=p.getNextTag();
   return result+"|"+next.tagname+"|"+p.curLine+":"+p.curPos+"|"+int(next===held)+"|"+p.getNextTag().text;
 }
 throw new Exception("Unknown EOF control");
}
function kagEofObserve(id){
 var p=void,result,failed=false,primary;
 try{p=new EofParser();result=kagEofRun(id,p);}catch(error){failed=true;primary=error;}
 try{if(p!==void && isvalid p)invalidate p;}catch(error){if(failed)Debug.message("eof-cleanup:"+error.message);else throw error;}
 global.eofFinalizeParser=void;
 if(failed)throw primary;return result;
}
`

export const kagEofStory = String.raw`*choice|Generated choice
[cm][nowait]CHOOSE[endnowait]
[r][link target=&global.eofGameChoice.target][emb exp=global.eofGameChoice.label][endlink]
[s]
*picked
[cm][nowait]CONTINUED[endnowait]
[eval exp="global.eofGamePhase=1"]
[l]
[jump target=*end]
WRONG
*end
[cm][nowait]END[endnowait]
[eval exp="global.eofGamePhase=2"]
[s]
`
export const kagEofGameSource = String.raw`
var eofGameParser=new KAGParser(),eofGameChoice=void,eofGameCount=0,eofGamePhase=0;
eofGameParser.debugLevel=tkdlNone;eofGameParser.loadScenario("eof-choice.ks");
var eofGameTag;
while((eofGameTag=eofGameParser.getNextTag())!==void){
 if(++eofGameCount>8)throw new Exception("Generated menu exceeded its input bound");
 if(eofGameTag.tagname!="choice")throw new Exception("Unexpected generated menu tag");
 eofGameChoice=eofGameTag;
}
if(eofGameCount!=1 || eofGameChoice.label!="CONTINUE" || eofGameChoice.target!="*picked")
 throw new Exception("EOF lost the generated choice");
function eofGameState(){
 var k=global.kag;
 return global.eofGamePhase+"|"+global.eofGameCount+"|"+global.eofGameChoice.label+"|"+global.eofGameChoice.target+"|"+
  k.currentLabel+"|"+k.historyLayer.currentLine+"|"+int(k.clickWaiting)+"|"+k.conductor.lastTagName+"|"+k.current.numLinks;
}
Debug.message("eof-game-ready");
`
