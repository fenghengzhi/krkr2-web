import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

test('saveLayerImage writes whole-image PNG/TLG variants and type tags through the storage overlay', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),layer=new Layer(window,root),loaded=new Layer(window,root);
layer.setImageSize(2,1);layer.fillRect(0,0,1,1,0x00123456);layer.fillRect(1,0,1,1,0x80abcdef);layer.setProvincePixel(1,0,91);layer.setClip(1,0,1,1);layer.type=ltAddAlpha;
var formats=["png","png24","tlg5","tlg524","tlg6","tlg624"],ok=true;
for(var i=0;i<formats.count;i++){
 var format=formats[i],path="savedata/round-"+format+".data";layer.saveLayerImage(path,format);var tags=loaded.loadImages(path);
 ok=ok && loaded.imageWidth==2 && loaded.getMainPixel(0,0)==0x123456 && loaded.getMainPixel(1,0)==0xabcdef && loaded.getProvincePixel(1,0)==0;
 var alpha=format=="png24" || format=="tlg524" || format=="tlg624";ok=ok && loaded.getMaskPixel(0,0)==(alpha?255:0) && loaded.getMaskPixel(1,0)==(alpha?255:128);
 ok=ok && (format.indexOf("tlg")==0?tags.mode=="addalpha":tags===null);
}
layer.saveLayerImage("savedata/default.png");var flags=layer.clipLeft==1 && layer.getProvincePixel(1,0)==91 && layer.getMaskPixel(1,0)==128;
`,
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('ok && flags'), '1')
    const files = session.exportSaves()
    assert.equal(files.length, 7)
    assert.equal(
      Buffer.from(files.find((f) => f.path === 'savedata/default.png')!.bytes)
        .subarray(0, 2)
        .toString(),
      'BM',
    )
  } finally {
    await session.stop()
  }
})

test('failed PNG compression preserves the existing saved file', async () => {
  const { session } = await headless(
    {
      'startup.tjs':
        'var window=new Window(),layer=new Layer(window,null);var rejected=false;try{layer.saveLayerImage("savedata/keep.png","png");}catch(e){rejected=true;}',
    },
    {
      deflateImage: async () => {
        throw new Error('Injected compression failure')
      },
    },
  )
  try {
    await session.importSaves([{ path: 'savedata/keep.png', bytes: new Uint8Array([1, 2, 3]) }])
    await session.start()
    assert.equal(await session.evaluate('rejected'), '1')
    assert.deepEqual([...session.exportSaves()[0]!.bytes], [1, 2, 3])
  } finally {
    await session.stop()
  }
})

test('pause and cancellation discard a pending TLG encoding without overwriting the saved file', async () => {
  let signal = () => {},
    release = () => {},
    held = false,
    ticks = 0
  const entered = new Promise<void>((resolve) => {
    signal = resolve
  })
  const { session, logs } = await headless(
    {
      'startup.tjs':
        'var window=new Window(),layer=new Layer(window,null);layer.setImageSize(129,65);layer.fillRect(0,0,129,65,0x80123456);Debug.message("encode-start");layer.saveLayerImage("savedata/keep.tlg","tlg6");Debug.message("encode-finished");',
    },
    {
      now: () => (ticks += 10),
      schedule: (callback, delay) => {
        if (delay === 0 && !held) {
          held = true
          release = callback
          signal()
          return () => {}
        }
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      },
    },
  )
  try {
    await session.importSaves([{ path: 'savedata/keep.tlg', bytes: new Uint8Array([1, 2, 3]) }])
    const started = session.start()
    await entered
    assert.ok(logs.includes('encode-start'))
    session.pause()
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(logs.includes('encode-finished'), false)
    const settled = await Promise.allSettled([started, session.stop()])
    assert.equal(settled[1]!.status, 'fulfilled')
    assert.deepEqual([...session.exportSaves()[0]!.bytes], [1, 2, 3])
    assert.equal(logs.includes('encode-finished'), false)
  } finally {
    await session.stop()
  }
})
