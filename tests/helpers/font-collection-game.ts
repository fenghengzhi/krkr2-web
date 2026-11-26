import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const members = [
  { file: 'latin.ttf', reference: 'latin-reference.bin', family: 'Selection Latin',
    sha256: 'e8c273fc26ebeea9be1d174322682aa32202aa58a4d663b8cd63f6f09436f88d' },
  { file: 'mono.ttf', reference: 'mono-reference.bin', family: 'Selection Mono',
    sha256: 'f56c6487666354e5f6345fa3b3850ffd58d00ed93660718326896aa8e6e2d48b' },
  { file: 'latin-bold.ttf', reference: 'bold-reference.bin', family: 'Selection Latin',
    sha256: '5552839cc0c7a88920a412eab00bcf50ed0c46e557749d0e7a7e3032c1be44d1' },
] as const
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Independent TTC 1.0 assembly: copy the authored SFNTs without sharing
 * tables, relocate every table offset from its standalone origin to the
 * collection origin, and zero the collection head checksumAdjustment. */
export async function fontCollectionFiles() {
  const fonts = await Promise.all(members.map(async (member) => {
    const bytes = await readFile(new URL('../fixtures/font-selection/' + member.file, import.meta.url))
    if (sha(bytes) !== member.sha256) throw new Error('Authored collection member changed: ' + member.file)
    return bytes
  }))
  let length = 12 + fonts.length * 4
  const offsets = fonts.map((bytes) => { const at = length; length += (bytes.length + 3) & ~3; return at }),
    collection = Buffer.alloc(length)
  collection.write('ttcf'); collection.writeUInt32BE(0x00010000, 4); collection.writeUInt32BE(fonts.length, 8)
  for (const [index, bytes] of fonts.entries()) {
    const base = offsets[index]!
    if (bytes.length < 12 || bytes.readUInt32BE(0) !== 0x00010000) throw new Error('Expected authored TrueType SFNT')
    const count = bytes.readUInt16BE(4)
    if (12 + count * 16 > bytes.length) throw new Error('Truncated authored SFNT directory')
    collection.writeUInt32BE(base, 12 + index * 4); bytes.copy(collection, base)
    for (let i = 0; i < count; i++) {
      const entry = 12 + i * 16, offset = bytes.readUInt32BE(entry + 8), size = bytes.readUInt32BE(entry + 12)
      if (offset + size > bytes.length) throw new Error('Authored font table exceeds its SFNT')
      collection.writeUInt32BE(base + offset, base + entry + 8)
      if (bytes.toString('ascii', entry, entry + 4) === 'head') {
        if (size < 12) throw new Error('Truncated authored font head')
        collection.writeUInt32BE(0, base + offset + 8)
      }
    }
  }
  return {
    files: { 'dialogue.ttc': collection, ...Object.fromEntries(members.map((member, i) => [member.reference, fonts[i]!])) },
    evidence: { collection: { bytes: collection.length, sha256: sha(collection), offsets },
      members: members.map((member, index) => ({ ...member, index, bytes: fonts[index]!.length })),
      scope: 'Project-authored SFNTs only. Reference .bin files are opened explicitly and are not catalog candidates.' },
  }
}

export const fontCollectionCases = [
  { face: 'Selection Latin', bold: false, file: false, width: 20, reference: 0 },
  { face: 'Selection Mono', bold: false, file: false, width: 28, reference: 1 },
  { face: 'Selection Latin', bold: true, file: false, width: 36, reference: 2 },
  { face: 'Selection Latin', bold: false, file: false, width: 20, reference: 0 },
  { face: 'dialogue.ttc', bold: false, file: true, width: 20, reference: 0 },
  { face: 'Selection Mono', bold: false, file: false, width: 28, reference: 1 },
] as const
export const fontCollectionLists = {
  all: 'Selection Latin|Selection Mono|@Selection Mono',
  horizontal: 'Selection Latin|Selection Mono',
  fixed: 'Selection Mono|@Selection Mono',
  fileCharset: 'Selection Latin',
} as const

export const fontCollectionGameSource = String.raw`
System.exitOnWindowClose=false;
var collectionPhase=0,collectionWidths=[],collectionFaces=${JSON.stringify(fontCollectionCases.map((row) => row.face))},
 collectionBold=${JSON.stringify(fontCollectionCases.map((row) => row.bold))},collectionFiles=${JSON.stringify(fontCollectionCases.map((row) => row.file))};
var collectionWindow=new Window();collectionWindow.caption="Click below to change collection face";collectionWindow.setInnerSize(480,100);
var collectionRoot=new Layer(collectionWindow,null);collectionRoot.setSize(480,100);collectionRoot.cached=true;
collectionRoot.fillRect(0,0,480,100,0xff000000);collectionWindow.add(collectionRoot);
var collectionText=new Layer(collectionWindow,collectionRoot),collectionLatin=new Layer(collectionWindow,collectionRoot),
 collectionMono=new Layer(collectionWindow,collectionRoot),collectionHeavy=new Layer(collectionWindow,collectionRoot),
 collectionPanels=[collectionText,collectionLatin,collectionMono,collectionHeavy];
for(var i=0;i<4;i++){
 var panel=collectionPanels[i];collectionWindow.add(panel);panel.setPos(i*120,0,120,60);panel.type=ltOpaque;
 panel.font.height=20;panel.fillRect(0,0,120,60,0xff000000);panel.visible=true;
}
collectionText.font.face="Selection Latin";
var collectionAll=collectionText.font.getList(fsfTrueTypeOnly).join("|"),
 collectionHorizontal=collectionText.font.getList(fsfTrueTypeOnly|fsfNoVertical).join("|"),
 collectionFixed=collectionText.font.getList(fsfTrueTypeOnly|fsfFixedPitch).join("|");
Debug.message("collection-list:"+collectionAll+";"+collectionHorizontal+";"+collectionFixed);
var collectionReferences=["latin-reference.bin","mono-reference.bin","bold-reference.bin"];
for(var i=0;i<3;i++){
 var panel=collectionPanels[i+1];panel.font.face=collectionReferences[i];panel.font.faceIsFileName=true;
 // The bold reference already has the authored physical style; do not add
 // synthetic emboldening to the independent standalone reference.
 panel.font.bold=false;panel.drawText(8,8,"AA",0xffffff,255,false);
}
function collectionDraw(){
 collectionText.font.face=collectionFaces[collectionPhase];collectionText.font.faceIsFileName=collectionFiles[collectionPhase];
 collectionText.font.bold=collectionBold[collectionPhase];collectionText.fillRect(0,0,120,60,0xff000000);
 collectionText.drawText(8,8,"AA",0xffffff,255,false);
 var width=collectionText.font.getTextWidth("AA");collectionWidths.add(width);
 collectionRoot.fillRect(0,60,480,40,width==20?0xff207040:width==28?0xff405090:0xff804020);
 collectionRoot.update();collectionWindow.update();
 if(collectionFiles[collectionPhase])Debug.message("collection-file-charset:"+collectionText.font.getList(fsfTrueTypeOnly|fsfSameCharSet).join("|"));
 Debug.message("collection-face:"+collectionPhase+":"+width+":"+collectionText.font.face+":"+int(collectionText.font.bold)+":"+int(collectionText.font.faceIsFileName));
}
collectionRoot.onClick=function(){if(global.collectionPhase+1<global.collectionFaces.count){global.collectionPhase++;global.collectionDraw();}};
collectionDraw();collectionWindow.visible=true;collectionWindow.update();
`

export function fontCollectionFrameMismatch(data: Uint8Array, width: number, height: number, phase: number): unknown | null {
  if (width !== 480 || height !== 100 || data.length !== width * height * 4) return { width, height, bytes: data.length }
  const expected = fontCollectionCases[phase]!, offset = (expected.reference + 1) * 120, different = [false, false, false]
  let ink = 0
  for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) for (let c = 0; c < 4; c++) {
    const at = (y * width + x) * 4 + c
    if (data[at] !== data[at + offset * 4]) return { x, y, channel: c, actual: data[at], expected: data[at + offset * 4] }
    if (c === 0 && data[at] === 255) ink++
    different[0] ||= data[at + 120 * 4] !== data[at + 240 * 4]
    different[1] ||= data[at + 120 * 4] !== data[at + 360 * 4]
    different[2] ||= data[at + 240 * 4] !== data[at + 360 * 4]
  }
  if (ink < 200 || different.some((value) => !value)) return { ink, different }
  const color = expected.reference === 0 ? [32, 112, 64, 255] : expected.reference === 1 ? [64, 80, 144, 255] : [128, 64, 32, 255]
  for (let y = 60; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++)
    if (data[(y * width + x) * 4 + c] !== color[c]) return { x, y, channel: c, actual: data[(y * width + x) * 4 + c], expected: color[c] }
  return null
}
