import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import type { DecodedImage, GraphicsDecoder } from '../../src/engine/ports/graphics.ts'
import type { LayerTree } from '../../src/engine/scene/layers.ts'
import type { ImageLoader } from '../../src/engine/storage/images.ts'
import { encodeBmp } from '../../src/formats/image/bmp.ts'
import { headless } from '../helpers/headless.ts'
import { imageFixture } from '../helpers/image-fixtures.ts'

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

function indexed(): DecodedImage {
  return {
    width: 2,
    height: 1,
    data: new Uint8Array([200, 100, 50, 255, 10, 20, 30, 0]),
    indices: new Uint8Array([7, 19]),
  }
}

function decoderGate() {
  const entered = deferred<void>(),
    result = deferred<DecodedImage>()
  let calls = 0
  const graphics: GraphicsDecoder = {
    async decode(bytes) {
      assert.equal(new TextDecoder().decode(bytes), 'province-decoder-gate')
      calls++
      entered.resolve()
      return result.promise
    },
    text() {
      throw new Error('Unexpected text drawing')
    },
  }
  return { entered: entered.promise, result, graphics, calls: () => calls }
}

async function fixture(binary: boolean, graphics?: GraphicsDecoder) {
  const harness = await headless(
    {
      'startup.tjs': '',
      'palette.png': imageFixture('palette-2x1.png'),
      'palette.bmp': encodeBmp(
        { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) },
        'bmp8',
      ),
      'oversized.bmp': encodeBmp({ width: 4, height: 1, data: new Uint8Array(4 * 4) }, 'bmp8'),
      'invalid.bmp': new Uint8Array([0x42, 0x4d]),
      'pending.bin': 'province-decoder-gate',
      'province-loading.tjs': String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(2,2);
var root=new Layer(win,null),layer=new Layer(win,root);
root.setSize(2,2);root.setImageSize(2,2);
layer.setSize(3,2);layer.setImageSize(3,2);
for(var y=0;y<2;y++)for(var x=0;x<3;x++){
  layer.setMainPixel(x,y,0x123456);layer.setMaskPixel(x,y,74);
}
layer.setProvincePixel(0,0,91);layer.setProvincePixel(2,1,92);
layer.setClip(1,0,1,2);layer.imageModified=false;
var loadResult="not started",loadError="";
function loadProvince(name){
  loadResult="pending";loadError="";
  try{
    var result=layer.loadProvinceImage(name);
    loadResult=result===void?"void":"unexpected return";
  }catch(error){loadResult="failed";loadError=error.message;}
  Debug.message("province-load-settled");
}
function provinceValues(){
  var values=[];
  for(var y=0;y<2;y++)for(var x=0;x<3;x++)values.add(layer.getProvincePixel(x,y));
  return values.join(",");
}
function otherPlanes(){
  var values=[];
  for(var y=0;y<2;y++)for(var x=0;x<3;x++){
    values.add(layer.getMainPixel(x,y));values.add(layer.getMaskPixel(x,y));
  }
  values.add(layer.clipLeft);values.add(layer.clipTop);values.add(layer.clipWidth);values.add(layer.clipHeight);
  return values.join(",");
}
var finalizerCalls=0,finalizerProvince="",finalizerOther="",finalizerReturn=false,retiringFont=null;
function retireWithProvince(){
  retiringFont=layer.font;
  retiringFont.finalize=function(){
    global.finalizerCalls++;
    var result=global.layer.loadProvinceImage("pending.bin");
    global.finalizerProvince=global.provinceValues();
    global.finalizerOther=global.otherPlanes();
    global.finalizerReturn=result===void;
  };
  invalidate layer;
}
`,
    },
    graphics ? { graphics } : {},
  )
  const { session } = harness,
    internal = session as unknown as { layers: LayerTree; images: ImageLoader },
    loads: Array<Promise<PromiseSettledResult<Uint8Array>>> = [],
    province = internal.images.province.bind(internal.images)
  // Observe the real complete image-loader promise, including conversion after
  // decode. This lets Stop tests await abandoned I/O without sleeps or another
  // VM entry; both success and failure are owned immediately.
  internal.images.province = (...args) => {
    const loading = province(...args)
    loads.push(observe(loading))
    return loading
  }
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("province-loading.tjs","savedata/province-loading.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/province-loading.cjs")')
    } else await session.evaluate('Scripts.execStorage("province-loading.tjs")')
    const id = Number(await session.evaluate('layer.__id')),
      handles = session.snapshot().handles
    assert.equal(session.snapshot().bitmapBytes, 46)
    return {
      ...harness,
      id,
      handles,
      layers: internal.layers,
      loads,
      load: (name: string) => session.evaluate(`loadProvince(${JSON.stringify(name)})`),
      execute: (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`),
      async otherPlanesPreserved() {
        assert.equal(
          await session.evaluate('otherPlanes()'),
          [...Array.from({ length: 6 }, () => [0x123456, 74]).flat(), 1, 0, 1, 2].join(','),
        )
      },
      stopped() {
        assert.equal(session.snapshot().bitmapBytes, 0)
        assert.equal(session.snapshot().handles, 0)
        assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      },
      async stop() {
        await session.stop()
        assert.equal(session.snapshot().bitmapBytes, 0)
        assert.equal(session.snapshot().handles, 0)
        assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      },
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: loadProvinceImage tiles actual indexed PNG and BMP bytes to MainImage dimensions`, async () => {
    const f = await fixture(binary)
    try {
      for (const [name, expected] of [
        ['palette.png', [0, 1, 0, 0, 1, 0]],
        ['palette.bmp', [0, 251, 0, 0, 251, 0]],
      ] as const) {
        await f.load(name)
        assert.equal(await f.session.evaluate('loadResult'), 'void')
        assert.equal(await f.session.evaluate('provinceValues()'), expected.join(','))
        const province = f.layers.get(f.id).province
        assert.ok(province)
        assert.deepEqual([province.width, province.height, province.bytes], [3, 2, 6])
        assert.deepEqual([...province.data], [...expected])
        assert.equal(f.session.snapshot().bitmapBytes, 46)
        assert.equal(f.session.snapshot().handles, f.handles)
        assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
        await f.otherPlanesPreserved()
      }
      await f.execute('invalidate layer;')
      assert.equal(f.session.snapshot().bitmapBytes, 16)
      assert.equal(await f.session.evaluate('isvalid layer'), '0')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a suspended first province load owns a zero plane until its real indexed decode returns`, async () => {
    const gate = decoderGate(),
      f = await fixture(binary, gate.graphics)
    let loading: Promise<PromiseSettledResult<string>> | undefined
    try {
      await f.execute(
        'layer.setClip();layer.face=dfProvince;layer.fillRect(0,0,3,2,0);layer.setClip(1,0,1,2);layer.imageModified=false;',
      )
      assert.equal(f.layers.get(f.id).province, undefined)
      assert.equal(f.session.snapshot().bitmapBytes, 40)
      loading = observe(f.load('pending.bin'))
      await within(gate.entered, 'province decoder entry')
      assert.equal(gate.calls(), 1)
      assert.deepEqual([...f.layers.get(f.id).province!.data], [0, 0, 0, 0, 0, 0])
      assert.equal(f.layers.get(f.id).imageModified, true)
      assert.equal(f.session.snapshot().bitmapBytes, 46)
      gate.result.resolve(indexed())
      assert.equal((await within(loading, 'province load completion')).status, 'fulfilled')
      assert.equal(await f.session.evaluate('loadResult'), 'void')
      assert.equal(await f.session.evaluate('provinceValues()'), '7,19,7,7,19,7')
      assert.equal(f.session.snapshot().bitmapBytes, 46)
      assert.equal(f.session.snapshot().handles, f.handles)
      await f.otherPlanesPreserved()
    } finally {
      gate.result.resolve(indexed())
      await f.stop()
      if (loading) await loading
    }
  })

  test(`${mode}: an actual cached Font finalizer can load Province before Layer image release`, async () => {
    const gate = decoderGate(),
      f = await fixture(binary, gate.graphics)
    let retiring: Promise<PromiseSettledResult<string>> | undefined
    try {
      retiring = observe(f.session.evaluate('retireWithProvince()'))
      await within(gate.entered, 'province load inside the cached Font finalizer')
      assert.equal(f.session.inspectOwnership().closingLayers, 1)
      assert.equal(f.session.inspectOwnership().fontSources, 1)
      assert.equal(f.session.snapshot().bitmapBytes, 46)
      gate.result.resolve(indexed())
      const completed = await within(retiring, 'Layer invalidation after the Font load')
      assert.equal(completed.status, 'fulfilled')
      assert.equal(await f.session.evaluate('finalizerCalls+","+int(finalizerReturn)'), '1,1')
      assert.equal(await f.session.evaluate('finalizerProvince'), '7,19,7,7,19,7')
      assert.equal(
        await f.session.evaluate('finalizerOther'),
        [...Array.from({ length: 6 }, () => [0x123456, 74]).flat(), 1, 0, 1, 2].join(','),
      )
      assert.equal(await f.session.evaluate('(isvalid layer)+","+(isvalid retiringFont)'), '0,0')
      assert.equal(f.session.snapshot().bitmapBytes, 16)
      assert.equal(f.session.inspectOwnership().closingLayers, 0)
      assert.equal(f.session.inspectOwnership().fontSources, 0)
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      await f.execute('invalidate root;')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      assert.equal(f.session.inspectOwnership().layerSources, 0)
    } finally {
      gate.result.resolve(indexed())
      await f.stop()
      if (retiring) await retiring
    }
  })

  for (const [name, message] of [
    ['missing.png', /Image resource not found/],
    ['invalid.bmp', /Truncated BMP header/],
    ['oversized.bmp', /Province image size mismatch/],
  ] as const) {
    test(`${mode}: ${name} province-load failure removes the old plane while preserving main, mask and clip`, async () => {
      const f = await fixture(binary)
      try {
        await f.load(name)
        assert.equal(await f.session.evaluate('loadResult'), 'failed')
        assert.match(await f.session.evaluate('loadError'), message)
        assert.equal(await f.session.evaluate('provinceValues()'), '0,0,0,0,0,0')
        assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
        assert.equal(f.layers.get(f.id).province, undefined)
        assert.equal(f.session.snapshot().bitmapBytes, 40)
        await f.otherPlanesPreserved()
      } finally {
        await f.stop()
      }
    })
  }

  for (const outcome of ['resolve', 'reject'] as const) {
    test(`${mode}: a late ${outcome} cannot replace or clear a host-side province write made during decode`, async () => {
      const gate = decoderGate(),
        f = await fixture(binary, gate.graphics)
      let loading: Promise<PromiseSettledResult<string>> | undefined
      try {
        loading = observe(f.load('pending.bin'))
        await within(gate.entered, 'province decoder entry')
        assert.deepEqual([...f.layers.get(f.id).province!.data], [91, 0, 0, 0, 0, 92])
        // The VM serializes evaluate calls. Exercise an actual host-side plane
        // mutation while the real source/bytecode load is suspended; this does
        // not pretend a second TJS script can run concurrently in that VM.
        assert.equal(f.layers.setPixel(f.id, 1, 0, 173, 'province'), true)
        const newer = f.layers.get(f.id).province
        if (outcome === 'resolve') gate.result.resolve(indexed())
        else gate.result.reject(new Error('late province decode failure'))
        assert.equal(
          (await within(loading, 'obsolete province load completion')).status,
          'fulfilled',
        )
        assert.equal(await f.session.evaluate('loadResult'), 'failed')
        assert.match(
          await f.session.evaluate('loadError'),
          outcome === 'resolve'
            ? /Province image load destination changed/
            : /late province decode failure/,
        )
        assert.equal(f.layers.get(f.id).province, newer)
        assert.equal(await f.session.evaluate('provinceValues()'), '91,173,0,0,0,92')
        assert.equal(f.session.snapshot().bitmapBytes, 46)
        await f.otherPlanesPreserved()
      } finally {
        gate.result.resolve(indexed())
        await f.stop()
        if (loading) await loading
      }
    })

    test(`${mode}: Stop releases a suspended province load before a late decoder ${outcome}`, async () => {
      const gate = decoderGate(),
        f = await fixture(binary, gate.graphics)
      let loading: Promise<PromiseSettledResult<string>> | undefined
      try {
        loading = observe(f.load('pending.bin'))
        await within(gate.entered, 'province decoder entry')
        assert.equal(f.session.snapshot().bitmapBytes, 46)
        // Stop must complete while this external decoder remains unsettled.
        await within(f.session.stop(), 'Stop while province decoder is held')
        const cancelled = await within(loading, 'cancelled province invocation')
        assert.equal(cancelled.status, 'rejected')
        if (cancelled.status === 'rejected')
          assert.match(String(cancelled.reason), /Execution cancelled/)
        f.stopped()
        assert.equal(f.logs.includes('province-load-settled'), false)
        if (outcome === 'resolve') gate.result.resolve(indexed())
        else gate.result.reject(new Error('late stopped province decode failure'))
        assert.equal(f.loads.length, 1)
        const abandoned = await within(f.loads[0]!, 'the abandoned complete province loader')
        assert.equal(abandoned.status, 'rejected')
        if (abandoned.status === 'rejected')
          assert.match(
            String(abandoned.reason),
            outcome === 'resolve'
              ? /Image cache is disposed/
              : /late stopped province decode failure/,
          )
        f.stopped()
        assert.equal(f.logs.includes('province-load-settled'), false)
      } finally {
        gate.result.resolve(indexed())
        await f.stop()
        if (loading) await loading
        await Promise.all(f.loads)
      }
    })
  }
}
