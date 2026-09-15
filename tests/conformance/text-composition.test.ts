import test from 'node:test'
import assert from 'node:assert/strict'
import { Bitmap } from '../../src/engine/graphics/bitmap.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import type { Pixels } from '../../src/engine/ports/graphics.ts'

const glyph: Pixels = {
  width: 3,
  height: 1,
  data: new Uint8Array([255, 64, 32, 0, 255, 64, 32, 128, 255, 64, 32, 255]),
}

test('text composition rejects unsupported faces before touching empty or transparent glyphs', () => {
  for (const [face, opacity] of [
    [2, 0],
    [3, 255],
    [4, -1],
  ]) {
    const tree = new LayerTree(),
      id = tree.create(0)
    tree.resizeImage(id, 3, 1)
    const bitmap = tree.bitmap(id)
    bitmap.fill(bitmap.clip, 0x7f123456, 0, false)
    tree.get(id).face = face!
    const before = bitmap.pixels.data.slice(),
      revision = bitmap.revision
    for (const image of [glyph, { width: 0, height: 0, data: new Uint8Array() }])
      assert.throws(() => tree.composite(id, image, 20, 20, opacity!), /dfAlpha|dfAddAlpha/)
    assert.deepEqual(bitmap.pixels.data, before)
    assert.equal(bitmap.revision, revision)
    assert.equal(tree.get(id).province, undefined)
  }
})

test('zero text opacity and negative opaque opacity preserve every plane and revision', () => {
  for (const [face, opacity] of [
    [0, 0],
    [1, 0],
    [4, 0],
    [1, -1],
    [1, -1000],
  ])
    for (const hold of [false, true]) {
      const tree = new LayerTree(),
        id = tree.create(0)
      tree.resizeImage(id, 3, 1)
      const bitmap = tree.bitmap(id),
        layer = tree.get(id)
      bitmap.fill(bitmap.clip, 0x7f123456, 0, false)
      for (let x = 0; x < 3; x++) tree.setPixel(id, x, 0, x + 7, 'province')
      layer.face = face!
      layer.holdAlpha = hold
      const before = bitmap.pixels.data.slice(),
        revision = bitmap.revision
      assert.equal(tree.composite(id, glyph, 0, 0, opacity!), false)
      assert.deepEqual(bitmap.pixels.data, before)
      assert.deepEqual([...layer.province!.data], [7, 8, 9])
      assert.equal(bitmap.revision, revision)
    }
})

test('text clamps over-range positive opacity and Alpha removal at their supported endpoints', () => {
  for (const face of [0, 1, 4]) {
    const full = new Bitmap(3, 1, 0x7f123456),
      clamped = new Bitmap(3, 1, 0x7f123456)
    full.composite(glyph, 0, 0, face, 255)
    clamped.composite(glyph, 0, 0, face, 500)
    assert.deepEqual(clamped.pixels.data, full.pixels.data)
  }
  const full = new Bitmap(3, 1, 0x7f123456),
    clamped = new Bitmap(3, 1, 0x7f123456)
  full.composite(glyph, 0, 0, 0, -255)
  clamped.composite(glyph, 0, 0, 0, -500)
  assert.deepEqual(clamped.pixels.data, full.pixels.data)
  assert.deepEqual([...clamped.pixels.data.subarray(8)], [0x12, 0x34, 0x56, 0])
})

test('Alpha and AddAlpha text ignore holdAlpha for RGB and destination alpha', () => {
  for (const face of [0, 4])
    for (const opacity of [64, 255]) {
      const regular = new Bitmap(3, 1, 0x40123456),
        held = new Bitmap(3, 1, 0x40123456)
      regular.composite(glyph, 0, 0, face, opacity, false)
      held.composite(glyph, 0, 0, face, opacity, true)
      assert.deepEqual(held.pixels.data, regular.pixels.data)
      assert(held.pixels.data[11]! > 0x40)
    }
  const regular = new Bitmap(3, 1, 0x7f123456),
    held = new Bitmap(3, 1, 0x7f123456)
  regular.composite(glyph, 0, 0, 0, -255, false)
  held.composite(glyph, 0, 0, 0, -255, true)
  assert.deepEqual(held.pixels.data, regular.pixels.data)
  assert.equal(held.pixels.data[11], 0)
})

test('opaque text holds or clears alpha across the entire intersecting glyph box', () => {
  const regular = new Bitmap(3, 1, 0x7f123456),
    held = new Bitmap(3, 1, 0x7f123456)
  regular.composite(glyph, 0, 0, 1, 255, false)
  held.composite(glyph, 0, 0, 1, 255, true)
  for (let pixel = 0; pixel < 3; pixel++) {
    const at = pixel * 4
    assert.deepEqual(
      held.pixels.data.subarray(at, at + 3),
      regular.pixels.data.subarray(at, at + 3),
    )
    assert.equal(held.pixels.data[at + 3], 0x7f)
    assert.equal(regular.pixels.data[at + 3], 0)
  }
  // Coverage zero still clears opaque alpha, as TVPApplyColorMap65 does.
  assert.deepEqual([...regular.pixels.data.subarray(0, 4)], [0x12, 0x34, 0x56, 0])
})

test('text update state follows clipped glyph rectangles, including zero-coverage intersections', () => {
  const tree = new LayerTree(),
    id = tree.create(0),
    layer = tree.get(id)
  tree.resizeImage(id, 3, 1)
  layer.face = 0
  layer.imageModified = false
  const bitmap = tree.bitmap(id),
    before = bitmap.pixels.data.slice(),
    revision = bitmap.revision
  assert.equal(tree.composite(id, glyph, 3, 0), false)
  assert.equal(tree.composite(id, { width: 0, height: 0, data: new Uint8Array() }, 0, 0), false)
  assert.equal(layer.imageModified, false)
  assert.equal(bitmap.revision, revision)
  bitmap.setClip({ x: 0, y: 0, width: 1, height: 1 })
  assert.equal(tree.composite(id, glyph, 0, 0), true)
  assert.equal(layer.imageModified, true)
  assert(bitmap.revision > revision)
  assert.deepEqual(bitmap.pixels.data, before)
  // A subsequent non-draw must preserve an already true ImageModified flag.
  assert.equal(tree.composite(id, glyph, 0, 0, 0), false)
  assert.equal(layer.imageModified, true)
})
