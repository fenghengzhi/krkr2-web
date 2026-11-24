// Independent literal pixels derived from pinned TransIntf.cpp and tvpgl.c,
// not from the product transition kernels. Native live Layer observations are
// collected separately by transition-alpha-sdk.ts before any equivalence claim.
export const alphaTransitionBefore = [240,16,32,0, 0,0,0,0, 255,255,255,255, 0,0,0,255] as const
export const alphaTransitionAfter = [8,224,64,0, 255,255,255,255, 0,0,0,0, 255,255,255,255] as const

const alpha1 = [8,223,63,0, 254,254,254,0, 255,255,255,254, 0,0,0,255] as const
const alpha127 = [8,223,63,0, 254,254,254,126, 255,255,255,128, 167,167,167,255] as const
const alpha128 = [8,223,63,0, 254,254,254,128, 255,255,255,126, 170,170,170,255] as const
const alpha255 = [8,223,63,0, 254,254,254,254, 0,0,0,0, 254,254,254,255] as const
// The <512 universal switch path uses NegativeMulTable for alpha. At >=512
// its unconditional path instead interpolates alpha, even at opacity255.
const alphaUniversal128 = [8,223,63,0, 254,254,254,127, 255,255,255,127, 168,168,168,191] as const
const alphaUniversal255 = [8,223,63,0, 254,254,254,254, 0,0,0,0, 254,254,254,254] as const
const alphaWide128 = [8,223,63,0, 254,254,254,127, 255,255,255,127, 168,168,168,255] as const
const add1 = [239,16,32,0, 0,0,0,0, 254,254,254,254, 0,0,0,255] as const
const add127 = [124,119,47,0, 126,126,126,126, 128,128,128,128, 126,126,126,255] as const
const add128 = [124,120,48,0, 127,127,127,127, 127,127,127,127, 127,127,127,255] as const
const add254 = [9,222,63,0, 253,253,253,253, 1,1,1,1, 253,253,253,255] as const
const add255 = [8,223,63,0, 254,254,254,254, 0,0,0,0, 254,254,254,255] as const

export interface AlphaTransitionCase {
  id: string
  type: 'ltAlpha' | 'ltAddAlpha' | 'ltPsNormal' | 'ltPsScreen'
  kind: 'crossfade' | 'universal'
  time: number
  vague: number
  frames: readonly { tick: number; rgba: readonly number[] }[]
}
export const alphaTransitionCases: readonly AlphaTransitionCase[] =
  (['ltAlpha', 'ltAddAlpha', 'ltPsNormal', 'ltPsScreen'] as const).flatMap((type) => {
    const add = type === 'ltAddAlpha'
    return [
      { id: type + '-crossfade', type, kind: 'crossfade' as const, time: 255, vague: 0, frames: [
        { tick: 0, rgba: alphaTransitionBefore }, { tick: 1, rgba: add ? add1 : alpha1 },
        { tick: 127, rgba: add ? add127 : alpha127 }, { tick: 128, rgba: add ? add128 : alpha128 },
        { tick: 254, rgba: add ? add254 : alpha255 }, { tick: 255, rgba: alphaTransitionAfter },
      ] },
      { id: type + '-universal-64', type, kind: 'universal' as const, time: 319, vague: 64, frames: [
        { tick: 0, rgba: alphaTransitionBefore }, { tick: 32, rgba: add ? add128 : alphaUniversal128 },
        { tick: 64, rgba: add ? add255 : alphaUniversal255 }, { tick: 65, rgba: alphaTransitionAfter },
        { tick: 319, rgba: alphaTransitionAfter },
      ] },
      { id: type + '-universal-512', type, kind: 'universal' as const, time: 767, vague: 512, frames: [
        { tick: 0, rgba: alphaTransitionBefore }, { tick: 255, rgba: add ? add128 : alphaWide128 },
        { tick: 512, rgba: add ? add255 : alpha255 }, { tick: 513, rgba: add ? add255 : alpha255 },
        { tick: 767, rgba: alphaTransitionAfter },
      ] },
    ]
  })

export function alphaTransitionFiles(): Record<string, Uint8Array> {
  // 4x1 opaque-black uncompressed24-bit BMP; rule sample is literally0.
  const bytes = new Uint8Array(66), view = new DataView(bytes.buffer)
  bytes.set([66,77]); view.setUint32(2,66,true); view.setUint32(10,54,true)
  view.setUint32(14,40,true); view.setInt32(18,4,true); view.setInt32(22,1,true)
  view.setUint16(26,1,true); view.setUint16(28,24,true); view.setUint32(34,12,true)
  return { 'alpha-rule.bmp': bytes }
}
export function alphaTransitionExpected(rgba: readonly number[], completed: boolean) {
  return rgba.join(',') + '|done:' + Number(completed) + '|clock:1|visible:' + (completed ? '0,1' : '1,0')
}
// Display the actual sampled RGB and actual sampled alpha on separate opaque
// rows, avoiding canvas premultiplication hiding zero-alpha nonzero RGB.
export function alphaTransitionCanvas(rgba: readonly number[]) {
  return { width: 4, height: 2, rgba: [
    ...rgba.map((value, index) => index % 4 === 3 ? 255 : value),
    ...rgba.filter((_value, index) => index % 4 === 3).flatMap((a) => [a,a,a,255]),
  ] }
}
export const alphaTransitionLeafExpected = alphaTransitionBefore.join(',') + '|clock:0|paint:0'

export const alphaTransitionSource = String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var alphaWindow=new Window();alphaWindow.caption="Alpha transition reference";
alphaWindow.setInnerSize(4,2);alphaWindow.visible=true;
var alphaRoot=new Layer(alphaWindow,null);alphaRoot.type=ltOpaque;
alphaRoot.setImageSize(4,2);alphaRoot.setSize(4,2);alphaRoot.fillRect(0,0,4,2,0xff000000);
var alphaFore,alphaBack,alphaSaved,alphaView,alphaGuard;
var alphaTick=0,alphaTime=0,alphaClockCalls=0,alphaPaintCalls=0,alphaDone=0;
var alphaLeafClockCalls=0,alphaLeafPaintCalls=0;
// Optional native-reference journal only. Normal Session/browser consumers
// leave this void; no frame, option or callback result is replaced.
var alphaTransitionTrace=void;
function alphaTransitionMark(phase){
 if(global.alphaTransitionTrace!==void)global.alphaTransitionTrace(phase);
}
var alphaBeforeRGB=[0xf01020,0,0xffffff,0],alphaBeforeA=[0,0,255,255];
var alphaAfterRGB=[0x08e040,0xffffff,0,0xffffff],alphaAfterA=[0,255,0,255];
function alphaTransitionRetire(){
 alphaTransitionMark("retire:before");
 if(global.alphaFore!==void && isvalid global.alphaFore)global.alphaFore.stopTransition();
 if(global.alphaBack!==void && isvalid global.alphaBack)global.alphaBack.stopTransition();
 if(global.alphaFore!==void && isvalid global.alphaFore)invalidate global.alphaFore;
 if(global.alphaBack!==void && isvalid global.alphaBack)invalidate global.alphaBack;
 if(global.alphaSaved!==void && isvalid global.alphaSaved)invalidate global.alphaSaved;
 if(global.alphaView!==void && isvalid global.alphaView)invalidate global.alphaView;
 global.alphaGuard=void;
 alphaTransitionMark("retire:after");
}
function alphaReadPixels(target){
 var bytes=[];
 for(var x=0;x<4;x++){
  var rgb=target.getMainPixel(x,0),a=target.getMaskPixel(x,0);
  bytes.add((rgb>>16)&255);bytes.add((rgb>>8)&255);bytes.add(rgb&255);bytes.add(a);
 }
 return bytes.join(",");
}
function alphaTransitionStart(type,kind,time,vague,guard=true){
 alphaTransitionMark("start:before-retire");
 alphaTransitionRetire();
 alphaTransitionMark("start:before-layers");
 global.alphaFore=new Layer(global.alphaWindow,global.alphaRoot);
 global.alphaBack=new Layer(global.alphaWindow,global.alphaRoot);
 global.alphaSaved=new Layer(global.alphaWindow,global.alphaRoot);
 alphaTransitionMark("start:layers-created");
 global.alphaFore.setImageSize(4,1);global.alphaFore.setSize(4,1);global.alphaFore.type=type;
 global.alphaBack.setImageSize(4,1);global.alphaBack.setSize(4,1);global.alphaBack.type=type;
 global.alphaSaved.setImageSize(4,1);global.alphaSaved.setSize(4,1);global.alphaSaved.visible=false;
 alphaTransitionMark("start:images-sized");
 for(var x=0;x<4;x++){
  global.alphaFore.setMainPixel(x,0,global.alphaBeforeRGB[x]);global.alphaFore.setMaskPixel(x,0,global.alphaBeforeA[x]);
  global.alphaBack.setMainPixel(x,0,global.alphaAfterRGB[x]);global.alphaBack.setMaskPixel(x,0,global.alphaAfterA[x]);
 }
 global.alphaFore.visible=true;global.alphaBack.visible=false;
 alphaTransitionMark("start:images-filled");
 if(guard){
  // Fixed Complete(rect) returns MainImage for a childless matching viewport.
  // This ordinary visible child lies wholly outside the4x1 requested region.
  // GetVisibleChildrenCount counts it, but clipping gives it no pixel influence.
  global.alphaGuard=new Layer(global.alphaWindow,global.alphaFore);
  global.alphaGuard.setImageSize(1,1);global.alphaGuard.setSize(1,1);
  global.alphaGuard.type=ltAlpha;global.alphaGuard.setPos(4,0);
  global.alphaGuard.fillRect(0,0,1,1,0);global.alphaGuard.visible=true;
 }
 alphaTransitionMark("start:guard-ready");
 global.alphaView=new Layer(global.alphaWindow,global.alphaRoot);
 global.alphaView.setImageSize(4,2);global.alphaView.setSize(4,2);global.alphaView.type=ltOpaque;
 global.alphaView.fillRect(0,0,4,2,0xff000000);global.alphaView.visible=true;
 alphaTransitionMark("start:view-ready");
 global.alphaTick=0;global.alphaTime=time;global.alphaClockCalls=0;global.alphaPaintCalls=0;global.alphaDone=0;
 global.alphaFore.onPaint=function(){global.alphaPaintCalls++;};
 global.alphaFore.onTransitionCompleted=function(dest,src){
  if(dest!==global.alphaFore||src!==global.alphaBack)throw new Exception("Wrong alpha transition owners");
  global.alphaDone++;
 };
 alphaTransitionMark("start:before-transition");
 global.alphaFore.beginTransition(kind,false,global.alphaBack,%[time:time,vague:vague,rule:"alpha-rule.bmp",selfupdate:true,
  callback:function(){global.alphaClockCalls++;return global.alphaTick;}]);
 alphaTransitionMark("start:after-transition");
 return "started";
}
function alphaTransitionLeaf(type){
 // A separate never-shown owned Window keeps this negative control outside
 // any asynchronous initial paint of the visible inspection Window.
 var w=new Window();w.setInnerSize(4,1);w.visible=false;
 var root=new Layer(w,null),f=new Layer(w,root),b=new Layer(w,root),saved=new Layer(w,root);
 root.setImageSize(4,1);root.setSize(4,1);
 f.setImageSize(4,1);f.setSize(4,1);f.type=type;f.visible=true;
 b.setImageSize(4,1);b.setSize(4,1);b.type=type;b.visible=false;
 saved.setImageSize(4,1);saved.setSize(4,1);saved.visible=false;
 for(var x=0;x<4;x++){
  f.setMainPixel(x,0,global.alphaBeforeRGB[x]);f.setMaskPixel(x,0,global.alphaBeforeA[x]);
  b.setMainPixel(x,0,global.alphaAfterRGB[x]);b.setMaskPixel(x,0,global.alphaAfterA[x]);
 }
 global.alphaLeafClockCalls=0;global.alphaLeafPaintCalls=0;
 f.onPaint=function(){global.alphaLeafPaintCalls++;};
 f.beginTransition("crossfade",false,b,%[time:255,selfupdate:true,
  callback:function(){global.alphaLeafClockCalls++;return 127;}]);
 f.update();var calls=global.alphaLeafClockCalls,paints=global.alphaLeafPaintCalls;
 saved.piledCopy(0,0,f,0,0,4,1);
 var clockChanged=int(global.alphaLeafClockCalls>calls),paintChanged=int(global.alphaLeafPaintCalls>paints);
 var result=alphaReadPixels(saved)+"|clock:"+clockChanged+"|paint:"+paintChanged;
 f.stopTransition();b.stopTransition();invalidate w;
 return result;
}
function alphaTransitionSample(tick){
 var calls=global.alphaClockCalls;
 global.alphaTick=tick;global.alphaFore.update();
 var target=global.alphaSaved;
 if(tick==global.alphaTime){
  // Completion exchanges the visible owners. Finish through the real Window
  // update, then read the now-visible source's own original image rather than
  // asking the retired destination to represent the final transition frame.
  alphaTransitionMark("sample:before-window-update");
  global.alphaWindow.update();target=global.alphaBack;
  alphaTransitionMark("sample:after-window-update");
 }else{
  alphaTransitionMark("sample:before-piled-copy");
  global.alphaSaved.piledCopy(0,0,global.alphaFore,0,0,4,1);
  alphaTransitionMark("sample:after-piled-copy");
 }
 var clockChanged=int(global.alphaClockCalls>calls),completed=global.alphaDone;
 var result=alphaReadPixels(target)+"|done:"+completed+"|clock:"+clockChanged+
  "|visible:"+int(global.alphaFore.visible)+","+int(global.alphaBack.visible);
 for(var x=0;x<4;x++){
  var rgb=target.getMainPixel(x,0),a=target.getMaskPixel(x,0);
  global.alphaView.setMainPixel(x,0,rgb);global.alphaView.setMaskPixel(x,0,255);
  global.alphaView.setMainPixel(x,1,a*0x010101);global.alphaView.setMaskPixel(x,1,255);
 }
 return result;
}
function alphaTransitionClose(){alphaTransitionRetire();invalidate global.alphaWindow;return "closed";}
Debug.message("alpha-transition-ready");
`

export function alphaTransitionSessionFiles(binary: boolean): Record<string, string | Uint8Array> {
  return { ...alphaTransitionFiles(), 'alpha-transition.tjs': alphaTransitionSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("alpha-transition.tjs","savedata/alpha-transition.cjs",false,true,false);Scripts.execStorage("savedata/alpha-transition.cjs");'
      : 'Scripts.execStorage("alpha-transition.tjs");' }
}

export const alphaTransitionChecks = [
  ...alphaTransitionCases.flatMap((c) => [
    ...(c.kind === 'crossfade' ? [{ id: c.id + ':leaf', call: `alphaTransitionLeaf(${c.type})`, expected: alphaTransitionLeafExpected }] : []),
    { id: c.id + ':start', call: `alphaTransitionStart(${c.type},"${c.kind}",${c.time},${c.vague})`, expected: 'started' },
    ...c.frames.map(({ tick, rgba }) => ({ id: c.id + ':' + tick, call: `alphaTransitionSample(${tick})`,
      expected: alphaTransitionExpected(rgba, tick === c.time) })),
  ]),
  { id: 'close', call: 'alphaTransitionClose()', expected: 'closed' },
] as const
