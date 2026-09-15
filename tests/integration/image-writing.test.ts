import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

test('saveLayerImage writes whole-image PNG/TLG variants and type tags through the storage overlay', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),layer=new Layer(window,root),loaded=new Layer(window,root);
layer.setImageSize(2,1);layer.fillRect(0,0,1,1,0x00123456);layer.fillRect(1,0,1,1,0x80abcdef);layer.setProvincePixel(1,0,91);layer.type=ltAddAlpha;layer.setClip(1,0,1,1);
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

for (const binary of [false, true])
  for (const format of ['png', 'png24', 'png32', 'tlg', 'tlg5', 'tlg524', 'tlg6', 'tlg624'])
    for (const overwrite of [false, true])
      test(
        `${binary ? 'bytecode' : 'source'}: cancellation at the first ${format} encoder yield ${overwrite ? 'preserves the existing destination' : 'creates no incomplete destination'}`,
        { timeout: 60000 },
        async () => {
          let signal = () => {},
            release = () => {},
            armed = false,
            held = false,
            ticks = 0
          const order: string[] = [],
            logs: string[] = [],
            entered = new Promise<void>((resolve) => {
              signal = resolve
            }),
            destination = overwrite ? 'savedata/keep.img' : 'savedata/pending.img'
          const { session } = await headless(
            {
              'startup.tjs': '',
              'encode.tjs': `
var window=new Window(),layer=new Layer(window,null);
layer.setImageSize(129,65);layer.fillRect(0,0,129,65,0x80123456);
Debug.message("encode-start");
layer.saveLayerImage("${destination}","${format}");
Debug.message("encode-finished");`,
            },
            {
              now: () => (ticks += 10),
              event(event) {
                if (event.type !== 'log') return
                logs.push(event.text)
                if (event.text === 'encode-start') {
                  armed = true
                  order.push('encode-start')
                }
                if (event.text === 'encode-finished') order.push('encode-finished')
              },
              schedule(callback, delay) {
                // This fixture has no frame driver or user timers. Between
                // encode-start and this first zero-delay schedule, the script
                // only enters saveLayerImage and advances its real encoder.
                if (armed && delay === 0 && !held) {
                  held = true
                  armed = false
                  release = () => {
                    release = () => {}
                    order.push('encoder-yield-released')
                    callback()
                  }
                  order.push('encoder-yield-held')
                  signal()
                  return () => {}
                }
                const timer = setTimeout(callback, delay)
                return () => clearTimeout(timer)
              },
            },
          )
          const unlisten = session.control.onCancel(() => order.push('cancelled'))
          try {
            await session.importSaves([
              { path: 'savedata/keep.img', bytes: new Uint8Array([1, 2, 3]) },
            ])
            await session.start()
            let storage = 'encode.tjs'
            if (binary) {
              storage = 'savedata/encode.cjs'
              await session.evaluate(
                'Scripts.compileStorage("encode.tjs","savedata/encode.cjs",false,true,false)',
              )
            }
            const snapshot = () =>
                session.exportSaves().map((file) => ({ path: file.path, bytes: [...file.bytes] })),
              before = snapshot(),
              execution = session.evaluate(`Scripts.execStorage("${storage}")`).then(
                () => ({ status: 'fulfilled' as const }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
              )
            await Promise.race([
              entered,
              execution.then((result) => {
                throw new Error(
                  `Encoding settled before its first checkpoint: ${result.status === 'rejected' ? String(result.error) : result.status}`,
                )
              }),
            ])
            assert.deepEqual(order, ['encode-start', 'encoder-yield-held'])
            assert.equal(session.control.cancelled, false)
            assert.deepEqual(snapshot(), before)
            assert.equal(held, true)
            order.push('paused')
            session.pause()
            release()
            await new Promise((resolve) => setTimeout(resolve, 20))
            assert.equal(logs.includes('encode-finished'), false)
            assert.deepEqual(snapshot(), before)
            order.push('stop-requested')
            await session.stop()
            const result = await execution
            assert.equal(result.status, 'rejected')
            if (result.status === 'rejected') assert.match(String(result.error), /cancelled/)
            assert.deepEqual(order, [
              'encode-start',
              'encoder-yield-held',
              'paused',
              'encoder-yield-released',
              'stop-requested',
              'cancelled',
            ])
            assert.deepEqual(snapshot(), before)
            assert.equal(logs.includes('encode-finished'), false)
            assert.equal(session.snapshot().state, 'stopped')
            assert.equal(session.snapshot().handles, 0)
          } finally {
            const stopped = session.stop()
            release()
            await stopped
            unlisten()
          }
        },
      )
