/** Fixed LayerIntf.cpp focus (7890–7898): omitted direction=true, supplied
 * direction=variant bool, return integer SetFocusTo result. LayerManager.cpp
 * 646–703 rejects nonfocusable/unchanged targets after ordinary redirection. */
export const layerFocusCases = [
  { id: 'focus-result-change', expected: '1,0,0,0,0,1|1|before:A:1,focus:A:1,before:A:1,before:B:1,focus:B:1' },
  { id: 'focus-result-direction', expected: '1,1,1,1,1,1,1|1,1,1,0,0,0,1|1' },
  { id: 'focus-result-redirect', expected: '0,1,1|1|before:B:1,before:B:0,focus:C:0,before:A:1' },
] as const

export const layerFocusSource = String.raw`
var focusResultLog=[],focusResultDirections=[],focusResultRedirect=void;
class FocusResultLayer extends Layer {
 function FocusResultLayer(w,p,n){super.Layer(w,p);name=n;setSize(8,8);visible=true;focusable=true;}
 function onBeforeFocus(layer,previous,direction){
  global.focusResultLog.add("before:"+name+":"+int(direction));
  super.onBeforeFocus(global.focusResultRedirect===void?layer:global.focusResultRedirect,previous,direction);
 }
 function onFocus(previous,direction){
  global.focusResultLog.add("focus:"+name+":"+int(direction));global.focusResultDirections.add(int(direction));
 }
}
function layerFocusRun(id,owned){
 global.focusResultLog.clear();global.focusResultDirections.clear();global.focusResultRedirect=void;
 var w=new Window();owned.add(w);var root=new Layer(w,null);w.add(root);root.setSize(8,8);root.visible=true;
 var a=new FocusResultLayer(w,root,"A"),b=new FocusResultLayer(w,root,"B"),c=new FocusResultLayer(w,root,"C");
 w.add(a);w.add(b);w.add(c);var results=[];
 if(id=="focus-result-change"){
  results.add(a.focus());results.add(a.focus());
  b.visible=false;results.add(b.focus());b.visible=true;
  b.enabled=false;results.add(b.focus());b.enabled=true;
  b.focusable=false;results.add(b.focus());b.focusable=true;
  results.add(b.focus());
  return results.join(",")+"|"+int(w.focusedLayer===b)+"|"+global.focusResultLog.join(",");
 }
 if(id=="focus-result-direction"){
  results.add(a.focus());results.add(b.focus(true));results.add(a.focus(0.5));
  results.add(b.focus(void));results.add(a.focus(false));results.add(b.focus(0));results.add(a.focus(-0.5));
  return results.join(",")+"|"+global.focusResultDirections.join(",")+"|"+int(w.focusedLayer===a);
 }
 if(id=="focus-result-redirect"){
  a.focus();global.focusResultLog.clear();
  global.focusResultRedirect=a;results.add(b.focus());
  global.focusResultRedirect=c;results.add(b.focus(false));
  global.focusResultRedirect=null;results.add(a.focus());
  return results.join(",")+"|"+int(w.focusedLayer===null)+"|"+global.focusResultLog.join(",");
 }
 throw new Exception("Unknown focus result case");
}
function layerFocusObserve(id){
 var owned=[],result,failed=false,primary,cleanup=[];
 try{result=layerFocusRun(id,owned);}catch(e){failed=true;primary=e;}
 global.focusResultRedirect=void;
 for(var i=owned.count-1;i>=0;i--){try{if(owned[i]!==void && isvalid owned[i])invalidate owned[i];}catch(e){cleanup.add(e.message);}}
 if(failed){if(cleanup.count)Debug.message("focus-result-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Focus result cleanup failed: "+cleanup.join("|"));return result;
}
`

export const nameFocusSource = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="hero";kag.saveDataLocation=System.dataPath;
var nameFocusAccepted=void,nameStage="",nameRendered="",nameVisits=0;
function nameFocusState(){return [global.nameStage,global.nameFocusAccepted,f.hero,global.nameRendered,
 global.nameVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status].join("|");}
function nameFieldState(){var field=kag.current.links[0].object;
 return [field.text,f.hero,int(field.focused),kag.current.keyLink,int(kag.focusedLayer===kag.current)].join("|");}
function nameStored(){var data=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return data.user.hero+"|"+data.core.mainConductor.curLabel;}
Debug.message("name-focus-ready");
`

export const nameFocusStory = String.raw`*name|Hero name
[cm][hr][eval exp="f.hero=''"][eval exp="global.nameStage='input'"]
[nowait]NAME YOUR HERO[endnowait][r]
[edit name=f.hero length=240 maxchars=16 opacity=80 bgcolor=0x000000 color=0xffffff]
[iscript]
global.nameFocusAccepted=kag.current.links[0].object.focus();
[endscript]
[if exp="global.nameFocusAccepted===1"]
 [link target=*confirm]Confirm name[endlink]
[else]
 [link target=*name]Input unavailable - retry[endlink]
[endif]
[if exp="Storages.isExistentStorage(kag.getBookMarkFileNameAtNum(0))"]
[r][link target=*load]Load hero[endlink]
[endif]
[s]
*confirm
[commit]
[jump target=*chapter cond="f.hero==='ALICE'"]
[jump target=*name]
*chapter|Hero chapter
[cm][hr][eval exp="global.nameStage='chapter'"][nowait]HELLO [emb exp=f.hero][endnowait]
[iscript]
global.nameRendered=kag.historyLayer.currentLine;global.nameVisits++;
[endscript]
[r][link target=*save]Save hero[endlink] / [link target=*change]Change hero[endlink] / [link target=*load]Load hero[endlink]
[r][link target=*continue]Continue[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*chapter]
*change
[eval exp="f.hero='BOB'"]
[jump target=*chapter]
*load
[load place=0 ask=false]
*continue
[cm][hr][nowait]ADVENTURE [emb exp=f.hero][endnowait][l]
[jump target=*chapter]
`
