/** Fixed 2.32stable LayerIntf ColorRect (3725–3764) delegates dfOpaque to
 * LayerBitmapIntf FillColor (462–503): negative opacity clamps to zero after
 * the original zero early return. It still reports a modified rectangle.
 * Alpha erasing and additive-alpha rejection are separate public contracts. */
const originalPixels = `${0x204060},17,${0x6080a0},128,${0xa06020},240`
export const layerColorOpacityCases = [
  { id: 'color-opaque-negative', expected: Array(6).fill(originalPixels + '|1').join(';') },
  { id: 'color-opaque-ramp', expected: [originalPixels,
    `${0x204060},17,${0x304050},128,${0xa06020},240`,
    `${0x204060},17,0,128,${0xa06020},240`,
    `${0x204060},17,0,128,${0xa06020},240`].join(';') },
  { id: 'color-alpha-erase', expected: `${0x204060},17,${0x6080a0},63,${0xa06020},240|1` },
  { id: 'color-addalpha-negative', expected: `1|${originalPixels}|0` },
] as const
export const layerColorOpacityStates = [
  '0|CHAPTER ONE|',
  '1|CHAPTER RESTORED|96:3952740,6568980;32:5533836,9196572;-32:6324384,10510368',
  '2|CHAPTER TWO|96:3952740,6568980;32:5533836,9196572;-32:6324384,10510368',
] as const
export const layerColorOpacitySource = String.raw`
function colorOpacityPixels(layer){
 var values=[];for(var x=0;x<3;x++){values.add(layer.getMainPixel(x,0));values.add(layer.getMaskPixel(x,0));}
 return values.join(",");
}
function colorOpacityReset(layer){
 layer.setClip();layer.face=dfAlpha;
 var colors=[0x204060,0x6080a0,0xa06020],masks=[17,128,240];
 for(var x=0;x<3;x++){layer.setMainPixel(x,0,colors[x]);layer.setMaskPixel(x,0,masks[x]);}
 layer.setClip(1,0,1,1);layer.imageModified=false;
}
function layerColorOpacityObserve(id){
 var w=void,failed=false,primary,result;
 try{
  w=new Window();var root=new Layer(w,null);w.add(root);
  var layer=new Layer(w,root);w.add(layer);layer.setImageSize(3,1);layer.setSize(3,1);
  var rows=[];
  if(id=="color-opaque-negative"){
   var opacities=[-1,-255,-300];
   for(var hold=0;hold<2;hold++)for(var i=0;i<opacities.count;i++){
    colorOpacityReset(layer);layer.type=ltOpaque;layer.face=dfAuto;layer.holdAlpha=hold;
    // Setting type can reset the clip; establish the actual drawing area last.
    layer.setClip(1,0,1,1);layer.imageModified=false;
    layer.colorRect(0,0,3,1,0,opacities[i]);
    rows.add(colorOpacityPixels(layer)+"|"+int(layer.imageModified));
   }
   result=rows.join(";");
  }else if(id=="color-opaque-ramp"){
   var opacities=[0,128,255,300];
   for(var i=0;i<opacities.count;i++){
    colorOpacityReset(layer);layer.face=dfOpaque;
    layer.colorRect(0,0,3,1,0,opacities[i]);rows.add(colorOpacityPixels(layer));
   }
   result=rows.join(";");
  }else if(id=="color-alpha-erase"){
   colorOpacityReset(layer);layer.face=dfAlpha;layer.colorRect(0,0,3,1,0,-128);
   result=colorOpacityPixels(layer)+"|"+int(layer.imageModified);
  }else if(id=="color-addalpha-negative"){
   colorOpacityReset(layer);layer.face=dfAddAlpha;var rejected=false;
   try{layer.colorRect(0,0,3,1,0,-1);}catch(error){rejected=true;}
   result=int(rejected)+"|"+colorOpacityPixels(layer)+"|"+int(layer.imageModified);
  }else throw new Exception("Unknown color opacity case");
 }catch(error){failed=true;primary=error;}
 try{if(w!==void && isvalid w)invalidate w;}catch(error){if(failed)Debug.message("color-opacity-cleanup:"+error.message);else throw error;}
 if(failed)throw primary;return result;
}
var colorOpacityWindow,colorOpacityRoot,colorOpacityScene,colorOpacityButton;
var colorOpacityPhase=0,colorOpacityStory="",colorOpacityTrace=[];
function colorOpacityState(){return global.colorOpacityPhase+"|"+global.colorOpacityStory+"|"+global.colorOpacityTrace.join(";");}
function colorOpacityPicture(){
 var colors=global.colorOpacityPhase==2?[0xff287848,0xff784828]:[0xff6080a0,0xffa06020];
 global.colorOpacityScene.fillRect(0,0,160,100,colors[0]);
 global.colorOpacityScene.fillRect(160,0,160,100,colors[1]);
}
function colorOpacityButtonDraw(){
 var layer=global.colorOpacityButton,phase=global.colorOpacityPhase;
 layer.fillRect(0,0,320,60,phase==2?0xff206040:0xff204060);
 layer.drawText(12,16,phase==0?"Restore chapter":phase==1?"Continue":"Chapter two",0xffffff);
}
function colorOpacityNext(){
 if(global.colorOpacityPhase==0){
  var opacities=[96,32,-32];
  for(var i=0;i<opacities.count;i++){
   global.colorOpacityPicture();global.colorOpacityScene.colorRect(0,0,320,100,0,opacities[i]);
   global.colorOpacityTrace.add(opacities[i]+":"+global.colorOpacityScene.getMainPixel(40,30)+","+global.colorOpacityScene.getMainPixel(200,30));
  }
  global.colorOpacityPhase=1;global.colorOpacityStory="CHAPTER RESTORED";
 }else if(global.colorOpacityPhase==1){
  global.colorOpacityPhase=2;global.colorOpacityStory="CHAPTER TWO";global.colorOpacityPicture();
 }else throw new Exception("Chapter route already complete");
 global.colorOpacityButtonDraw();global.colorOpacityWindow.update();
 var result=global.colorOpacityState();Debug.message("color-opacity:"+result);return result;
}
function colorOpacityMenu(){
 global.colorOpacityPhase=0;global.colorOpacityStory="CHAPTER ONE";global.colorOpacityTrace=[];
 global.colorOpacityWindow=new Window();colorOpacityWindow.caption="Chapter fade";colorOpacityWindow.setInnerSize(320,160);
 global.colorOpacityRoot=new Layer(colorOpacityWindow,null);colorOpacityWindow.add(colorOpacityRoot);
 colorOpacityRoot.type=ltOpaque;colorOpacityRoot.holdAlpha=false;colorOpacityRoot.setSize(320,160);colorOpacityRoot.fillRect(0,0,320,160,0xff102030);
 global.colorOpacityScene=new Layer(colorOpacityWindow,colorOpacityRoot);colorOpacityWindow.add(colorOpacityScene);
 colorOpacityScene.type=ltOpaque;colorOpacityScene.holdAlpha=false;colorOpacityScene.setSize(320,100);colorOpacityScene.visible=true;
 global.colorOpacityButton=new Layer(colorOpacityWindow,colorOpacityRoot);colorOpacityWindow.add(colorOpacityButton);
 colorOpacityButton.type=ltOpaque;colorOpacityButton.holdAlpha=false;colorOpacityButton.setPos(0,100,320,60);colorOpacityButton.visible=true;
 colorOpacityButton.font.height=20;colorOpacityButton.onClick=function(x,y){global.colorOpacityNext();};
 colorOpacityPicture();colorOpacityScene.colorRect(0,0,320,100,0,128);colorOpacityButtonDraw();
 colorOpacityWindow.visible=true;colorOpacityWindow.update();
 var result=colorOpacityState();Debug.message("color-opacity-ready:"+result);return result;
}
`

/** Every pixel of the scene, independent of the platform's button font. */
export function layerColorOpacityFrame(phase: number): Uint8Array {
  const colors = phase === 0 ? [0x304050, 0x503010] : phase === 1 ? [0x6080a0, 0xa06020] : [0x287848, 0x784828],
    data = new Uint8Array(320 * 100 * 4)
  for (let y = 0; y < 100; y++) for (let x = 0; x < 320; x++) {
    const color = colors[x < 160 ? 0 : 1]!
    data.set([color >>> 16, color >>> 8 & 255, color & 255, 255], (y * 320 + x) * 4)
  }
  return data
}
