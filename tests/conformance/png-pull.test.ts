import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeSelectedImage, type SelectedImageDecoderDependencies } from '../../src/engine/graphics/image-decoder.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../../src/formats/image/selection.ts'
import { createHeadlessImageInflaterProvider } from '../helpers/image-zlib.ts'
import { imageBytes, imageFixture, imageManifest } from '../helpers/image-fixtures.ts'

function dependencies(openInflater: NonNullable<SelectedImageDecoderDependencies['openInflater']>): SelectedImageDecoderDependencies {
  return { openInflater,
    async finish<T>(work: Generator<void, T>) {
      try { for (;;) { const next = work.next(); if (next.done) return next.value } }
      finally { work.return(undefined as T) }
    },
    async inflate() { throw new Error('Selected pull PNG must not use bulk inflation') },
    async host() { throw new Error('Selected pull PNG must not use a host decoder') },
  }
}

test('real PNG pull decoding preserves the independent 8/16-bit, palette and Adam7 corpus with complete row publication', { timeout: 60000 }, async () => {
  const provider = createHeadlessImageInflaterProvider()
  try {
    const fixtures = imageManifest.entries.filter((entry) =>
      [137, 80, 78, 71, 13, 10, 26, 10].every((byte, at) => imageBytes[entry.offset + at] === byte))
    assert.equal(fixtures.length, 102)
    for (const [offset, expected] of [[24, [1, 2, 4, 8, 16]], [25, [0, 2, 3, 4, 6]], [28, [0, 1]]] as const)
      assert.deepEqual([...new Set(fixtures.map((entry) => imageBytes[entry.offset + offset]!))].sort((a, b) => a - b), expected)
    for (const fixture of fixtures) {
      const writes: number[] = [], rows: number[] = [], delivered: number[] = []
      const image = await decodeSelectedImage(imageFixture(fixture.name), { format: 'png', mode: 'normal' },
        dependencies((source, length) => provider.open(source, length)), {
          size(width, height) { assert.deepEqual([width, height], [fixture.width, fixture.height]) },
          write(y) { writes.push(y) },
          row(y, rgba) { rows.push(y); delivered.push(...rgba) },
        })
      const expected = fixture.name === 'transparent-rgb.png'
        ? [18, 86, 154, 255, 18, 86, 154, 255]
        : [...imageBytes.subarray(fixture.rgbaOffset, fixture.rgbaOffset + fixture.width * fixture.height * 4)]
      assert.deepEqual([...image.data], expected, fixture.name)
      assert.deepEqual(delivered, expected, fixture.name)
      assert.deepEqual(rows, Array.from({ length: fixture.height }, (_, y) => y), fixture.name)
      assert.deepEqual(writes, rows, fixture.name)
    }
  } finally { provider.dispose() }
})

test('pull PNG size, raw-write and completion failures keep the exact consumer cause and close every acquired native stream', { timeout: 60000 }, async () => {
  const provider = createHeadlessImageInflaterProvider(), bytes = imageFixture('transparent-rgb.png')
  try {
    for (const phase of ['size', 'write', 'row'] as const) for (const cause of [new ImageDecodeError('png', 'IDAT: CRC error'), 'consumer failure']) {
      let opens = 0, closes = 0
      const events: string[] = [], observer: ImageDecodeProgress = {
        size() { events.push('size'); if (phase === 'size') throw cause },
        write(y) { events.push('write:' + y); if (phase === 'write') throw cause },
        row(y) { events.push('row:' + y); if (phase === 'row') throw cause },
      }
      await assert.rejects(decodeSelectedImage(bytes, { format: 'png', mode: 'normal' }, dependencies(async (source, length) => {
        opens++
        const stream = await provider.open(source, length)
        return { step: (input, output) => stream.step(input, output), close() { closes++; stream.close() } }
      }), observer), (error) => error === cause)
      assert.deepEqual(events, phase === 'size' ? ['size'] : phase === 'write' ? ['size', 'write:0'] : ['size', 'write:0', 'row:0'])
      assert.equal(opens, phase === 'size' ? 0 : 1)
      assert.equal(closes, opens)
    }
  } finally { provider.dispose() }
})
