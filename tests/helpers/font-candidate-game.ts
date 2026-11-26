export const fontCandidateCases = [
  { face: 'Missing Game Face, Krkr Synthetic narrow, Krkr Synthetic wide', width: 20, wide: false },
  { face: 'Missing Game Face, Krkr Synthetic wide, Krkr Synthetic narrow', width: 36, wide: true },
  { face: 'Krkr Synthetic narrow, Krkr Synthetic wide', width: 20, wide: false },
  { face: ', Krkr Synthetic wide, Krkr Synthetic narrow', width: 36, wide: true },
  { face: '存在しない，別名, Krkr Synthetic narrow', width: 20, wide: false },
] as const

/** The two authored TTFs draw the same rectangular A but advance 500/900
 * units per 1000 em. "AA" visibly distinguishes the selected family. The
 * reference panels use direct file names and never pass through a face list. */
export const fontCandidateGameSource = String.raw`
System.exitOnWindowClose=false;
var candidatePhase=0,candidateWidths=[],candidateFaces=${JSON.stringify(fontCandidateCases.map((row) => row.face))};
var candidateWindow=new Window();candidateWindow.caption="Dialogue font choices";candidateWindow.setInnerSize(360,100);
var candidateRoot=new Layer(candidateWindow,null);candidateRoot.setSize(360,100);candidateRoot.cached=true;
candidateRoot.fillRect(0,0,360,100,0xff000000);
var candidateText=new Layer(candidateWindow,candidateRoot),candidateNarrow=new Layer(candidateWindow,candidateRoot),candidateWide=new Layer(candidateWindow,candidateRoot);
var candidatePanels=[candidateText,candidateNarrow,candidateWide];
for(var i=0;i<3;i++){
 var p=candidatePanels[i];candidateWindow.add(p);p.setPos(i*120,0,120,60);p.type=ltOpaque;
 p.font.height=20;p.fillRect(0,0,120,60,0xff000000);p.visible=true;
}
candidateWindow.add(candidateRoot);
candidateNarrow.font.face="narrow.ttf";candidateNarrow.font.faceIsFileName=true;
candidateWide.font.face="wide.ttf";candidateWide.font.faceIsFileName=true;
candidateNarrow.drawText(8,8,"AA",0xffffff,255,false);candidateWide.drawText(8,8,"AA",0xffffff,255,false);
function candidateDraw(){
 global.candidateText.font.face=global.candidateFaces[global.candidatePhase];
 global.candidateText.fillRect(0,0,120,60,0xff000000);
 global.candidateText.drawText(8,8,"AA",0xffffff,255,false);
 var width=global.candidateText.font.getTextWidth("AA");global.candidateWidths.add(width);
 global.candidateRoot.fillRect(0,60,360,40,width==36?0xff604020:0xff207040);
 global.candidateRoot.update();global.candidateWindow.update();
 global.Debug.message("candidate-font:"+global.candidatePhase+":"+width+":"+global.candidateText.font.face);
}
candidateRoot.onClick=function(){
 if(global.candidatePhase+1<global.candidateFaces.count){global.candidatePhase++;global.candidateDraw();}
};
// Deliberately no getList or font dialog: ordinary text is the first family lookup.
candidateDraw();candidateWindow.visible=true;candidateWindow.update();
`

export function fontCandidateFrameMismatch(data: Uint8Array, width: number, height: number, phase: number): unknown | null {
  if (width !== 360 || height !== 100 || data.length !== width * height * 4) return { width, height, bytes: data.length }
  const expected = fontCandidateCases[phase]!, offset = expected.wide ? 240 : 120
  let different = false, ink = 0
  for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) for (let c = 0; c < 4; c++) {
    const at = (y * width + x) * 4 + c, wanted = data[at + offset * 4]!
    if (data[at] !== wanted) return { x, y, channel: c, actual: data[at], expected: wanted }
    if (data[at + 120 * 4] !== data[at + 240 * 4]) different = true
    if (c === 0 && data[at] === 255) ink++
  }
  if (!different || ink < 200) return { different, ink }
  const color = expected.wide ? [96, 64, 32, 255] : [32, 112, 64, 255]
  for (let y = 60; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
    const actual = data[(y * width + x) * 4 + c]
    if (actual !== color[c]) return { x, y, channel: c, actual, expected: color[c] }
  }
  return null
}
