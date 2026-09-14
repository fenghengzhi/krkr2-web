import assert from 'node:assert/strict'
import test from 'node:test'
import { affinePixels, type AffineParameters } from '../../src/engine/graphics/affine.ts'
import { Bitmap } from '../../src/engine/graphics/bitmap.ts'
import type { Pixels, Rect } from '../../src/engine/ports/graphics.ts'

function raster(
  source: Pixels,
  rect: Rect,
  parameters: AffineParameters,
  type = 0,
  matrix = true,
  clip = { x: 0, y: 0, width: 8, height: 8 },
) {
  const work = affinePixels(source, rect, matrix, parameters, clip, type)
  let result = work.next()
  while (!result.done) result = work.next()
  return result.value
}
function numbered(width: number, height: number): Bitmap {
  const bitmap = new Bitmap(width, height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * width + x + 1
      bitmap.setPixel(x, y, index * 65536, 'main')
      bitmap.setPixel(x, y, (index * 17) & 255, 'mask')
    }
  return bitmap
}
const red = (bitmap: Bitmap) => [...bitmap.pixels.data].filter((_, at) => at % 4 === 0)
const matrixIdentity: AffineParameters = [1, 0, 0, 1, 0, 0]

test('affine matrices address the source rectangle locally and agree with half-pixel corner points', () => {
  const source = numbered(6, 3),
    rect = { x: 2, y: 1, width: 3, height: 2 },
    target = new Bitmap(6, 5, 0x49c86432),
    pointsTarget = new Bitmap(6, 5, 0x49c86432)
  const first = raster(source.pixels, rect, [1, 0, 0, 1, 1, 2]),
    second = raster(source.pixels, rect, [0.5, 1.5, 3.5, 1.5, 0.5, 3.5], 0, false)
  target.affine(first, 'copy', 0)
  pointsTarget.affine(second, 'copy', 0)
  assert.deepEqual(pointsTarget.pixels, target.pixels)
  assert.deepEqual(
    red(target),
    [
      200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 9, 10, 11, 200, 200, 200, 15,
      16, 17, 200, 200, 200, 200, 200, 200, 200, 200,
    ],
  )
  assert.equal(target.getPixel(1, 2, 'mask'), 153)
  assert.equal(target.getPixel(0, 0, 'mask'), 73)
})

test('rotation, reflection and shear preserve source pixels and leave uncovered corners untouched', () => {
  const source = numbered(2, 3),
    rect = { x: 0, y: 0, width: 2, height: 3 }
  for (const [parameters, expected] of [
    [
      [0, 1, -1, 0, 3, 1],
      [
        [1, 1, 5],
        [2, 1, 3],
        [3, 1, 1],
        [1, 2, 6],
        [2, 2, 4],
        [3, 2, 2],
      ],
    ],
    [
      [-1, 0, 0, 1, 3, 1],
      [
        [2, 1, 2],
        [3, 1, 1],
        [2, 2, 4],
        [3, 2, 3],
        [2, 3, 6],
        [3, 3, 5],
      ],
    ],
    [
      [1, 0, 1, 1, 2, 1],
      [
        [2, 1, 1],
        [3, 1, 2],
        [3, 2, 3],
        [4, 2, 4],
        [4, 3, 5],
        [5, 3, 6],
      ],
    ],
  ] as Array<[AffineParameters, number[][]]>) {
    const target = new Bitmap(7, 5, 0x49c86432),
      want = new Array(35).fill(200)
    target.affine(raster(source.pixels, rect, parameters), 'copy', 0)
    for (const [x, y, value] of expected) want[y! * 7 + x!] = value!
    assert.deepEqual(red(target), want)
  }
})

test('affine clear uses the full destination clip and respects alpha holding and empty sources', () => {
  const source = numbered(2, 2),
    rect = { x: 0, y: 0, width: 2, height: 2 },
    target = new Bitmap(5, 5, 0x49334455)
  target.setClip({ x: 1, y: 1, width: 3, height: 3 })
  source.setClip({ x: 0, y: 0, width: 0, height: 0 })
  const result = raster(source.pixels, rect, [1, 0, 0, 1, 2, 2], 0, true, target.clip)
  target.affine(result, 'copy', 1, 255, true, 0x00ffffff)
  assert.equal(target.getPixel(1, 1, 'main'), 0xffffff)
  assert.equal(target.getPixel(2, 2, 'main'), 0x010000)
  assert.equal(target.getPixel(3, 3, 'main'), 0x040000)
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 5; x++) assert.equal(target.getPixel(x, y, 'mask'), 73)
  assert.equal(target.getPixel(0, 1, 'main'), 0x334455)
  const before = target.pixels.data.slice(),
    revision = target.revision
  assert.equal(
    target.affine(
      raster(source.pixels, { ...rect, width: 0 }, matrixIdentity),
      'copy',
      0,
      255,
      false,
      0,
    ),
    false,
  )
  assert.equal(target.revision, revision)
  assert.deepEqual(target.pixels.data, before)
  target.affine(raster(source.pixels, rect, [0, 0, 0, 0, 0, 0]), 'copy', 0, 255, false, 0x00ffffff)
  assert.equal(target.getPixel(2, 2, 'main'), 0xffffff)
  assert.equal(target.getPixel(2, 2, 'mask'), 0)
  assert.equal(target.getPixel(0, 0, 'mask'), 73)
})

test('filtered neighbor access changes with stRefNoClip without changing coverage', () => {
  const source = new Bitmap(3, 1, 0xff000000)
  source.setPixel(1, 0, 0xff0000, 'main')
  const rect = { x: 1, y: 0, width: 1, height: 1 },
    parameters: AffineParameters = [1, 0, 0, 1, 0.25, 0]
  const clipped = raster(source.pixels, rect, parameters, 1)!,
    unclipped = raster(source.pixels, rect, parameters, 1 | 0x10000)!
  assert.deepEqual(clipped.spans, unclipped.spans)
  assert.deepEqual([...clipped.pixels.data], [255, 0, 0, 255])
  assert.deepEqual([...unclipped.pixels.data], [191, 0, 0, 255])
})

test('affine area averaging integrates a rotated footprint, and every filter preserves a constant image', () => {
  const source = new Bitmap(3, 3, 0xff000000)
  source.setPixel(1, 1, 0xff0000, 'main')
  const q = Math.SQRT1_2,
    rect = { x: 0, y: 0, width: 3, height: 3 },
    clip = { x: 0, y: 0, width: 1, height: 1 }
  const diamond = raster(source.pixels, rect, [q, q, -q, q, 0, -Math.SQRT2], 14, true, clip)!
  assert.deepEqual([...diamond.pixels.data], [211, 0, 0, 255])
  source.fill(rect, 0xad302010, 0, false)
  for (let type = 0; type < 20; type++) {
    const result = raster(source.pixels, rect, [q, q, -q, q, 3, 1], type)!
    for (let y = 0; y < result.pixels.height; y++)
      for (let x = result.spans[y * 2]!; x < result.spans[y * 2 + 1]!; x++)
        assert.deepEqual(
          [
            ...result.pixels.data.subarray(
              (y * result.pixels.width + x) * 4,
              (y * result.pixels.width + x + 1) * 4,
            ),
          ],
          [48, 32, 16, 173],
          `filter ${type}`,
        )
  }
})

test('self transforms read a complete source snapshot and alpha zero still copies pixels', () => {
  const bitmap = numbered(4, 1)
  bitmap.setPixel(3, 0, 0, 'mask')
  bitmap.affine(
    raster(bitmap.pixels, { x: 0, y: 0, width: 4, height: 1 }, [-1, 0, 0, 1, 3, 0]),
    'copy',
    0,
    255,
    false,
    0,
  )
  assert.deepEqual(red(bitmap), [4, 3, 2, 1])
  assert.equal(bitmap.getPixel(0, 0, 'mask'), 0)
  assert.equal(bitmap.getPixel(3, 0, 'mask'), 17)
})

test('invalid affine input rejects before destination mutation and long filters yield work batches', () => {
  const source = new Bitmap(64, 64, 0xff123456),
    rect = { x: 0, y: 0, width: 64, height: 64 },
    clip = { ...rect }
  assert.throws(() => raster(source.pixels, { ...rect, x: -1 }, matrixIdentity), /outside/)
  assert.throws(() => raster(source.pixels, rect, [NaN, 0, 0, 1, 0, 0]), /coordinates/)
  assert.throws(() => raster(source.pixels, rect, matrixIdentity, 20), /filter/)
  let yields = 0
  const work = affinePixels(source.pixels, rect, true, [0.01, 0, 0, 0.01, 0, 0], clip, 14)
  let next = work.next()
  while (!next.done) {
    yields++
    next = work.next()
  }
  assert.ok(yields > 1)
  assert.deepEqual([...next.value!.pixels.data], [18, 52, 86, 255])
})
