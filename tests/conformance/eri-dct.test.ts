import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { decodeSelectedEri } from '../../src/formats/image/eri.ts'
import { EriInverseDct } from '../../src/formats/image/eri-idct.ts'
import { ImageDecodeError } from '../../src/formats/image/selection.ts'
import { eriDctCases, eriDctRejectedCases } from '../helpers/eri-dct-fixtures.ts'

function finish<T>(work: Generator<void, T>): T {
  for (;;) { const result = work.next(); if (result.done) return result.value }
}

test('ERI inverse transform follows the two-dimensional cosine basis at all supported block sizes', () => {
  for (const size of [8, 16, 32]) {
    const transform = new EriInverseDct(size)
    for (const [kx, ky] of [[0, 0], [1, 0], [0, 1], [3, 2], [size - 1, size - 2]] as const) {
      const plane = new Float32Array(size * size)
      plane[ky * size + kx] = 40
      transform.transform(plane)
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const expected = 40 * Math.cos((2 * x + 1) * kx * Math.PI / (2 * size)) *
          Math.cos((2 * y + 1) * ky * Math.PI / (2 * size))
        assert(Math.abs(plane[y * size + x]! - expected) < 0.002, [size, kx, ky, x, y].join(','))
      }
    }
  }
})

test('ERI frame 9 cropped blocks, prediction, chroma, alpha and grays reach the original row interface', () => {
  for (const item of eriDctCases) for (const mode of ['normal', 'grayscale'] as const) {
    const rows: number[] = [], sizes: number[][] = []
    const image = finish(decodeSelectedEri(item.bytes, mode, { size(w, h) { sizes.push([w, h]) },
      write() { assert.fail('DCT publishes completed rows') }, row(y, rgba) { assert.equal(y, rows.length / (item.width * 4)); rows.push(...rgba) } }))
    const expected = mode === 'grayscale' ? item.gray : item.rgba
    assert.deepEqual(sizes, [[item.width, item.height]])
    assert.deepEqual([...image.data], expected, item.name); assert.deepEqual(rows, expected)
  }
})

test('ERI DCT reports image size and withholds scanlines on invalid frame controls', () => {
  const item = eriDctCases[0]!, file = Buffer.from(item.bytes)
  const frame = file.indexOf('ImageFrm') + 16, info = file.indexOf('ImageInf') + 16
  for (const [offset, value, phase] of [[frame, 8, 'DecodeImage'], [frame + 1, 1, 'DecodeImage'],
    [frame + 2, 2, 'DecodeImage'], [frame + 3, 7, 'DecodeImage'], [frame + 4, 128, 'DecodeImage'],
    [info + 32, 0, 'Initialize'], [info + 52, 6, 'Initialize']] as const) {
    const input = Buffer.from(file), events: string[] = []
    input[offset] = value
    assert.throws(() => finish(decodeSelectedEri(input, 'normal', { size() { events.push('size') },
      write() { events.push('write') }, row() { events.push('row') } })), (error) =>
      error instanceof ImageDecodeError && error.reason === 'ERIDecoder::' + phase + ' failed.')
    assert.deepEqual(events, ['size'])
  }
})

test('ERI DCT preserves the original 20100 Gamma rejection before publishing any row', () => {
  for (const item of eriDctRejectedCases) {
    if (item.originalSha256)
      assert.equal(createHash('sha256').update(item.bytes).digest('hex'), item.originalSha256, item.name)
    for (const mode of ['normal', 'grayscale'] as const) {
      const sizes: number[][] = [], rows: number[] = []
      assert.throws(() => finish(decodeSelectedEri(item.bytes, mode, {
        size(w, h) { sizes.push([w, h]) }, write() { assert.fail('Initialization failure published pixels') },
        row(y) { rows.push(y) },
      })), (error) => error instanceof ImageDecodeError && error.reason === item.reason, item.name)
      assert.deepEqual(sizes, [[item.width, item.height]], item.name)
      assert.deepEqual(rows, [], item.name)
    }
  }
})
