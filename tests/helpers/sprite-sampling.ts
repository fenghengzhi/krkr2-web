// Literal grayscale and mask bytes. The SDK runs the same public Layer methods.
// The two-pixel-to-three-pixel case distinguishes the 16.16 step from an exact
// floating point inverse at the middle destination pixel.
const row = (colors: number[], masks = colors) => colors.map((value, i) => value + '/' + masks[i]).join(',')
export const spriteSamplingCases = [
  { id: 'sprite-third-stretch', expected: row([0, 0, 64]) },
  { id: 'sprite-third-matrix', expected: row([0, 0, 64]) },
  { id: 'sprite-third-points', expected: row([0, 0, 64]) },
  { id: 'sprite-third-reversed', expected: row([64, 64, 0]) },
  { id: 'sprite-hold-stretch', expected: row([0,0,64,64,192,192,240,240], Array(8).fill(73)) },
  { id: 'sprite-hold-affine', expected: row([0,0,64,64,192,192,240,240], Array(8).fill(73)) },
  { id: 'sprite-cubic-clipped', expected: row([17,16,48,96,160,204,228,17], [73,16,48,96,160,204,228,73]) },
  { id: 'sprite-ref-clip', expected: row([64,96,160,192]) },
  { id: 'sprite-ref-neighbor', expected: row([48,96,160,204]) },
  { id: 'sprite-alpha-magnify', expected: '1,1,1,1' },
  { id: 'sprite-alpha-affine', expected: '1,1,1,1' },
  { id: 'sprite-two-pass', expected: row([15,143]) },
  { id: 'sprite-rotated', expected: row([192]) },
  // Complete RGB integers and alpha, independently reduced from constant
  // RGBA [255,128,64,255] over [0,0,0,0]. Borders use raw opacity; horizontal
  // interiors add (opacity > 7), arbitrary-angle interiors add (opacity >> 7).
  { id: 'sprite-opacity-stretch', expected: row([0x3f2010,0x402010,0x402010,0x402010,0x402010,0x402010,0x402010,0x3f2010], [63,64,64,64,64,64,64,63]) },
  { id: 'sprite-opacity-affine', expected: row([0x3f2010,0x402010,0x402010,0x402010,0x402010,0x402010,0x402010,0x3f2010], [63,64,64,64,64,64,64,63]) },
  { id: 'sprite-opacity-eight', expected: row([0x070402,0x080402,0x080402,0x080402,0x080402,0x080402,0x080402,0x070402], [7,8,8,8,8,8,8,7]) },
  { id: 'sprite-opacity-rotated64', expected: row([0x3f2010,0x3f2010,0x3f2010,0x3f2010], [63,63,63,63]) },
  { id: 'sprite-opacity-rotated128', expected: row([0x7f4020,0x804020,0x804020,0x7f4020], [127,128,128,127]) },
] as const

/** Rows remain in the real destination Layer for the browser's visible
 * preview. Unlike the original grayscale cases, expected colors are full RGB. */
export const spriteOpacityPreviews = [
  { id: 'sprite-opacity-stretch', row: 1, cells: 8 },
  { id: 'sprite-opacity-affine', row: 1, cells: 8 },
  { id: 'sprite-opacity-eight', row: 1, cells: 8 },
  { id: 'sprite-opacity-rotated64', row: 2, cells: 4 },
  { id: 'sprite-opacity-rotated128', row: 2, cells: 4 },
] as const

export const spriteSamplingSource = String.raw`
System.exitOnWindowClose=false;System.exitOnNoWindowStartup=false;
var spriteW=new Window();spriteW.caption="Sprite gallery";spriteW.setInnerSize(96,60);
var spriteRoot=new Layer(spriteW,null);spriteRoot.setSize(96,60);spriteRoot.fillRect(0,0,96,60,0xff202020);
var spriteIn=new Layer(spriteW,spriteRoot),spriteOut=new Layer(spriteW,spriteRoot);
spriteW.add(spriteIn);spriteW.add(spriteOut);spriteIn.visible=false;spriteOut.visible=false;
function spriteInit(layer,w,h){
 layer.type=ltAlpha;layer.face=dfAlpha;layer.holdAlpha=false;layer.setImageSize(w,h);layer.setSize(w,h);layer.setClip();
}
function spritePut(layer,x,y,value,mask){
 layer.setMainPixel(x,y,value*0x010101);layer.setMaskPixel(x,y,mask);
}
function spritePixel(layer,x,y){
 return (layer.getMainPixel(x,y)&255)+"/"+layer.getMaskPixel(x,y);
}
function spriteLine(n){
 var a=[];for(var x=0;x<n;x++)a.add(spritePixel(spriteOut,x,0));return a.join(",");
}
function spriteColorLine(n,y){
 var a=[];for(var x=0;x<n;x++)a.add(spriteOut.getMainPixel(x,y)+"/"+spriteOut.getMaskPixel(x,y));return a.join(",");
}
function spriteBase(){
 spriteOut.face=dfAlpha;spriteOut.holdAlpha=false;spriteOut.fillRect(0,0,8,4,0x49111111);
}
function spritePileRun(affine,type){
 spriteBase();
 if(affine)spriteOut.affinePile(spriteIn,0,0,4,1,true,2,0,0,1,.5,0,255,type);
 else spriteOut.stretchPile(0,0,8,1,spriteIn,0,0,4,1,255,type);
 return spriteLine(8);
}
function spriteSamplingRun(id){
 spriteInit(spriteIn,4,2);spriteInit(spriteOut,8,4);spriteBase();
 var values=[0,64,192,240];
 for(var x=0;x<4;x++)spritePut(spriteIn,x,0,values[x],values[x]);
 if(id.indexOf("sprite-opacity-")==0){
  spriteIn.fillRect(0,0,4,2,0xffff8040);
  spriteInit(spriteOut,8,8);spriteOut.fillRect(0,0,8,8,0);spriteOut.face=dfOpaque;
  var rotated=id=="sprite-opacity-rotated64" || id=="sprite-opacity-rotated128";
  var opacity=id=="sprite-opacity-eight"?8:id=="sprite-opacity-rotated128"?128:64;
  if(rotated)spriteOut.operateAffine(spriteIn,0,0,4,2,true,0,2,-2,0,2.5,.5,omOpaque,opacity,stFastLinear);
  else if(id=="sprite-opacity-affine")spriteOut.operateAffine(spriteIn,0,0,4,2,true,2,0,0,2,.5,.5,omOpaque,opacity,stFastLinear);
  else spriteOut.operateStretch(0,0,8,4,spriteIn,0,0,4,2,omOpaque,opacity,stFastLinear);
  return spriteColorLine(rotated?4:8,rotated?2:1);
 }
 if(id=="sprite-third-stretch")spriteOut.stretchCopy(0,0,3,1,spriteIn,0,0,2,1);
 else if(id=="sprite-third-matrix")spriteOut.affineCopy(spriteIn,0,0,2,1,true,1.5,0,0,1,.25,0);
 else if(id=="sprite-third-points")spriteOut.affineCopy(spriteIn,0,0,2,1,false,-.5,-.5,2.5,-.5,-.5,.5);
 else if(id=="sprite-third-reversed")spriteOut.stretchCopy(3,0,-3,1,spriteIn,0,0,2,1);
 else if(id=="sprite-hold-stretch" || id=="sprite-hold-affine"){
  spriteOut.face=dfOpaque;spriteOut.holdAlpha=true;
  if(id=="sprite-hold-stretch")spriteOut.stretchCopy(0,0,8,1,spriteIn,0,0,4,1,stLinear);
  else spriteOut.affineCopy(spriteIn,0,0,4,1,true,2,0,0,1,.5,0,stCubic);
  return spriteLine(8);
 }else if(id=="sprite-cubic-clipped"){
  spriteOut.setClip(1,0,6,1);spriteOut.stretchCopy(0,0,8,1,spriteIn,0,0,4,1,stCubic);return spriteLine(8);
 }else if(id=="sprite-ref-clip" || id=="sprite-ref-neighbor"){
  spriteOut.affineCopy(spriteIn,1,0,2,1,true,2,0,0,1,.5,0,stLinear|(id=="sprite-ref-neighbor"?0x10000:0));
  return spriteLine(4);
 }else if(id=="sprite-alpha-magnify" || id=="sprite-alpha-affine"){
  for(var x=0;x<4;x++)spriteIn.setMaskPixel(x,0,255);
  var affine=id=="sprite-alpha-affine",nearest=spritePileRun(affine,stNearest),checks=[];
  checks.add(int((spriteOut.getMainPixel(0,0)&255)<8 && (spriteOut.getMainPixel(7,0)&255)>228));
  for(var filter=1;filter<=3;filter++)checks.add(int(nearest==spritePileRun(affine,filter)));
  return checks.join(",");
 }else if(id=="sprite-two-pass" || id=="sprite-rotated"){
  for(var y=0;y<2;y++)for(var x=0;x<2;x++){
   var v=x && (id=="sprite-rotated" || y)?255:0;spritePut(spriteIn,x,y,v,v);
  }
  if(id=="sprite-rotated"){
   spriteOut.affineCopy(spriteIn,0,0,2,2,true,0,2,-2,0,2.5,.5,stCubic);return spritePixel(spriteOut,2,2);
  }
  spriteOut.affineCopy(spriteIn,0,0,2,2,true,2,0,0,2,.5,.5,stFastLinear);
  return spritePixel(spriteOut,1,1)+","+spritePixel(spriteOut,2,2);
 }
 return spriteLine(3);
}
function spriteSamplingClose(){invalidate spriteW;}
`
