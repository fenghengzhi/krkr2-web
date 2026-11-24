import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

interface JpegFixture {
  id: string; path: string; bytes: number; sha256: string
  mode: 'normal' | 'grayscale'; width: number | null; height: number | null
  constant?: number
}
const directory = resolve('out/verification/jpeg-fixtures')

/** Read independently encoded hosted bytes, never a browser/product encoder. */
export function jpegFixture(id: string): Buffer {
  const inventory = JSON.parse(readFileSync(resolve(directory, 'case-manifest.json'), 'utf8')) as JpegFixture[],
    cases = inventory.filter((entry) => entry.id === id)
  if (cases.length !== 1 || !/^[a-z0-9-]+$/.test(id) || cases[0]!.path !== `inputs/${id}.jpg`)
    throw new Error('Missing or ambiguous hosted JPEG fixture: ' + id)
  const entry = cases[0]!, bytes = readFileSync(resolve(directory, entry.path))
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw new Error('Hosted JPEG fixture hash or size differs: ' + id)
  if (id.startsWith('constant-gray') &&
      (entry.width !== 8 || entry.height !== 8 || entry.constant !== Number(id.slice('constant-gray'.length))))
    throw new Error('Unexpected independent constant JPEG recipe')
  return bytes
}

export function jpegErrorCodes() {
  const value = JSON.parse(readFileSync(resolve(directory, 'codes.json'), 'utf8')) as Record<string, number>
  for (const name of ['INPUT_EMPTY', 'NO_SOI', 'CONVERSION_NOTIMPL', 'JPEG_EOF'])
    if (!Number.isInteger(value[name]) || value[name]! <= 0) throw new Error('Missing fixed IJG numeric error: ' + name)
  return value
}

export function jpegContractFiles(): Record<string, Buffer> {
  const zero = jpegFixture('constant-gray0'), middle = jpegFixture('constant-gray64'),
    white = jpegFixture('constant-gray255')
  if (middle.at(-2) !== 255 || middle.at(-1) !== 217) throw new Error('Constant JPEG does not end at its original EOI')
  return {
    'gray0.jpg': zero, 'gray64.jpg': middle, 'gray255.jpg': white,
    'mask0.jpg': white, 'mask0_m.jpg': zero,
    'mask64.jpg': white, 'mask64_m.jpg': middle,
    'mask255.jpg': middle, 'mask255_m.jpg': white,
    'empty.jpg': jpegFixture('empty'), 'no-soi.jpg': jpegFixture('not-jpeg'),
    'unsupported-mask.jpg': white, 'unsupported-mask_m.jpg': jpegFixture('rgb-gray'),
    // Only remove EOI from fully encoded entropy. Original fill_input_buffer
    // warns and supplies synthetic EOI; no partial entropy pixels are guessed.
    'gray64-eof.jpg': Buffer.from(middle.subarray(0, -2)),
  }
}

export const jpegRgba = (value: number, alpha = 255) => Array.from({ length: 64 }, () => [value, value, value, alpha]).flat()
export const jpegFrame = (value: number, alpha = 255) => ({ width: 8, height: 16,
  rgba: [...jpegRgba(value), ...jpegRgba(alpha)] })
export const jpegError = (code: number) => `jpeg-holder:<error code : ${code}>`

export const jpegContractSource = String.raw`
System.exitOnWindowClose=false;
System.assignMessage("TVPJPEGLoadError","jpeg-holder:<%1>");
System.assignMessage("TJSReadError","wrong-jpeg-read-holder");
var jpegWindow=new Window();jpegWindow.caption="JPEG native contract";jpegWindow.setInnerSize(8,16);jpegWindow.visible=true;
var jpegRoot=new Layer(jpegWindow,null);jpegWindow.add(jpegRoot);jpegRoot.type=ltOpaque;
jpegRoot.setSize(8,16);jpegRoot.fillRect(0,0,8,16,0xff123456);
var jpegImage=new Layer(jpegWindow,jpegRoot);jpegImage.type=ltOpaque;jpegImage.setSize(8,8);jpegImage.visible=true;
var jpegMask=new Layer(jpegWindow,jpegRoot);jpegMask.type=ltOpaque;jpegMask.setSize(8,8);jpegMask.top=8;jpegMask.visible=true;
var jpegCopy=new Layer(jpegWindow,jpegRoot);jpegCopy.setSize(8,8);jpegCopy.visible=false;
function jpegLoad(target,name,key){try{target.loadImages(name,key);return "ok";}catch(error){return error.message;}}
function jpegPixels(target){
  var bytes=[];for(var y=0;y<8;y++)for(var x=0;x<8;x++){
    var c=target.getMainPixel(x,y);bytes.add((c>>16)&255);bytes.add((c>>8)&255);bytes.add(c&255);bytes.add(target.getMaskPixel(x,y));
  }return bytes.join(",");
}
function jpegShowMask(){
  for(var y=0;y<8;y++)for(var x=0;x<8;x++){
    var a=global.jpegImage.getMaskPixel(x,y);global.jpegMask.setMainPixel(x,y,a*0x010101);
  }return 0;
}
`
