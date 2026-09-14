import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { decodeBmp } from '../../src/formats/image/bmp.ts'
test('piledCopy includes children once, ignores draw faces and persists a complete thumbnail', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),group=new Layer(window,root),child=new Layer(window,group),target=new Layer(window,root);
root.setSize(4,1);group.setSize(4,1);child.setSize(2,1);child.visible=true;group.opacity=128;
group.fillRect(0,0,4,1,0xffff0000);child.fillRect(0,0,2,1,0xff0000ff);
group.face=dfProvince;target.setImageSize(4,1);target.face=dfMask;target.piledCopy(0,0,group,0,0,4,1);
target.face=dfAlpha;target.stretchCopy(2,0,2,1,target,0,0,4,1,stNearest);
target.saveLayerImage("savedata/thumbnail.bmp","bmp24");
var data=%[value:7];(Dictionary.saveStruct incontextof data)("savedata/thumbnail.bmp","o66");
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        'target.getMainPixel(0,0)==0x0000ff && target.getMainPixel(2,0)==0x0000ff && target.getMainPixel(3,0)==0xff0000',
      ),
      '1',
    )
    assert.equal(
      await session.evaluate('Scripts.evalStorage("savedata/thumbnail.bmp","o66").value'),
      '7',
    )
    const saved = await session.exportSaves(),
      bytes = saved.find((file) => file.path === 'savedata/thumbnail.bmp')!.bytes
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(2, true), 66)
    assert.deepEqual(
      [...decodeBmp(bytes)!.data],
      [0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255],
    )
  } finally {
    await session.stop()
  }
})
test('a snapshot paints pending source layers before copying their pixels', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),target=new Layer(window,root),painted=0;
root.onPaint=function(){painted++;root.fillRect(0,0,1,1,0xff123456);};root.callOnPaint=true;
target.piledCopy(0,0,root,0,0,1,1);
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        'painted==1 && target.getMainPixel(0,0)==0x123456 && !root.callOnPaint',
      ),
      '1',
    )
  } finally {
    await session.stop()
  }
})
