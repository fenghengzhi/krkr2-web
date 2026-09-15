import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import type { DecodedImage, GraphicsDecoder } from '../../src/engine/ports/graphics.ts'
import type { LayerTree } from '../../src/engine/scene/layers.ts'
import {
  ProvinceImageLoadError,
  type ImageLoader,
  type LoadedImage,
} from '../../src/engine/storage/images.ts'
import { encodeBmp } from '../../src/formats/image/bmp.ts'
import { headless } from '../helpers/headless.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function observe<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  )
}

const masked = [200, 100, 50, 64, 40, 80, 120, 192],
  matted = [241, 216, 203, 255, 93, 123, 153, 255]

function decoderGate() {
  const entered = deferred<void>(),
    result = deferred<DecodedImage>()
  let calls = 0
  const graphics: GraphicsDecoder = {
    async decode(bytes) {
      assert.equal(new TextDecoder().decode(bytes), 'province-companion-decoder-gate')
      calls++
      entered.resolve()
      return result.promise
    },
    text() {
      throw new Error('Unexpected text drawing')
    },
  }
  return {
    entered: entered.promise,
    result,
    graphics,
    calls: () => calls,
    release() {
      // Safe even if setup failed before the decoder acquired this promise.
      result.resolve({ width: 1, height: 1, data: new Uint8Array(4), grayscale: true })
    },
  }
}

async function fixture(binary: boolean, graphics?: GraphicsDecoder) {
  const frames: Array<Array<{ id: number; width: number; height: number; pixels: number[] }>> = [],
    main = encodeBmp({
      width: 2,
      height: 1,
      data: new Uint8Array([200, 100, 50, 17, 40, 80, 120, 201]),
    }),
    mask = encodeBmp({
      width: 2,
      height: 1,
      data: new Uint8Array([64, 64, 64, 255, 192, 192, 192, 255]),
    }),
    harness = await headless(
      {
        'startup.tjs': '',
        'broken.bmp': main,
        'broken_m.bmp': mask,
        'broken_p.bmp': new Uint8Array([0x42, 0x4d]),
        'pending.bmp': main,
        'pending_m.bmp': mask,
        'pending_p.png': 'province-companion-decoder-gate',
        'province-companion.tjs': String.raw`
System.exitOnWindowClose=false;
var win=new Window(),root=new Layer(win,null),layer=new Layer(win,root);
win.focusable=false;win.setInnerSize(16,12);win.visible=true;
root.type=ltBinder;root.setSize(16,12);layer.visible=true;
layer.setSize(3,2);layer.setImageSize(5,4);layer.setPos(7,9);layer.setImagePos(-2,-1);
for(var y=0;y<4;y++)for(var x=0;x<5;x++){
  layer.setMainPixel(x,y,0x123456);layer.setMaskPixel(x,y,74);
}
layer.setProvincePixel(0,0,91);layer.setProvincePixel(4,3,92);
layer.setClip(1,1,2,2);layer.imageModified=false;
var loadResult="not started",loadError="";
function loadCompanion(name,key){
  loadResult="pending";loadError="";
  try{
    var result=layer.loadImages(name,key);
    loadResult=result===null?"null":"unexpected return";
  }catch(error){loadResult="failed";loadError=error.message;}
  Debug.message("companion-load-settled");
}
function geometry(){
  return [layer.left,layer.top,layer.width,layer.height,layer.imageWidth,layer.imageHeight,
    layer.imageLeft,layer.imageTop,layer.clipLeft,layer.clipTop,layer.clipWidth,layer.clipHeight].join(",");
}
function loadedPixels(){
  return [layer.getMainPixel(0,0),layer.getMaskPixel(0,0),layer.getMainPixel(1,0),
    layer.getMaskPixel(1,0),layer.getProvincePixel(0,0),layer.getProvincePixel(1,0)].join(",");
}
`,
      },
      {
        ...(graphics ? { graphics } : {}),
        renderer: {
          present(layers) {
            // Copy at the presentation boundary: later bitmap writes must not
            // retroactively change the evidence of the earlier visible frame.
            frames.push(
              layers.map(({ id, pixels }) => ({
                id,
                width: pixels.width,
                height: pixels.height,
                pixels: [...pixels.data],
              })),
            )
          },
          dispose() {},
        },
      },
    ),
    { session } = harness,
    internal = session as unknown as { layers: LayerTree; images: ImageLoader },
    loads: Array<Promise<PromiseSettledResult<LoadedImage>>> = [],
    load = internal.images.load.bind(internal.images)
  // Own the complete loader result, including mask, matte and companion
  // conversion. Stop can then await abandoned I/O without reentering the VM.
  internal.images.load = (...args) => {
    const loading = load(...args)
    loads.push(observe(loading))
    return loading
  }
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("province-companion.tjs","savedata/province-companion.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/province-companion.cjs")')
    } else await session.evaluate('Scripts.execStorage("province-companion.tjs")')
    const id = Number(await session.evaluate('layer.__id')),
      handles = session.snapshot().handles
    assert.equal(session.snapshot().bitmapBytes, 100)
    assert.equal(await session.evaluate('geometry()'), '7,9,3,2,5,4,-2,-1,1,1,2,2')
    const stopped = () => {
      assert.equal(session.snapshot().bitmapBytes, 0)
      assert.equal(session.snapshot().handles, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
    }
    return {
      ...harness,
      id,
      handles,
      layers: internal.layers,
      loads,
      frames,
      load: (name: string, key = 'clAlphaMat+0xffffff') =>
        session.evaluate(`loadCompanion(${JSON.stringify(name)},${key})`),
      planeState() {
        const layer = internal.layers.get(id),
          bitmap = internal.layers.bitmap(id)
        return {
          pixels: [...bitmap.pixels.data],
          province: layer.province && [...layer.province.data],
          geometry: [
            layer.left,
            layer.top,
            layer.width,
            layer.height,
            bitmap.width,
            bitmap.height,
            layer.imageLeft,
            layer.imageTop,
          ],
          clip: { ...bitmap.clip },
          modified: layer.imageModified,
        }
      },
      stopped,
      async stop() {
        await session.stop()
        stopped()
      },
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

function partialFailure(
  result: PromiseSettledResult<LoadedImage>,
  cause: RegExp,
  pixels: number[],
) {
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.ok(result.reason instanceof ProvinceImageLoadError)
  assert.match(String(result.reason.cause), cause)
  assert.deepEqual(
    {
      width: result.reason.image.width,
      height: result.reason.image.height,
      pixels: [...result.reason.image.data],
    },
    { width: 2, height: 1, pixels },
  )
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  for (const [label, key, pixels, tjsPixels] of [
    ['mask', 'clNone', masked, [0xc86432, 64, 0x285078, 192, 0, 0]],
    ['matte', 'clAlphaMat+0xffffff', matted, [0xf1d8cb, 255, 0x5d7b99, 255, 0, 0]],
  ] as const) {
    test(`${mode}: a malformed BMP _p commits the decoded main and ${label}, clears Province and resets image geometry before throwing`, async () => {
      const f = await fixture(binary)
      try {
        const oldBitmap = f.layers.bitmap(f.id)
        await f.load('broken.bmp', key)
        assert.equal(await f.session.evaluate('loadResult'), 'failed')
        assert.match(await f.session.evaluate('loadError'), /Truncated BMP header/)
        assert.equal(await f.session.evaluate('loadedPixels()'), tjsPixels.join(','))
        assert.equal(await f.session.evaluate('geometry()'), '7,9,2,1,2,1,0,0,0,0,2,1')
        assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
        assert.notEqual(f.layers.bitmap(f.id), oldBitmap)
        assert.deepEqual([...f.layers.bitmap(f.id).pixels.data], [...pixels])
        assert.equal(f.layers.get(f.id).province, undefined)
        assert.equal(f.session.snapshot().bitmapBytes, 8)
        assert.equal(f.session.snapshot().handles, f.handles)
        assert.equal(f.loads.length, 1)
        partialFailure(await f.loads[0]!, /Truncated BMP header/, [...pixels])
      } finally {
        await f.stop()
      }
    })
  }

  for (const shrink of [false, true]) {
    test(`${mode}: a failed _p load ${shrink ? 'presents the completed main when the display shrinks' : 'does not request presentation when the display size stays unchanged'}`, async () => {
      const f = await fixture(binary)
      try {
        if (!shrink) await f.session.evaluate('layer.setSize(2,1)')
        const before = f.frames.length,
          previous = f.frames.at(-1)
        assert.ok(before > 0)
        assert.ok(previous?.some((layer) => layer.id === f.id))
        await f.load('broken.bmp')
        // This is the load invocation's own completed execute/present boundary;
        // do not use idle, another VM call, or a timer to manufacture a frame.
        assert.equal(f.frames.length, before + Number(shrink))
        if (shrink)
          assert.deepEqual(
            f.frames.at(-1)?.find((layer) => layer.id === f.id),
            {
              id: f.id,
              width: 2,
              height: 1,
              pixels: matted,
            },
          )
        else assert.equal(f.frames.at(-1), previous)
        assert.equal(await f.session.evaluate('loadResult'), 'failed')
        assert.match(await f.session.evaluate('loadError'), /Truncated BMP header/)
        assert.deepEqual([...f.layers.bitmap(f.id).pixels.data], matted)
        assert.equal(f.layers.get(f.id).province, undefined)
        assert.equal(await f.session.evaluate('geometry()'), '7,9,2,1,2,1,0,0,0,0,2,1')
        assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
        assert.equal(f.session.snapshot().bitmapBytes, 8)
      } finally {
        await f.stop()
      }
    })
  }

  for (const mutation of ['main pixel write', 'Province replacement'] as const) {
    test(`${mode}: a late _p failure preserves a host-side ${mutation} made while the real loadImages call is suspended`, async () => {
      const gate = decoderGate(),
        f = await fixture(binary, gate.graphics)
      let loading: Promise<PromiseSettledResult<string>> | undefined
      try {
        loading = observe(f.load('pending.bmp'))
        await within(gate.entered, 'companion decoder entry')
        assert.equal(gate.calls(), 1)
        const oldBitmap = f.layers.bitmap(f.id),
          oldProvince = f.layers.get(f.id).province
        assert.equal(f.layers.get(f.id).imageModified, false)
        // EngineSession serializes evaluate calls: this is an actual host-side
        // mutation, not a claim that another TJS script runs concurrently in
        // the suspended source/bytecode VM invocation.
        if (mutation === 'main pixel write')
          assert.equal(f.layers.setPixel(f.id, 1, 1, 0xabcdef, 'main'), true)
        else f.layers.provinceImage(f.id, new Uint8Array(20).fill(173))
        const newerProvince = f.layers.get(f.id).province,
          current = f.planeState()
        if (mutation === 'main pixel write') {
          assert.equal(newerProvince, oldProvince)
          assert.equal(f.layers.getPixel(f.id, 1, 1, 'main'), 0xabcdef)
        } else {
          assert.notEqual(newerProvince, oldProvince)
          assert.deepEqual(current.province, Array(20).fill(173))
        }
        gate.result.reject(new Error('late companion decode failure'))
        assert.equal((await within(loading, 'obsolete companion invocation')).status, 'fulfilled')
        assert.equal(await f.session.evaluate('loadResult'), 'failed')
        assert.match(await f.session.evaluate('loadError'), /late companion decode failure/)
        assert.equal(f.layers.bitmap(f.id), oldBitmap)
        assert.equal(f.layers.get(f.id).province, newerProvince)
        assert.deepEqual(f.planeState(), current)
        assert.equal(await f.session.evaluate('geometry()'), '7,9,3,2,5,4,-2,-1,1,1,2,2')
        assert.equal(f.session.snapshot().bitmapBytes, 100)
        assert.equal(f.session.snapshot().handles, f.handles)
        assert.equal(f.loads.length, 1)
        partialFailure(await f.loads[0]!, /late companion decode failure/, matted)
      } finally {
        gate.release()
        await f.stop()
        if (loading) await loading
        await Promise.all(f.loads)
      }
    })
  }

  test(`${mode}: Stop releases a suspended loadImages before its late _p failure without committing or reviving images`, async () => {
    const gate = decoderGate(),
      f = await fixture(binary, gate.graphics)
    let loading: Promise<PromiseSettledResult<string>> | undefined
    try {
      loading = observe(f.load('pending.bmp'))
      await within(gate.entered, 'companion decoder entry before Stop')
      assert.equal(f.session.snapshot().bitmapBytes, 100)
      // The external decoder is deliberately still pending when Stop returns.
      await within(f.session.stop(), 'Stop while companion decoder is held')
      const cancelled = await within(loading, 'cancelled loadImages invocation')
      assert.equal(cancelled.status, 'rejected')
      if (cancelled.status === 'rejected')
        assert.match(String(cancelled.reason), /Execution cancelled/)
      f.stopped()
      assert.equal(f.layers.has(f.id), false)
      assert.equal(f.logs.includes('companion-load-settled'), false)
      gate.result.reject(new Error('late stopped companion decode failure'))
      assert.equal(f.loads.length, 1)
      partialFailure(
        await within(f.loads[0]!, 'the abandoned complete companion loader'),
        /late stopped companion decode failure/,
        matted,
      )
      f.stopped()
      assert.equal(f.layers.has(f.id), false)
      assert.equal(f.logs.includes('companion-load-settled'), false)
    } finally {
      gate.release()
      await f.stop()
      if (loading) await loading
      await Promise.all(f.loads)
    }
  })
}
