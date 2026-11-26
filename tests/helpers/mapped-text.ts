/** Independently authored TFT v1. I is a repeating coverage ramp and J is
 * transparent. Tall outlines make the sampled rows independent of installed
 * system-font ascent; the image clip selects their interior. */
export function mappedTextFiles(): Record<string, Uint8Array> {
  const rows = [0, 16, 32, 48, 64, 48, 16, 0], bytes = new Uint8Array(80 + 8 * 256 + 3 * 256), view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('TVP pre-rendered font\x1a')); bytes[22] = 1; bytes[23] = 2
  view.setUint32(24, 2, true); view.setUint32(28, 36, true); view.setUint32(32, 40, true)
  for (const [i, width] of [8, 3].entries()) {
    view.setUint16(36 + i * 2, 73 + i, true)
    const at = 40 + i * 20
    view.setUint32(at, 80 + (i ? 8 * 256 : 0), true)
    view.setUint16(at + 4, width, true); view.setUint16(at + 6, 256, true)
    view.setInt16(at + 10, 128, true); view.setInt16(at + 12, width, true); view.setInt16(at + 16, width, true)
  }
  for (let y = 0; y < 256; y++) bytes.set(rows, 80 + y * 8)
  return { 'mapped-subtitle.tft': bytes }
}

// Literal RGBA, hand-derived from fixed colormap.nas and the stock C opacity
// variants. Original SDK observations compare the same independent inputs.
export const mappedTextCases = [
  { id: 'mapped-opaque', face: 1, opacity: 255, hold: false, rgba: [16,32,64,64, 60,56,64,48, 104,80,64,32, 148,104,64,16, 192,128,64,0, 148,104,64,16, 60,56,64,48, 16,32,64,64] },
  { id: 'mapped-held', face: 1, opacity: 255, hold: true, rgba: [16,32,64,64, 60,56,64,64, 104,80,64,64, 148,104,64,64, 192,128,64,64, 148,104,64,64, 60,56,64,64, 16,32,64,64] },
  { id: 'mapped-opaque-half', face: 1, opacity: 128, hold: false, rgba: [16,32,64,0, 38,44,64,0, 60,56,64,0, 82,68,64,0, 104,80,64,0, 82,68,64,0, 38,44,64,0, 16,32,64,0] },
  { id: 'mapped-alpha', face: 0, opacity: 255, hold: true, rgba: [16,32,64,64, 115,86,64,112, 155,108,64,160, 177,120,64,208, 191,127,64,255, 177,120,64,208, 115,86,64,112, 16,32,64,64] },
  { id: 'mapped-additive', face: 4, opacity: 255, hold: true, rgba: [16,32,64,64, 60,56,64,112, 104,80,64,160, 148,104,64,208, 192,128,64,255, 148,104,64,208, 60,56,64,112, 16,32,64,64] },
  { id: 'mapped-additive-half', face: 4, opacity: 128, hold: true, rgba: [15,31,63,64, 37,43,63,88, 59,55,63,112, 81,67,63,136, 103,79,63,160, 81,67,63,136, 37,43,63,88, 15,31,63,64] },
  { id: 'mapped-remove', face: 0, opacity: -255, hold: true, rgba: [16,32,64,64, 16,32,64,48, 16,32,64,32, 16,32,64,16, 16,32,64,0, 16,32,64,16, 16,32,64,48, 16,32,64,64] },
  { id: 'mapped-remove-half', face: 0, opacity: -128, hold: true, rgba: [16,32,64,64, 16,32,64,55, 16,32,64,47, 16,32,64,39, 16,32,64,31, 16,32,64,39, 16,32,64,55, 16,32,64,64] },
  { id: 'mapped-shadow-level', face: 1, opacity: 255, hold: true, shadow: 0, rgba: [16,32,64,64, 38,44,64,64, 60,56,64,64, 82,68,64,64, 104,80,64,64, 82,68,64,64, 38,44,64,64, 16,32,64,64] },
  { id: 'mapped-shadow-blur', face: 1, opacity: 255, hold: true, shadow: 1, rgba: [24,36,64,64, 54,53,64,64, 90,72,64,64, 137,98,64,64, 148,104,64,64, 120,89,64,64, 62,57,64,64, 24,36,64,64] },
  // KAG MessageLayer edgeEmphasis=512. Native blur level 512 produces the
  // interior 65-level rows [0,32,64,64,64,64,32,0] and
  // [9,30,60,64,64,64,39,9] (radius 1 has eight weights 1, center 2).
  { id: 'mapped-shadow-emphasis', face: 1, opacity: 255, hold: true, shadow: 0, level: 512, rgba: [16,32,64,64, 104,80,64,64, 192,128,64,64, 192,128,64,64, 192,128,64,64, 192,128,64,64, 104,80,64,64, 16,32,64,64] },
  { id: 'mapped-shadow-emphasis-blur', face: 1, opacity: 255, hold: true, shadow: 1, level: 512, rgba: [40,45,64,64, 98,77,64,64, 181,122,64,64, 192,128,64,64, 192,128,64,64, 192,128,64,64, 123,90,64,64, 40,45,64,64] },
  { id: 'mapped-transparent-tail', face: 0, opacity: 255, hold: false, rgba: [1,2,3,0, 1,2,3,0, 191,127,63,0, 1,2,3,0, 1,2,3,0, 1,2,3,0, 1,2,3,0, 1,2,3,0] },
] as const
export const mappedTextExpected = (row: typeof mappedTextCases[number]) => [...row.rgba, ...row.rgba].join(',')

export const mappedTextSource = String.raw`
function mappedTextObserve(id,face,opacity,hold,shadow=void,level=void){
 var w=void,a=void,result,failed=false,primary,cleanup=[];
 try{
  w=new Window();a=new Layer(w,null);a.setImageSize(8,2);a.font.height=12;
  a.font.mapPrerenderedFont("mapped-subtitle.tft");a.face=dfAlpha;a.holdAlpha=false;
  a.fillRect(0,0,8,2,id=="mapped-transparent-tail"?0x00010203:0x40102040);a.face=face;a.holdAlpha=hold;
  if(shadow!==void)a.drawText(100,0,"I",0xffffff,opacity,true,level===void?(shadow?255:128):level,0xc08040,shadow,-100,0);
  else a.drawText(0,0,id=="mapped-transparent-tail"?"J":"I",0xc08040,opacity);
  var values=[];
  for(var y=0;y<2;y++)for(var x=0;x<8;x++){
   var c=a.getMainPixel(x,y);values.add((c>>16)&255);values.add((c>>8)&255);values.add(c&255);values.add(a.getMaskPixel(x,y));
  }
  result=values.join(",");
 }catch(e){primary=e;failed=true;}
 try{if(a!==void && isvalid a)a.font.unmapPrerenderedFont();}catch(e){cleanup.add(e.message);}
 try{if(a!==void && isvalid a)invalidate a;}catch(e){cleanup.add(e.message);}
 try{if(w!==void && isvalid w)invalidate w;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("mapped-text-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception(cleanup.join("|"));return result;
}
var mappedWindow,mappedActual,mappedReference,mappedNext, mappedPhase=0;
var mappedColumns=[
 [0x182838,0x4a4a3e,0x7c6c44,0xae8e4a,0xe0b050,0xae8e4a,0x4a4a3e,0x182838],
 [0x182838,0x3d413c,0x635b41,0x887445,0xae8e4a,0x887445,0x3d413c,0x182838],
 [0x182838,0x31393b,0x4a4a3e,0x635b41,0x7c6c44,0x635b41,0x31393b,0x182838],
 [0x182838,0x243039,0x31393b,0x3d413c,0x4a4a3e,0x3d413c,0x243039,0x182838]
];
function mappedTextDraw(){
 mappedActual.face=dfAlpha;mappedActual.holdAlpha=false;mappedActual.fillRect(0,0,160,80,0xff182838);
 mappedReference.fillRect(0,0,160,80,0xff182838);
 mappedActual.face=dfOpaque;mappedActual.holdAlpha=true;
 mappedActual.drawText(8,0,"IIIIII",0xe0b050,[255,192,128,64][mappedPhase]);
 for(var i=0;i<48;i++)mappedReference.fillRect(8+i,0,1,80,0xff000000|mappedColumns[mappedPhase][i%8]);
 mappedNext.fillRect(0,0,320,32,[0xff285038,0xff304878,0xff703848,0xff806020][mappedPhase]);
 mappedActual.update();mappedReference.update();mappedNext.update();
 Debug.message("mapped-subtitle-phase:"+mappedPhase+":"+mappedActual.font.getTextWidth("IIIIII"));
}
function mappedTextAdvance(){if(mappedPhase<3){global.mappedPhase++;global.mappedTextDraw();}}
function mappedTextMenu(){
 global.mappedWindow=new Window();mappedWindow.caption="Mapped subtitle opacity";mappedWindow.setInnerSize(320,112);
 var root=new Layer(mappedWindow,null);mappedWindow.add(root);root.setSize(320,112);root.holdAlpha=false;root.fillRect(0,0,320,112,0xff182838);
 global.mappedActual=new Layer(mappedWindow,root);mappedWindow.add(mappedActual);mappedActual.setSize(160,80);mappedActual.type=ltOpaque;mappedActual.visible=true;
 mappedActual.font.height=12;mappedActual.font.mapPrerenderedFont("mapped-subtitle.tft");
 global.mappedReference=new Layer(mappedWindow,root);mappedWindow.add(mappedReference);mappedReference.setPos(160,0,160,80);mappedReference.type=ltOpaque;mappedReference.holdAlpha=false;mappedReference.visible=true;
 global.mappedNext=new Layer(mappedWindow,root);mappedWindow.add(mappedNext);mappedNext.setPos(0,80,320,32);mappedNext.holdAlpha=false;mappedNext.visible=true;
 mappedNext.onClick=function(){global.mappedTextAdvance();};global.mappedTextDraw();mappedWindow.visible=true;
 Debug.message("mapped-subtitle-ready");
}
`

const subtitleColumns = [
  [0x182838,0x4a4a3e,0x7c6c44,0xae8e4a,0xe0b050,0xae8e4a,0x4a4a3e,0x182838],
  [0x182838,0x3d413c,0x635b41,0x887445,0xae8e4a,0x887445,0x3d413c,0x182838],
  [0x182838,0x31393b,0x4a4a3e,0x635b41,0x7c6c44,0x635b41,0x31393b,0x182838],
  [0x182838,0x243039,0x31393b,0x3d413c,0x4a4a3e,0x3d413c,0x243039,0x182838],
] as const
export function mappedTextFrameMismatch(data: Uint8Array, width: number, height: number, phase: number): string | null {
  if (width !== 320 || height !== 112 || data.length !== width * height * 4) return 'Wrong subtitle frame dimensions'
  const columns = subtitleColumns[phase], button = [0x285038,0x304878,0x703848,0x806020][phase]
  if (!columns || button === undefined) return 'Unknown subtitle phase'
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const local = x % 160, color = y >= 80 ? button : local >= 8 && local < 56 ? columns[(local - 8) % 8]! : 0x182838,
      expected = [color >>> 16, (color >>> 8) & 255, color & 255, 255], at = (y * width + x) * 4
    for (let c = 0; c < 4; c++) if (data[at + c] !== expected[c]) return `Subtitle pixel differs at ${x},${y},${c}`
  }
  return null
}
