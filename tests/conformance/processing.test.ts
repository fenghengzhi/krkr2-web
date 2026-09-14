import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Bitmap } from '../../src/engine/graphics/bitmap.ts'
import { boxBlur } from '../../src/engine/graphics/processing.ts'
import { processingCases } from '../helpers/processing-vectors.ts'
function finish<T>(work: Generator<void, T>): T {
  let result = work.next()
  while (!result.done) result = work.next()
  return result.value
}

test('conversion, grayscale and box blur match independent native pixel fixtures', () => {
  const reference = readFileSync(new URL('../fixtures/processing-reference.bin', import.meta.url)),
    metadata = JSON.parse(
      readFileSync(new URL('../fixtures/processing-reference.json', import.meta.url), 'utf8'),
    )
  assert.equal(createHash('sha256').update(reference).digest('hex'), metadata.sha256)
  let cursor = 0,
    cases = 0,
    mismatches = 0
  const failures: unknown[] = []
  for (const c of processingCases()) {
    const bitmap = new Bitmap(c.source.width, c.source.height)
    bitmap.pixels.data.set(c.source.data)
    bitmap.setClip(c.clip)
    if (c.operation < 2) bitmap.convert(c.operation === 0)
    else if (c.operation === 2) bitmap.grayscale()
    else {
      const result = finish(boxBlur(bitmap.pixels, bitmap.clip, c.rx, c.ry, c.operation === 4))
      if (result)
        bitmap.copyPixels(result, c.clip.x, c.clip.y, {
          x: 0,
          y: 0,
          width: result.width,
          height: result.height,
        })
    }
    const want = reference.subarray(cursor, cursor + bitmap.pixels.data.length),
      actual = Buffer.from(bitmap.pixels.data)
    if (!actual.equals(want)) {
      mismatches++
      if (failures.length < 8) {
        const index = actual.findIndex((value, i) => value !== want[i]),
          at = index - (index % 4)
        failures.push({
          case: cases,
          operation: c.operation,
          width: bitmap.width,
          height: bitmap.height,
          clip: c.clip,
          rx: c.rx,
          ry: c.ry,
          pixel: at / 4,
          actual: [...actual.subarray(at, at + 4)],
          expected: [...want.subarray(at, at + 4)],
        })
      }
    }
    cursor += actual.length
    cases++
  }
  assert.equal(cases, metadata.cases)
  assert.equal(cursor, metadata.pixels * 4)
  assert.equal(mismatches, 0, JSON.stringify(failures, null, 2))
})

test('alpha-aware blur rejects hidden RGB while the other faces average raw channels', () => {
  const source = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 0, 0, 0, 255, 255]) },
    clip = { x: 0, y: 0, width: 2, height: 1 }
  assert.deepEqual(
    [...finish(boxBlur(source, clip, 1, 0, true))!.data],
    [0, 0, 255, 128, 0, 0, 255, 128],
  )
  assert.deepEqual(
    [...finish(boxBlur(source, clip, 1, 0, false))!.data],
    [128, 0, 128, 128, 128, 0, 128, 128],
  )
  assert.deepEqual([...source.data], [255, 0, 0, 0, 0, 0, 255, 255])
})

test('blur samples outside the clip, bounds its work by the bitmap and skips zero radius', () => {
  const bitmap = new Bitmap(3, 1, 0xff000000)
  bitmap.setPixel(0, 0, 0xff0000, 'main')
  bitmap.setClip({ x: 1, y: 0, width: 1, height: 1 })
  const output = finish(boxBlur(bitmap.pixels, bitmap.clip, -1, 0, false))!
  assert.deepEqual([...output.data], [85, 0, 0, 255])
  assert.equal(finish(boxBlur(bitmap.pixels, bitmap.clip, 0, 0, true)), undefined)
  assert.throws(() => finish(boxBlur(bitmap.pixels, bitmap.clip, 2048, 2048, false)), /16 million/)
  assert.throws(() => finish(boxBlur(bitmap.pixels, bitmap.clip, NaN, 0, false)), /radius/)
  assert.deepEqual(
    [...finish(boxBlur(bitmap.pixels, bitmap.clip, 1000000, 0, false))!.data],
    [85, 0, 0, 255],
  )
  const single = { width: 1, height: 1, data: new Uint8Array([234, 205, 10, 0]) }
  assert.deepEqual(
    [...finish(boxBlur(single, { x: 0, y: 0, width: 1, height: 1 }, 0, 7, false))!.data],
    [234, 205, 10, 0],
  )
})

test('conversion and flipping cover the whole bitmap while grayscale obeys clip', () => {
  const bitmap = new Bitmap(3, 2)
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 3; x++) {
      const index = y * 3 + x + 1
      bitmap.setPixel(x, y, index * 0x10000, 'main')
      bitmap.setPixel(x, y, index + 10, 'mask')
      bitmap.setPixel(x, y, index + 40, 'province')
    }
  bitmap.setClip({ x: 1, y: 0, width: 1, height: 1 })
  bitmap.flip(true)
  bitmap.flip(false)
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 3; x++) {
      const index = 6 - y * 3 - x
      assert.equal(bitmap.getPixel(x, y, 'main'), index * 0x10000)
      assert.equal(bitmap.getPixel(x, y, 'mask'), index + 10)
      assert.equal(bitmap.getPixel(x, y, 'province'), index + 40)
    }
  bitmap.grayscale()
  assert.equal(bitmap.getPixel(1, 0, 'main'), 0x010101)
  assert.equal(bitmap.getPixel(0, 0, 'main'), 0x060000)
  const province = bitmap.province!.slice()
  bitmap.convert(true)
  assert.equal(bitmap.getPixel(0, 0, 'main'), 0)
  assert.equal(bitmap.getPixel(0, 0, 'mask'), 16)
  assert.deepEqual(bitmap.province, province)
  bitmap.convert(false)
  assert.equal(bitmap.getPixel(0, 0, 'mask'), 16)
})
