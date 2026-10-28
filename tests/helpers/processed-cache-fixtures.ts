import { imageFixture } from './image-fixtures.ts'

/** Independent top-down, padded BGR24 fixture. */
export function cacheBmp(color: number, width = 1, height = 1): Buffer {
  const stride = Math.ceil(width * 3 / 4) * 4, bytes = Buffer.alloc(54 + stride * height)
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(width, 18); bytes.writeInt32LE(-height, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = 54 + y * stride + x * 3
    bytes[at] = color & 255; bytes[at + 1] = (color >>> 8) & 255; bytes[at + 2] = (color >>> 16) & 255
  }
  return bytes
}
export function processedCacheFiles(): Record<string, Uint8Array> {
  return {
    'a.bmp': cacheBmp(0x112233), 'b.bmp': cacheBmp(0x445566), 'c.bmp': cacheBmp(0x778899),
    'base/scene.bmp': cacheBmp(0xff0000, 3, 2), 'patch/scene.bmp': cacheBmp(0x00ff00, 3, 2),
    'hero.png': imageFixture('main.png'), 'hero_m.png': imageFixture('mask.png'),
    'hero_p.png': imageFixture('palette-2x1.png'), 'province.png': imageFixture('palette-2x1.png'),
    'failed.bmp': cacheBmp(0x123456, 2, 1), 'failed_p.bmp': Uint8Array.of(66, 77),
    'oversized.bmp': cacheBmp(0x654321), 'oversized_p.png': imageFixture('palette-2x1.png'),
    'stem.bmp': cacheBmp(0x010203),
  }
}
export const processedCacheSource = String.raw`
System.exitOnWindowClose=false;
var cacheWindow=new Window();cacheWindow.visible=true;cacheWindow.setInnerSize(3,2);
var cacheRoot=new Layer(cacheWindow,null),cacheImage=new Layer(cacheWindow,cacheRoot),cacheBack=new Layer(cacheWindow,cacheRoot);
cacheRoot.setSize(3,2);cacheRoot.fillRect(0,0,3,2,0xff000000);cacheImage.visible=true;
function cacheColor(name,key=clNone){cacheImage.loadImages(name,key);return cacheImage.getMainPixel(0,0);}
function cacheFailure(name){try{cacheImage.loadImages(name);}catch(error){return error.message;}return "NO_ERROR";}
function cacheDraw(){cacheImage.setSize(3,2);cacheImage.update();cacheWindow.update();return cacheImage.getMainPixel(0,0);}
`
