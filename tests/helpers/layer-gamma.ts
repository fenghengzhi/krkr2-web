// Literal pixel expectations from the pinned scalar TVP gamma table and the
// Layer clip/zero-alpha contract. The original SDK observes them independently.
const before = [64,128,192,0, 64,128,192,1, 192,64,128,128, 255,0,128,255] as const
export const layerGammaCases = [
  { id: 'gamma-contrast-clipped', rgba: [64,128,192,0, 32,127,0,1, 224,223,0,128, 255,0,128,255], clip: '0,0,3,1' },
  { id: 'gamma-contrast-full', rgba: [64,128,192,0, 32,127,0,1, 224,223,0,128, 255,255,0,255], clip: '0,0,4,1' },
  // The documented native gamma range includes 9.5. Constant ramps isolate
  // its acceptance from transcendental rounding, while alpha/clip remain real.
  { id: 'gamma-wide', rgba: [64,128,192,0, 50,100,150,1, 50,100,150,128, 50,100,150,255], clip: '0,0,4,1' },
] as const
export const layerGammaExpected = (row: (typeof layerGammaCases)[number]) =>
  `${row.rgba.join(',')}|clip:${row.clip}|province:11,12,13,14|modified:1|type:2|face:0`
export const layerGammaCanvas = (row: (typeof layerGammaCases)[number]) => ({ width: 4, height: 2, rgba: [
  ...row.rgba.map((value, index) => index % 4 === 3 ? 255 : value),
  ...row.rgba.filter((_value, index) => index % 4 === 3).flatMap((alpha) => [alpha, alpha, alpha, 255]),
] })

export const layerGammaSource = String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var gammaWindow=new Window();gammaWindow.caption="Gamma contrast";gammaWindow.setInnerSize(4,2);
var gammaRoot=new Layer(gammaWindow,null);gammaRoot.type=ltOpaque;gammaRoot.setImageSize(4,2);gammaRoot.setSize(4,2);
var gammaImage=new Layer(gammaWindow,gammaRoot);gammaImage.type=ltAlpha;gammaImage.setImageSize(4,1);gammaImage.setSize(4,1);
var gammaDisplay=new Layer(gammaWindow,gammaRoot);gammaDisplay.type=ltOpaque;gammaDisplay.setImageSize(4,2);gammaDisplay.setSize(4,2);gammaDisplay.visible=true;
var gammaOriginal=[${before.join(',')}];
function gammaRead(){
 var a=[];
 for(var x=0;x<4;x++){
  var rgb=gammaImage.getMainPixel(x,0);a.add((rgb>>16)&255);a.add((rgb>>8)&255);a.add(rgb&255);a.add(gammaImage.getMaskPixel(x,0));
 }
 return a;
}
function layerGammaRun(id){
 gammaImage.setClip();gammaImage.face=dfAlpha;
 for(var x=0;x<4;x++){
  var at=x*4;gammaImage.setMainPixel(x,0,(gammaOriginal[at]<<16)|(gammaOriginal[at+1]<<8)|gammaOriginal[at+2]);
  gammaImage.setMaskPixel(x,0,gammaOriginal[at+3]);gammaImage.setProvincePixel(x,0,11+x);
 }
 gammaImage.setClip(0,0,id=="gamma-contrast-clipped"?3:4,1);gammaImage.imageModified=false;
 if(id=="gamma-wide")gammaImage.adjustGamma(9.5,50,50,9.5,100,100,9.5,150,150);
 else gammaImage.adjustGamma(1,-64,319,1,319,-64,1,-300,-100);
 var pixels=gammaRead(),province=[];
 for(var x=0;x<4;x++)province.add(gammaImage.getProvincePixel(x,0));
 return pixels.join(",")+"|clip:"+[gammaImage.clipLeft,gammaImage.clipTop,gammaImage.clipWidth,gammaImage.clipHeight].join(",")+
  "|province:"+province.join(",")+"|modified:"+int(gammaImage.imageModified)+"|type:"+gammaImage.type+"|face:"+gammaImage.face;
}
function layerGammaShow(){
 for(var x=0;x<4;x++){
  gammaDisplay.setMainPixel(x,0,gammaImage.getMainPixel(x,0));gammaDisplay.setMaskPixel(x,0,255);
  var a=gammaImage.getMaskPixel(x,0);gammaDisplay.setMainPixel(x,1,a*0x010101);gammaDisplay.setMaskPixel(x,1,255);
 }
 gammaWindow.visible=true;gammaWindow.update();return "shown";
}
function layerGammaClose(){invalidate gammaWindow;return "closed";}
`
