import { cacheBmp } from './processed-cache-fixtures.ts'

/** Three independently authored BGR24 images, each exactly 1 MiB once decoded
 * to 512 x 512 RGBA. No production cache accounting computes expectations. */
export function graphicCacheGameFiles(): Record<string, Uint8Array> {
  return { 'red.bmp': cacheBmp(0xff0000, 512, 512), 'green.bmp': cacheBmp(0x00ff00, 512, 512),
    'blue.bmp': cacheBmp(0x0000ff, 512, 512) }
}
export const graphicCacheButtons = [
  ['auto', 'Auto/preload'], ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue'],
  ['clamp', 'Max bytes'], ['zero', 'Cache off'], ['clear', 'Clear cache'], ['small', '4096 bytes'],
] as const

export const graphicCacheGameSource = String.raw`
var gcWindow=new Window();gcWindow.caption="Graphic cache game";gcWindow.setInnerSize(384,160);gcWindow.visible=true;
var gcRoot=new Layer(gcWindow,null);gcRoot.holdAlpha=false;gcRoot.setSize(384,160);gcRoot.fillRect(0,0,384,160,0xff101010);
var gcImage=new Layer(gcWindow,gcRoot);gcImage.holdAlpha=false;gcImage.visible=false;
var gcRun=System.getArgument("-gclim")===void?"default":string(System.getArgument("-gclim")),gcStep=0,gcPixel=0x101010;
var gcNames=["red.bmp","green.bmp","blue.bmp"],gcButtons=[];
function graphicCacheState(){return [gcRun,gcStep,System.graphicCacheLimit,gcPixel].join("|");}
function graphicCacheReport(action){Debug.message("graphic-cache:"+gcRun+":"+gcStep+":"+action+":"+System.graphicCacheLimit+":"+gcPixel);}
function graphicCacheAction(action){
 if(action=="auto"){System.graphicCacheLimit=gcsAuto;System.touchImages(gcNames);}
 else if(action=="clamp"){System.graphicCacheLimit=99*1024*1024;}
 else if(action=="zero"){System.graphicCacheLimit=0;System.touchImages(gcNames);}
 else if(action=="clear"){System.clearGraphicCache();}
 else if(action=="small"){System.graphicCacheLimit=4096;}
 else{
  gcImage.loadImages(action+".bmp");gcImage.setPos(0,0,384,96);gcImage.visible=true;
  gcPixel=gcImage.getMainPixel(0,0);
 }
 gcStep++;gcWindow.update();graphicCacheReport(action);
}
` + graphicCacheButtons.map(([action, title], index) => `
var gcButton${index}=new Layer(gcWindow,gcRoot);gcButton${index}.holdAlpha=false;
gcButton${index}.setPos(${index % 4 * 96},${96 + Math.floor(index / 4) * 32},96,32);
gcButton${index}.fillRect(0,0,96,32,0xff304050);gcButton${index}.font.height=12;
gcButton${index}.drawText(4,8,${JSON.stringify(title)},0xffffff);gcButton${index}.visible=true;
gcButton${index}.onClick=function(){global.graphicCacheAction(${JSON.stringify(action)});};gcButtons.add(gcButton${index});
`).join('') + String.raw`
// Ordinary game startup does not enable the cache implicitly. This call must
// return without loading anything until the player chooses Auto/preload.
System.touchImages(gcNames);gcWindow.update();graphicCacheReport("ready");
`
