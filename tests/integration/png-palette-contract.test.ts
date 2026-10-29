import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { paletteFiles, paletteRgba, packedKeyRgba, paletteGray } from '../helpers/png-palette-contract.ts'

const source = String.raw`
System.exitOnWindowClose=false;
System.assignMessage("TVPPNGLoadError","palette-png:%1");
var paletteWindow=new Window();paletteWindow.caption="PNG palette contract";paletteWindow.setInnerSize(4,6);paletteWindow.visible=true;
var paletteRoot=new Layer(paletteWindow,null);paletteWindow.add(paletteRoot);paletteRoot.type=ltOpaque;
paletteRoot.setSize(4,6);paletteRoot.fillRect(0,0,4,6,0xff000000);
var paletteImage=new Layer(paletteWindow,paletteRoot);paletteImage.type=ltOpaque;paletteImage.setSize(4,3);paletteImage.visible=true;
var paletteCopy=new Layer(paletteWindow,paletteRoot);paletteCopy.setSize(4,3);paletteCopy.visible=false;
function paletteLoad(target,name,key){try{target.loadImages(name,key);return "ok";}catch(error){return error.message;}}
function paletteBytes(target){
  var bytes=[];for(var y=0;y<3;y++)for(var x=0;x<4;x++){
    var c=target.getMainPixel(x,y);bytes.add((c>>16)&255);bytes.add((c>>8)&255);bytes.add(c&255);bytes.add(target.getMaskPixel(x,y));
  }return bytes.join(",");
}
`

async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof headless>>, reads: Map<string, number>,
  frames: { id: number; width: number; height: number; data: number[] }[][]) => Promise<void>) {
  const reads = new Map<string, number>(), frames: { id: number; width: number; height: number; data: number[] }[][] = [],
    f = await headless({}, { renderer: { present(layers) {
      frames.push(layers.map(({ id, pixels }) => ({ id, width: pixels.width, height: pixels.height, data: [...pixels.data] })))
    }, dispose() {} } }), failures: unknown[] = [],
    files: Record<string, string | Uint8Array> = { ...paletteFiles(), 'palette.tjs': source,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("palette.tjs","savedata/palette.cjs",false,true,false);Scripts.execStorage("savedata/palette.cjs");'
        : 'Scripts.execStorage("palette.tjs");' }
  f.session.mount(Object.entries(files).map(([name, value]) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    return { name, size: bytes.length, cacheToken: {}, async read() {
      reads.set(name, (reads.get(name) ?? 0) + 1); return bytes
    } }
  }))
  try {
    await f.session.start()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/palette.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    await run(f, reads, frames)
  } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().bitmapBytes, 0)
    assert.equal(f.session.snapshot().imageCacheBytes, 0)
    assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'PNG palette consumer or cleanup failed', { cause: failures[0] })
}
const opaqueRgba = paletteRgba.map((value, index) => index % 4 === 3 ? 255 : value)
const maskRgba = (values: readonly number[]) => values.flatMap((alpha, index) =>
  index % 4 === 0 ? [17, 34, 51, alpha] : [200, 100, 50, alpha])

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: palette tRNS survives all key indices and Adam7 through independent cache destinations`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads, frames) => {
      const id = Number(await session.evaluate('paletteImage.__id'))
      let entries = 0
      for (const name of ['alpha.png', 'alpha-adam7.png']) for (const key of ['clNone', 'clPalIdx+0', 'clPalIdx+1', 'clPalIdx+255']) {
        assert.equal(await session.evaluate(`paletteLoad(paletteImage,"${name}",${key})`), 'ok')
        assert.equal(await session.evaluate('paletteBytes(paletteImage)'), paletteRgba.join(','))
        assert.equal(session.snapshot().imageCacheEntries, ++entries, 'Every explicit color key is a separate processed request')
        const hits = session.snapshot().imageCacheHits
        assert.equal(await session.evaluate(`paletteLoad(paletteCopy,"${name}",${key})`), 'ok')
        assert.equal(session.snapshot().imageCacheHits, hits + 1)
        await session.evaluate('(paletteImage.setMainPixel(1,0,0xabcdef),paletteImage.setMaskPixel(1,0,222),0)')
        assert.equal(await session.evaluate('paletteBytes(paletteCopy)'), paletteRgba.join(','), 'Cache replay owns a separate destination')
        assert.equal(await session.evaluate(`paletteLoad(paletteImage,"${name}",${key})`), 'ok')
        assert.equal(await session.evaluate('paletteBytes(paletteImage)'), paletteRgba.join(','))
        assert.deepEqual(frames.at(-1)!.find((layer) => layer.id === id), { id, width: 4, height: 3, data: [...paletteRgba] })
      }
      assert.equal(reads.get('alpha.png'), 4); assert.equal(reads.get('alpha-adam7.png'), 4)
    })
  })
  test(`${mode}: no-tRNS palette keys retain the native packed prefix and only the Web-defined zero tail`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads) => {
      let entries = 0
      for (const name of ['opaque.png', 'opaque-adam7.png']) for (const key of ['clNone', 'clPalIdx+0', 'clPalIdx+1', 'clPalIdx+255']) {
        const expected = key === 'clNone' ? opaqueRgba : packedKeyRgba
        assert.equal(await session.evaluate(`paletteLoad(paletteImage,"${name}",${key})`), 'ok')
        assert.equal(await session.evaluate('paletteBytes(paletteImage)'), expected.join(','))
        assert.equal(session.snapshot().imageCacheEntries, ++entries)
        const hits = session.snapshot().imageCacheHits
        assert.equal(await session.evaluate(`paletteLoad(paletteCopy,"${name}",${key})`), 'ok')
        assert.equal(session.snapshot().imageCacheHits, hits + 1)
        await session.evaluate('(paletteImage.setMainPixel(0,0,0),paletteImage.setMaskPixel(0,0,255),0)')
        assert.equal(await session.evaluate('paletteBytes(paletteCopy)'), expected.join(','))
        assert.equal(await session.evaluate(`paletteLoad(paletteImage,"${name}",${key})`), 'ok')
        assert.equal(await session.evaluate('paletteBytes(paletteImage)'), expected.join(','))
      }
      assert.equal(reads.get('opaque.png'), 4); assert.equal(reads.get('opaque-adam7.png'), 4)
    })
  })
  test(`${mode}: palette tRNS mask uses the original byte-stride grayscale and never binds its incomplete final row`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads, frames) => {
      assert.equal(await session.evaluate('paletteLoad(paletteImage,"masked.bmp",clNone)'), 'ok')
      assert.equal(await session.evaluate('paletteBytes(paletteImage)'), maskRgba(paletteGray).join(','))
      assert.equal(session.snapshot().imageCacheEntries, 1)
      const hits = session.snapshot().imageCacheHits
      assert.equal(await session.evaluate('paletteLoad(paletteCopy,"masked.bmp",clNone)'), 'ok')
      assert.equal(session.snapshot().imageCacheHits, hits + 1)
      assert.equal(await session.evaluate('paletteBytes(paletteCopy)'), maskRgba(paletteGray).join(','))
      await session.evaluate('(System.clearGraphicCache(),0)')
      for (let attempt = 1; attempt <= 2; attempt++) {
        const before = frames.length
        assert.equal(await session.evaluate('paletteLoad(paletteImage,"masked-bad.bmp",clNone)'), 'palette-png:IDAT: CRC error')
        assert.equal(await session.evaluate('paletteBytes(paletteImage)'), maskRgba([...paletteGray.slice(0, 8), 255, 255, 255, 255]).join(','))
        assert.equal(frames.length, before, 'A failed mask does not request final Update')
        assert.equal(session.snapshot().imageCacheEntries, 0)
        assert.equal(reads.get('masked-bad.bmp'), attempt); assert.equal(reads.get('masked-bad_m.png'), attempt)
      }
      assert.equal(await session.evaluate('paletteBytes(paletteCopy)'), maskRgba(paletteGray).join(','))
    })
  })
  test(`${mode}: palette raw row and read-end errors retain only native-published bytes without successful cache insertion`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads, frames) => {
      for (const [name, expected, phase] of [
        ['alpha-bad-row.png', paletteRgba, 'IDAT'], ['opaque-bad-row.png', packedKeyRgba, 'IDAT'],
        ['alpha-tail.png', paletteRgba, 'IEND'], ['alpha-adam7-tail.png', Array(48).fill(0), 'IEND'],
      ] as const) for (let attempt = 1; attempt <= 2; attempt++) {
        const before = frames.length
        assert.equal(await session.evaluate(`paletteLoad(paletteImage,"${name}",clPalIdx+1)`), `palette-png:${phase}: CRC error`)
        assert.equal(await session.evaluate('paletteBytes(paletteImage)'), expected.join(','))
        assert.equal(frames.length, before, 'A failed decode does not request final Update')
        assert.equal(session.snapshot().imageCacheEntries, 0)
        assert.equal(reads.get(name), attempt, 'Failed processed data must be decoded again')
      }
    })
  })
}
