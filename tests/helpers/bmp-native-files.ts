/** Independent CORE24, INFO16 and native CORE indexed byte vectors. */
export function bmpNativeFiles(): Record<string, Buffer> {
  const core = Buffer.alloc(38)
  core.write('BM'); core.writeUInt32LE(38, 2); core.writeUInt32LE(26, 10)
  core.writeUInt32LE(12, 14); core.writeUInt16LE(3, 18); core.writeUInt16LE(1, 20)
  core.writeUInt16LE(1, 22); core.writeUInt16LE(24, 24)
  core.set([0, 0, 255, 0, 255, 0, 255, 0, 0], 26)
  const mask = Buffer.alloc(62)
  mask.write('BM'); mask.writeUInt32LE(62, 2); mask.writeUInt32LE(54, 10)
  mask.writeUInt32LE(40, 14); mask.writeInt32LE(3, 18); mask.writeInt32LE(-1, 22)
  mask.writeUInt16LE(1, 26); mask.writeUInt16LE(16, 28)
  mask.writeUInt16LE(0x7c00, 54); mask.writeUInt16LE(0x03e0, 56); mask.writeUInt16LE(0x001f, 58)
  const province = Buffer.alloc(38)
  province.write('BM'); province.writeUInt32LE(38, 2); province.writeUInt32LE(34, 10)
  province.writeUInt32LE(12, 14); province.writeUInt16LE(3, 18); province.writeUInt16LE(1, 20)
  province.writeUInt16LE(1, 22); province.writeUInt16LE(1, 24)
  // The selected fixed loader uses four-byte palette items after its CORE
  // memset. Index values, rather than either palette color, form the province.
  province.set([10, 20, 30, 0, 50, 60, 70, 0], 26)
  province[34] = 0x40
  return { 'core.dib': core, 'core_m.bmp': mask, 'province.dib': province }
}

export const bmpNativeSource = String.raw`
var win=new Window();win.visible=true;win.setInnerSize(3,1);
var root=new Layer(win,null),image=new Layer(win,root);root.setSize(3,1);root.fillRect(0,0,3,1,0xff000000);
var metadata=image.loadImages("core.dib");image.setSize(3,1);image.visible=true;
image.loadProvinceImage("province.dib");
var bmpNativeReady=metadata===null && image.imageWidth==3 && image.imageHeight==1
 && image.getMainPixel(0,0)==0xff0000 && image.getMainPixel(1,0)==0xff00 && image.getMainPixel(2,0)==0xff
 && image.getMaskPixel(0,0)==54 && image.getMaskPixel(1,0)==181 && image.getMaskPixel(2,0)==20
 && image.getProvincePixel(0,0)==0 && image.getProvincePixel(1,0)==1 && image.getProvincePixel(2,0)==0;
Debug.message("bmp-native-ready:"+string(bmpNativeReady));
`
