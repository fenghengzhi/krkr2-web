/** A game-owned reading panel over unmodified KAG. It deliberately stays out
 * of Tab order, while setMode must initially focus it before its action button.
 * Stock LayerManager::SetModeTo calls SearchFirstFocusable() with the default
 * ignore_chain_focusable=true (LayerIntf.h); ordinary Tab search stays false. */
export const modalReadingSource = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="modal";kag.saveDataLocation=System.dataPath;
var modalReader,modalConfirm,modalPages=0,modalStage="menu",modalRendered="",modalVisits=0;
class ModalReadingPanel extends Layer {
 function ModalReadingPanel(){
  super.Layer(kag,kag.primaryLayer);setSize(480,220);setImageSize(480,220);setPos(80,100);
  type=ltOpaque;holdAlpha=false;focusable=true;joinFocusChain=false;visible=false;font.height=22;
 }
 function draw(){
  fillRect(0,0,480,220,0xff183048);
  drawText(20,24,global.modalPages==0?"THE BRIDGE IS CLOSED":"TAKE THE FOREST PATH",0xffffff);
  drawText(20,70,global.modalPages<2?"Enter: read the next line":"Tab: choose Continue",0xffffff);
 }
 function onKeyDown(key,shift,process=true){
  if(key==VK_RETURN){if(global.modalPages<2)global.modalPages++;draw();return;}
  super.onKeyDown(key,shift,process);
 }
 function onKeyPress(key){}
}
class ModalReadingConfirm extends Layer {
 function ModalReadingConfirm(p){
  super.Layer(kag,p);setSize(260,44);setImageSize(260,44);setPos(110,154);
  type=ltOpaque;holdAlpha=false;focusable=true;visible=true;font.height=20;
  fillRect(0,0,260,44,0xff306030);drawText(12,10,"Continue via forest",0xffffff);
 }
 function accept(){
  f.choice=global.modalPages==2?7:99;
  global.modalReader.removeMode();global.modalReader.visible=false;
  global.modalStage="confirmed";kag.process("","*chosen");
 }
 function onKeyDown(key,shift,process=true){if(key==VK_RETURN){accept();return;}super.onKeyDown(key,shift,process);}
 function onKeyPress(key){}
 function onClick(x,y){accept();}
}
function openModalReading(){
 if(global.modalReader===void){
  global.modalReader=new ModalReadingPanel();kag.add(global.modalReader);
  global.modalConfirm=new ModalReadingConfirm(global.modalReader);kag.add(global.modalConfirm);
 }
 global.modalPages=0;global.modalStage="reading";global.modalReader.draw();
 global.modalReader.setMode();
}
function modalReadingState(){return [global.modalStage,global.modalPages,f.choice,global.modalRendered,
 global.modalVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status].join("|");}
function modalReadingFocus(){return [int(kag.focusedLayer===global.modalReader),int(kag.focusedLayer===global.modalConfirm),
 int(kag.currentModalLayer===global.modalReader),int(kag.current.nodeEnabled),
 int(global.modalReader.joinFocusChain)].join("|");}
function modalReadingStored(){var data=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return data.user.choice+"|"+data.core.mainConductor.curLabel;}
Debug.message("modal-reading-ready");
`

export const modalReadingStory = String.raw`*menu|Sealed note
[cm][hr][eval exp="f.choice=0"][eval exp="global.modalStage='menu'"]
[link target=*read]Read the sealed note[endlink]
[if exp="Storages.isExistentStorage(kag.getBookMarkFileNameAtNum(0))"]
[r][link target=*load]Load chosen route[endlink]
[endif]
[s]
*read
[cm][hr][nowait]READ THE NOTE[endnowait]
[iscript]
openModalReading();
[endscript]
[s]
*chosen
[jump target=*chapter cond="f.choice==7"]
[cm][hr][nowait]THE NOTE WAS NOT READ[endnowait][s]
*chapter|Forest route
[cm][hr][eval exp="global.modalStage='chapter'"][nowait]FOREST ROUTE [emb exp=f.choice][endnowait]
[iscript]
global.modalRendered=kag.historyLayer.currentLine;global.modalVisits++;
[endscript]
[r][link target=*save]Save route[endlink] / [link target=*change]Change route[endlink] / [link target=*load]Load route[endlink]
[r][link target=*continue]Continue[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*chapter]
*change
[eval exp="f.choice=99"]
[jump target=*chapter]
*load
[load place=0 ask=false]
*continue
[cm][hr][nowait]THE FOREST IS SAFE[endnowait][l]
[jump target=*chapter]
`
