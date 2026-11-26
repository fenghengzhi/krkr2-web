/** Fixed KAGParser.cpp 2490/2510 use variant bool, while debugLevel (2530)
 * uses an integer. tjsVariant.h 895–905 distinguishes real/object/octet. */
export const kagModeFiles = {
  'mode-route.ks': '[if exp=true]YES[else]NO[endif][jump target=*end]BAD\n*end\nEND[done]\n',
  'mode-lines.ks': 'X\nY[done]\n',
}
export const kagModeExpected: Readonly<Record<string, string>> = {
  'mode-values': '11,11,00,00,11,11,11,00,00,00,00|11,11,11,11',
  'mode-routing': 'YESEND|*end|11|if|0',
  'mode-lines': 'XY|X/Y',
  'mode-debug': '0|1|2',
}
export const kagModeSource = String.raw`
class ModeParser extends KAGParser {
 function ModeParser(){super.KAGParser();debugLevel=tkdlNone;}
}
function modeDrain(p){
 var result="";
 for(var i=0;i<100;i++){
  var tag=p.getNextTag();if(tag===void)throw new Exception("Mode scenario ended before done");
  if(tag.tagname=="done")return result;
  if(tag.tagname=="ch")result+=tag.text;
  else if(tag.tagname=="r")result+="/";
  else throw new Exception("Unexpected mode tag: "+tag.tagname);
 }
 throw new Exception("Mode scenario exceeded its tag bound");
}
function kagModeRun(id,p){
 var result,rows=[],values,reason="missing-error";
 switch(id){
  case "mode-values":
   values=[0.5,-0.5,0.0,0,1,-1,"1","0","not-a-number",void,null];
   for(var i=0;i<values.count;i++){
    p.ignoreCR=values[i];p.processSpecialTags=values[i];rows.add(string(p.ignoreCR)+p.processSpecialTags);
   }
   result=rows.join(",");rows.clear();values=[%[],[],function(){return 1;},<%00%>];
   for(var j=0;j<values.count;j++){
    p.ignoreCR=values[j];p.processSpecialTags=values[j];rows.add(string(p.ignoreCR)+p.processSpecialTags);
   }
   return result+"|"+rows.join(",");
  case "mode-routing":
   p.ignoreCR=-0.5;p.processSpecialTags=0.5;p.loadScenario("mode-route.ks");
   result=modeDrain(p)+"|"+p.curLabel+"|"+string(p.ignoreCR)+p.processSpecialTags;
   p.processSpecialTags=0.0;p.loadScenario("mode-route.ks");
   return result+"|"+p.getNextTag().tagname+"|"+p.processSpecialTags;
  case "mode-lines":
   p.ignoreCR=0.5;p.loadScenario("mode-lines.ks");result=modeDrain(p);
   p.ignoreCR=0.0;p.loadScenario("mode-lines.ks");return result+"|"+modeDrain(p);
  case "mode-debug":
   p.debugLevel=0.5;result=string(p.debugLevel);p.debugLevel=2;
   // Compare the native conversion for the very same object; do not change
   // the process-global message holder merely to inspect this control.
   var bad=%[],expectedError="";
   try{expectedError=string(int(bad));}catch(e){expectedError=e.message;}
   try{p.debugLevel=bad;}catch(e){reason=int(expectedError!="" && e.message==expectedError);}
   return result+"|"+reason+"|"+p.debugLevel;
 }
 throw new Exception("Unknown KAG mode control");
}
function kagModeObserve(id){
 var p=void,result,failed=false,primary;
 try{p=new ModeParser();result=kagModeRun(id,p);}catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("mode-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

/** Original KAG keeps all message/link handlers. These authored settings are
 * valid nonzero real booleans, not integer mode enumerations. The explicit hr
 * separates chapter history: cm only repages history in everypage mode. */
export const kagModeStory = String.raw`*choice|Parser options
[cm][hr][nowait]CHOOSE[endnowait]
[r][link target=*picked]Continue[endlink]
[s]
*picked
[cm][hr][nowait]
[if exp=true]ROUTE[else]WRONG[endif]
[emb exp="' READY'"][endnowait]
[eval exp="global.modeGamePhase=1"]
[l]
[jump target=*end]
WRONG
*end
[cm][hr][nowait]END[endnowait]
[eval exp="global.modeGamePhase=2"]
[s]
`
export const kagModeGameSource = String.raw`
var modeGamePhase=0;
function configureParserModes(){
 global.kag.conductor.ignoreCR=0.5;
 global.kag.conductor.processSpecialTags=-0.5;
}
configureParserModes();
function modeGameState(){
 var k=global.kag,p=k.conductor;
 return global.modeGamePhase+"|"+k.currentLabel+"|"+k.historyLayer.currentLine+"|"+int(k.clickWaiting)+"|"+
  p.lastTagName+"|"+k.current.numLinks+"|"+string(p.ignoreCR)+p.processSpecialTags;
}
Debug.message("mode-game-ready");
`
