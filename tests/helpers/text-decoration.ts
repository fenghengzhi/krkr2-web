/** A project-owned TTF with deliberately high, but valid, ascent metrics.
 * Retain every original outline/advance; change the three metrics used by
 * host font engines and rebuild SFNT checksums. This runs only in hosted tests. */
export function highAscentFont(original: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(original), view = new DataView(bytes.buffer)
  const count = view.getUint16(4), tables: { record: number; tag: string; offset: number; length: number }[] = []
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16, tag = String.fromCharCode(...bytes.subarray(record, record + 4)),
      offset = view.getUint32(record + 8), length = view.getUint32(record + 12)
    if (offset + length > bytes.length) throw new Error('Authored font table exceeds input')
    tables.push({ record, tag, offset, length })
  }
  const table = (name: string) => {
    const entry = tables.find((entry) => entry.tag === name)
    if (!entry) throw new Error('Missing authored font table ' + name)
    return entry
  }
  const head = table('head'), hhea = table('hhea'), os2 = table('OS/2')
  if (view.getUint16(head.offset + 18) !== 1000 || hhea.length < 10 || os2.length < 78)
    throw new Error('Unexpected project-owned font metrics')
  view.setInt16(hhea.offset + 4, 1100)
  view.setInt16(os2.offset + 68, 1100)
  view.setUint16(os2.offset + 74, 1100)
  view.setUint32(head.offset + 8, 0)
  const checksum = (offset: number, length: number) => {
    let sum = 0
    for (let at = 0; at < length; at += 4) {
      let word = 0
      for (let i = 0; i < 4; i++) word = word * 256 + (at + i < length ? bytes[offset + at + i]! : 0)
      sum = (sum + word) >>> 0
    }
    return sum
  }
  for (const entry of tables) view.setUint32(entry.record + 4, checksum(entry.offset, entry.length))
  view.setUint32(head.offset + 8, (0xb1b0afba - checksum(0, bytes.length)) >>> 0)
  return bytes
}

export const textDecorationGameSource = String.raw`
var decorationWindow=new Window();decorationWindow.caption="Subtitle decoration - click to continue";
decorationWindow.setInnerSize(384,224);decorationWindow.visible=true;
var decorationLayer=new Layer(decorationWindow,null);decorationLayer.holdAlpha=false;
decorationLayer.setSize(384,224);decorationLayer.type=ltOpaque;decorationLayer.visible=true;
var decorationStep=0;
function decorationDraw(){
 decorationLayer.fillRect(0,0,384,224,0xff101820);
 decorationLayer.font.face="serif";decorationLayer.font.height=128;
 decorationLayer.font.bold=false;decorationLayer.font.italic=false;
 decorationLayer.font.underline=!!(decorationStep&1);
 decorationLayer.font.strikeout=!!(decorationStep&2);
 decorationLayer.drawText(64,24,"AV",0xffffff,255,false);
 decorationWindow.update();Debug.message("subtitle-decoration:"+decorationStep);
}
decorationLayer.onClick=function(){global.decorationStep++;global.decorationDraw();};
decorationDraw();
`
