/** Authored source pixels, independent of the transition implementation. */
function image(after: boolean): Uint8Array {
  const bytes = new Uint8Array(54 + 100 * 100 * 4), view = new DataView(bytes.buffer)
  bytes.set([66, 77]); view.setUint32(2, bytes.length, true); view.setUint32(10, 54, true)
  view.setUint32(14, 40, true); view.setInt32(18, 100, true); view.setInt32(22, -100, true)
  view.setUint16(26, 1, true); view.setUint16(28, 32, true); view.setUint32(34, 40000, true)
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++)
    bytes.set(after ? [233, 200 - y, 200 - x, 255] : [17, y, x, 255], 54 + (y * 100 + x) * 4)
  return bytes
}
export const scrollPhaseFiles = () => ({ 'scroll-old.bmp': image(false), 'scroll-new.bmp': image(true) })

/** Literal rectangle placements at the specified whole-pixel offset. This
 * never computes a time fraction or reads a product transition result. */
export function scrollPhasePixels(from: number, offset: 0 | 28 | 29 | 30 | 100): number[] {
  const result: number[] = []
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    let sourceX = x, sourceY = y, after: boolean
    if (from === 0) { after = x < offset; sourceX = after ? x + 100 - offset : x - offset }
    else if (from === 2) { after = x >= 100 - offset; sourceX = after ? x - 100 + offset : x + offset }
    else if (from === 1) { after = y < offset; sourceY = after ? y + 100 - offset : y - offset }
    else if (from === 3) { after = y >= 100 - offset; sourceY = after ? y - 100 + offset : y + offset }
    else throw new Error('Unknown authored scroll direction')
    result.push(...(after ? [200 - sourceX, 200 - sourceY, 233, 255] : [sourceX, sourceY, 17, 255]))
  }
  return result
}
export const scrollPhaseSource = String.raw`
var phaseWindow=new Window();phaseWindow.caption="scroll-phase";phaseWindow.setInnerSize(100,100);
var phaseRoot=new Layer(phaseWindow,null);phaseRoot.setImageSize(100,100);phaseRoot.setSize(100,100);phaseRoot.type=ltOpaque;
phaseRoot.fillRect(0,0,100,100,0xff000000);phaseWindow.visible=true;
var phaseFore,phaseBack,phaseTick=0,phaseDone=0;
function scrollPhaseRetire(){
  if(global.phaseFore!==void && isvalid global.phaseFore){global.phaseFore.stopTransition();invalidate global.phaseFore;}
  if(global.phaseBack!==void && isvalid global.phaseBack)invalidate global.phaseBack;
}
function scrollPhaseStart(from){
  scrollPhaseRetire();global.phaseTick=0;global.phaseDone=0;
  global.phaseFore=new Layer(global.phaseWindow,global.phaseRoot);
  global.phaseBack=new Layer(global.phaseWindow,global.phaseRoot);
  global.phaseFore.loadImages("scroll-old.bmp");global.phaseBack.loadImages("scroll-new.bmp");
  global.phaseFore.setSize(100,100);global.phaseBack.setSize(100,100);
  global.phaseFore.type=ltOpaque;global.phaseBack.type=ltOpaque;
  global.phaseFore.visible=true;global.phaseBack.visible=false;
  global.phaseFore.onTransitionCompleted=function(dest,src){
    if(dest!==global.phaseFore||src!==global.phaseBack)throw new Exception("Wrong scroll completion owners");
    global.phaseDone++;
  };
  global.phaseFore.beginTransition("scroll",false,global.phaseBack,%[time:100,from:from,stay:0,selfupdate:true,callback:function(){return global.phaseTick;}]);
  global.phaseFore.update();global.phaseWindow.update();return global.phaseDone;
}
function scrollPhaseAt(tick){
  global.phaseTick=tick;global.phaseFore.update();global.phaseWindow.update();return global.phaseDone;
}
Debug.message("scroll-phase-ready");
`
