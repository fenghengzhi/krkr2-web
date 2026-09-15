import test from 'node:test'
import assert from 'node:assert/strict'
import { captureVideoMixingBitmap } from '../../src/engine/media/video-mixing.ts'
import { defaultVideoSettings } from '../../src/engine/ports/video.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'

function fixture() {
  const tree = new LayerTree(),
    id = tree.create(0),
    layer = tree.get(id),
    settings = { ...defaultVideoSettings(), mode: 2 as const, width: 64, height: 48 },
    window = { zoomNumer: 1, zoomDenom: 1 }
  tree.resizeImage(id, 2, 1)
  layer.visible = true
  return { tree, id, layer, settings, window }
}

test('video mixing captures all MainImage RGB without its mask, type, children, or clip', () => {
  const f = fixture(),
    bitmap = f.tree.bitmap(f.id)
  bitmap.pixels.data.set([12, 34, 56, 0, 98, 76, 54, 128])
  bitmap.setClip({ x: 1, y: 0, width: 1, height: 1 })
  f.layer.type = 2
  f.layer.opacity = 128
  f.layer.children.push(999)
  const captured = captureVideoMixingBitmap(f.layer, f.settings, f.window)!
  assert.deepEqual([...captured.pixels.data], [12, 34, 56, 255, 98, 76, 54, 255])
  assert.deepEqual([...bitmap.pixels.data], [12, 34, 56, 0, 98, 76, 54, 128])
  assert.equal(captured.opacity, 0.501960813999176)
  bitmap.pixels.data.fill(7)
  bitmap.resize(4, 2, 0)
  f.layer.left = 30
  f.layer.opacity = 0
  assert.deepEqual([...captured.pixels.data], [12, 34, 56, 255, 98, 76, 54, 255])
  assert.deepEqual([captured.pixels.width, captured.pixels.height], [2, 1])
  assert.equal(captured.destination.left, 0.0078125)
  assert.equal(captured.opacity, 0.501960813999176)
})

test('hidden mixing sources reset before MainImage access, while visible no-image sources fail', () => {
  const f = fixture()
  f.layer.bitmap = undefined
  f.layer.visible = false
  assert.equal(captureVideoMixingBitmap(f.layer, f.settings, f.window), null)
  f.layer.visible = true
  for (const mode of [0, 1, 2] as const)
    assert.throws(
      () => captureVideoMixingBitmap(f.layer, { ...f.settings, mode }, f.window),
      /no drawable image/,
    )
})

test('valid non-mixer sources are ignored after the native MainImage precondition', () => {
  const f = fixture()
  for (const mode of [0, 1] as const)
    assert.equal(captureVideoMixingBitmap(f.layer, { ...f.settings, mode }, f.window), null)
})

test('mixing coordinates use rounded output edges and local image offsets, not movie origin', () => {
  const f = fixture()
  Object.assign(f.settings, { left: 1, top: -1, width: 3, height: 3 })
  Object.assign(f.window, { zoomNumer: 3, zoomDenom: 2 })
  Object.assign(f.layer, { left: 2, top: 2, imageLeft: -1, imageTop: -1, parent: 100 })
  const captured = captureVideoMixingBitmap(f.layer, f.settings, f.window)!
  // Native edge rounding yields output width 6-2=4 and height 3-(-2)=5.
  assert.deepEqual(captured.destination, {
    left: 0.375,
    top: 0.30000001192092896,
    right: 0.875,
    bottom: 0.5,
  })
  Object.assign(f.settings, { width: 6, height: 6 })
  const replacement = captureVideoMixingBitmap(f.layer, f.settings, f.window)!
  assert.notDeepEqual(replacement.destination, captured.destination)
  assert.equal(captured.destination.left, 0.375)
})

test('output edge rounding is not equivalent to rounding the video width', () => {
  const f = fixture()
  Object.assign(f.settings, { left: 1, top: 0, width: 3, height: 2 })
  Object.assign(f.window, { zoomNumer: 1, zoomDenom: 2 })
  const captured = captureVideoMixingBitmap(f.layer, f.settings, f.window)!
  // round(4/2)-round(1/2) = 1, not round(3/2) = 2.
  assert.equal(captured.destination.left, 0.5)
  assert.equal(captured.destination.right, 2.5)
})

test('zero opacity still captures opaque source RGB and preserves the Layer image', () => {
  const f = fixture()
  f.layer.opacity = 0
  f.tree.bitmap(f.id).pixels.data.set([1, 2, 3, 4, 5, 6, 7, 8])
  const captured = captureVideoMixingBitmap(f.layer, f.settings, f.window)!
  assert.equal(captured.opacity, 0)
  assert.deepEqual([...captured.pixels.data], [1, 2, 3, 255, 5, 6, 7, 255])
  assert.equal(f.tree.bitmap(f.id).pixels.data[3], 4)
})
