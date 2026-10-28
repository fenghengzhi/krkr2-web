import { imageFixture } from './image-fixtures.ts'
import { tlgFixture } from './tlg-fixtures.ts'
import { solidBmp } from './archive-patch.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

/** Independent BMP/PNG/TLG fixtures exercise the script's selected handler. */
export function imageSelectionFiles(): Record<string, Uint8Array> {
  return {
    'choice.tlg6': tlgFixture('6-4-solid-17x9-auto'),
    'choice.tlg5': tlgFixture('5-3-solid-17x9-auto'),
    'choice.tlg': tlgFixture('5-3-solid-17x9-auto'),
    'choice.eri': Uint8Array.of(1, 2, 3),
    'choice.png': imageFixture('main.png'),
    'choice.bmp': solidBmp(0x112233),
    'alias.DIB': solidBmp(0x123456),
    'only.bmp': solidBmp(0x123456),
    'onlybare': solidBmp(0xabcdef),
    'unknown.data': imageFixture('main.png'),
    'unknown.gif': imageFixture('palette-2x1.gif'),
    'wrong.bmp': imageFixture('main.png'),
    'wrong.png': solidBmp(0x112233),
    'unavailable.eri': Uint8Array.of(1, 2, 3),
    'unavailable.png': imageFixture('main.png'),
    'maskfail.bmp': solidBmp(0x112233),
    'maskfail_m.tlg6': tlgFixture('6-4-solid-17x9-auto'),
    'provincefail.bmp': solidBmp(0x445566),
    'provincefail_p.tlg6': tlgFixture('6-4-solid-17x9-auto'),
    'art/hero.PNG': imageFixture('main.png'),
    'art/hero_m.png': imageFixture('palette-2x1.png'),
    'art/hero_p.png': imageFixture('mask.png'),
    'patch/hero_m.png': imageFixture('mask.png'),
    'patch/hero_p.png': imageFixture('palette-2x1.png'),
    'assets.xp3': xp3Fixture({
      'inside/arch.DIB': solidBmp(0x789abc),
      'inside/arch_m.png': imageFixture('png-0-8-0-1x1'),
      'inside/packed.tlg6': tlgFixture('6-4-solid-17x9-auto'),
      'inside/packed.png': imageFixture('main.png'),
    }, { compressed: true }).bytes,
  }
}

export const imageSelectionSource = String.raw`
var selectionWindow=new Window();selectionWindow.visible=true;selectionWindow.setInnerSize(3,2);
var selectionRoot=new Layer(selectionWindow,null),selectionLayer=new Layer(selectionWindow,selectionRoot),selectionBack=new Layer(selectionWindow,selectionRoot);
selectionRoot.setSize(3,2);selectionRoot.fillRect(0,0,3,2,0xff000000);
selectionLayer.setSize(3,2);selectionLayer.visible=true;selectionBack.setSize(3,2);
function imageFailure(name,operation=0){
  try{
    if(operation==1)global.selectionLayer.loadProvinceImage(name);
    else if(operation==2)global.selectionLayer.beginTransition("universal",false,global.selectionBack,%[rule:name,time:100,selfupdate:true]);
    else global.selectionLayer.loadImages(name);
  }catch(error){return error.message;}
  return "NO_ERROR";
}
function imageSelectionMessages(){
  System.assignMessage("TVPUnknownGraphicFormat","unknown:%1");
  System.assignMessage("TVPCannotSuggestGraphicExtension","suggest:%1");
  System.assignMessage("TVPCannotOpenStorage","open:%1");
  System.assignMessage("TVPImageLoadError","bmp:%1");
  System.assignMessage("TVPPNGLoadError","png:%1");
  System.assignMessage("TVPTLGLoadError","tlg:%1");
  System.assignMessage("TVPJPEGLoadError","jpeg:%1");
  System.assignMessage("TVPNotImplemented","unavailable-handler");
  System.assignMessage("TVPCannotLoadRuleGraphic","rule:%1");
  return true;
}
function imageSelectionOrder(){
  global.selectionLayer.loadImages("choice");
  var ok=global.selectionLayer.imageWidth==17 && global.selectionLayer.getMainPixel(0,0)==0xca3511 && global.selectionLayer.getMaskPixel(0,0)==128;
  global.selectionLayer.loadImages("choice.TLG5");ok=ok && global.selectionLayer.getMaskPixel(0,0)==255;
  global.selectionLayer.loadImages("choice.tlg");ok=ok && global.selectionLayer.getMainPixel(0,0)==0xca3511;
  global.selectionLayer.loadImages("choice.PNG");ok=ok && global.selectionLayer.imageWidth==2 && global.selectionLayer.getMainPixel(0,0)==0xc86432;
  global.selectionLayer.loadImages("alias.dib");
  return ok && global.selectionLayer.imageWidth==3 && global.selectionLayer.getMainPixel(0,0)==0x123456;
}
function imageSelectionErrors(){
  return imageFailure("folder/../unknown.data")+"|"+imageFailure("absent.data")+"|"+imageFailure("unknown.gif")+"|"+imageFailure("onlybare")+"|"+imageFailure("absent.bmp")+"|"+imageFailure("unavailable");
}
function imageSelectionWrongFormat(){
  global.selectionLayer.loadImages("only.bmp");
  var bmp=imageFailure("wrong.bmp"),png=imageFailure("wrong.png");
  return bmp=="bmp:This is not a Windows BMP file or an OS/2 BMP file." && png.indexOf("png:")==0 && global.selectionLayer.getMainPixel(0,0)==0x123456;
}
function imageSelectionModes(){
  global.selectionLayer.loadImages("choice.tlg6");
  var province=imageFailure("choice.tlg6",1),mask=imageFailure("maskfail.bmp"),companion=imageFailure("provincefail.bmp");
  var completed=global.selectionLayer.getMainPixel(0,0)==0x445566 && global.selectionLayer.getProvincePixel(0,0)==0;
  global.selectionLayer.setImageSize(3,2);global.selectionLayer.setSize(3,2);global.selectionBack.setImageSize(3,2);global.selectionBack.setSize(3,2);
  var rule=imageFailure("choice.tlg6",2),missing=imageFailure("missing-rule",2);
  return province.indexOf("tlg:")==0 && mask.indexOf("tlg:")==0 && companion.indexOf("tlg:")==0 && completed && rule=="rule:choice.tlg6" && missing=="rule:missing-rule";
}
function imageSelectionCompanions(){
  Storages.addAutoPath("art/");Storages.addAutoPath("patch/");
  global.selectionLayer.loadImages("hero");
  return global.selectionLayer.getMainPixel(0,0)==0xc86432 && global.selectionLayer.getMaskPixel(0,0)==0 && global.selectionLayer.getMaskPixel(1,0)==128 && global.selectionLayer.getProvincePixel(1,0)==1;
}
function imageSelectionArchive(){
  global.selectionLayer.loadImages("assets.xp3>inside/packed");
  var ok=global.selectionLayer.imageWidth==17 && global.selectionLayer.getMaskPixel(0,0)==128;
  // The separate DIB path's intentionally small mask must retain its actual
  // size failure; then a same-format direct load can still succeed normally.
  System.assignMessage("TVPMaskSizeMismatch","mask-dimensions");
  return ok && imageFailure("assets.xp3>inside/arch.DIB")=="mask-dimensions";
}
function imageSelectionDraw(){
  global.selectionLayer.loadImages("only.bmp");global.selectionLayer.setSize(3,2);global.selectionLayer.visible=true;
  global.selectionLayer.update();global.selectionWindow.update();
  return global.selectionLayer.getMainPixel(0,0)==0x123456;
}
`

export const imageSelectionErrors = 'unknown:game://./unknown.data|unknown:game://./absent.data|unknown:game://./unknown.gif|suggest:game://./onlybare|open:game://./absent.bmp|unavailable-handler'
