/** Fixed KAGParser invokes ttstr::ToLowerCase for tag names, attribute names
 * and macro definitions. Original tjsString.cpp folds A..Z, never Unicode. */
export const kagNameFiles = {
  'names-tags.ks': '[ＥＭＩＴ ＨＰ=7 ｈｐ=2 MiXeD=ascii İ=dot Σ=upper σ=lower][done]\n',
  'names-macros.ks': '[macro name=ＨＥＲＯ]UP[endmacro][macro name=ｈｅｒｏ]LOW[endmacro][MACRO NAME=Ascii]A[endmacro][ＨＥＲＯ][ｈｅｒｏ][ASCII][ascii][done]\n',
  'names-params.ks': '[macro name=inner][emit hp=%ＨＰ low=%ｈｐ normal=%mixed][endmacro][macro name=紹介][inner *][endmacro][紹介 ＨＰ=7 ｈｐ=2 MiXeD=ok][done]\n',
  'names-entry.ks': '*entry\n[macro name=ＨＥＲＯ][call storage=names-chapter.ks target=*chapter][endmacro]\n[macro name=ｈｅｒｏ]lower[endmacro]\n[ＨＥＲＯ ＨＰ=7 ｈｐ=2]AFTER[ｈｅｒｏ][done]\n',
  'names-chapter.ks': '*chapter\n[emit hp=%ＨＰ low=%ｈｐ][return]\n',
}
export const kagNameExpected: Readonly<Record<string, string>> = {
  'names-tags': 'ＥＭＩＴ|7|2|ascii|dot|upper|lower|1',
  'names-macros': 'UPLOWAA|1|1|1',
  'names-params': '7|2|ok|1',
  'names-bookmark': '7|2|1|1|1|7|2|AFTERlower|0|1',
}
export const kagNameSource = String.raw`
class NameParser extends KAGParser {
 function NameParser(){super.KAGParser();debugLevel=tkdlNone;ignoreCR=true;}
}
function nameNext(p,expected){
 var tag=p.getNextTag();
 if(tag===void || tag.tagname!=expected)throw new Exception("Expected name tag "+expected);
 return tag;
}
function nameDrain(p){
 var result="";
 for(var i=0;i<100;i++){
  var tag=p.getNextTag();if(tag===void)throw new Exception("Missing name control end");
  if(tag.tagname=="done")return result;
  if(tag.tagname!="ch")throw new Exception("Unexpected name control tag: "+tag.tagname);
  result+=tag.text;
 }
 throw new Exception("Name control exceeded its tag bound");
}
function kagNameRun(id,p,q){
 var tag,result;
 switch(id){
  case "names-tags":
   p.loadScenario("names-tags.ks");tag=nameNext(p,"ＥＭＩＴ");
   result=tag.tagname+"|"+tag["ＨＰ"]+"|"+tag["ｈｐ"]+"|"+tag.mixed+"|"+tag["İ"]+"|"+tag["Σ"]+"|"+tag["σ"]+"|"+int(tag.MiXeD===void);
   nameNext(p,"done");return result;
  case "names-macros":
   p.loadScenario("names-macros.ks");result=nameDrain(p);
   return result+"|"+int(p.macros["ＨＥＲＯ"]!==p.macros["ｈｅｒｏ"])+"|"+int(p.macros.ascii!==void)+"|"+int(p.macros.ASCII===void);
  case "names-params":
   p.loadScenario("names-params.ks");tag=nameNext(p,"emit");result=tag.hp+"|"+tag.low+"|"+tag.normal;
   nameNext(p,"done");return result+"|"+int(p.macroParams===null);
  case "names-bookmark":
   p.loadScenario("names-entry.ks");tag=nameNext(p,"emit");result=tag.hp+"|"+tag.low+"|"+p.callStackDepth;
   var saved=p.store();(Dictionary.saveStruct incontextof saved)("name-bookmark.tjs");
   var loaded=Scripts.evalStorage("name-bookmark.tjs");
   result+="|"+int(loaded.macros["ＨＥＲＯ"]!==void)+"|"+int(loaded.macros["ｈｅｒｏ"]!==void);
   q.restore(loaded);tag=nameNext(q,"emit");result+="|"+tag.hp+"|"+tag.low+"|"+nameDrain(q);
   nameDrain(p);return result+"|"+q.callStackDepth+"|"+int(q.macroParams===null);
 }
 throw new Exception("Unknown KAG name control");
}
function kagNameObserve(id){
 var p=void,q=void,result,failed=false,primary,cleanup=[];
 try{p=new NameParser();q=new NameParser();result=kagNameRun(id,p,q);}catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){cleanup.add(e.message);}
 try{if(q!==void && isvalid q)invalidate q;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("names-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Name control cleanup: "+cleanup.join("|"));
 return result;
}
function kagNameResumeFile(path){
 var p=void,result,failed=false,primary;
 try{
  p=new NameParser();p.restore(Scripts.evalStorage(path));var tag=nameNext(p,"emit");
  result=tag.hp+"|"+tag.low+"|"+nameDrain(p)+"|"+p.callStackDepth+"|"+int(p.macroParams===null);
 }catch(e){failed=true;primary=e;}
 try{if(p!==void && isvalid p)invalidate p;}catch(e){if(failed)Debug.message("names-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
`

export const kagNameStory = String.raw`*choice|Localized script names
[macro name=ＨＥＲＯ][nowait]HERO [emb exp="mp['ＨＰ']"]/[emb exp="mp['ｈｐ']"][endnowait][endmacro]
[macro name=ｈｅｒｏ][nowait]friend [emb exp="mp['ＨＰ']"][endnowait][endmacro]
[MACRO NAME=NextLine][r][endmacro]
[cm][nowait]CHOOSE[endnowait]
[r][link target=*picked]Continue[endlink]
[s]
*picked
[cm][ＨＥＲＯ ＨＰ=7 ｈｐ=2]
[eval exp="global.nameGamePhase=1"]
[l]
[NEXTLINE][ｈｅｒｏ ＨＰ=3]
[eval exp="global.nameGamePhase=2"]
[l]
[jump target=*end]
WRONG
*end
[cm][nowait]END[endnowait]
[eval exp="global.nameGamePhase=3"]
[s]
`
export const kagNameGameSource = String.raw`
var nameGamePhase=0;
function nameGameState(){
 var k=global.kag,p=k.conductor;
 return global.nameGamePhase+"|"+k.currentLabel+"|"+k.historyLayer.currentLine+"|"+int(k.clickWaiting)+"|"+
  p.lastTagName+"|"+k.current.numLinks+"|"+int(p.macroParams===null)+"|"+
  int(p.macros["ＨＥＲＯ"]!==p.macros["ｈｅｒｏ"])+"|"+int(p.macros.nextline!==void);
}
Debug.message("names-game-ready");
`
