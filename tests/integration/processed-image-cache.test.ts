import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { headless } from '../helpers/headless.ts'
import { cacheBmp, processedCacheFiles, processedCacheSource } from '../helpers/processed-cache-fixtures.ts'
import { imageFixture } from '../helpers/image-fixtures.ts'
import { inflateImage } from '../../src/backends/files/blob-source.ts'

async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof headless>>, reads: Map<string, number>) => Promise<void>,
  overrides: Partial<SessionDependencies> = {}, extra: Record<string, string | Uint8Array> = {}) {
  const f = await headless({}, overrides), reads = new Map<string, number>(), failures: unknown[] = [],
    files: Record<string, string | Uint8Array> = { ...processedCacheFiles(), ...extra, 'cache.tjs': processedCacheSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("cache.tjs","savedata/cache.cjs",false,true,false);Scripts.execStorage("savedata/cache.cjs");'
        : 'Scripts.execStorage("cache.tjs");' }
  f.session.mount(Object.entries(files).map(([name, value]) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    return { name, size: bytes.length, cacheToken: {},
      source: { size: bytes.length, read: async (offset: number, length: number) => bytes.slice(offset, offset + length) },
      read: async () => {
      reads.set(name, (reads.get(name) ?? 0) + 1); return bytes
    } }
  }))
  try {
    await f.session.start()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/cache.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    await run(f, reads)
  } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().imageCacheBytes, 0)
    assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Processed cache scenario or cleanup failed', { cause: failures[0] })
}
const exec = (f: Awaited<ReturnType<typeof headless>>, source: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: processed hits reuse completed masks and province planes with private metadata and key-specific results`, { timeout: 60000 }, async () => {
    await using(binary, async (f, reads) => {
      await exec(f, 'var tags=cacheImage.loadImages("hero");tags.offs_x="poisoned";cacheImage.setMainPixel(0,0,0);')
      const first = ['hero.png', 'hero_m.png', 'hero_p.png'].map((name) => reads.get(name))
      assert.deepEqual(first, [1, 1, 1])
      assert.equal(f.session.snapshot().imageCacheBytes, 10, 'finished normal RGBA 8 plus province indices 2')
      assert.equal(f.session.snapshot().imageCacheEntries, 2, 'mask is not a separate cached image')
      assert(f.session.snapshot().imageCacheResidentBytes > f.session.snapshot().imageCacheBytes)
      await exec(f, 'var fresh=cacheImage.loadImages("hero");')
      assert.equal(await f.session.evaluate('fresh.offs_x=="12" && cacheImage.getMainPixel(0,0)==0xc86432 && cacheImage.getMaskPixel(1,0)==128 && cacheImage.getProvincePixel(1,0)==1'), '1')
      assert.deepEqual(['hero.png', 'hero_m.png', 'hero_p.png'].map((name) => reads.get(name)), first)
      await f.session.evaluate('cacheColor("hero.png")')
      assert.deepEqual(['hero.png', 'hero_m.png', 'hero_p.png'].map((name) => reads.get(name)), [2, 2, 1], 'request alias is an independent normal key')
      await f.session.evaluate('cacheColor("a.bmp",0x112233)')
      assert.equal(await f.session.evaluate('cacheImage.getMaskPixel(0,0)'), '0')
      await f.session.evaluate('cacheColor("a.bmp")')
      assert.equal(await f.session.evaluate('cacheImage.getMaskPixel(0,0)'), '255')
      assert.equal(reads.get('a.bmp'), 2)
    })
  })
  test(`${mode}: AutoPath changes preserve processed hits until explicit graphic clearing`, { timeout: 60000 }, async () => {
    await using(binary, async (f, reads) => {
      await exec(f, 'Storages.addAutoPath("base/");')
      assert.equal(await f.session.evaluate('cacheColor("scene")'), String(0xff0000))
      await exec(f, 'Storages.addAutoPath("patch/");')
      assert.equal(await f.session.evaluate('Storages.getPlacedPath("scene.bmp")'), 'game://./patch/scene.bmp')
      assert.equal(await f.session.evaluate('cacheColor("scene")'), String(0xff0000))
      assert.equal(reads.get('patch/scene.bmp'), undefined)
      await exec(f, 'System.clearGraphicCache();')
      assert.equal(await f.session.evaluate('cacheColor("scene")'), String(0x00ff00))
      await exec(f, 'Storages.removeAutoPath("patch/");')
      assert.equal(await f.session.evaluate('cacheColor("scene")'), String(0x00ff00))
      await exec(f, 'System.clearGraphicCache();')
      assert.equal(await f.session.evaluate('cacheColor("scene")'), String(0xff0000))
      assert.equal(reads.get('base/scene.bmp'), 2)
      assert.equal(reads.get('patch/scene.bmp'), 1)
    })
  })
  test(`${mode}: a graphic hit does not rebuild a newly corrupt AutoPath archive`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      await f.session.evaluate('cacheColor("a.bmp")')
      f.session.pause(); await f.session.importSaves([{ path: 'bad.xp3', bytes: Uint8Array.of(1, 2, 3) }]); f.session.resume()
      await exec(f, 'Storages.addAutoPath("bad.xp3>");')
      const misses = f.session.snapshot().imageCacheMisses
      assert.equal(await f.session.evaluate('cacheColor("a.bmp")'), String(0x112233))
      assert.equal(f.session.snapshot().imageCacheMisses, misses)
      await exec(f, 'System.clearGraphicCache();')
      assert.notEqual(await f.session.evaluate('cacheFailure("a.bmp")'), 'NO_ERROR', 'companion discovery on a miss must rebuild the corrupt registered archive')
    })
  })
  test(`${mode}: province and actual universal-rule dimensions create separate packed processed entries`, { timeout: 60000 }, async () => {
    await using(binary, async (f, reads) => {
      await exec(f, 'cacheImage.setImageSize(3,2);cacheImage.loadProvinceImage("province.png");')
      assert.equal(f.session.snapshot().imageCacheBytes, 6)
      await exec(f, 'cacheImage.setImageSize(5,2);cacheImage.loadProvinceImage("province.png");')
      assert.equal(f.session.snapshot().imageCacheBytes, 16)
      assert.equal(f.session.snapshot().imageCacheEntries, 2)
      assert.equal(await f.session.evaluate('cacheImage.getProvincePixel(3,1)+","+cacheImage.getProvincePixel(4,1)'), '1,0')
      await exec(f, 'cacheImage.loadProvinceImage("province.png");cacheBack.setImageSize(5,2);cacheImage.beginTransition("universal",false,cacheBack,%[rule:"province.png",time:1000,selfupdate:true]);cacheImage.stopTransition();')
      assert.equal(f.session.snapshot().imageCacheBytes, 26)
      assert.equal(f.session.snapshot().imageCacheEntries, 3)
      assert.equal(reads.get('province.png'), 3)
    })
  })
  test(`${mode}: preload duplicate hits consume output bytes and do not begin the next list item`, { timeout: 60000 }, async () => {
    await using(binary, async (f, reads) => {
      await exec(f, 'System.graphicCacheLimit=64;System.touchImages(["a","a","b"],8);')
      assert.equal(f.session.snapshot().imageCacheBytes, 4)
      assert.equal(f.session.snapshot().imageCacheEntries, 1)
      assert.equal(reads.get('a.bmp'), 1)
      assert.equal(reads.get('b.bmp'), undefined)
      assert.equal(f.session.snapshot().imageCacheHits, 1)
    })
  })
  test(`${mode}: successful main and oversized province entries survive the outer Layer failure independently`, { timeout: 60000 }, async () => {
    await using(binary, async (f, reads) => {
      assert.notEqual(await f.session.evaluate('cacheFailure("failed.bmp")'), 'NO_ERROR')
      assert.equal(f.session.snapshot().imageCacheBytes, 8)
      assert.equal(f.session.snapshot().imageCacheEntries, 1)
      assert.equal(await f.session.evaluate('cacheImage.getMainPixel(0,0)'), String(0x123456))
      assert.notEqual(await f.session.evaluate('cacheFailure("failed.bmp")'), 'NO_ERROR')
      assert.equal(reads.get('failed.bmp'), 1)
      assert.equal(reads.get('failed_p.bmp'), 2)
      await exec(f, 'System.clearGraphicCache();')
      assert.notEqual(await f.session.evaluate('cacheFailure("oversized.bmp")'), 'NO_ERROR')
      assert.equal(f.session.snapshot().imageCacheBytes, 6, 'main RGBA 4 and successfully decoded oversized plane 2')
      assert.equal(f.session.snapshot().imageCacheEntries, 2)
      assert.notEqual(await f.session.evaluate('cacheFailure("oversized.bmp")'), 'NO_ERROR')
      assert.equal(reads.get('oversized.bmp'), 1)
      assert.equal(reads.get('oversized_p.png'), 1)
    })
  })
  test(`${mode}: validated image-save open clears unrelated images before an encoder failure, while invalid format preserves the cache`, { timeout: 60000 }, async () => {
    await using(binary, async (f, reads) => {
      f.session.pause(); await f.session.importSaves([{ path: 'savedata/keep.png', bytes: Uint8Array.of(7, 8, 9) }]); f.session.resume()
      await exec(f, 'System.touchImages(["a.bmp","b.bmp"]);')
      assert.equal(f.session.snapshot().imageCacheEntries, 2)
      assert.equal(await f.session.evaluate('(function(){try{cacheImage.saveLayerImage("savedata/nope","bad-mode");}catch(e){return true;}return false;})()'), '1')
      assert.equal(f.session.snapshot().imageCacheEntries, 2)
      assert.equal(await f.session.evaluate('(function(){try{cacheImage.saveLayerImage("savedata/keep.png","png");}catch(e){return e.message;}return "NO_ERROR";})()'), 'controlled PNG encoder failure')
      assert.equal(f.session.snapshot().imageCacheEntries, 0)
      assert.deepEqual([...f.session.exportSaves().find((file) => file.path === 'savedata/keep.png')!.bytes], [7, 8, 9])
      await f.session.evaluate('cacheColor("a.bmp")')
      assert.equal(reads.get('a.bmp'), 2)
    }, { deflateImage: async () => { throw new Error('controlled PNG encoder failure') } })
  })
  test(`${mode}: immutable save mutation invalidates affected requests and dropped namespace publication clears old graphics`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      await exec(f, 'System.touchImages(["stem","b.bmp"]);')
      assert.equal(f.session.snapshot().imageCacheEntries, 2)
      f.session.pause(); await f.session.importSaves([{ path: 'notes.txt', bytes: Uint8Array.of(1) }]); f.session.resume()
      assert.equal(f.session.snapshot().imageCacheEntries, 2)
      f.session.pause(); await f.session.importSaves([{ path: 'stem.png', bytes: imageFixture('main.png') }]); f.session.resume()
      assert.equal(f.session.snapshot().imageCacheEntries, 1)
      assert.equal(await f.session.evaluate('cacheColor("stem")'), String(0xc86432))
      const bytes = cacheBmp(0xabcdef)
      let droppedReads = 0
      const names = await f.session.commitDroppedResources({ roots: [{ name: 'new.bmp', kind: 'file' }],
        entries: [{ root: 0, path: '', kind: 'file', source: { size: bytes.length, async read(offset, length) {
          droppedReads++; return bytes.subarray(offset, offset + length)
        } } }] }, () => true)
      assert.equal(droppedReads, 0, 'new capability publication is not a payload read')
      assert.equal(f.session.snapshot().imageCacheEntries, 0)
      assert.equal(await f.session.evaluate(`cacheColor(${JSON.stringify(names[0])})`), String(0xabcdef))
      assert.equal(droppedReads, 1)
    })
  })
  test(`${mode}: a replaced PNG cannot refill the processed cache after its paused decoder settles`, { timeout: 60000 }, async () => {
    let enter!: () => void, release!: () => void, held = false
    const entered = new Promise<void>((done) => { enter = done }), gate = new Promise<void>((done) => { release = done })
    try {
      await using(binary, async (f) => {
        const pending = f.session.evaluate('cacheColor("pending.png")').then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }))
        try {
          await Promise.race([entered, pending.then((result) => { throw new Error('PNG load settled before its gate: ' + result.status) })])
          f.session.pause()
          await f.session.importSaves([{ path: 'pending.png', bytes: imageFixture('mask.png') }])
          release(); f.session.resume()
          const completed = await pending
          assert.equal(completed.status, 'fulfilled')
          if (completed.status === 'fulfilled') assert.equal(completed.value, String(0xc86432))
          assert.equal(f.session.snapshot().imageCacheEntries, 0)
          assert.equal(await f.session.evaluate('cacheColor("pending.png")'), '0')
          assert.equal(f.session.snapshot().imageCacheEntries, 1)
        } finally { release() }
      }, { async inflateImage(bytes, length) {
        if (!held) { held = true; enter(); await gate }
        return inflateImage(bytes, length)
      } }, { 'pending.png': imageFixture('main.png') })
    } finally { release() }
  })
}
