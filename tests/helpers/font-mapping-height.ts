/** Two independently authored TFT v1 files. The full-height repeating stripes
 * keep the visible clip independent of the installed fallback font's ascent. */
export function fontMappingHeightFiles(): Record<string, Uint8Array> {
  const make = (advance: number, columns: readonly number[]) => {
    const bytes = new Uint8Array(58 + 8 * 256), view = new DataView(bytes.buffer)
    bytes.set(new TextEncoder().encode('TVP pre-rendered font\x1a')); bytes[22] = 1; bytes[23] = 2
    view.setUint32(24, 1, true); view.setUint32(28, 36, true); view.setUint32(32, 38, true)
    view.setUint16(36, 65, true); view.setUint32(38, 58, true)
    view.setUint16(42, 8, true); view.setUint16(44, 256, true)
    view.setInt16(48, 128, true); view.setInt16(50, advance, true); view.setInt16(54, advance, true)
    for (let y = 0; y < 256; y++) bytes.set(columns, 58 + y * 8)
    return bytes
  }
  return {
    'mapping-negative.tft': make(37, [64, 64, 0, 0, 64, 64, 0, 0]),
    'mapping-positive.tft': make(53, [64, 0, 64, 0, 64, 0, 64, 0]),
  }
}

export const fontMappingHeightCases = [
  { id: 'font-mapping-signed', expected: '-12|12|74|106|74|1|1|106|11001100|10101010' },
  { id: 'font-mapping-normalized', expected: '74|106|12|106|106|-12|74|106|10101010|11001100' },
] as const

/** Fixed tTVPFont::operator== includes signed Height. ApplyFont selects the TFT
 * using that identity before normalizing LOGFONT height for rasterization. */
export const fontMappingHeightSource = String.raw`
function fontMappingHeightInk(a){
 a.face=dfOpaque;a.holdAlpha=true;a.fillRect(0,0,160,96,0);a.drawText(8,0,"AA",0xffffff);
 var bits="";for(var x=8;x<16;x++)bits+=int(a.getMainPixel(x,0)==0xffffff);return bits;
}
function fontMappingHeightObserve(id){
 var w=void,a=void,b=void,c=void,result,failed=false,primary,cleanup=[];
 try{
  w=new Window();a=new Layer(w,null);b=new Layer(w,a);c=new Layer(w,a);
  a.setImageSize(160,96);b.setImageSize(160,96);c.setImageSize(160,96);
  a.font.face="Signed mapped subtitle";b.font.face=a.font.face;c.font.face=a.font.face;
  b.font.height=b.font.height;
  var negativeBase=a.font.getTextWidth("AA"),positiveBase=b.font.getTextWidth("AA");
  a.font.mapPrerenderedFont("mapping-negative.tft");b.font.mapPrerenderedFont("mapping-positive.tft");
  if(id=="font-mapping-signed"){
   var negativeInk=fontMappingHeightInk(a),positiveInk=fontMappingHeightInk(b);
   result=[a.font.height,b.font.height,a.font.getTextWidth("AA"),b.font.getTextWidth("AA")].join("|");
   b.font.unmapPrerenderedFont();result+="|"+a.font.getTextWidth("AA")+"|"+int(b.font.getTextWidth("AA")==positiveBase);
   b.font.mapPrerenderedFont("mapping-positive.tft");a.font.unmapPrerenderedFont();
   result+="|"+int(a.font.getTextWidth("AA")==negativeBase)+"|"+b.font.getTextWidth("AA")+"|"+negativeInk+"|"+positiveInk;
  }else if(id=="font-mapping-normalized"){
   result=a.font.getTextWidth("AA")+"|"+b.font.getTextWidth("AA");a.font.height=a.font.height;
   result+="|"+a.font.height+"|"+a.font.getTextWidth("AA")+"|"+b.font.getTextWidth("AA")+"|"+c.font.height+"|"+c.font.getTextWidth("AA")+"|"+b.font.getTextWidth("AA");
   result+="|"+fontMappingHeightInk(a)+"|"+fontMappingHeightInk(c);
  }else throw new Exception("Unknown signed mapping control");
 }catch(e){failed=true;primary=e;}
 try{if(b!==void && isvalid b)b.font.unmapPrerenderedFont();}catch(e){cleanup.add(e.message);}
 try{if(c!==void && isvalid c)c.font.unmapPrerenderedFont();}catch(e){cleanup.add(e.message);}
 try{if(c!==void && isvalid c)invalidate c;}catch(e){cleanup.add(e.message);}
 try{if(b!==void && isvalid b)invalidate b;}catch(e){cleanup.add(e.message);}
 try{if(a!==void && isvalid a)invalidate a;}catch(e){cleanup.add(e.message);}
 try{if(w!==void && isvalid w)invalidate w;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("signed-mapping-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception(cleanup.join("|"));return result;
}
var signedFontWindow,signedFontRoot,signedFontLeft,signedFontRight,signedFontButton,signedFontPhase=0;
function signedFontPanel(x){
 var a=new Layer(global.signedFontWindow,global.signedFontRoot);global.signedFontWindow.add(a);
 a.setPos(x,0,160,96);a.type=ltOpaque;a.face=dfOpaque;a.holdAlpha=true;a.visible=true;a.font.face="Signed mapped subtitle";return a;
}
function signedFontDraw(){
 signedFontLeft.fillRect(0,0,160,96,0x182838);signedFontRight.fillRect(0,0,160,96,0x182838);
 signedFontLeft.drawText(8,0,"AA",0xffffff);signedFontRight.drawText(8,0,"AA",0xffffff);
 signedFontButton.fillRect(0,0,320,48,[0xff285038,0xff304878,0xff703848][signedFontPhase]);
 signedFontLeft.update();signedFontRight.update();signedFontButton.update();
 Debug.message("signed-font-phase:"+signedFontPhase+":"+signedFontLeft.font.height+":"+signedFontLeft.font.getTextWidth("AA")+":"+signedFontRight.font.getTextWidth("AA"));
}
function signedFontNext(){
 if(signedFontPhase>=2)return;global.signedFontPhase++;
 if(signedFontPhase==1)signedFontLeft.font.height=signedFontLeft.font.height;
 else{invalidate signedFontLeft;global.signedFontLeft=global.signedFontPanel(0);}
 global.signedFontDraw();
}
function signedFontMenu(){
 global.signedFontWindow=new Window();signedFontWindow.caption="Signed subtitle mappings";signedFontWindow.setInnerSize(320,144);
 global.signedFontRoot=new Layer(signedFontWindow,null);signedFontWindow.add(signedFontRoot);signedFontRoot.setSize(320,144);
 signedFontRoot.holdAlpha=false;signedFontRoot.fillRect(0,0,320,144,0xff182838);
 global.signedFontLeft=global.signedFontPanel(0);global.signedFontRight=global.signedFontPanel(160);
 signedFontRight.font.height=signedFontRight.font.height;
 signedFontLeft.font.mapPrerenderedFont("mapping-negative.tft");signedFontRight.font.mapPrerenderedFont("mapping-positive.tft");
 global.signedFontButton=new Layer(signedFontWindow,signedFontRoot);signedFontWindow.add(signedFontButton);
 signedFontButton.setPos(0,96,320,48);signedFontButton.holdAlpha=false;signedFontButton.visible=true;
 signedFontButton.onClick=function(){global.signedFontNext();};global.signedFontDraw();signedFontWindow.visible=true;
}
`

export function fontMappingHeightMismatch(data: Uint8Array, width: number, height: number, phase: number): string | null {
  if (width !== 320 || height !== 144 || data.length !== width * height * 4) return 'Wrong signed mapping frame dimensions'
  const button = [0x285038, 0x304878, 0x703848][phase]
  if (button === undefined) return 'Unknown signed mapping phase'
  const starts = [[8, 45], [8, 61]], stripes = [[1, 1, 0, 0, 1, 1, 0, 0], [1, 0, 1, 0, 1, 0, 1, 0]]
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const variant = x >= 160 || phase === 1 ? 1 : 0, local = x % 160,
      ink = starts[variant]!.some((start) => local >= start && local < start + 8 && stripes[variant]![local - start] === 1),
      color = y >= 96 ? button : ink ? 0xffffff : 0x182838,
      expected = [color >>> 16, (color >>> 8) & 255, color & 255, 255], at = (y * width + x) * 4
    for (let channel = 0; channel < 4; channel++)
      if (data[at + channel] !== expected[channel]) return `Signed mapping pixel differs at ${x},${y},${channel}`
  }
  return null
}
