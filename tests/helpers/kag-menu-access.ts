/** The stock KAG template owns every System/History/Save/Load/Confirm handler.
 * Only this small story and observer/settings script are supplied by the game. */
export const menuAccessStory = String.raw`*title|Keyboard title
[eval exp="f.keyboardProgress=0"]
[cm][hr][nowait]TITLE[endnowait]
[startanchor]
[r][link target=*chapter]Continue[endlink]
[s]
*chapter
[eval exp="f.keyboardProgress=7"]
*checkpoint|Keyboard chapter
[cm][hr][nowait]CHAPTER [emb exp="f.keyboardProgress"][endnowait]
[r][link target=*change]Change[endlink] / [link target=*continue]Continue[endlink]
[s]
*change
[eval exp="f.keyboardProgress=99"]
[jump target=*checkpoint]
*continue
[cm][hr][nowait]CONTINUE [emb exp="f.keyboardProgress"][endnowait]
[l]
[jump target=*checkpoint]
`

export const menuAccessGameSource = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="keyboard";kag.saveDataLocation=System.dataPath;
var keyboardActions="";
var keyboardMenu=new MenuItem(kag,"Access(&Z)");kag.menu.add(keyboardMenu);
var keyboardOnce=new MenuItem(kag,"Once(&O)"),keyboardDisabled=new MenuItem(kag,"Disabled(&D)"),
 keyboardFirst=new MenuItem(kag,"First(&D)"),keyboardSecond=new MenuItem(kag,"Second(&D)"),
 keyboardHidden=new MenuItem(kag,"Hidden(&D)");
keyboardMenu.add(keyboardOnce);keyboardMenu.add(keyboardDisabled);keyboardMenu.add(new MenuItem(kag,"-"));
keyboardMenu.add(keyboardFirst);keyboardMenu.add(keyboardSecond);keyboardMenu.add(keyboardHidden);
keyboardDisabled.enabled=false;keyboardHidden.visible=false;keyboardOnce.shortcut="Shift+F6";
keyboardOnce.onClick=function(){global.keyboardActions+="O";Debug.message("keyboard-actions:"+global.keyboardActions);};
keyboardDisabled.onClick=function(){throw new Exception("Disabled menu was invoked");};
keyboardHidden.onClick=function(){throw new Exception("Hidden menu was invoked");};
keyboardFirst.onClick=function(){global.keyboardActions+="1";Debug.message("keyboard-actions:"+global.keyboardActions);};
keyboardSecond.onClick=function(){global.keyboardActions+="2";Debug.message("keyboard-actions:"+global.keyboardActions);};
var keyboardPopup=new MenuItem(kag,"Popup(&P)");kag.menu.add(keyboardPopup);
keyboardPopup.onClick=function(){global.keyboardMenu.popup(0,40,40);Debug.message("keyboard-popup-closed");};
function keyboardGameState(){var k=global.kag;
 return [f.keyboardProgress,k.currentLabel,k.current.numLinks,k.conductor.status,int(k.historyLayer.visible),
  global.keyboardActions].join("|");
}
function keyboardSaved(){var d=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return [d.user.keyboardProgress,d.core.mainConductor.curLabel].join("|");}
Debug.message("keyboard-game-ready");
`
