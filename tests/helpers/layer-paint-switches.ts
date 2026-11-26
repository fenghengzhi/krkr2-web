/** Fixed LayerIntf.cpp SetCached(bool) 3489/8658 and callOnPaint's explicit
 * variant bool at 9440. BeforeCompletion clears the paint flag at 5134.
 * Group pixels retain the independently confirmed image-less group contract. */
const matrix = '0,1,1,1,1,0,1,0,0,0,1,0,0,0,1,1,1,1'
export const layerPaintStates = ['0|1|1|0', '1|2|0|0', '2|2|1|0', '3|3|1|0'] as const
export const layerPaintPixels = [
  '4194304,16384,2113632', '4194304,32768,6307872',
  '4194304,16384,6307872', '4194304,16384,2125888',
] as const
export const layerPaintCases = [
  { id: 'paint-bool-cached', expected: matrix },
  { id: 'paint-bool-callOnPaint', expected: matrix },
  { id: 'paint-bool-render', expected: layerPaintStates.map((state, i) => state + '|' + layerPaintPixels[i]).join(';') },
] as const

export const layerPaintSource = String.raw`
var paintSwitchWindow,paintSwitchRoot,paintSwitchGroup,paintSwitchChild,paintSwitchPanel,paintSwitchSaved;
var paintSwitchPhase=0,paintSwitchCalls=0;
function paintSwitchState(){return [global.paintSwitchPhase,global.paintSwitchCalls,global.paintSwitchGroup.cached,global.paintSwitchPanel.callOnPaint].join("|");}
function paintSwitchPixels(){
 return [global.paintSwitchSaved.getMainPixel(40,30),global.paintSwitchSaved.getMainPixel(180,30),global.paintSwitchSaved.getMainPixel(40,130)].join(",");
}
function paintSwitchApply(){
 var phase=global.paintSwitchPhase;
 global.paintSwitchGroup.cached=phase==0?0.5:phase==1?"0.5":phase==2?%[]:<%00%>;
 global.paintSwitchGroup.update();global.paintSwitchPanel.update();
 global.paintSwitchPanel.callOnPaint=phase==0?0.5:phase==1?-0.5:phase==2?"0.5":[];
 global.paintSwitchSaved.piledCopy(0,0,global.paintSwitchRoot,0,0,240,160);
 global.paintSwitchWindow.update();
 return global.paintSwitchState()+"|"+global.paintSwitchPixels();
}
function paintSwitchNext(){
 if(global.paintSwitchPhase>=3)throw new Exception("Paint switch route exceeded its bound");
 global.paintSwitchPhase++;var result=global.paintSwitchApply();
 global.Debug.message("paint-switch:"+result);return result;
}
function paintSwitchMenu(){
 global.paintSwitchPhase=0;global.paintSwitchCalls=0;
 global.paintSwitchWindow=new Window();paintSwitchWindow.caption="Painted choices";paintSwitchWindow.setInnerSize(240,160);
 global.paintSwitchRoot=new Layer(paintSwitchWindow,null);paintSwitchWindow.add(paintSwitchRoot);
 paintSwitchRoot.type=ltOpaque;paintSwitchRoot.holdAlpha=false;paintSwitchRoot.setSize(240,160);paintSwitchRoot.fillRect(0,0,240,160,0xff000000);
 global.paintSwitchGroup=new Layer(paintSwitchWindow,paintSwitchRoot);paintSwitchWindow.add(paintSwitchGroup);
 paintSwitchGroup.type=ltOpaque;paintSwitchGroup.setSize(240,100);paintSwitchGroup.hasImage=false;
 paintSwitchGroup.neutralColor=0x00800000;paintSwitchGroup.opacity=128;paintSwitchGroup.visible=true;
 global.paintSwitchChild=new Layer(paintSwitchWindow,paintSwitchGroup);paintSwitchWindow.add(paintSwitchChild);
 paintSwitchChild.type=ltOpaque;paintSwitchChild.holdAlpha=false;paintSwitchChild.setPos(120,0,120,100);
 paintSwitchChild.fillRect(0,0,120,100,0xff008000);paintSwitchChild.visible=true;
 global.paintSwitchPanel=new Layer(paintSwitchWindow,paintSwitchRoot);paintSwitchWindow.add(paintSwitchPanel);
 paintSwitchPanel.type=ltOpaque;paintSwitchPanel.holdAlpha=false;paintSwitchPanel.setPos(0,100,240,60);paintSwitchPanel.visible=true;
 paintSwitchPanel.onPaint=function(){
  if(global.paintSwitchPanel.callOnPaint)throw new Exception("Paint flag was not consumed before the callback");
  global.paintSwitchCalls++;var colors=[0xff204060,0xff604020,0xff704020,0xff207040];
  global.paintSwitchPanel.fillRect(0,0,240,60,colors[global.paintSwitchPhase]);
 };
 paintSwitchPanel.onClick=function(x,y){global.paintSwitchNext();};
 global.paintSwitchSaved=new Layer(paintSwitchWindow,paintSwitchRoot);paintSwitchWindow.add(paintSwitchSaved);
 paintSwitchSaved.setImageSize(240,160);paintSwitchWindow.visible=true;
 var result=paintSwitchApply();Debug.message("paint-switch-ready:"+result);return result;
}
function layerPaintObserve(id){
 var w=void,result,failed=false,primary;
 try{
  if(id=="paint-bool-render"){
   global.paintSwitchWindow=void;
   var rows=[paintSwitchMenu()];w=global.paintSwitchWindow;
   for(var step=0;step<3;step++)rows.add(paintSwitchNext());result=rows.join(";");
  }else{
   w=new Window();var root=new Layer(w,null);w.add(root);var child=new Layer(w,root);w.add(child);
   var field=id.substr(11),values=[0,1,-1,0.5,-0.5,0.0,4294967296,void,null,"0","1","0.5","-0.5","yes",[],%[],<%00%>,function(){}],rows=[];
   for(var i=0;i<values.count;i++){child[field]=values[i];rows.add(child[field]);}result=rows.join(",");
  }
 }catch(error){failed=true;primary=error;if(id=="paint-bool-render")w=global.paintSwitchWindow;}
 try{if(w!==void && isvalid w)invalidate w;}catch(error){if(failed)Debug.message("paint-switch-cleanup:"+error.message);else throw error;}
 if(failed)throw primary;return result;
}
`

export function layerPaintFrame(phase: number): Uint8Array {
  const result = new Uint8Array(240 * 160 * 4), panels = [0x204060, 0x604020, 0x604020, 0x207040]
  for (let y = 0; y < 160; y++) for (let x = 0; x < 240; x++) {
    const color = y >= 100 ? panels[phase]! : x < 120 ? 0x400000 : phase === 1 ? 0x008000 : 0x004000,
      at = (y * 240 + x) * 4
    result.set([color >>> 16, color >>> 8 & 255, color & 255, 255], at)
  }
  return result
}
