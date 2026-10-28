import { deflateSync } from 'node:zlib'
import { provinceGatePng } from './image-decoder-gate.ts'

export const partialColor = 0xc86432
export const partialKey = 0x112233

/** Independent BITMAPINFOHEADER/24-bit bytes. rows counts file-order rows,
 * not destination rows: an incomplete second eight-row read publishes none
 * of that group. Header sizes intentionally still describe the full bitmap. */
export function partialBmp(options: {
  width: number; height: number; rows?: number; topDown?: boolean; mask?: boolean
}): Buffer {
  const { width, height, rows = height, topDown = true, mask = false } = options,
    stride = Math.ceil(width * 3 / 4) * 4, bytes = Buffer.alloc(54 + stride * rows)
  bytes.write('BM'); bytes.writeUInt32LE(54 + stride * height, 2); bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(width, 18); bytes.writeInt32LE(topDown ? -height : height, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(stride * height, 34)
  for (let fileRow = 0; fileRow < rows; fileRow++) {
    const y = topDown ? fileRow : height - 1 - fileRow
    for (let x = 0; x < width; x++) {
      const at = 54 + fileRow * stride + x * 3, gray = 64 + y * 4,
        rgb = mask ? [gray, gray, gray] : x === 0 ? [17, 34, 51] : [200, 100, 50]
      bytes.set([rgb[2]!, rgb[1]!, rgb[0]!], at)
    }
  }
  return bytes
}

function chunk(name: string, data: Uint8Array): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length); bytes.write(name, 4, 'ascii'); bytes.set(data, 8)
  let crc = 0xffffffff
  for (const value of bytes.subarray(4, bytes.length - 4)) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}

/** Real RGBA PNG/zlib input. A bad filter occurs only after valid earlier
 * scanlines; a damaged IEND is after the complete IDAT stream. No decoder or
 * host callback manufactures the output pixels for these fixtures. */
export function partialPng(options: {
  width: number; height: number; badFilterRow?: number;
  trailing?: 'bad-crc' | 'truncated'; earlyCrc?: boolean; mask?: boolean
}): Buffer {
  const { width, height, mask = false } = options, header = Buffer.alloc(13),
    rows = Buffer.alloc((width * 4 + 1) * height)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    rows[row] = y === options.badFilterRow ? 5 : 0
    for (let x = 0; x < width; x++) {
      const gray = 64 + y * 4
      rows.set(mask ? [gray, gray, gray, 255] : x === 0 ? [17, 34, 51, 255] : [200, 100, 50, 255], row + 1 + x * 4)
    }
  }
  const ihdr = chunk('IHDR', header), iend = chunk('IEND', new Uint8Array())
  if (options.earlyCrc) ihdr[ihdr.length - 1]! ^= 1
  if (options.trailing === 'bad-crc') iend[iend.length - 1]! ^= 1
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ihdr,
    chunk('IDAT', deflateSync(rows)), options.trailing === 'truncated' ? iend.subarray(0, 9) : iend])
}

export function imagePartialFiles(): Record<string, Buffer> {
  const main = partialBmp({ width: 5, height: 17 })
  return {
    'early.bmp': Buffer.from([0x42, 0x4d]),
    'early.png': partialPng({ width: 5, height: 17, earlyCrc: true }),
    'main-truncated.bmp': partialBmp({ width: 5, height: 17, rows: 9 }),
    'bottom-truncated.bmp': partialBmp({ width: 5, height: 17, rows: 9, topDown: false }),
    'same-truncated.bmp': partialBmp({ width: 7, height: 19, rows: 9 }),
    'mask-size.bmp': main,
    'mask-size_m.bmp': partialBmp({ width: 4, height: 17, mask: true }),
    'mask-read.bmp': main,
    'mask-read_m.bmp': Buffer.from([0x42, 0x4d]),
    'mask-truncated.bmp': main,
    'mask-truncated_m.bmp': partialBmp({ width: 5, height: 17, rows: 9, mask: true }),
    'png-filter.png': partialPng({ width: 5, height: 17, badFilterRow: 8 }),
    'png-tail.png': partialPng({ width: 5, height: 17, trailing: 'bad-crc' }),
    'png-tail-short.png': partialPng({ width: 5, height: 17, trailing: 'truncated' }),
    'pending.png': partialPng({ width: 5, height: 17 }),
    'pending-mask.bmp': main,
    'pending-mask_m.png': partialPng({ width: 5, height: 17, mask: true }),
    'plain.bmp': main,
    'success.bmp': main,
    'success_m.bmp': partialBmp({ width: 5, height: 17, mask: true }),
    'success_p.png': provinceGatePng(),
  }
}

export const imagePartialSource = String.raw`
System.exitOnWindowClose=false;
System.assignMessage("TVPImageLoadError","partial-bmp:%1");
System.assignMessage("TVPPNGLoadError","partial-png:%1");
System.assignMessage("TVPMaskSizeMismatch","partial-mask-size");
var partialWindow=new Window();partialWindow.caption="Image partial";partialWindow.visible=true;
var partialRoot=new Layer(partialWindow,null);partialWindow.add(partialRoot);
partialRoot.type=ltOpaque;partialRoot.setSize(20,24);partialRoot.fillRect(0,0,20,24,0xff000000);
partialWindow.setInnerSize(20,24);
var partialLayer=new Layer(partialWindow,partialRoot);partialLayer.type=ltAlpha;partialLayer.visible=true;partialLayer.setPos(0,0);
var partialPaints=0,partialResult="not-started",partialError="";
partialLayer.onPaint=function(){global.partialPaints++;};
function resetPartialImage(){
  global.partialLayer.setImagePos(0,0);global.partialLayer.setSize(3,2);global.partialLayer.setImageSize(7,19);
  global.partialLayer.setClip(0,0,7,19);
  for(var y=0;y<19;y++)for(var x=0;x<7;x++){
    global.partialLayer.setMainPixel(x,y,0x123456);global.partialLayer.setMaskPixel(x,y,74);
    global.partialLayer.setProvincePixel(x,y,0);
  }
  global.partialLayer.setProvincePixel(0,0,91);global.partialLayer.setProvincePixel(6,18,92);
  global.partialLayer.setImagePos(-2,-1);global.partialLayer.setClip(1,1,2,2);global.partialLayer.imageModified=false;
}
function partialLoad(name,key=clNone){
  global.partialResult="pending";global.partialError="";
  try{var metadata=global.partialLayer.loadImages(name,key);global.partialResult=metadata===null?"null":"metadata";}
  catch(error){global.partialResult="failed";global.partialError=error.message;}
  return global.partialResult+":"+global.partialError;
}
function partialGeometry(){
  return [global.partialLayer.left,global.partialLayer.top,global.partialLayer.width,global.partialLayer.height,
    global.partialLayer.imageWidth,global.partialLayer.imageHeight,global.partialLayer.imageLeft,global.partialLayer.imageTop,
    global.partialLayer.clipLeft,global.partialLayer.clipTop,global.partialLayer.clipWidth,global.partialLayer.clipHeight].join(",");
}
function partialPlaneState(){
  return [global.partialLayer.getMainPixel(1,0),global.partialLayer.getMaskPixel(1,0),
    global.partialLayer.getProvincePixel(0,0),global.partialLayer.getProvincePixel(4,16),
    int(global.partialLayer.imageModified)].join(",");
}
resetPartialImage();
`
