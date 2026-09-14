import test from 'node:test'
import assert from 'node:assert/strict'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { Bitmap } from '../../src/engine/graphics/bitmap.ts'

test('gamma adjustment respects channel ranges, clipping, transparency and additive light', () => {
  const bitmap = new Bitmap(3, 1, 0x80404040)
  bitmap.setPixel(1, 0, 0, 'mask')
  bitmap.setClip({ x: 0, y: 0, width: 2, height: 1 })
  bitmap.adjustGamma([
    { gamma: 2, floor: 0, ceil: 255 },
    { gamma: 1, floor: 255, ceil: 0 },
    { gamma: 0, floor: 20, ceil: 230 },
  ])
  assert.equal(bitmap.getPixel(0, 0, 'main'), 0x80bf14)
  assert.equal(bitmap.getPixel(0, 0, 'mask'), 128)
  assert.equal(bitmap.getPixel(1, 0, 'main'), 0x404040)
  assert.equal(bitmap.getPixel(2, 0, 'main'), 0x404040)
  const additive = new Bitmap(2, 1, 0x800020c0)
  additive.setPixel(1, 0, 0, 'mask')
  additive.adjustGamma(
    Array.from({ length: 3 }, () => ({ gamma: 1, floor: 255, ceil: 255 })),
    true,
  )
  assert.equal(additive.getPixel(0, 0, 'main'), 0x8080c0)
  assert.equal(additive.getPixel(1, 0, 'main'), 0x0020c0)
  assert.equal(additive.getPixel(0, 0, 'mask'), 128)
})

test('display resizing preserves the backing image and image resizing constrains the viewport', () => {
  const tree = new LayerTree(),
    root = tree.create(0),
    child = tree.create(root)
  assert.equal(tree.property(child, 'visible'), false)
  assert.equal(tree.property(child, 'imageWidth'), 32)
  tree.resizeImage(child, 5, 3)
  tree.fill(child, { x: 0, y: 0, width: 5, height: 3 }, 0x80123456)
  tree.resize(child, 2, 2)
  tree.imagePosition(child, -3, -1)
  assert.equal(tree.bitmap(child).getPixel(4, 2, 'main'), 0x123456)
  assert.equal(tree.bitmap(child).getPixel(4, 2, 'mask'), 128)
  tree.resize(child, 4, 3)
  assert.deepEqual(
    [
      tree.property(child, 'imageWidth'),
      tree.property(child, 'imageLeft'),
      tree.property(child, 'imageTop'),
    ],
    [5, -1, 0],
  )
  assert.throws(() => tree.imagePosition(child, -2, 0), /offset/)
  tree.resizeImage(child, 1, 1)
  assert.deepEqual(
    [
      tree.property(child, 'width'),
      tree.property(child, 'height'),
      tree.property(child, 'imageLeft'),
    ],
    [1, 1, 0],
  )
})

test('drawing clips, mask and province pixels control hit testing independently of image color', () => {
  const tree = new LayerTree(),
    root = tree.create(0),
    child = tree.create(root)
  tree.resizeImage(child, 4, 4)
  tree.set(child, 'visible', 1)
  tree.bitmap(child).setClip({ x: 1, y: 1, width: 2, height: 2 })
  tree.set(child, 'face', 3)
  tree.fill(child, { x: 0, y: 0, width: 4, height: 4 }, 7)
  assert.equal(tree.bitmap(child).getPixel(0, 0, 'province'), 0)
  assert.equal(tree.bitmap(child).getPixel(1, 1, 'province'), 7)
  assert.equal(tree.hitTest(1, 1)?.id, root)
  tree.set(child, 'hitType', 1)
  assert.equal(tree.hitTest(1, 1)?.id, child)
  tree.set(child, 'enabled', 0)
  // A disabled hit blocks the lower layer; it does not make the pixel transparent.
  assert.equal(tree.hitTest(1, 1), undefined)
  assert.equal(tree.hitTest(1, 1, undefined, false, true)?.id, child)
  tree.set(child, 'enabled', 1)
  tree.set(child, 'hitType', 0)
  tree.setPixel(child, 1, 1, 255, 'mask')
  assert.equal(tree.hitTest(1, 1)?.id, child)
  tree.set(child, 'face', 1)
  tree.set(child, 'holdAlpha', 1)
  tree.fill(child, { x: 0, y: 0, width: 4, height: 4 }, 0x0099aabb)
  assert.equal(tree.bitmap(child).getPixel(1, 1, 'mask'), 255)
  assert.equal(tree.bitmap(child).getPixel(0, 0, 'main'), 0xffffff)
})

test('overlapping copies use original source pixels and main-only copies preserve masks', () => {
  const bitmap = new Bitmap(4, 1, 0x7f000000)
  for (let x = 0; x < 4; x++) bitmap.setPixel(x, 0, x + 1, 'main')
  bitmap.copy(bitmap, 1, 0, { x: 0, y: 0, width: 3, height: 1 }, 0)
  assert.deepEqual(
    [0, 1, 2, 3].map((x) => bitmap.getPixel(x, 0, 'main')),
    [1, 1, 2, 3],
  )
  const source = new Bitmap(4, 1, 0xff123456)
  bitmap.copy(source, 0, 0, { x: 0, y: 0, width: 4, height: 1 }, 1)
  assert.equal(bitmap.getPixel(2, 0, 'mask'), 127)
  bitmap.setClip({ x: 1, y: 0, width: 2, height: 1 })
  bitmap.setPixel(1, 0, 1, 'main')
  bitmap.setPixel(2, 0, 2, 'main')
  bitmap.flip(true)
  assert.deepEqual(
    [0, 1, 2, 3].map((x) => bitmap.getPixel(x, 0, 'main')),
    [0x123456, 2, 1, 0x123456],
  )
})

test('relative and absolute ordering survive reparenting, while destroying a parent detaches children', () => {
  const tree = new LayerTree(),
    root = tree.create(0),
    a = tree.create(root),
    b = tree.create(root),
    c = tree.create(root)
  tree.set(a, 'absolute', 10)
  tree.set(c, 'absolute', -1)
  assert.deepEqual(tree.get(root).children, [c, b, a])
  tree.move(a, c, false)
  assert.deepEqual(tree.get(root).children, [a, c, b])
  assert.equal(tree.get(root).absoluteOrderMode, false)
  tree.reparent(c, b)
  assert.throws(() => tree.reparent(b, c), /Cyclic/)
  tree.destroy(b)
  assert.equal(tree.get(c).parent, 0)
  assert.equal(tree.property(c, 'nodeVisible'), false)
  tree.destroy(c)
  tree.destroy(a)
  tree.destroy(root)
  assert.equal(tree.inspect().bitmapBytes, 0)
})

test('colorRect follows TVP fixed-point alpha arithmetic, including erase and premultiplied color', () => {
  const alpha = new Bitmap(1, 1, 0x00ffffff)
  alpha.color({ x: 0, y: 0, width: 1, height: 1 }, 0xff0000, 128, 0)
  assert.deepEqual(Array.from(alpha.pixels.data), [255, 0, 0, 129])
  alpha.color({ x: 0, y: 0, width: 1, height: 1 }, 0, -128, 0)
  assert.equal(alpha.getPixel(0, 0, 'mask'), 63)
  const premultiplied = new Bitmap(1, 1, 0)
  premultiplied.color({ x: 0, y: 0, width: 1, height: 1 }, 0xff0000, 128, 4)
  assert.deepEqual(Array.from(premultiplied.pixels.data), [127, 0, 0, 128])
})
