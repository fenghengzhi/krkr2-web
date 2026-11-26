/** WindowFormUnit.cpp 1779–1786/1824–1860 and LayerManager.cpp 337–345:
 * Click gets LastMouseDownX/Y, then MouseUp gets the release coordinates. */
export const mouseClickOriginSource = String.raw`
var clickWindow=new Window();clickWindow.caption="Drag choice";
clickWindow.setInnerSize(320,180);clickWindow.visible=true;
var clickRoot=new Layer(clickWindow,null);clickRoot.setSize(320,180);clickRoot.type=ltOpaque;
clickRoot.holdAlpha=false;clickRoot.fillRect(0,0,320,180,0xff101820);
var clickTrace=[],clickChoice="none",clickRound=0;
function clickRecord(name,x,y){clickTrace.add(name+":"+x+","+y);}
class DragChoice extends Layer {
 var label;
 function DragChoice(w,parent,name,x,color){
  super.Layer(w,parent);label=name;holdAlpha=false;type=ltOpaque;
  setPos(x,0,160,140);fillRect(0,0,160,140,color);visible=true;
 }
 function onMouseDown(x,y,button,shift){global.clickRecord(label+"-down",x,y);}
 function onClick(x,y){
  global.clickRecord(label+"-click",x,y);global.clickChoice=label;
  global.clickRoot.fillRect(0,140,320,40,label=="left"?0xff207040:0xff704020);
 }
 function onMouseUp(x,y,button,shift){
  global.clickRecord(label+"-up",x,y);global.clickRound++;
  global.clickWindow.update();
  global.Debug.message("drag-choice:"+global.clickRound+":"+global.clickChoice+":"+global.clickTrace.join("|"));
 }
}
var clickLeft=new DragChoice(clickWindow,clickRoot,"left",0,0xff204060),
    clickRight=new DragChoice(clickWindow,clickRoot,"right",160,0xff604020);
clickWindow.onMouseDown=function(x,y,button,shift){global.clickTrace.clear();global.clickRecord("window-down",x,y);};
clickWindow.onClick=function(x,y){global.clickRecord("window-click",x,y);};
clickWindow.onMouseUp=function(x,y,button,shift){global.clickRecord("window-up",x,y);};
clickWindow.update();Debug.message("drag-choice-ready");
`

export const mouseClickOriginExpected = [
  'window-down:40,30|left-down:40,30|window-click:40,30|left-click:40,30|window-up:240,90|left-up:240,90',
  'window-down:240,30|right-down:80,30|window-click:240,30|right-click:80,30|window-up:40,90|right-up:-120,90',
] as const
