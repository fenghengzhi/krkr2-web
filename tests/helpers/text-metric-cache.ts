import { readFileSync } from 'node:fs'

export const textMetricFiles = () => ({ 'metric-coverage.tft': new Uint8Array(readFileSync(new URL('../fixtures/font/coverage-v1.tft', import.meta.url))) })
export const textMetricCases = [
  { id: 'text-metric-empty', expected: '0|0|0|1|24|0|24|0|24' },
  // 157's original SDK observes zero here: textMetricWarm deliberately
  // discards getTextWidth's result, so the native method does not measure.
  { id: 'text-metric-setter', expected: '0|0|0|0|0|0|0' },
  { id: 'text-metric-bitmap', expected: '0|0|0|0' },
  { id: 'text-metric-draw', expected: '0|0|0|0' },
  { id: 'text-metric-map', expected: '0|0|4|24|0|4|0|1|24|24|0' },
  { id: 'text-metric-used-setter', expected: '24|24|24|24|0|0|0' },
  { id: 'text-metric-used-bitmap', expected: '24|0|0|24' },
  { id: 'text-metric-used-draw', expected: '0|24|24|0' },
  { id: 'text-metric-used-map', expected: '24|0|4|24|0|4|0|1|24|24|0' },
  { id: 'text-metric-results', expected: '0,0,0,0,0,0|24,24,24,24,24,24|Integer,Integer,Real,Real,Real,Real|6|1|0|24' },
  { id: 'text-metric-entry', expected: 'metric-count,metric-count,metric-count,metric-count,metric-count,metric-count|6|metric-string,metric-string,metric-string,metric-string,metric-string,metric-string|6|metric-image:getTextWidth,metric-image:getTextHeight,metric-image:getEscWidthX,metric-image:getEscWidthY,metric-image:getEscHeightX,metric-image:getEscHeightY' },
] as const

/** Stock BaseBitmap 1764/1941–42/2544–2603: cached empty text starts at
 * (0,0); it becomes a normal empty line only after another text was measured.
 * All controls use live Layer/Font objects and a separately authored TFT. */
export const textMetricSource = String.raw`
function textMetricWarm(layer){layer.font.getTextWidth("A");return layer.font.getTextHeight("");}
function textMetricUsedWarm(layer){var width=layer.font.getTextWidth("A");if(width<=0)throw new Exception("Expected actual glyph width");return layer.font.getTextHeight("");}
var textMetricArgumentReads=0;
function textMetricArgument(){global.textMetricArgumentReads++;return "A";}
function textMetricRun(id,a,b){
 var f=a.font,g=b.font,result,warm=global.textMetricWarm;f.height=24;g.height=24;
 if(id.substr(0,17)=="text-metric-used-"){id="text-metric-"+id.substr(17);warm=global.textMetricUsedWarm;}
 if(id=="text-metric-empty"){
  result=[f.getTextHeight(""),f.getTextWidth(""),int(f.getEscHeightY("")),int(f.getTextWidth("A")>0),f.getTextHeight(""),
   f.getTextWidth(""),f.getTextHeight(""),g.getTextHeight("")].join("|");
  a.fillRect(0,0,1,1,0xffffffff);return result+"|"+f.getTextHeight("");
 }
 if(id=="text-metric-setter"){
  result=warm(a);f.height=24;result+="|"+f.getTextHeight("");f.face=f.face;result+="|"+f.getTextHeight("");
  f.bold=false;result+="|"+f.getTextHeight("");f.height=25;f.height=24;result+="|"+f.getTextHeight("");
  var warmed=warm(a);f.bold=true;f.bold=false;result+="|"+f.getTextHeight("");
  warmed=warm(a);f.angle=300;f.angle=0;return result+"|"+f.getTextHeight("");
 }
 if(id=="text-metric-bitmap"){
  var warmed=warm(a);a.setImageSize(32,32);result=f.getTextHeight("");
  a.setImageSize(33,32);a.setImageSize(32,32);result+="|"+f.getTextHeight("");
  warmed=warm(a);a.assignImages(b);result+="|"+f.getTextHeight("");
  warmed=warm(a);a.fillRect(0,0,1,1,0xffffffff);return result+"|"+f.getTextHeight("");
 }
 if(id=="text-metric-draw"){
  a.drawText(0,0,"A",0xffffff);result=f.getTextHeight("");
  result+="|"+warm(a);a.drawText(0,0,"A",0xffffff);result+="|"+f.getTextHeight("");
  f.height=25;f.height=24;a.drawText(0,0,"A",0xffffff);return result+"|"+f.getTextHeight("");
 }
 if(id=="text-metric-map"){
  result=warm(b);f.mapPrerenderedFont("metric-coverage.tft");result+="|"+g.getTextHeight("");
  result+="|"+g.getTextWidth("A")+"|"+g.getTextHeight("");
  f.mapPrerenderedFont("metric-coverage.tft");result+="|"+g.getTextHeight("")+"|"+g.getTextWidth("A");
  f.unmapPrerenderedFont();result+="|"+g.getTextHeight("")+"|"+int(g.getTextWidth("A")>0)+"|"+g.getTextHeight("");
  f.unmapPrerenderedFont();return result+"|"+g.getTextHeight("")+"|"+f.getTextHeight("");
 }
 var methods=["getTextWidth","getTextHeight","getEscWidthX","getEscWidthY","getEscHeightX","getEscHeightY"];
 if(id=="text-metric-results"){
  var ignored=[],used=[],types=[];global.textMetricArgumentReads=0;
  for(var i=0;i<methods.count;i++){
   f.height=25;f.height=24;f[methods[i]](global.textMetricArgument());ignored.add(f.getTextHeight(""));
   var value=f[methods[i]]("A");types.add(typeof value);used.add(f.getTextHeight(""));
  }
  f.height=25;f.height=24;var bound=g.getTextWidth,otherWidth=bound("A");
  return ignored.join(",")+"|"+used.join(",")+"|"+types.join(",")+"|"+textMetricArgumentReads+"|"+
   int(otherWidth>0)+"|"+f.getTextHeight("")+"|"+g.getTextHeight("");
 }
 if(id=="text-metric-entry"){
  System.assignMessage("TJSBadParamCount","metric-count");
  System.assignMessage("TJSVariantConvertError","metric-string");System.assignMessage("TVPUnsupportedLayerType","metric-image:%1");
  var arity=[],converted=[],images=[],ignored=0,noImage=0;
  for(var i=0;i<methods.count;i++){
   try{f[methods[i]]();arity.add("unexpected");}catch(e){arity.add(e.message);}
   f[methods[i]](<%00%>);ignored++;
   try{var value=f[methods[i]](<%00%>);converted.add("unexpected");}catch(e){converted.add(e.message);}
  }
  a.hasImage=false;
  for(var i=0;i<methods.count;i++){
   f[methods[i]]("A");noImage++;
   try{var value=f[methods[i]]("A");images.add("unexpected");}catch(e){images.add(e.message);}
  }
  a.hasImage=true;
  return arity.join(",")+"|"+ignored+"|"+converted.join(",")+"|"+noImage+"|"+images.join(",");
 }
 throw new Exception("Unknown text metric control");
}
function textMetricObserve(id){
 var w=void,a=void,b=void,result,failed=false,primary,cleanup=[];
 try{w=new Window();a=new Layer(w,null);b=new Layer(w,a);a.setImageSize(32,32);b.setImageSize(32,32);result=textMetricRun(id,a,b);}catch(e){failed=true;primary=e;}
 try{if(a!==void && isvalid a && a.hasImage)a.font.unmapPrerenderedFont();}catch(e){cleanup.add(e.message);}
 try{if(b!==void && isvalid b)invalidate b;}catch(e){cleanup.add(e.message);}
 try{if(a!==void && isvalid a)invalidate a;}catch(e){cleanup.add(e.message);}
 try{if(w!==void && isvalid w)invalidate w;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("metric-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Text metric cleanup: "+cleanup.join("|"));return result;
}
var textMetricWindow,textMetricLayer,textMetricReference,textMetricButton,textMetricPhase=0,textMetricHeight=-1;
function textMetricDraw(){
 var text=global.textMetricPhase==1?"A":"",expected=[0,24,24,0][global.textMetricPhase];
 global.textMetricHeight=textMetricLayer.font.getTextHeight(text);
 textMetricLayer.fillRect(0,0,160,80,0xff182838);textMetricReference.fillRect(0,0,160,80,0xff182838);
 if(text!=""){textMetricLayer.drawText(4,4,text,0xffffff);textMetricReference.drawText(4,4,text,0xffffff);}
 textMetricLayer.fillRect(4,4+textMetricHeight,120,4,0xff40c080);
 textMetricReference.fillRect(4,4+expected,120,4,0xff40c080);
 textMetricButton.fillRect(0,0,320,32,[0xff285038,0xff304878,0xff703848,0xff806020][textMetricPhase]);
 textMetricLayer.update();textMetricReference.update();textMetricButton.update();
 Debug.message("text-metric-phase:"+textMetricPhase+":"+textMetricHeight);
}
function textMetricNext(){
 if(textMetricPhase>=3)return;global.textMetricPhase++;
 if(textMetricPhase==3){textMetricLayer.font.height=25;textMetricLayer.font.height=24;}
 global.textMetricDraw();
}
function textMetricMenu(){
 global.textMetricWindow=new Window();textMetricWindow.caption="Empty dialogue rows";textMetricWindow.setInnerSize(320,112);
 var root=new Layer(textMetricWindow,null);textMetricWindow.add(root);root.setSize(320,112);root.holdAlpha=false;root.fillRect(0,0,320,112,0xff182838);
 global.textMetricLayer=new Layer(textMetricWindow,root);textMetricWindow.add(textMetricLayer);textMetricLayer.setPos(0,0,160,80);textMetricLayer.holdAlpha=false;textMetricLayer.visible=true;textMetricLayer.font.height=24;
 global.textMetricReference=new Layer(textMetricWindow,root);textMetricWindow.add(textMetricReference);textMetricReference.setPos(160,0,160,80);textMetricReference.holdAlpha=false;textMetricReference.visible=true;textMetricReference.font.height=24;
 global.textMetricButton=new Layer(textMetricWindow,root);textMetricWindow.add(textMetricButton);textMetricButton.setPos(0,80,320,32);textMetricButton.holdAlpha=false;textMetricButton.visible=true;
 textMetricButton.onClick=function(){global.textMetricNext();};
 // Author code may request a warm-up and ignore its return. Stock native
 // measurement methods leave the empty-line cache untouched in that case.
 textMetricLayer.font.getTextWidth("A");textMetricLayer.font.getTextHeight("A");
 textMetricLayer.font.getEscWidthX("A");textMetricLayer.font.getEscWidthY("A");
 textMetricLayer.font.getEscHeightX("A");textMetricLayer.font.getEscHeightY("A");
 global.textMetricDraw();textMetricWindow.visible=true;Debug.message("text-metric-game-ready");
}
`

export function textMetricFrameMismatch(bytes: Uint8Array, width: number, height: number, phase: number): string | null {
  if (width !== 320 || height !== 112 || bytes.length !== width * height * 4) return 'Frame dimensions differ'
  const row = [0, 24, 24, 0][phase], colors = [[40, 80, 56, 255], [48, 72, 120, 255], [112, 56, 72, 255], [128, 96, 32, 255]], color = colors[phase]
  if (row === undefined || !color) return 'Unexpected metric phase'
  for (let y = 0; y < 80; y++) for (let x = 0; x < 160; x++) for (let c = 0; c < 4; c++)
    if (bytes[(y * width + x) * 4 + c] !== bytes[(y * width + x + 160) * 4 + c]) return `Rows differ at ${x},${y},${c}`
  for (let y = 80; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++)
    if (bytes[(y * width + x) * 4 + c] !== color[c]) return `Status differs at ${x},${y},${c}`
  for (let x = 4; x < 124; x++) for (let c = 0; c < 4; c++)
    if (bytes[((4 + row) * width + x) * 4 + c] !== [64, 192, 128, 255][c]) return 'Authored baseline is absent'
  if (phase === 1) {
    let ink = false
    for (let y = 4; y < 28; y++) for (let x = 4; x < 40; x++) {
      const at = (y * width + x) * 4
      if (bytes[at]! > 24 && bytes[at + 1]! > 40 && bytes[at + 2]! > 56) ink = true
    }
    if (!ink) return 'The visible dialogue glyph is absent'
  }
  return null
}
