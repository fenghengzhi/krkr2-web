export const layerDefaultFontCases = [
  { id: 'default-font-state', expected: '1|-12|0|0|0|0|0|1|-12|1' },
  { id: 'default-font-setter', expected: '12|12|24|-12|1' },
  { id: 'default-font-metrics', expected: '1|1|12|12|-12|12' },
] as const

/** TVPConstructDefaultFont uses a Japanese narrow literal and lfHeight=-12.
 * SDK setup replaces the expected face code units using that process's ACP.
 * Web selects the Japanese spelling independently of the script encoding. */
export const layerDefaultFontSource = String.raw`
var defaultFontExpectedCodes="65325,65331,32,65328,12468,12471,12483,12463",defaultFontObservedCodes="";
function defaultFontCodes(face){var codes=[];for(var i=0;i<face.length;i++)codes.add(#(face.charAt(i)));return codes.join(",");}
function defaultFontRun(id,a,b){
 var f=a.font,g=b.font;
 global.defaultFontObservedCodes=defaultFontCodes(f.face);
 if(id=="default-font-state")return [int(defaultFontObservedCodes==defaultFontExpectedCodes),f.height,int(f.bold),int(f.italic),
  int(f.underline),int(f.strikeout),f.angle,int(f===a.font),g.height,int(g!==f)].join("|");
 if(id=="default-font-setter"){
  f.height=f.height;var result=f.height;f.height=-12;result+="|"+f.height;f.height=-24;
  return result+"|"+f.height+"|"+g.height+"|"+int(defaultFontCodes(g.face)==defaultFontExpectedCodes);
 }
 if(id=="default-font-metrics"){
  g.face=f.face;g.height=12;var first=f.getTextWidth("AV"),second=g.getTextWidth("AV");
  return [int(first>0),int(first==second),f.getTextHeight("AV"),g.getTextHeight("AV"),f.height,g.height].join("|");
 }
 throw new Exception("Unknown default Font control");
}
function layerDefaultFontObserve(id){
 var w=void,a=void,b=void,result,failed=false,primary,cleanup=[];
 try{w=new Window();a=new Layer(w,null);b=new Layer(w,a);result=defaultFontRun(id,a,b);}catch(e){failed=true;primary=e;}
 try{if(b!==void && isvalid b)invalidate b;}catch(e){cleanup.add(e.message);}
 try{if(a!==void && isvalid a)invalidate a;}catch(e){cleanup.add(e.message);}
 try{if(w!==void && isvalid w)invalidate w;}catch(e){cleanup.add(e.message);}
 if(failed){if(cleanup.count)Debug.message("default-font-cleanup:"+cleanup.join("|"));throw primary;}
 if(cleanup.count)throw new Exception("Default Font cleanup: "+cleanup.join("|"));return result;
}
var defaultFontPhase=0,defaultFontWindow,defaultFontText,defaultFontReference,defaultFontButton,defaultFontSample="Continue: AB Wi 日本語";
function defaultFontDraw(){
 var text=global.defaultFontSample;
 defaultFontText.fillRect(0,0,320,48,0xff182838);defaultFontReference.fillRect(0,0,320,48,0xff182838);
 defaultFontText.drawText(4,4,text,0xffffff);defaultFontReference.drawText(4,4,text,0xffffff);
 defaultFontButton.fillRect(0,0,320,48,defaultFontPhase==0?0xff285038:defaultFontPhase==1?0xff304878:0xff703848);
 defaultFontText.update();defaultFontReference.update();defaultFontButton.update();
 Debug.message("default-font-phase:"+defaultFontPhase+":"+defaultFontText.font.height+":"+defaultFontReference.font.height);
}
function defaultFontNext(){
 global.defaultFontPhase++;
 if(defaultFontPhase==1)defaultFontText.font.height=defaultFontText.font.height;
 else {defaultFontText.font.height=-24;defaultFontReference.font.height=24;}
 defaultFontText.setAttentionPos(8,36);global.defaultFontDraw();
}
function defaultFontMenu(){
 global.defaultFontWindow=new Window();defaultFontWindow.caption="Default dialogue font";defaultFontWindow.setInnerSize(320,144);
 var root=new Layer(defaultFontWindow,null);defaultFontWindow.add(root);root.setSize(320,144);root.holdAlpha=false;root.fillRect(0,0,320,144,0xff182838);
 global.defaultFontText=new Layer(defaultFontWindow,root);defaultFontWindow.add(defaultFontText);
 defaultFontText.setPos(0,0,320,48);defaultFontText.holdAlpha=false;defaultFontText.visible=true;
 global.defaultFontReference=new Layer(defaultFontWindow,root);defaultFontWindow.add(defaultFontReference);
 defaultFontReference.setPos(0,48,320,48);defaultFontReference.holdAlpha=false;defaultFontReference.visible=true;
 defaultFontReference.font.face="ＭＳ Ｐゴシック";defaultFontReference.font.height=12;
 global.defaultFontButton=new Layer(defaultFontWindow,root);defaultFontWindow.add(defaultFontButton);
 defaultFontButton.setPos(0,96,320,48);defaultFontButton.holdAlpha=false;defaultFontButton.visible=true;
 defaultFontButton.onClick=function(){global.defaultFontNext();};
 defaultFontText.focusable=true;defaultFontText.imeMode=imOpen;defaultFontText.useAttention=true;defaultFontText.setAttentionPos(8,36);
 global.defaultFontDraw();defaultFontWindow.visible=true;defaultFontText.focus();Debug.message("default-font-menu-ready");
}
`

/** Full panel equality against a separately configured 12/24 px font. No
 * particular host outline is asserted to reproduce Windows MS PGothic. */
export function layerDefaultFontFrameMismatch(bytes: Uint8Array, width: number, height: number, phase: number): string | null {
  if (width !== 320 || height !== 144 || bytes.length !== width * height * 4) return 'Frame dimensions differ'
  let ink = 0
  const background = [24, 40, 56, 255], colors = [[40, 80, 56, 255], [48, 72, 120, 255], [112, 56, 72, 255]], status = colors[phase]
  if (!status) return 'Unexpected font phase'
  for (let y = 0; y < 48; y++) for (let x = 0; x < width; x++) {
    const first = (y * width + x) * 4, second = ((y + 48) * width + x) * 4
    for (let c = 0; c < 4; c++) if (bytes[first + c] !== bytes[second + c]) return `Font panels differ at ${x},${y},${c}`
    if (bytes[first] !== background[0] || bytes[first + 1] !== background[1] || bytes[first + 2] !== background[2]) ink++
  }
  if (!ink) return 'Default text is blank'
  for (let y = 96; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++)
    if (bytes[(y * width + x) * 4 + c] !== status[c]) return `Status differs at ${x},${y},${c}`
  return null
}
