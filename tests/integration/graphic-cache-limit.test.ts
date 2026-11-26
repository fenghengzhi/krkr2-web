import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { solidBmp } from '../helpers/archive-patch.ts'

const program = `
var galleryWindow=new Window(),galleryImage=new Layer(galleryWindow,null);
function galleryLoad(name){galleryImage.loadImages(name);return galleryImage.getMainPixel(0,0);}
`
const mib = 1024 * 1024

async function gallery(option: string, binary: boolean) {
  const project = { executableDirectory: 'Disc/', directory: 'Disc/data/' }
  const harness = await headless({
    'Disc/Novel.exe': new Uint8Array([77, 90]), 'Disc/Novel.cf': 'gclim=4',
    'Disc/savedata/Novel.cfu': 'gclim=' + option,
    'Disc/data/gallery.tjs': program, 'Disc/data/a.bmp': solidBmp(0xff0000),
    'Disc/data/b.bmp': solidBmp(0x00ff00), 'Disc/data/c.bmp': solidBmp(0x0000ff),
    'Disc/data/startup.tjs': binary
      ? 'Scripts.compileStorage("gallery.tjs",System.dataPath+"gallery.cjs",false,true,false);Scripts.execStorage(System.dataPath+"gallery.cjs");'
      : 'Scripts.execStorage("gallery.tjs");',
  }, { project, now: () => 500 })
  return harness.session
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: a zero cache ceiling distinguishes disabled loading, native automatic caching and preloading`, async (t) => {
    const s = await gallery('0', binary)
    t.after(() => s.stop())
    await s.start()
    const run = (code: string) => s.evaluate(code)
    const counts = () => {
      const state = s.snapshot()
      return [state.imageCacheEntries, state.imageCacheHits, state.imageCacheMisses]
    }
    assert.equal(await run('System.graphicCacheLimit'), '0')
    await run('(System.touchImages(["a.bmp"]),galleryLoad("a.bmp"),galleryLoad("a.bmp"))')
    assert.deepEqual(counts(), [0, 0, 2])
    assert.equal(await run('(System.graphicCacheLimit=gcsAuto,System.graphicCacheLimit)'), '0')
    await run('(System.touchImages(["a.bmp","b.bmp"]),0)')
    assert.deepEqual(counts(), [0, 0, 2])
    assert.equal(await run('galleryLoad("a.bmp")'), String(0xff0000))
    assert.deepEqual(counts(), [1, 0, 3])
    await run('galleryLoad("a.bmp")')
    assert.deepEqual(counts(), [1, 1, 3])
    assert.equal(await run('galleryLoad("b.bmp")'), String(0x00ff00))
    await run('galleryLoad("a.bmp")')
    assert.deepEqual(counts(), [1, 1, 5])
    await run('(System.graphicCacheLimit=0,galleryLoad("a.bmp"))')
    assert.deepEqual(counts(), [0, 1, 6])
    await run('(System.graphicCacheLimit=4096,galleryLoad("c.bmp"),galleryLoad("c.bmp"))')
    assert.deepEqual(counts(), [1, 2, 7])
    assert.equal(await run('System.graphicCacheLimit'), '0')
  })

  test(`${mode}: startup ceilings, property narrowing and preload arguments use separate 32-bit and 64-bit units`, async (t) => {
    const s = await gallery('0x80', binary)
    t.after(() => s.stop())
    await s.start()
    const run = (code: string) => s.evaluate(code)
    assert.equal(await run('System.getArgument("-gclim")'), '0x80')
    assert.equal(await run('System.graphicCacheLimit'), '0')
    for (const [input, actual] of [['gcsAuto', 128 * mib], ['0x100000001', 1], ['0x100000000', 0], ['-2', 128 * mib]] as const)
      assert.equal(await run(`(System.graphicCacheLimit=${input},System.graphicCacheLimit)`), String(actual))
    await run('(System.setArgument("-gclim","1"),System.graphicCacheLimit=gcsAuto,0)')
    assert.equal(s.snapshot().imageCacheLimit, 128 * mib)
    await run('(System.touchImages(["a.bmp","b.bmp"],0,-1),0)')
    assert.equal(s.snapshot().imageCacheMisses, 0)
    await run('(System.touchImages(["a.bmp","b.bmp"],0x100000001),0)')
    assert.equal(s.snapshot().imageCacheMisses, 1)
    await run('(System.touchImages(["b.bmp"],0,0x10000000000),0)')
    assert.equal(s.snapshot().imageCacheEntries, 2)
    assert.equal(await run('galleryLoad("b.bmp")'), String(0x00ff00))
    assert.equal(s.snapshot().imageCacheHits, 1)
  })
}

test('graphicCacheLimit exposes a signed getter for an unsigned system ceiling', async (t) => {
  const s = await gallery('4095', false)
  t.after(() => s.stop())
  await s.start()
  assert.equal(await s.evaluate('(System.graphicCacheLimit=gcsAuto,System.graphicCacheLimit)'), String(-mib))
  assert.equal(s.snapshot().imageCacheLimit, 4095 * mib)
  assert.equal(await s.evaluate('(System.graphicCacheLimit=0x80000000,System.graphicCacheLimit)'), '-2147483648')
  assert.equal(s.snapshot().imageCacheResidentBytes, 0)
})
