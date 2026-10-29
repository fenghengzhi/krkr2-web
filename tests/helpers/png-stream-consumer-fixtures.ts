/** Independent stored-DEFLATE PNGs: every row has its own byte-aligned block.
 * The Adler trailer is in a separate IDAT, so final-row completion must cross
 * the previous IDAT's CRC after transformed bytes reached the caller. */
function chunk(name: string, data: Uint8Array, badCrc = false): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length); bytes.write(name, 4, 'ascii'); bytes.set(data, 8)
  let crc = 0xffffffff
  for (const value of bytes.subarray(4, bytes.length - 4)) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE(((crc ^ 0xffffffff) ^ Number(badCrc)) >>> 0, bytes.length - 4)
  return bytes
}

export const streamMainRows = [
  [17, 34, 51, 77, 200, 100, 50, 88],
  [17, 34, 51, 99, 200, 100, 50, 110],
] as const
export const streamMainKey = 0x112233

function splitPng(mask: boolean, badCrc: boolean): Buffer {
  const header = Buffer.alloc(13), rows = mask ? [[32, 48], [64, 96]] : streamMainRows,
    blocks: Buffer[] = [Buffer.from([0x78, 0x01])]
  header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = mask ? 0 : 6
  let a = 1, b = 0
  for (let y = 0; y < rows.length; y++) {
    const row = Buffer.from([0, ...rows[y]!]), block = Buffer.alloc(5 + row.length)
    block[0] = Number(y === rows.length - 1)
    block.writeUInt16LE(row.length, 1); block.writeUInt16LE(row.length ^ 0xffff, 3); block.set(row, 5)
    blocks.push(block)
    for (const value of row) { a = (a + value) % 65521; b = (b + a) % 65521 }
  }
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE(((b << 16) | a) >>> 0)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', Buffer.concat(blocks), badCrc), chunk('IDAT', trailer), chunk('IEND', new Uint8Array())])
}

function mainBmp(): Buffer {
  const bytes = Buffer.alloc(54 + 16)
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(2, 18); bytes.writeInt32LE(-2, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(32, 28)
  for (let y = 0; y < 2; y++) bytes.set([51, 34, 17, 200, 50, 100, 200, 200], 54 + y * 8)
  return bytes
}

export function pngStreamConsumerFiles(): Record<string, Buffer> {
  return { 'raw-main.png': splitPng(false, true), 'raw-mask.bmp': mainBmp(),
    'raw-mask_m.png': splitPng(true, true), 'good.png': splitPng(false, false) }
}

export const pngStreamConsumerSource = String.raw`
System.exitOnWindowClose=false;
System.assignMessage("TVPPNGLoadError","stream-png:%1");
var streamWindow=new Window();streamWindow.caption="PNG stream";streamWindow.visible=true;
var streamRoot=new Layer(streamWindow,null);streamWindow.add(streamRoot);
streamRoot.type=ltOpaque;streamRoot.setSize(8,6);streamRoot.fillRect(0,0,8,6,0xff000000);streamWindow.setInnerSize(8,6);
var streamLayer=new Layer(streamWindow,streamRoot);streamLayer.type=ltAlpha;streamLayer.visible=true;
function resetStream(){
  global.streamLayer.setImagePos(0,0);global.streamLayer.setSize(3,3);global.streamLayer.setImageSize(4,4);
  global.streamLayer.setClip(0,0,4,4);
  for(var y=0;y<4;y++)for(var x=0;x<4;x++){
    global.streamLayer.setMainPixel(x,y,0x123456);global.streamLayer.setMaskPixel(x,y,74);global.streamLayer.setProvincePixel(x,y,0);
  }
  global.streamLayer.setProvincePixel(0,0,91);global.streamLayer.setImagePos(-1,-1);
  global.streamLayer.setClip(1,1,1,1);global.streamLayer.imageModified=false;
}
function streamLoad(name,key){
  try{global.streamLayer.loadImages(name,key);return "ok";}
  catch(error){return error.message;}
}
function streamPixels(){
  var values=[];
  for(var y=0;y<2;y++)for(var x=0;x<2;x++){
    values.add(global.streamLayer.getMainPixel(x,y));values.add(global.streamLayer.getMaskPixel(x,y));
  }
  return values.join(",");
}
function streamState(){
  return [global.streamLayer.width,global.streamLayer.height,global.streamLayer.imageWidth,global.streamLayer.imageHeight,
    global.streamLayer.imageLeft,global.streamLayer.imageTop,global.streamLayer.clipLeft,global.streamLayer.clipTop,
    global.streamLayer.clipWidth,global.streamLayer.clipHeight,int(global.streamLayer.imageModified),global.streamLayer.getProvincePixel(0,0)].join(",");
}
resetStream();
`
