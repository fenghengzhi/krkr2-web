import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

// Independent two-pixel, uncompressed BMP24. No application encoder supplies
// the bytes used to replace a previously shared image.
function replacementBmp() {
  const bytes = Buffer.alloc(62)
  bytes.write('BM'); bytes.writeUInt32LE(62, 2); bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(2, 18); bytes.writeInt32LE(1, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(8, 34)
  bytes.set([0xcc, 0xbb, 0xaa, 0x33, 0x22, 0x11, 0, 0], 54)
  return bytes
}
const program = String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var sharedWin=void,sharedRoot,origin,copies,paints=0;
function prepareImages(width,height){
 if(sharedWin!==void && isvalid sharedWin)invalidate sharedWin;
 sharedWin=new Window();sharedRoot=new Layer(sharedWin,null);sharedWin.add(sharedRoot);sharedRoot.hasImage=false;
 origin=new Layer(sharedWin,sharedRoot);sharedWin.add(origin);origin.setImageSize(width,height);
 origin.setMainPixel(0,0,0x112233);origin.setMaskPixel(0,0,77);origin.setProvincePixel(0,0,17);
 copies=[];
 for(var i=0;i<3;i++){var copy=new Layer(sharedWin,sharedRoot);sharedWin.add(copy);copy.assignImages(origin);copies.add(copy);}
}
function pixel(layer,x){return [layer.getMainPixel(x,0),layer.getMaskPixel(x,0),layer.getProvincePixel(x,0)].join(",");}
function smallImages(){
 prepareImages(2,1);origin.fillRect(0,0,2,1,0x4d112233);
 for(var i=0;i<3;i++)copies[i].assignImages(origin);
 return pixel(copies[2],0);
}
function writeCopies(){
 copies[0].setClip(1,0,1,1);copies[0].setMainPixel(0,0,0xfedcba);
 copies[0].setMainPixel(1,0,0xabcdef);copies[0].setMaskPixel(1,0,201);copies[0].setProvincePixel(1,0,29);
 copies[1].independMainImage();copies[1].setMaskPixel(0,0,88);
 copies[1].independProvinceImage(false);copies[1].setProvincePixel(0,0,37);
 origin.setMainPixel(0,0,0x010203);origin.setProvincePixel(0,0,31);
 return [pixel(origin,0),pixel(copies[0],0),pixel(copies[0],1),pixel(copies[1],0),pixel(copies[2],0)].join("|");
}
function exclusiveImages(){
 copies[1].independMainImage(false);copies[1].independProvinceImage(false);
 return pixel(copies[1],0);
}
function replaceImage(){
 copies[2].loadImages("replacement.bmp");copies[2].setImageSize(3,1);
 return [pixel(copies[2],0),pixel(copies[2],1),pixel(copies[2],2),pixel(origin,0)].join("|");
}
function preparePaint(){
 smallImages();sharedWin.setInnerSize(4,2);sharedWin.visible=true;copies[0].visible=true;
 copies[0].onPaint=function(){global.paints++;};sharedWin.update();paints=0;
}
function armPaint(){copies[0].update(0,0,0,1);}
function assignShared(){copies[0].assignImages(origin);}
function assignChanged(){origin.setMainPixel(0,0,0x556677);copies[0].assignImages(origin);}
function paintState(){return paints+","+int(copies[0].callOnPaint);}
function largeImages(){prepareImages(2560,2048);}
function firstLargeWrite(){copies[0].setMainPixel(0,0,0xabcdef);}
function rejectedLargeWrite(){
 copies[1].imageModified=false;var failure="not-rejected";
 try{copies[1].setMaskPixel(0,0,201);}catch(e){failure=e.message;}
 return failure;
}
function largeState(){return [pixel(origin,0),pixel(copies[1],0),pixel(copies[2],0),int(copies[1].imageModified)].join("|");}
function releaseAndWrite(){copies[0].hasImage=false;copies[1].setMaskPixel(0,0,201);return largeState();}
function closeSharedImages(){invalidate sharedWin;sharedWin=void;}
`

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: real shared Layer images preserve writes, replacement, pending paint and the actual allocation budget`, { timeout: 60000 }, async () => {
    const { session } = await headless({
      'images.tjs': program,
      'replacement.bmp': replacementBmp(),
      'startup.tjs': binary
        ? 'Scripts.compileStorage("images.tjs","savedata/images.cjs",false,true,false);Scripts.execStorage("savedata/images.cjs");'
        : 'Scripts.execStorage("images.tjs");',
    }), failures: unknown[] = []
    try {
      await session.start()
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((entry) => entry.path === 'savedata/images.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
      assert.equal(await session.evaluate('smallImages()'), '1122867,77,17')
      assert.equal(session.snapshot().bitmapBytes, 10)
      assert.equal(await session.evaluate('writeCopies()'),
        '66051,77,31|1122867,77,17|11259375,201,29|1122867,88,37|1122867,77,17')
      assert.equal(await session.evaluate('exclusiveImages()'), '1122867,88,37')
      assert.equal(await session.evaluate('replaceImage()'),
        '11189196,255,0|1122867,255,0|16777215,0,0|66051,77,31')
      await session.evaluate('preparePaint()')
      await session.evaluate('armPaint()')
      assert.equal(await session.evaluate('paintState()'), '0,1')
      await session.evaluate('assignShared()')
      assert.equal(await session.evaluate('paintState()'), '0,1', 'Assigning an already shared image must not flush pending onPaint')
      await session.evaluate('assignChanged()')
      assert.equal(await session.evaluate('paintState()'), '1,0')
      await session.evaluate('largeImages()')
      assert.equal(session.snapshot().bitmapBytes, 25 * 1024 * 1024)
      await session.evaluate('firstLargeWrite()')
      assert.equal(session.snapshot().bitmapBytes, 45 * 1024 * 1024)
      assert.match(String(await session.evaluate('rejectedLargeWrite()')), /64 MiB budget/)
      assert.equal(session.snapshot().bitmapBytes, 45 * 1024 * 1024)
      assert.equal(await session.evaluate('largeState()'), '1122867,77,17|1122867,77,17|1122867,77,17|0')
      assert.equal(await session.evaluate('releaseAndWrite()'), '1122867,77,17|1122867,201,17|1122867,77,17|1')
      assert.equal(session.snapshot().bitmapBytes, 45 * 1024 * 1024)
      await session.evaluate('closeSharedImages()')
      assert.equal(session.snapshot().bitmapBytes, 0)
    } catch (error) { failures.push(error) }
    try {
      await session.stop()
      assert.equal(session.snapshot().bitmapBytes, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Shared Layer images or cleanup failed', { cause: failures[0] })
  })
