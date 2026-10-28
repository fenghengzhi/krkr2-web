import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecodedImage } from '../../src/engine/ports/graphics.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import type { ImageDecodeSelection } from '../../src/formats/image/selection.ts'
import { ImageLoader, ProvinceImageLoadError } from '../../src/engine/storage/images.ts'
import { noColorKey } from '../../src/engine/graphics/loading.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'

async function finish<T>(work: Generator<void, T>): Promise<T> {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
const pixels = (value: number): DecodedImage => ({
  width: 1, height: 1, data: Uint8Array.of(value, value, value, 255), indices: Uint8Array.of(value),
})
function fixture(entries: readonly (readonly [string, number, string?])[], options: {
  normalize?: (name: string) => string
  decode?: (value: number, selection: ImageDecodeSelection) => Promise<DecodedImage>
  find?: (name: string) => void
  check?: () => void
  finish?: typeof finish
} = {}) {
  const queries: string[] = [], reads: string[] = [], events: string[] = [],
    selections: ImageDecodeSelection[] = [], resources = new Map<string, Resource>()
  for (const [name, value, canonical] of entries) resources.set(name, {
    name: canonical ?? name, cacheToken: {}, size: 1,
    read: async () => { reads.push(name); events.push('read:' + name); return Uint8Array.of(value) },
  })
  const loader = new ImageLoader(
    async (name) => { queries.push(name); events.push('find:' + name); options.find?.(name); return resources.get(name) },
    async (bytes, selection) => {
      selections.push(selection); events.push('decode:' + bytes[0] + ':' + selection.mode)
      return options.decode ? options.decode(bytes[0]!, selection) : pixels(bytes[0]!)
    },
    options.finish ?? finish, { now: () => 0, check: options.check ?? (() => {}), yield: async () => {} }, options.normalize,
  )
  return { loader, queries, reads, events, selections, resources }
}
function message(id: string, name: string) {
  return (error: unknown) => {
    assert.ok(error instanceof TvpError)
    assert.deepEqual(error.tvpMessage, { id, args: [name] })
    return true
  }
}

test('all ten native suffixes select their own handler with ASCII case folding', async () => {
  const cases = [
    ['.bmp', 'bmp'], ['.dib', 'bmp'], ['.jpeg', 'jpeg'], ['.jpg', 'jpeg'], ['.jif', 'jpeg'],
    ['.png', 'png'], ['.eri', 'eri'], ['.tlg', 'tlg'], ['.tlg5', 'tlg'], ['.tlg6', 'tlg'],
  ] as const
  for (const [suffix, format] of cases) {
    const name = 'scene' + suffix.toUpperCase(), f = fixture([[name, 7]])
    assert.equal((await f.loader.load(name, noColorKey)).image.data[0], 7)
    assert.deepEqual(f.selections, [{ format, mode: 'normal' }])
    assert.deepEqual(f.reads, [name])
  }
})

test('extension suggestion chooses the original reverse-registration priority ahead of a bare file', async () => {
  const f = fixture([
    ['hero', 99], ['hero.bmp', 1], ['hero.dib', 2], ['hero.jpeg', 3], ['hero.jpg', 4],
    ['hero.jif', 5], ['hero.png', 6], ['hero.eri', 7], ['hero.tlg', 8], ['hero.tlg5', 9], ['hero.tlg6', 10],
  ])
  const loaded = await f.loader.load('hero', noColorKey)
  assert.equal(loaded.image.data[0], 10)
  assert.equal(f.queries[0], 'hero.tlg6')
  assert.equal(f.queries.includes('hero'), false)
  assert.deepEqual(f.reads, ['hero.tlg6'])
  assert.deepEqual(f.selections, [{ format: 'tlg', mode: 'normal' }])
})

test('unknown explicit suffixes fail with the normalized request before any existence query or read', async () => {
  const f = fixture([['game://./art/scene.data', 7]], { normalize: (name) => 'game://./art/' + name })
  for (const suffix of ['data', 'gif', 'webp'])
    await assert.rejects(f.loader.load('scene.' + suffix, noColorKey),
      message('TVPUnknownGraphicFormat', 'game://./art/scene.' + suffix))
  assert.deepEqual(f.queries, [])
  assert.deepEqual(f.reads, [])
})

test('an extensionless bare resource cannot satisfy suggestion and all native candidates are tried in order', async () => {
  const f = fixture([['hero', 7]])
  await assert.rejects(f.loader.load('hero', noColorKey), message('TVPCannotSuggestGraphicExtension', 'hero'))
  assert.deepEqual(f.queries, [
    'hero.tlg6', 'hero.tlg5', 'hero.tlg', 'hero.eri', 'hero.png',
    'hero.jif', 'hero.jpg', 'hero.jpeg', 'hero.dib', 'hero.bmp',
  ])
  assert.deepEqual(f.reads, [])
})

test('a missing recognized image retains the storage-open message and performs no suffix fallback', async () => {
  const f = fixture([['hero.bmp', 7]])
  await assert.rejects(f.loader.load('hero.png', noColorKey), message('TVPCannotOpenStorage', 'hero.png'))
  assert.deepEqual(f.queries, ['hero.png'])
  assert.deepEqual(f.reads, [])
})

test('a higher-priority archive lookup failure is not swallowed to choose a later format', async () => {
  const cause = new Error('Archive index corrupt'), f = fixture([['hero.png', 7]], {
    find(name) { if (name === 'hero.tlg6') throw cause },
  })
  await assert.rejects(f.loader.load('hero', noColorKey), (error: unknown) => error === cause)
  assert.deepEqual(f.queries, ['hero.tlg6'])
  assert.deepEqual(f.reads, [])
})

test('companions use the normalized caller stem and province discovery precedes the selected mask read', async () => {
  const f = fixture([
    ['game://./scene.png', 20, 'patch.xp3>pictures/different.png'],
    ['game://./scene_p.bmp', 3, 'province.xp3>other.bmp'],
    ['game://./scene_m.png', 128, 'masks.xp3>mask.png'],
    ['game://./scene_m.tlg6', 9],
  ], { normalize: (name) => 'game://./' + name })
  const loaded = await f.loader.load('scene.png', noColorKey)
  assert.deepEqual([...loaded.image.data], [20, 20, 20, 128])
  assert.deepEqual([...loaded.province!], [3])
  assert.deepEqual(f.reads, ['game://./scene.png', 'game://./scene_m.png', 'game://./scene_p.bmp'])
  assert.deepEqual(f.selections, [
    { format: 'png', mode: 'normal' }, { format: 'png', mode: 'grayscale' }, { format: 'bmp', mode: 'palettized' },
  ])
  assert.ok(f.events.indexOf('decode:20:normal') < f.events.indexOf('find:game://./scene_p.bmp'))
  assert.ok(f.events.indexOf('find:game://./scene_p.bmp') < f.events.indexOf('read:game://./scene_m.png'))
  assert.equal(f.queries.some((name) => name.includes('different') || name.includes('.xp3>')), false)
})

test('an inferred main suffix gives the mask no preference, while an explicit suffix is tried first', async () => {
  for (const [request, alpha, format] of [['scene', 128, 'png'], ['scene.bmp', 13, 'bmp']] as const) {
    const f = fixture([['scene.bmp', 20], ['scene_m.png', 128], ['scene_m.bmp', 13]])
    assert.equal((await f.loader.load(request, noColorKey)).image.data[3], alpha)
    assert.deepEqual(f.selections.at(-1), { format, mode: 'grayscale' })
  }
})

test('province size diagnostics retain the normalized selected name rather than its placed archive identity', async () => {
  const f = fixture([
    ['game://./scene.png', 20, 'images.xp3>main.png'],
    ['game://./scene_p.png', 9, 'patch.xp3>different.png'],
  ], {
    normalize: (name) => 'game://./' + name,
    decode: async (value) => value === 9
      ? { width: 2, height: 1, data: new Uint8Array(8), indices: Uint8Array.of(1, 2) }
      : pixels(value),
  })
  await assert.rejects(f.loader.load('scene.png', noColorKey), (error: unknown) => {
    assert.ok(error instanceof ProvinceImageLoadError)
    assert.ok(error.cause instanceof TvpError)
    assert.deepEqual(error.cause.tvpMessage, { id: 'TVPProvinceSizeMismatch', args: ['game://./scene_p.png'] })
    assert.deepEqual([...error.image.data], [20, 20, 20, 255])
    return true
  })
})

test('an absent preferred mask suffix falls back through the full registered order', async () => {
  const f = fixture([['scene.bmp', 20], ['scene_m.png', 128], ['scene_m.jpeg', 13]])
  assert.equal((await f.loader.load('scene.bmp', noColorKey)).image.data[3], 128)
  const start = f.queries.indexOf('scene_m.bmp')
  assert.deepEqual(f.queries.slice(start), [
    'scene_m.bmp', 'scene_m.tlg6', 'scene_m.tlg5', 'scene_m.tlg', 'scene_m.eri', 'scene_m.png',
  ])
})

test('touch discovers province names without reading pixels and still validates the mask before continuing', async () => {
  let maskFailures = 0
  const f = fixture([['scene.png', 20], ['scene_p.bmp', 3], ['scene_m.png', 128], ['next.png', 9]], {
    decode: async (value) => value === 128 ? { width: 2, height: 1, data: new Uint8Array(8) } : pixels(value),
    async finish<T>(work: Generator<void, T>): Promise<T> {
      try { return await finish(work) }
      catch (error) {
        if (error instanceof TvpError && error.tvpMessage.id === 'TVPMaskSizeMismatch') maskFailures++
        throw error
      }
    },
  })
  await f.loader.touch(['scene.png', 'next.png'])
  assert.equal(maskFailures, 1)
  assert.ok(f.queries.includes('scene_p.bmp'))
  assert.deepEqual(f.reads, ['scene.png', 'scene_m.png', 'next.png'])
  assert.deepEqual(f.selections.map((selection) => selection.mode), ['normal', 'grayscale', 'normal'])
  await assert.rejects(f.loader.load('scene.png', noColorKey), (error: unknown) =>
    error instanceof TvpError && error.tvpMessage.id === 'TVPMaskSizeMismatch')
  assert.equal(f.reads.includes('scene_p.bmp'), false)
})

test('preload budget exhaustion finishes the current mask and does not start the next image', async () => {
  const f = fixture([['scene.png', 20], ['scene_m.png', 128], ['next.png', 9]])
  f.loader.setLimit(5) // A one-pixel fixture includes its one-byte palette index.
  await f.loader.touch(['scene.png', 'next.png'])
  assert.deepEqual(f.reads, ['scene.png', 'scene_m.png'])
  assert.equal(f.queries.includes('next.png'), false)
  assert.equal(f.loader.snapshot().imageCacheBytes, 5)
})

test('normal, grayscale, palette and handler contexts cannot reuse one another through a shared resource', async () => {
  const f = fixture([['same.png', 7]])
  f.resources.set('same.bmp', f.resources.get('same.png')!)
  for (let repeat = 0; repeat < 2; repeat++) {
    await f.loader.load('same.png', noColorKey)
    await f.loader.rule('same.png')
    await f.loader.province('same.png', 1, 1)
    await f.loader.load('same.bmp', noColorKey)
  }
  assert.deepEqual(f.selections, [
    { format: 'png', mode: 'normal' }, { format: 'png', mode: 'grayscale' },
    { format: 'png', mode: 'palettized' }, { format: 'bmp', mode: 'normal' },
  ])
  assert.equal(f.loader.snapshot().imageCacheEntries, 4)
  f.loader.invalidate('same.png')
  assert.equal(f.loader.snapshot().imageCacheEntries, 0)
  await f.loader.rule('same.png')
  assert.equal(f.selections.length, 5)
})

test('cancellation after resource lookup prevents payload reads and format decoding', async () => {
  const cause = new Error('Stop during lookup')
  let cancelled = false
  const f = fixture([['scene.png', 7]], {
    find() { cancelled = true }, check() { if (cancelled) throw cause },
  })
  await assert.rejects(f.loader.load('scene.png', noColorKey), (error: unknown) => error === cause)
  assert.deepEqual(f.queries, ['scene.png'])
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.selections, [])
})

test('cancellation after the selected decoder returns prevents companion work and is not swallowed by touch', async () => {
  const cause = new Error('Stop during decode')
  let cancelled = false
  const f = fixture([['scene.png', 7], ['scene_m.png', 8]], {
    decode: async (value) => { cancelled = true; return pixels(value) },
    check() { if (cancelled) throw cause },
  })
  await assert.rejects(f.loader.touch(['scene.png']), (error: unknown) => error === cause)
  assert.deepEqual(f.queries, ['scene.png'])
  assert.deepEqual(f.reads, ['scene.png'])
  assert.equal(f.loader.snapshot().imageCachePending, 0)
})
