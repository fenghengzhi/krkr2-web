// Independent authored inputs, following ERINA 1.0A cmperi.cpp OutACode /
// EncodeGammaCodes / EncodeTrueColorImage and cpp/cmperib.cpp forward
// DifferentialOperation. No product decoder supplies bytes or expected pixels.
// Fixed sources: out/verification/image-loading/119-eri-source/erinalib/.
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
export function eriFixtureWords(...values: number[]) {
  const out = new Uint8Array(values.length * 4), view = new DataView(out.buffer)
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true))
  return out
}
function record(name: string, data: Uint8Array) {
  if (name.length !== 8) throw new Error('ERI record name must occupy eight bytes')
  return concat(new TextEncoder().encode(name), eriFixtureWords(data.length, 0), data)
}
export class EriFixtureBits {
  readonly bits: number[] = []
  put(value: number, count: number) {
    for (let bit = count - 1; bit >= 0; bit--) this.bits.push((value >>> bit) & 1)
  }
  gamma(value: number) {
    if (!Number.isInteger(value) || value < 1) throw new Error('Invalid authored gamma code')
    // Original OutACode: binary digits after the leading 1 each follow a 1,
    // then a terminating zero. This is input encoding, not product decoding.
    const digits = value.toString(2).slice(1)
    for (const bit of digits) { this.put(1, 1); this.put(Number(bit), 1) }
    this.put(0, 1)
  }
  runs(values: readonly number[]) {
    this.put(Number(values[0] !== 0), 1)
    for (let start = 0; start < values.length;) {
      const nonzero = values[start] !== 0
      let end = start + 1
      while (end < values.length && (values[end] !== 0) === nonzero) end++
      this.gamma(end - start)
      if (nonzero) for (let i = start; i < end; i++) {
        const value = values[i]!
        this.put(Number(value < 0), 1); this.gamma(Math.abs(value))
      }
      start = end
    }
  }
  bytes() {
    // Original Flushout zero pads the last nonempty DWORD.
    const out = new Uint8Array(Math.ceil(this.bits.length / 32) * 4)
    this.bits.forEach((bit, i) => { out[i >>> 3]! |= bit << (7 - (i & 7)) })
    return out
  }
}

// Decoder restore order is B,G,R,A. These are authored pre-conversion RGBA
// values: alpha is the native additive/premultiplied representation.
export const eriTrueRaw = [
  10, 20, 30, 255, 32, 16, 8, 128, 60, 40, 20, 64,
  9, 8, 7, 0, 0, 1, 2, 1, 200, 130, 80, 128,
  255, 255, 255, 255, 1, 2, 3, 254, 7, 15, 31, 32,
] as const
export const eriTrueRgb = [
  10, 20, 30, 255, 32, 16, 8, 255, 60, 40, 20, 255,
  9, 8, 7, 255, 0, 1, 2, 255, 200, 130, 80, 255,
  255, 255, 255, 255, 1, 2, 3, 255, 7, 15, 31, 255,
] as const
// Fixed TVPDivTable: a=0 gives0; otherwise min(255, channel*255/a floored).
// All values below are literal and independent of the encoded residuals.
export const eriTrueRgba = [
  10, 20, 30, 255, 63, 31, 15, 128, 239, 159, 79, 64,
  0, 0, 0, 0, 0, 255, 255, 1, 255, 255, 159, 128,
  255, 255, 255, 255, 1, 2, 3, 254, 55, 119, 247, 32,
] as const
export const eriTrueGray = [18, 18, 42, 8, 0, 141, 255, 1, 14] as const
const reverseRows = (values: readonly number[], width: number, stride: number) => {
  const out: number[] = []
  for (let at = values.length - width * stride; at >= 0; at -= width * stride)
    out.push(...values.slice(at, at + width * stride))
  return out
}
export const eriTrueGrayRgba = (values: readonly number[]) => values.flatMap((value) => [value, value, value, 255])
export interface TruecolorInput {
  width: number; height: number; raw: readonly number[]
  alpha?: boolean; gray?: boolean; depth?: 8 | 24 | 32; frame?: 1 | 4; enhanced?: boolean
  table?: boolean; positive?: boolean; operations?: readonly number[]
  failAfterBlocks?: number; badSeparator?: boolean
}

/** Fixed2x2 forward encoder. Padding is authored zero; the finite difference
 * is algebraically C(x,y)-C(x-1,y)-C(x,y-1)+C(x-1,y-1), including block edges.
 * It is equivalent to the independent original encoder's vertical-then-
 * horizontal passes, without importing the product's inverse integration. */
export function eriTruecolorInput(options: TruecolorInput): Uint8Array {
  const { width, height, raw, alpha = false, gray = false, depth = gray ? 8 : alpha ? 32 : 24,
    frame = 1, enhanced = frame === 4, table = false, positive = false } = options,
    channels = gray ? 1 : alpha ? 4 : 3, blockSize = 2, area = 4,
    across = Math.ceil(width / blockSize), down = Math.ceil(height / blockSize), blocks: number[][] = [],
    operations = options.operations ?? Array(across * down).fill(0) as number[]
  if (raw.length !== width * height * 4 || operations.length !== across * down)
    throw new Error('Invalid authored ERI dimensions or block operations')
  // Enhanced arrange2x2 maps from original InitializeArrangeTable, not the
  // product. Row-even/odd is identical for2 rows; other orders remain distinct.
  const orders = [[0, 1, 2, 3], [0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2], [2, 1, 0, 3]]
  // Independent forward ColorOperation functions in cpp/cmperib.cpp650–813.
  // Each pair explicitly names its B/G/R base plane and subtracted targets.
  const differences: Readonly<Record<number, readonly [number, readonly number[]]>> = {
    5: [0, [1]], 6: [0, [2]], 7: [0, [1, 2]],
    9: [1, [0]], 10: [1, [2]], 11: [1, [0, 2]],
    13: [2, [0]], 14: [2, [1]], 15: [2, [0, 1]],
  }
  const sample = (x: number, y: number, channel: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : raw[(y * width + x) * 4 + [2, 1, 0, 3][channel]!]!
  for (let by = 0; by < down; by++) for (let bx = 0; bx < across; bx++) {
    const op = operations[blocks.length]!, color = enhanced ? op < 50 ? [0, 5, 6, 7, 9, 10, 11, 13, 14, 15][op % 10]! : 0 : op,
      order = orders[enhanced && op < 50 ? Math.floor(op / 10) : 0]!, planes: number[][] = []
    if (!Number.isInteger(op) || op < 0 || op >= (enhanced ? 64 : 16) || !order)
      throw new Error('Invalid authored forward operation')
    for (let c = 0; c < channels; c++) {
      const plane: number[] = []
      for (let y = 0; y < blockSize; y++) for (let x = 0; x < blockSize; x++) {
        const sx = bx * blockSize + x, sy = by * blockSize + y
        plane.push(sample(sx, sy, c) - sample(sx - 1, sy, c) - sample(sx, sy - 1, c) + sample(sx - 1, sy - 1, c))
      }
      planes.push(plane)
    }
    const difference = differences[color]
    if (difference && channels >= 3) for (const target of difference[1]) for (let i = 0; i < area; i++)
      planes[target]![i]! -= planes[difference[0]]![i]!
    blocks.push(planes.flatMap((plane) => order.map((i) => ((plane[i]! + 128) & 255) - 128)))
  }
  const bits = new EriFixtureBits(), opBits = enhanced ? 6 : 4
  bits.put(frame, 8); bits.put(0, 8); bits.put(Number(table), 8); bits.put(0, 8)
  if (table && channels >= 3) for (const op of operations) bits.put(op, opBits)
  bits.put(Number(options.badSeparator), 1)
  if (table) bits.runs(blocks.flat())
  else for (let i = 0; i < blocks.length; i++) {
    if (channels >= 3) bits.put(operations[i]!, opBits)
    if (i === options.failAfterBlocks) {
      // Valid private earlier blocks, then a nonzero run whose first magnitude
      // is an unterminated gamma code ending at a real DWORD/EOF boundary.
      // No guessed short-DWORD padding is used to predict failure.
      bits.put(1, 1); bits.gamma(channels * area); bits.put(0, 1)
      const end = (Math.floor(bits.bits.length / 32) + 1) * 32
      for (let part = 0; bits.bits.length < end; part++) bits.put(part % 2 === 0 ? 1 : 0, 1)
      break
    }
    bits.runs(blocks[i]!)
  }
  const info = eriFixtureWords(enhanced ? 0x00020200 : 0x00020100, 0x03020000, 0xffffffff,
    gray ? 2 : alpha ? 0x04000001 : 1, width, positive ? height : -height, depth, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0)
  return eriFixtureContainer(info, bits.bytes())
}

export function eriFixtureContainer(info: Uint8Array, frame: Uint8Array) {
  const header = new Uint8Array(64)
  header.set([69, 110, 116, 105, 115, 26, 0, 0]); new DataView(header.buffer).setUint32(8, 0x03000100, true)
  header.set(new TextEncoder().encode('Entis Rasterized Image'), 16)
  return concat(header, record('Header  ', concat(record('FileHdr ', eriFixtureWords(0x00020100, 1, 1, 1, 0)), record('ImageInf', info))),
    record('Stream  ', record('ImageFrm', frame)))
}

export interface EriTruecolorCase {
  name: string; width: number; height: number; input: TruecolorInput
  rgba: readonly number[]; gray: readonly number[]
}
const base = { width: 3, height: 3, raw: eriTrueRaw } as const
const graySamples = [0, 1, 127, 128, 254, 255, 5, 9, 33] as const
export const eriTruecolorCases: readonly EriTruecolorCase[] = [
  { name: 'tc-rgb-v1-independent.eri', ...base, input: base, rgba: eriTrueRgb, gray: eriTrueGray },
  { name: 'tc-rgb-v1-table.eri', ...base, input: { ...base, table: true }, rgba: eriTrueRgb, gray: eriTrueGray },
  { name: 'tc-rgb32-v1-positive.eri', ...base, input: { ...base, depth: 32, positive: true, table: true },
    rgba: reverseRows(eriTrueRgb, 3, 4), gray: reverseRows(eriTrueGray, 3, 1) },
  { name: 'tc-rgb-v4-table.eri', ...base, input: { ...base, frame: 4, table: true, operations: [6, 16, 26, 46] },
    rgba: eriTrueRgb, gray: eriTrueGray },
  { name: 'tc-rgb-v4-independent.eri', ...base, input: { ...base, frame: 4, operations: [36, 6, 26, 46] },
    rgba: eriTrueRgb, gray: eriTrueGray },
  { name: 'tc-rgba-v1-independent.eri', ...base, input: { ...base, alpha: true }, rgba: eriTrueRgba, gray: eriTrueGray },
  { name: 'tc-rgba-v4-positive.eri', ...base, input: { ...base, alpha: true, frame: 4, table: true, positive: true,
    operations: [36, 16, 26, 46] }, rgba: reverseRows(eriTrueRgba, 3, 4), gray: reverseRows(eriTrueGray, 3, 1) },
  { name: 'tc-rgb-single.eri', width: 2, height: 2, input: { width: 2, height: 2, raw: [10, 20, 30, 255, 32, 16, 8, 128,
    9, 8, 7, 0, 0, 1, 2, 1] }, rgba: [10, 20, 30, 255, 32, 16, 8, 255, 9, 8, 7, 255, 0, 1, 2, 255], gray: [18, 18, 8, 0] },
  { name: 'tc-rgb-zero-table.eri', ...base, input: { ...base, raw: Array(36).fill(0), table: true },
    rgba: Array.from({ length: 9 }, () => [0, 0, 0, 255]).flat(), gray: Array(9).fill(0) },
  { name: 'tc-gray-v1.eri', ...base, input: { ...base, gray: true, raw: eriTrueGrayRgba(graySamples) },
    rgba: eriTrueGrayRgba(graySamples), gray: graySamples },
  { name: 'tc-gray-v4-positive.eri', ...base, input: { ...base, gray: true, frame: 4, table: true, positive: true,
    raw: eriTrueGrayRgba(graySamples) }, rgba: eriTrueGrayRgba(reverseRows(graySamples, 3, 1)), gray: reverseRows(graySamples, 3, 1) },
]
export const eriTruecolorError = 'ERIDecoder::DecodeImage failed.'
export function eriTruecolorFiles(): Record<string, Uint8Array> {
  const files = Object.fromEntries(eriTruecolorCases.map((item) => [item.name, eriTruecolorInput(item.input)])),
    main = files['tc-rgb-v1-independent.eri']!, mask = files['tc-rgba-v1-independent.eri']!,
    broken = eriTruecolorInput({ ...base, alpha: true, failAfterBlocks: 1 })
  return { ...files, 'tc-late-failure.eri': broken,
    'tc-bad-separator.eri': eriTruecolorInput({ ...base, badSeparator: true }),
    'tc-mask.eri': main, 'tc-mask_m.eri': mask, 'tc-mask-bad.eri': main, 'tc-mask-bad_m.eri': broken }
}

export const eriTruecolorSource = String.raw`
System.exitOnWindowClose=false;
System.assignMessage("TVPERILoadError","eri-true:<%1>");
System.assignMessage("TJSReadError","wrong-eri-short-read");
var tcWindow=new Window();tcWindow.caption="ERI truecolor";tcWindow.setInnerSize(3,6);tcWindow.visible=true;
var tcRoot=new Layer(tcWindow,null);tcWindow.add(tcRoot);tcRoot.type=ltOpaque;
tcRoot.setSize(3,6);tcRoot.fillRect(0,0,3,6,0xff123456);
var tcImage=new Layer(tcWindow,tcRoot);tcImage.type=ltOpaque;tcImage.setSize(3,3);tcImage.visible=true;
var tcMask=new Layer(tcWindow,tcRoot);tcMask.type=ltOpaque;tcMask.setSize(3,3);tcMask.top=3;tcMask.visible=true;
var tcCopy=new Layer(tcWindow,tcRoot);tcCopy.setSize(3,3);tcCopy.visible=false;
function tcLoad(target,name,key){try{target.loadImages(name,key);return "ok";}catch(error){return error.message;}}
function tcPixels(target){
  var bytes=[];for(var y=0;y<target.imageHeight;y++)for(var x=0;x<target.imageWidth;x++){
    var c=target.getMainPixel(x,y);bytes.add((c>>16)&255);bytes.add((c>>8)&255);bytes.add(c&255);bytes.add(target.getMaskPixel(x,y));
  }return bytes.join(",");
}
function tcShowMask(){
  for(var y=0;y<3;y++)for(var x=0;x<3;x++){
    var a=global.tcImage.getMaskPixel(x,y);global.tcMask.setMainPixel(x,y,a*0x010101);
  }return 0;
}
function tcPrepareFailure(){
  var layer=global.tcImage;
  layer.setImagePos(0,0);layer.setSize(3,3);layer.loadImages("tc-rgb-v1-independent.eri",clNone);
  layer.setProvincePixel(1,1,71);layer.setSize(2,2);layer.setImagePos(-1,-1);layer.setClip(1,0,2,2);
  layer.imageModified=false;System.clearGraphicCache();return 0;
}
`
