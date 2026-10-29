import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { decodeSelectedImage, type SelectedImageDecoderDependencies } from '../../src/engine/graphics/image-decoder.ts'
import { decodePng } from '../../src/formats/image/png.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import type { ImageDecodeProgress, ImageDecodeSelection } from '../../src/formats/image/selection.ts'
import { ImageLoader } from '../../src/engine/storage/images.ts'
import { noColorKey } from '../../src/engine/graphics/loading.ts'
import { createHeadlessImageInflaterProvider } from '../helpers/image-zlib.ts'
import { palettePng, paletteRgba, packedKeyRgba, paletteGray, opaqueGray, paletteIndices } from '../helpers/png-palette-contract.ts'

const options = { timeout: 60000 }
function finish<T>(work: Generator<void, T>): T {
  try { for (let step = 0; step < 10000; step++) { const next = work.next(); if (next.done) return next.value } }
  finally { work.return(undefined as T) }
  throw new Error('Palette fixture exceeded its work bound')
}
async function using(run: (dependencies: SelectedImageDecoderDependencies) => Promise<void>) {
  const provider = createHeadlessImageInflaterProvider()
  let opened = 0, closed = 0
  try {
    await run({ async finish<T>(work: Generator<void, T>) { return finish(work) },
      async inflate(compressed) { return inflateSync(compressed) },
      async host() { throw new Error('Palette PNG must not fall through to the host decoder') },
      async openInflater(source, length) {
        const stream = await provider.open(source, length); opened++
        return { step: (input, output) => stream.step(input, output), close() { closed++; stream.close() } }
      },
    })
    assert.equal(closed, opened)
  } finally { provider.dispose() }
}
function decode(bytes: Uint8Array, dependencies: SelectedImageDecoderDependencies, mode: ImageDecodeSelection['mode'],
  paletteKey?: number, progress?: ImageDecodeProgress) {
  return decodeSelectedImage(bytes, { format: 'png', mode, ...(paletteKey === undefined ? {} : { paletteKey }) }, dependencies, progress)
}
const grayRgba = (plane: readonly number[]) => plane.flatMap((value) => [value, value, value, 255])
const crcError = (error: unknown) => {
  assert.ok(error instanceof TvpError)
  assert.deepEqual(error.tvpMessage, { id: 'TVPPNGLoadError', args: ['IDAT: CRC error'] })
  return true
}

test('normal palette PNG keeps file tRNS under every palette key in packed and Adam7 inputs', options, async () => {
  await using(async (dependencies) => {
    for (const interlace of [false, true]) for (const depth of [2, 4, 8] as const)
      for (const paletteKey of [undefined, 0, 1, 255]) for (const streaming of [false, true]) {
        const image = await decode(palettePng({ interlace, depth }),
          streaming ? dependencies : { ...dependencies, openInflater: undefined }, 'normal', paletteKey)
        assert.deepEqual([...image.data], paletteRgba)
        assert.deepEqual([...image.indices!], paletteIndices.flat())
      }
  })
})

test('palette keys without file tRNS preserve defined packed BGR bytes with only the Web tail zero policy', options, async () => {
  await using(async (dependencies) => {
    for (const interlace of [false, true]) for (const depth of [2, 4, 8] as const) {
      const bytes = palettePng({ alpha: false, interlace, depth })
      for (const paletteKey of [0, 1, 255]) for (const streaming of [false, true]) {
        const image = await decode(bytes, streaming ? dependencies : { ...dependencies, openInflater: undefined }, 'normal', paletteKey)
        assert.deepEqual([...image.data], packedKeyRgba)
      }
      const expected = paletteRgba.map((value, index) => index % 4 === 3 ? 255 : value),
        image = await decode(bytes, dependencies, 'normal'), generic = finish(decodePng(bytes)!)
      assert.deepEqual([...image.data], expected, 'No key retains the ordinary opaque palette branch')
      assert.deepEqual([...finish(generic.decode(inflateSync(generic.compressed))).data], expected, 'The generic PNG decoder keeps standard RGBA')
    }
  })
})

test('palette grayscale consumes BGR triples from the actual expanded BGR or BGRA rows after Adam7 assembly', options, async () => {
  await using(async (dependencies) => {
    for (const alpha of [false, true]) for (const interlace of [false, true]) for (const depth of [2, 4, 8] as const)
      for (const streaming of [false, true]) {
        const image = await decode(palettePng({ alpha, interlace, depth }),
          streaming ? dependencies : { ...dependencies, openInflater: undefined }, 'grayscale')
        assert.equal(image.grayscale, true); assert.equal(image.indices, undefined)
        assert.deepEqual([...image.data], grayRgba(alpha ? paletteGray : opaqueGray))
      }
  })
})

test('normal packed output writes its last raw row before a finish error but manual palette gray commits only complete rows', options, async () => {
  await using(async (dependencies) => {
    for (const mode of ['normal', 'grayscale'] as const) {
      const raw: number[] = [], complete: number[] = [], delivered: number[][] = [], destination = new Uint8Array(48),
        expected = mode === 'normal' ? packedKeyRgba : grayRgba(paletteGray)
      await assert.rejects(decode(palettePng({ alpha: mode !== 'normal', badRowEnd: true }), dependencies,
        mode, mode === 'normal' ? 1 : undefined, {
          size(w, h) { assert.deepEqual([w, h], [4, 3]) },
          write(y, row) { raw.push(y); destination.set(row, y * 16) },
          row(y, row) { complete.push(y); delivered.push([...row]); destination.set(row, y * 16) },
        }), crcError)
      assert.deepEqual(raw, mode === 'normal' ? [0, 1, 2] : [])
      assert.deepEqual(complete, [0, 1])
      assert.deepEqual(delivered.flat(), expected.slice(0, 32))
      assert.deepEqual([...destination], mode === 'normal' ? packedKeyRgba : [...expected.slice(0, 32), ...Array<number>(16).fill(0)])
    }
  })
})

test('Adam7 palette output stays private until read-end succeeds for both manual gray and packed key output', options, async () => {
  await using(async (dependencies) => {
    for (const mode of ['normal', 'grayscale'] as const) {
      const events: string[] = []
      await assert.rejects(decode(palettePng({ alpha: mode !== 'normal', interlace: true, badEnd: true }), dependencies,
        mode, mode === 'normal' ? 255 : undefined, {
          size() { events.push('size') }, write() { events.push('write') }, row() { events.push('row') },
        }), (error: unknown) => {
        assert.ok(error instanceof TvpError)
        assert.deepEqual(error.tvpMessage, { id: 'TVPPNGLoadError', args: ['IEND: CRC error'] })
        return true
      })
      assert.deepEqual(events, ['size'])
    }
  })
})

test('actual PNG handler output feeds distinct processed keys and eight-bit transition rules without generic index masking', options, async () => {
  await using(async (dependencies) => {
    const bytes = palettePng(), selections: ImageDecodeSelection[] = []
    let reads = 0
    const resource = { name: 'palette.png', size: bytes.length, cacheToken: {}, async read() { reads++; return bytes } },
      loader = new ImageLoader((name) => name === resource.name ? resource : undefined,
        async (input, selection, progress) => {
          selections.push(selection)
          return decodeSelectedImage(input, selection, dependencies, progress)
        }, async <T>(work: Generator<void, T>) => finish(work), { now: () => 0, check() {}, yield: async () => {} })
    for (const key of [noColorKey, 0x03000000, 0x03000001, 0x030000ff]) {
      const first = await loader.load('palette.png', key)
      assert.deepEqual([...first.image.data], paletteRgba)
      first.image.data.fill(0)
      assert.deepEqual([...(await loader.load('palette.png', key)).image.data], paletteRgba)
    }
    assert.equal(reads, 4)
    assert.deepEqual(selections.map((selection) => selection.paletteKey), [undefined, 0, 1, 255])
    const rule = await loader.rule('palette.png', 8, 6)
    assert.deepEqual([rule.width, rule.height], [8, 6])
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++)
      assert.deepEqual([...rule.data.subarray((y * 8 + x) * 4, (y * 8 + x + 1) * 4)],
        grayRgba([paletteGray[(y % 3) * 4 + x % 4]!]))
    assert.equal(reads, 5)
    assert.deepEqual(selections.at(-1), { format: 'png', mode: 'grayscale' })
    assert.equal(loader.snapshot().imageCacheEntries, 5)
    loader.clear()
    assert.equal(loader.snapshot().imageCacheResidentBytes, 0)
  })
})

test('invalid palette-key descriptors fail before any source work and paused selection snapshots cannot change key semantics', options, async () => {
  await using(async (dependencies) => {
    for (const paletteKey of [-1, 256, 0.5, NaN])
      await assert.rejects(decode(palettePng(), dependencies, 'normal', paletteKey), /Invalid selected image palette key/)
    await assert.rejects(decode(palettePng(), dependencies, 'grayscale', 0), /Invalid selected image palette key/)
    const selection: { format: 'png'; mode: 'normal'; paletteKey?: number } = { format: 'png', mode: 'normal', paletteKey: 1 },
      pending = decodeSelectedImage(palettePng({ alpha: false }), selection, dependencies)
    delete selection.paletteKey
    assert.deepEqual([...(await pending).data], packedKeyRgba)
  })
})
