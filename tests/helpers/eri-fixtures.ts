// Independent hand-authored ERINA v2 inputs. Container fields follow the fixed
// SDK's experi.h and werifile.cpp; entropy follows cmperi.cpp's encoder, never
// the product decoder. See the pinned 119 ERINA source manifest in the audit.
export const eriWidth = 3, eriHeight = 2

// MSB-first OutACode(n): emit 1+bit for each binary digit after n's leading1,
// then0. MTF tables persist across rows; each row starts in table256/last=-1.
// [0,1,2] -> 0|100|110; [2,2,1] ->110|110|0(run1)|110.
// The resulting17 bits are01001101101100110, zero-padded to a DWORD by Flushout.
// The first DWORD is EncodePaletteImage's literal0x02000000 frame header.
export const eriFrame = Uint8Array.of(2, 0, 0, 0, 0x4d, 0xb3, 0, 0)
const palette = Uint8Array.of(0, 0, 0, 0, 51, 34, 17, 7, 50, 100, 200, 99)
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { result.set(part, at); at += part.length }
  return result
}
function words(...values: number[]) {
  const result = new Uint8Array(values.length * 4), view = new DataView(result.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true))
  return result
}
function record(name: string, payload: Uint8Array) {
  if (name.length !== 8) throw new Error('ERI fixture record ID must contain eight bytes')
  return concat(new TextEncoder().encode(name), words(payload.length, 0), payload)
}
function eri(options: { height?: number; gray?: boolean; fileVersion?: number; imageVersion?: number; frame?: Uint8Array } = {}) {
  const container = new Uint8Array(64)
  container.set([69, 110, 116, 105, 115, 26, 0, 0])
  new DataView(container.buffer).setUint32(8, 0x03000100, true)
  container.set(new TextEncoder().encode('Entis Rasterized Image'), 16)
  const file = words(options.fileVersion ?? 0x00020100, options.gray ? 1 : 0x11, 1, 1, 0)
  //17 DWORDs /68 bytes, with signed width/height at16/20 and blockingDegree0.
  const info = words(options.imageVersion ?? 0x00020100, 0x03020000, 0xffffffff,
    options.gray ? 2 : 0x01000001, eriWidth, options.height ?? -eriHeight, 8,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  return concat(container,
    record('Header  ', concat(record('FileHdr ', file), record('ImageInf', info))),
    record('Stream  ', concat(...(options.gray ? [] : [record('Palette ', palette)]),
      record('ImageFrm', options.frame ?? eriFrame))))
}

// Palette reserved bytes0/7/99 never supply alpha. Original loader forces255.
export const eriRgbNegative = [
  0, 0, 0, 255, 17, 34, 51, 255, 200, 100, 50, 255,
  200, 100, 50, 255, 200, 100, 50, 255, 17, 34, 51, 255,
] as const
export const eriRgbPositive = [
  200, 100, 50, 255, 200, 100, 50, 255, 17, 34, 51, 255,
  0, 0, 0, 255, 17, 34, 51, 255, 200, 100, 50, 255,
] as const
export const eriKey1 = [
  0, 0, 0, 255, 17, 34, 51, 0, 200, 100, 50, 255,
  200, 100, 50, 255, 200, 100, 50, 255, 17, 34, 51, 0,
] as const
export const eriGrayNegative = [0, 1, 2, 2, 2, 1] as const
export const eriGrayPositive = [2, 2, 1, 0, 1, 2] as const
// Authored palette A gives8109>>8=31; B gives30050>>8=117, using the fixed
// original TVP integer gray coefficients. No product conversion is imported.
export const eriPaletteGray = [0, 31, 117, 117, 117, 31] as const
export const eriGrayRgba = (values: readonly number[]) => values.flatMap((value) => [value, value, value, 255])
export const eriMaskedRgba = (alpha: readonly number[]) => eriRgbNegative.map((value, at) => at % 4 === 3 ? alpha[at >> 2]! : value)
export const eriError = (reason: string) => `eri-holder:<${reason}>`
export const eriProvinceReason = 'currently Kirikiri does not support loading palettized ERI image.'

export function eriContractFiles(): Record<string, Uint8Array> {
  const rgb = eri(), gray = eri({ gray: true }),
    badHeader = eri({ fileVersion: 0x00020101 }),
    badInit = eri({ imageVersion: 0x00020101 }),
    badFrame = eri({ frame: Uint8Array.of(3, 0, 0, 0, 0x4d, 0xb3, 0, 0) }),
    // A whole all-one DWORD contains no terminating gamma bit. Consuming all
    //32 bits reaches true EOF; this does not rely on short-DWORD zero padding.
    badEntropy = eri({ frame: Uint8Array.of(2, 0, 0, 0, 255, 255, 255, 255) })
  return {
    'rgb-negative.eri': rgb, 'rgb-positive.eri': eri({ height: eriHeight }),
    'gray-negative.eri': gray, 'gray-positive.eri': eri({ height: eriHeight, gray: true }),
    'bad-header.eri': badHeader, 'bad-initialize.eri': badInit,
    'bad-frame-header.eri': badFrame, 'bad-entropy.eri': badEntropy,
    'masked-gray.eri': rgb, 'masked-gray_m.eri': gray,
    'masked-palette.eri': rgb, 'masked-palette_m.eri': rgb,
    'masked-bad.eri': rgb, 'masked-bad_m.eri': badEntropy,
  }
}

export interface EriContractCase {
  name: string; mode: 'normal' | 'grayscale' | 'palettized'; paletteKey?: number
  width: number; height: number; rgba?: readonly number[]; error?: string; sizeExpected: boolean
}
export const eriContractCases: readonly EriContractCase[] = [
  { name: 'rgb-negative.eri', mode: 'normal', width: 3, height: 2, rgba: eriRgbNegative, sizeExpected: true },
  { name: 'rgb-positive.eri', mode: 'normal', width: 3, height: 2, rgba: eriRgbPositive, sizeExpected: true },
  { name: 'gray-negative.eri', mode: 'normal', width: 3, height: 2, rgba: eriGrayRgba(eriGrayNegative), sizeExpected: true },
  { name: 'gray-positive.eri', mode: 'normal', width: 3, height: 2, rgba: eriGrayRgba(eriGrayPositive), sizeExpected: true },
  { name: 'rgb-negative.eri', mode: 'normal', paletteKey: 1, width: 3, height: 2, rgba: eriKey1, sizeExpected: true },
  { name: 'rgb-negative.eri', mode: 'normal', paletteKey: 255, width: 3, height: 2, rgba: eriRgbNegative, sizeExpected: true },
  { name: 'gray-negative.eri', mode: 'normal', paletteKey: 1, width: 3, height: 2, rgba: eriGrayRgba(eriGrayNegative), sizeExpected: true },
  { name: 'rgb-negative.eri', mode: 'grayscale', width: 3, height: 2, rgba: eriGrayRgba(eriPaletteGray), sizeExpected: true },
  { name: 'gray-negative.eri', mode: 'grayscale', width: 3, height: 2, rgba: eriGrayRgba(eriGrayNegative), sizeExpected: true },
  { name: 'bad-header.eri', mode: 'normal', width: 3, height: 2, error: 'ERIFile::Open failed.', sizeExpected: false },
  { name: 'bad-initialize.eri', mode: 'normal', width: 3, height: 2, error: 'ERIDecoder::Initialize failed.', sizeExpected: true },
  { name: 'bad-frame-header.eri', mode: 'normal', width: 3, height: 2, error: 'ERIDecoder::DecodeImage failed.', sizeExpected: true },
  { name: 'bad-entropy.eri', mode: 'normal', width: 3, height: 2, error: 'ERIDecoder::DecodeImage failed.', sizeExpected: true },
  { name: 'rgb-negative.eri', mode: 'palettized', width: 3, height: 2, error: eriProvinceReason, sizeExpected: false },
]

export const eriContractSource = String.raw`
System.exitOnWindowClose=false;
System.assignMessage("TVPERILoadError","eri-holder:<%1>");
System.assignMessage("TJSReadError","wrong-eri-read-holder");
var eriWindow=new Window();eriWindow.caption="ERI native contract";eriWindow.setInnerSize(3,4);eriWindow.visible=true;
var eriRoot=new Layer(eriWindow,null);eriWindow.add(eriRoot);eriRoot.type=ltOpaque;
eriRoot.setSize(3,4);eriRoot.fillRect(0,0,3,4,0xff123456);
var eriImage=new Layer(eriWindow,eriRoot);eriImage.type=ltOpaque;eriImage.setSize(3,2);eriImage.visible=true;
var eriMask=new Layer(eriWindow,eriRoot);eriMask.type=ltOpaque;eriMask.setSize(3,2);eriMask.top=2;eriMask.visible=true;
var eriCopy=new Layer(eriWindow,eriRoot);eriCopy.setSize(3,2);eriCopy.visible=false;
function eriLoad(target,name,key){try{target.loadImages(name,key);return "ok";}catch(error){return error.message;}}
function eriProvince(name){try{eriImage.loadProvinceImage(name);return "ok";}catch(error){return error.message;}}
function eriPixels(target){
  var bytes=[];for(var y=0;y<2;y++)for(var x=0;x<3;x++){
    var c=target.getMainPixel(x,y);bytes.add((c>>16)&255);bytes.add((c>>8)&255);bytes.add(c&255);bytes.add(target.getMaskPixel(x,y));
  }return bytes.join(",");
}
function eriShowMask(){
  for(var y=0;y<2;y++)for(var x=0;x<3;x++){
    var a=global.eriImage.getMaskPixel(x,y);global.eriMask.setMainPixel(x,y,a*0x010101);
  }return 0;
}
`
