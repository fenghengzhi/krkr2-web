/** LayerIntf.cpp SetVisible(bool) 988/8638 and the explicit variant bool
 * setters at 9212/9278/9326. Strings use TJS AsInteger, not JS truthiness;
 * holdAlpha at 8949 deliberately remains integer-then-bool. */
const matrix = '0,1,1,1,1,0,1,0,0,0,1,0,0,0,1,1,1,1'
export const layerInputBooleanCases = [
  { id: 'layer-bool-visible', expected: matrix },
  { id: 'layer-bool-enabled', expected: matrix },
  { id: 'layer-bool-focusable', expected: matrix },
  { id: 'layer-bool-joinFocusChain', expected: matrix },
  { id: 'layer-bool-once', expected: '4|1,1,1,1|0,0|1|0' },
] as const

export const layerInputBooleanSource = String.raw`
var layerInputReads=0;
function layerInputOnce(){global.layerInputReads++;return %[];}
function layerInputBooleanRun(id,owned){
 var w=new Window();owned.add(w);var root=new Layer(w,null);w.add(root);root.setSize(8,8);
 var child=new Layer(w,root);w.add(child);child.setSize(8,8);
 if(id!="layer-bool-once"){
  var field=id.substr(11),values=[0,1,-1,0.5,-0.5,0.0,4294967296,void,null,"0","1","0.5","-0.5","yes",[],%[],<%00%>,function(){}],rows=[];
  for(var i=0;i<values.count;i++){child[field]=values[i];rows.add(child[field]);}
  return rows.join(",");
 }
 global.layerInputReads=0;
 child.visible=layerInputOnce();child.enabled=layerInputOnce();
 child.focusable=layerInputOnce();child.joinFocusChain=layerInputOnce();
 var result=global.layerInputReads+"|"+[child.visible,child.enabled,child.focusable,child.joinFocusChain].join(",");
 child.holdAlpha=0.5;child.opacity=0.5;result+="|"+[child.holdAlpha,child.opacity].join(",");
 var rejected=false;try{child.holdAlpha=%[];}catch(e){rejected=true;}
 return result+"|"+int(rejected)+"|"+child.holdAlpha;
}
function layerInputBooleanObserve(id){
 var owned=[],result,failed=false,primary,cleanup=[];
 try{result=layerInputBooleanRun(id,owned);}catch(e){failed=true;primary=e;}
 for(var i=owned.count-1;i>=0;i--){try{if(isvalid owned[i])invalidate owned[i];}catch(e){cleanup.add(e.message);}}
 if(failed){if(cleanup.count)Debug.message("layer-bool-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Layer boolean cleanup failed: "+cleanup.join("|"));return result;
}

var layerInputWindow,layerInputRoot,layerInputLeft,layerInputRight,layerInputPhase=0,layerInputChoice="none";
function layerInputState(){
 var focus=global.layerInputWindow.focusedLayer;
 return [global.layerInputPhase,global.layerInputChoice,focus===null?"none":focus.name,
  global.layerInputLeft.visible,global.layerInputLeft.enabled,global.layerInputLeft.focusable,
  global.layerInputLeft.joinFocusChain,global.layerInputRight.joinFocusChain].join("|");
}
function layerInputChoose(name){
 if(global.layerInputPhase==0 && name=="left"){
  global.layerInputPhase=1;global.layerInputRight.joinFocusChain=0.5;global.layerInputLeft.enabled="0.5";
 }else if(global.layerInputPhase==1 && name=="right"){
  global.layerInputPhase=2;global.layerInputLeft.enabled=<%00%>;global.layerInputLeft.visible="0.5";
 }else if(global.layerInputPhase==2 && name=="right"){
  global.layerInputPhase=3;global.layerInputLeft.visible=-0.5;global.layerInputRight.joinFocusChain="0.5";
 }else if(global.layerInputPhase==3 && name=="left")global.layerInputPhase=4;
 else throw new Exception("Unexpected selectable layer: "+name+":"+global.layerInputPhase);
 global.layerInputChoice=name;
 var colors=[0xff101820,0xff207040,0xff704020,0xff604070,0xff207040];
 global.layerInputRoot.fillRect(0,80,240,40,colors[global.layerInputPhase]);global.layerInputWindow.update();
 global.Debug.message("layer-bool-choice:"+global.layerInputState());
}
class BooleanChoice extends Layer {
 function BooleanChoice(w,parent,title,x,color){
  super.Layer(w,parent);name=title;type=ltOpaque;holdAlpha=false;setPos(x,0,120,80);fillRect(0,0,120,80,color);
 }
 function onClick(x,y){global.layerInputChoose(name);}
 function onKeyDown(key,shift){if(key==13 && !shift)global.layerInputChoose(name);else super.onKeyDown(key,shift);}
}
function layerInputMenu(){
 global.layerInputWindow=new Window();layerInputWindow.caption="Selectable choices";layerInputWindow.setInnerSize(240,120);
 global.layerInputRoot=new Layer(layerInputWindow,null);layerInputWindow.add(layerInputRoot);
 layerInputRoot.type=ltOpaque;layerInputRoot.holdAlpha=false;layerInputRoot.setSize(240,120);layerInputRoot.fillRect(0,0,240,120,0xff101820);
 global.layerInputLeft=new BooleanChoice(layerInputWindow,layerInputRoot,"left",0,0xff204060);layerInputWindow.add(layerInputLeft);
 global.layerInputRight=new BooleanChoice(layerInputWindow,layerInputRoot,"right",120,0xff604020);layerInputWindow.add(layerInputRight);
 layerInputLeft.visible=0.5;layerInputLeft.enabled=-0.5;layerInputLeft.focusable=0.5;layerInputLeft.joinFocusChain=-0.5;
 layerInputRight.visible=%[];layerInputRight.enabled=[];layerInputRight.focusable=<%00%>;layerInputRight.joinFocusChain="0.5";
 layerInputWindow.visible=true;layerInputLeft.focus();layerInputWindow.update();
 Debug.message("layer-bool-ready:"+layerInputState());
}
`

export const layerInputStates = [
  '0|none|left|1|1|1|1|0',
  '1|left|right|1|0|1|1|1',
  '2|right|right|0|1|1|1|1',
  '3|right|right|1|1|1|1|0',
  '3|right|left|1|1|1|1|0',
  '4|left|left|1|1|1|1|0',
] as const

export function layerInputFrame(phase: number): Uint8Array {
  const colors = [0x101820, 0x207040, 0x704020, 0x604070, 0x207040], result = new Uint8Array(240 * 120 * 4)
  for (let y = 0; y < 120; y++) for (let x = 0; x < 240; x++) {
    const color = y >= 80 ? colors[phase]! : x >= 120 ? 0x604020 : phase === 2 ? 0x101820 : 0x204060,
      at = (y * 240 + x) * 4
    result.set([color >>> 16, color >>> 8 & 255, color & 255, 255], at)
  }
  return result
}
