import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecodedImage } from '../../src/engine/ports/graphics.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { noColorKey } from '../../src/engine/graphics/loading.ts'
import { ImageLoader, ProvinceImageLoadError } from '../../src/engine/storage/images.ts'

async function finish<T>(work: Generator<void, T>): Promise<T> {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}

function fixture(
  options: {
    province?: boolean
    read?: (name: string) => void
    decode?: (name: string) => DecodedImage | undefined
    finish?: typeof finish
  } = {},
) {
  const names = [
      'scene.bmp',
      'scene_m.bmp',
      ...(options.province === false ? [] : ['scene_p.bmp']),
    ],
    reads: string[] = [],
    decodes: string[] = [],
    resources = new Map<string, Resource>(
      names.map((name, index) => [
        name,
        {
          name,
          size: 1,
          cacheToken: {},
          async read() {
            reads.push(name)
            options.read?.(name)
            return Uint8Array.of(index)
          },
        },
      ]),
    ),
    loader = new ImageLoader(
      (name) => resources.get(name),
      async (bytes) => {
        const name = names[bytes[0]!]!
        decodes.push(name)
        const override = options.decode?.(name)
        if (override) return override
        if (name === 'scene.bmp')
          return { width: 1, height: 1, data: Uint8Array.of(200, 100, 50, 64) }
        if (name === 'scene_m.bmp')
          return { width: 1, height: 1, data: Uint8Array.of(128, 128, 128, 255) }
        return {
          width: 1,
          height: 1,
          data: Uint8Array.of(9, 9, 9, 255),
          indices: Uint8Array.of(9),
        }
      },
      options.finish ?? finish,
      { now: () => 0, check() {}, yield: async () => {} },
    )
  return { loader, reads, decodes }
}

for (const stage of ['read', 'decode'] as const) {
  test(`a failed province ${stage} exposes the completed main image and retries only the failed source`, async () => {
    const cause = new Error(`Broken province ${stage}`)
    let broken = true
    function failProvince(name: string): undefined {
      if (name === 'scene_p.bmp' && broken) throw cause
      return undefined
    }
    const f = fixture(stage === 'read' ? { read: failProvince } : { decode: failProvince })
    await assert.rejects(f.loader.load('scene.bmp', 0x04ffffff), (error: unknown) => {
      assert.ok(error instanceof ProvinceImageLoadError)
      assert.equal(error.name, 'ProvinceImageLoadError')
      assert.equal(error.message, cause.message)
      assert.equal(error.cause, cause)
      // The companion mask supplies alpha 128 before white matting.
      assert.deepEqual([...error.image.data], [227, 177, 152, 255])
      error.image.data.fill(0)
      return true
    })
    assert.equal(f.loader.snapshot().imageCacheEntries, 2)
    assert.equal(f.loader.snapshot().imageCachePending, 0)
    assert.equal(f.loader.snapshot().imageCacheBytes, 8)
    assert.deepEqual([...(await f.loader.rule('scene.bmp')).data], [200, 100, 50, 64])
    broken = false
    const loaded = await f.loader.load('scene.bmp', 0x04ffffff)
    assert.deepEqual([...loaded.image.data], [227, 177, 152, 255])
    assert.deepEqual([...loaded.province!], [9])
    assert.equal(f.reads.filter((name) => name === 'scene_p.bmp').length, 2)
    assert.equal(
      f.decodes.filter((name) => name === 'scene_p.bmp').length,
      stage === 'read' ? 1 : 2,
    )
    assert.equal(f.decodes.filter((name) => name === 'scene.bmp').length, 1)
    assert.equal(f.decodes.filter((name) => name === 'scene_m.bmp').length, 1)
    assert.equal(f.loader.snapshot().imageCacheEntries, 3)
    assert.equal(f.loader.snapshot().imageCachePending, 0)
  })
}

for (const invalid of ['truecolor', 'oversized'] as const) {
  test(`a ${invalid} province conversion keeps its successful main image in the typed failure`, async () => {
    const f = fixture({
      decode: (name) =>
        name !== 'scene_p.bmp'
          ? undefined
          : invalid === 'truecolor'
            ? { width: 1, height: 1, data: Uint8Array.of(1, 2, 3, 255) }
            : {
                width: 2,
                height: 1,
                data: new Uint8Array(8),
                indices: Uint8Array.of(1, 2),
              },
    })
    await assert.rejects(f.loader.load('scene.bmp', noColorKey), (error: unknown) => {
      assert.ok(error instanceof ProvinceImageLoadError)
      assert.ok(error.cause instanceof Error)
      assert.equal(error.message, error.cause.message)
      assert.match(
        error.message,
        invalid === 'truecolor' ? /palette or grayscale/ : /size mismatch/,
      )
      assert.deepEqual([...error.image.data], [200, 100, 50, 128])
      return true
    })
    // These are valid decoded source images; only their use as this Province failed.
    assert.equal(f.loader.snapshot().imageCacheEntries, 3)
    assert.equal(f.loader.snapshot().imageCachePending, 0)
    assert.equal((await f.loader.rule('scene_p.bmp')).width, invalid === 'oversized' ? 2 : 1)
  })
}

test('a failure after province conversion yields preserves its non-Error cause and completed main image', async () => {
  const cause = 'Province conversion interrupted'
  let calls = 0
  const f = fixture({
    async finish<T>(work: Generator<void, T>): Promise<T> {
      if (++calls === 4) {
        assert.equal(work.next().done, false)
        throw cause
      }
      return finish(work)
    },
  })
  await assert.rejects(f.loader.load('scene.bmp', noColorKey), (error: unknown) => {
    assert.ok(error instanceof ProvinceImageLoadError)
    assert.equal(error.cause, cause)
    assert.equal(error.message, cause)
    assert.deepEqual([...error.image.data], [200, 100, 50, 128])
    return true
  })
  assert.equal(calls, 4)
  assert.equal(f.loader.snapshot().imageCachePending, 0)
})

for (const [stage, call] of [
  ['key', 1],
  ['mask', 2],
  ['matte', 3],
] as const) {
  test(`a ${stage} operation failure is not misreported as a completed main image`, async () => {
    const cause = new Error(`Interrupted ${stage}`)
    let calls = 0
    const f = fixture({
      async finish<T>(work: Generator<void, T>): Promise<T> {
        if (++calls === call) throw cause
        return finish(work)
      },
    })
    await assert.rejects(f.loader.load('scene.bmp', 0x04ffffff), (error: unknown) => {
      assert.equal(error, cause)
      assert.equal(error instanceof ProvinceImageLoadError, false)
      return true
    })
    assert.equal(f.reads.includes('scene_p.bmp'), false)
    assert.equal(f.loader.snapshot().imageCachePending, 0)
  })
}

for (const source of ['scene.bmp', 'scene_m.bmp']) {
  test(`failure to read ${source} retains the original error without attempting Province`, async () => {
    const cause = new Error(`Cannot read ${source}`),
      f = fixture({
        read(name) {
          if (name === source) throw cause
        },
      })
    await assert.rejects(f.loader.load('scene.bmp', noColorKey), (error: unknown) => {
      assert.equal(error, cause)
      return true
    })
    assert.equal(f.reads.includes('scene_p.bmp'), false)
    assert.equal(f.loader.snapshot().imageCacheEntries, source === 'scene.bmp' ? 0 : 1)
    assert.equal(f.loader.snapshot().imageCachePending, 0)
  })
}

test('an absent province companion returns the completed main image normally', async () => {
  const f = fixture({ province: false }),
    loaded = await f.loader.load('scene.bmp', 0x04ffffff)
  assert.deepEqual([...loaded.image.data], [227, 177, 152, 255])
  assert.equal(Object.hasOwn(loaded, 'province'), false)
  assert.deepEqual(f.reads, ['scene.bmp', 'scene_m.bmp'])
  assert.equal(f.loader.snapshot().imageCachePending, 0)
})
