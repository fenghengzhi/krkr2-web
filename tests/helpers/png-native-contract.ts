import { deflateSync } from 'node:zlib'

// Fixture bytes are independent of the production parser/filter/CRC code.
function chunk(name: string, data: Uint8Array, badCrc = false): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length); bytes.write(name, 4, 'ascii'); bytes.set(data, 8)
  let crc = 0xffffffff
  for (const value of bytes.subarray(4, bytes.length - 4)) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE(((crc ^ 0xffffffff) ^ (badCrc ? 1 : 0)) >>> 0, bytes.length - 4)
  return bytes
}
function position(x: number, y: number, unit: number, extra = 0): Buffer {
  const bytes = Buffer.alloc(9 + extra)
  bytes.writeUInt32BE(x >>> 0); bytes.writeUInt32BE(y >>> 0, 4); bytes[8] = unit
  return bytes
}
function png(type: number, samples: number[], before: Buffer[] = [], after: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = type
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...before,
    chunk('IDAT', deflateSync(Buffer.from([0, ...samples]))), ...after, chunk('IEND', Buffer.alloc(0))])
}
const rgb = [20, 40, 60, 90, 100, 110]
export function pngNativeFiles(): Record<string, Buffer> {
  return {
    'native-rgb.png': png(2, rgb, [chunk('tRNS', Uint8Array.of(0, 20, 0, 40, 0, 60))]),
    'native-gray.png': png(0, [32, 128], [chunk('tRNS', Uint8Array.of(0, 32))]),
    'native-rgba.png': png(6, [100, 50, 25, 64, 70, 80, 90, 191]),
    'native-metadata.png': png(2, rgb, [
      chunk('oFFs', position(-3, 5, 0)), chunk('oFFs', position(44, 55, 1)),
      chunk('pHYs', position(0xffffffff, 0x80000000, 1)), chunk('pHYs', position(66, 77, 0)),
      chunk('vpAg', position(0xffffffff, 6, 1, 2)),
    ], [chunk('oFFs', position(99, 99, 1)), chunk('pHYs', position(99, 99, 0)),
      chunk('VpAG', position(0x80000000, 0xffffffff, 9))]),
    'native-tail.png': png(2, rgb, [], [chunk('oFFs', position(3, 4, 0)), chunk('pHYs', position(5, 6, 1))]),
    'native-short.png': png(2, rgb, [chunk('oFFs', Buffer.alloc(8)), chunk('pHYs', Buffer.alloc(8)), chunk('vpAg', Buffer.alloc(8))]),
    'native-crc.png': png(2, rgb, [chunk('oFFs', position(3, 4, 0), true), chunk('pHYs', position(5, 6, 1), true)],
      [chunk('vpAg', position(0xffffffff, 9, 0), true)]),
  }
}

export const pngMetadataExpected = '-3,5,pixel,-1,-2147483648,meter,-2147483648,-1,unknown'
export const pngNativeSource = String.raw`
System.exitOnWindowClose=false;
var pngWindow=new Window();pngWindow.caption="PNG native contract";pngWindow.visible=true;
var pngRoot=new Layer(pngWindow,null);pngWindow.add(pngRoot);pngRoot.type=ltOpaque;
pngRoot.setSize(12,8);pngRoot.fillRect(0,0,12,8,0xff010203);pngWindow.setInnerSize(12,8);
var pngRgb=new Layer(pngWindow,pngRoot);pngRgb.type=ltAlpha;pngRgb.visible=true;pngRgb.setPos(0,0);pngRgb.loadImages("native-rgb.png");
var pngGray=new Layer(pngWindow,pngRoot);pngGray.type=ltAlpha;pngGray.visible=true;pngGray.setPos(0,2);pngGray.loadImages("native-gray.png");
var pngRgba=new Layer(pngWindow,pngRoot);pngRgba.type=ltAlpha;pngRgba.loadImages("native-rgba.png");
var pngProbe=new Layer(pngWindow,pngRoot),pngMetadata;
function pngAlpha(){return [global.pngRgb.getMaskPixel(0,0),global.pngRgb.getMaskPixel(1,0),global.pngGray.getMaskPixel(0,0),global.pngGray.getMaskPixel(1,0),global.pngRgba.getMaskPixel(0,0),global.pngRgba.getMaskPixel(1,0)].join(",");}
function pngMeta(){global.pngMetadata=global.pngProbe.loadImages("native-metadata.png");var m=global.pngMetadata;return [m.offs_x,m.offs_y,m.offs_unit,m.reso_x,m.reso_y,m.reso_unit,m.vpag_w,m.vpag_h,m.vpag_unit].join(",");}
function pngEmptyMeta(name){return global.pngProbe.loadImages(name)===null;}
function pngCrcMeta(){var m=global.pngProbe.loadImages("native-crc.png");return [m.offs_x===void,m.reso_x===void,m.vpag_w,m.vpag_h,m.vpag_unit].join(",");}
`

export const pngNativeFrame = { width: 12, height: 8,
  rgba: Array.from({ length: 12 * 8 }, (_, pixel) => {
    const x = pixel % 12, y = Math.floor(pixel / 12)
    if (y === 0 && x < 2) return x === 0 ? [20, 40, 60, 255] : [90, 100, 110, 255]
    if (y === 2 && x === 1) return [128, 128, 128, 255]
    return [1, 2, 3, 255]
  }).flat() }
