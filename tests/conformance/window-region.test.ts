import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pixels } from '../../src/engine/ports/graphics.ts'
import { createWindowRegion, copyWindowRegion, validateWindowRegion, windowRegionContains,
  WindowRegions, WINDOW_REGION_RECTANGLE_LIMIT, type WindowRegion } from '../../src/engine/scene/window-region.ts'

function pixels(width: number, alpha: number[]): Pixels {
  const data = new Uint8Array(alpha.length * 4)
  for (let at = 0; at < alpha.length; at++) data.set([at & 255, 79, 203, alpha[at]!], at * 4)
  return { width, height: alpha.length / width, data }
}

test('window regions apply unsigned alpha thresholds inclusively, including zero and the empty region', async () => {
  const image = pixels(5, [0, 1, 127, 128, 255])
  for (const [threshold, left, width] of [[0, 0, 5], [1, 1, 4], [128, 3, 2], [255, 4, 1]]) {
    const region = await createWindowRegion(image, threshold!)
    assert.deepEqual([...region.rectangles], [left, 0, width, 1])
  }
  for (const threshold of [256, 0xffffffff]) {
    const region = await createWindowRegion(image, threshold)
    assert.equal(region.rectangles.length, 0)
    assert.equal(windowRegionContains(region, 1, 0), false)
    assert.equal(windowRegionContains(null, 1, 0), true, 'Removing a region is distinct from an empty union')
  }
  const empty = await createWindowRegion({ width: 0, height: 0, data: new Uint8Array() }, 1)
  assert.equal(empty.rectangles.length, 0)
})

test('equal runs merge vertically while holes and right/bottom-exclusive boundaries remain exact', async () => {
  const region = await createWindowRegion(pixels(4, [0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1]), 1)
  assert.deepEqual([...region.rectangles], [1, 0, 2, 2, 0, 2, 1, 1, 3, 2, 1, 1])
  for (const [x, y, inside] of [[1, 0, true], [2.999, 1.999, true], [3, 1, false],
    [1, 2, false], [0, 2, true], [3, 2, true], [4, 2, false], [3, 3, false]])
    assert.equal(windowRegionContains(region, x as number, y as number), inside)
  assert.equal(windowRegionContains(region, NaN, 0), false)
})

test('region preparation snapshots alpha before its first yield and never reads RGB as a mask', async () => {
  const image = pixels(3, [0, 127, 255]), before = [...image.data]
  let yielded = false
  const region = await createWindowRegion(image, 128, { yieldControl: async () => {
    if (!yielded) { yielded = true; image.data.fill(255) }
  } })
  assert.equal(yielded, true)
  assert.deepEqual([...region.rectangles], [2, 0, 1, 1])
  const original = pixels(3, [0, 127, 255])
  await createWindowRegion(original, 128)
  assert.deepEqual([...original.data], before, 'Creating a region does not write the source bitmap')
})

test('region preparation propagates checkpoints and scheduler failure without returning a partial union', async () => {
  const image = pixels(2, Array(160).fill(255)), stopped = new Error('region cancelled')
  let yields = 0, cancelled = false
  await assert.rejects(createWindowRegion(image, 1, {
    checkpoint: () => { if (cancelled) throw stopped },
    yieldControl: async () => { if (++yields === 2) cancelled = true },
  }), (error) => error === stopped)
  assert.equal(yields, 2)
  const scheduler = new Error('region scheduler failed')
  await assert.rejects(createWindowRegion(image, 1, { yieldControl: async () => { throw scheduler } }),
    (error) => error === scheduler)
  await assert.rejects(createWindowRegion(image, 1, { checkpoint: () => { throw stopped } }),
    (error) => error === stopped)
})

test('the exact rectangle budget admits its boundary and rejects added checkerboard complexity', async () => {
  const checker = (height: number) => pixels(256, Array.from({ length: height * 256 }, (_, at) =>
    ((at % 256) + Math.floor(at / 256)) % 2 ? 255 : 0))
  const region = await createWindowRegion(checker(512), 1)
  assert.equal(region.rectangles.length / 4, WINDOW_REGION_RECTANGLE_LIMIT)
  assert.equal(region.rectangles.byteLength, 512 * 1024)
  await assert.rejects(createWindowRegion(checker(513), 1), /rectangle budget exceeded/)
  await assert.rejects(createWindowRegion(pixels(3, [255, 0, 255]), 1, { maxRectangles: 1 }), /rectangle budget exceeded/)
})

test('Session region storage accounts all windows and rejects replacement before losing the old region', async () => {
  const regions = new WindowRegions(24),
    two = await createWindowRegion(pixels(3, [255, 0, 255]), 1),
    one = await createWindowRegion(pixels(2, [255, 255]), 1),
    three = await createWindowRegion(pixels(5, [255, 0, 255, 0, 255]), 1)
  regions.replace(1, two)
  regions.replace(2, one)
  assert.deepEqual(regions.inspect(), { regions: 2, bytes: 24 })
  assert.equal(regions.availableRectangles(1), 2)
  assert.throws(() => regions.replace(1, three), /Session budget/)
  assert.equal(regions.get(1), two)
  regions.replace(1, one)
  assert.deepEqual(regions.inspect(), { regions: 2, bytes: 16 })
  regions.replace(2, null)
  assert.deepEqual(regions.inspect(), { regions: 1, bytes: 8 })
  regions.clear()
  assert.deepEqual(regions.inspect(), { regions: 0, bytes: 0 })
})

test('region validation rejects malformed wire geometry and copies own their packed coordinates', async () => {
  const good = await createWindowRegion(pixels(2, [255, 255]), 1)
  validateWindowRegion(good)
  for (const bad of [null, {}, { ...good, width: 4097 }, { ...good, height: 0.5 },
    { ...good, rectangles: [0, 0, 2, 1] }, { ...good, rectangles: new Uint16Array(3) },
    { ...good, rectangles: new Uint16Array([0, 0, 0, 1]) },
    { ...good, rectangles: new Uint16Array([1, 0, 2, 1]) },
    { ...good, rectangles: new Uint16Array([0, 1, 1, 1]) },
    { ...good, rectangles: new Uint16Array((WINDOW_REGION_RECTANGLE_LIMIT + 1) * 4) }])
    assert.throws(() => validateWindowRegion(bad), /Invalid Window region/)
  const copy = copyWindowRegion(good)
  copy.rectangles[0] = 1
  assert.equal(good.rectangles[0], 0)
  const registry = new WindowRegions()
  assert.throws(() => registry.replace(1, { ...good, width: 0 } as WindowRegion), /Invalid Window region/)
  assert.deepEqual(registry.inspect(), { regions: 0, bytes: 0 })
})
