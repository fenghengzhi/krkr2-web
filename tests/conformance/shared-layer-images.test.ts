import test from 'node:test'
import assert from 'node:assert/strict'
import { LayerTree } from '../../src/engine/scene/layers.ts'

const MiB = 1024 * 1024
const rgba = () => Uint8Array.of(17, 34, 51, 77, 68, 85, 102, 88, 119, 136, 153, 99, 170, 187, 204, 111)
const provinces = () => Uint8Array.of(3, 5, 7, 11)
const main = (tree: LayerTree, id: number) => tree.bitmap(id).readPixels.data
const province = (tree: LayerTree, id: number) => tree.get(id).province!.readData
function image(tree: LayerTree, id: number) {
  tree.image(id, { width: 2, height: 2, data: rgba() }, provinces())
}
function state(tree: LayerTree, id: number) {
  const layer = tree.get(id), bitmap = tree.bitmap(id)
  return { bytes: tree.inspect().bitmapBytes, main: main(tree, id), province: layer.province?.readData,
    clip: { ...bitmap.clip }, geometry: [layer.width, layer.height, bitmap.width, bitmap.height, layer.imageLeft, layer.imageTop],
    modified: layer.imageModified, revision: layer.revision, bitmapRevision: bitmap.revision,
    provinceGeneration: layer.provinceGeneration,
    first: [tree.getPixel(id, 0, 0, 'main'), tree.getPixel(id, 0, 0, 'mask'), tree.getPixel(id, 0, 0, 'province')] }
}

test('new Layers share the transparent default image until an actual write, without sharing clips', () => {
  const tree = new LayerTree(), a = tree.create(0), b = tree.create(0), c = tree.create(0)
  try {
    const initial = main(tree, a)
    assert.equal(main(tree, b), initial); assert.equal(main(tree, c), initial)
    assert.equal(tree.inspect().bitmapBytes, 4096)
    tree.bitmap(a).setClip({ x: 1, y: 0, width: 1, height: 1 })
    assert.deepEqual(tree.bitmap(b).clip, { x: 0, y: 0, width: 32, height: 32 })
    assert.equal(tree.getPixel(a, 0, 0, 'main'), 0xffffff)
    assert.equal(tree.getPixel(a, 0, 0, 'mask'), 0)
    assert.equal(tree.setPixel(a, 0, 0, 0x123456, 'main'), false)
    assert.equal(tree.fill(a, { x: 0, y: 0, width: 0, height: 1 }, 0xff123456), false)
    assert.equal(main(tree, a), initial, 'Read-only and empty/clipped writes do not allocate')
    tree.setPixel(a, 1, 0, 0x123456, 'main')
    assert.notEqual(main(tree, a), initial)
    assert.equal(tree.getPixel(b, 1, 0, 'main'), 0xffffff)
    assert.equal(tree.inspect().bitmapBytes, 8192)
    tree.destroy(a)
    assert.equal(tree.inspect().bitmapBytes, 4096)
  } finally { tree.clear() }
})

test('assigned main and Province planes separate independently on writes in both directions', () => {
  const tree = new LayerTree(), source = tree.create(0), target = tree.create(0)
  try {
    image(tree, source); tree.assignImages(target, source)
    const sharedMain = main(tree, source), sharedProvince = province(tree, source)
    assert.equal(main(tree, target), sharedMain); assert.equal(province(tree, target), sharedProvince)
    assert.equal(tree.inspect().bitmapBytes, 20)
    tree.bitmap(target).setClip({ x: 1, y: 0, width: 1, height: 2 })
    assert.equal(tree.setPixel(target, 0, 0, 201, 'mask'), false)
    assert.equal(tree.setPixel(target, 0, 0, 29, 'province'), false)
    assert.equal(main(tree, target), sharedMain); assert.equal(province(tree, target), sharedProvince)
    tree.setPixel(target, 1, 0, 0xabcdef, 'main'); tree.setPixel(target, 1, 0, 201, 'mask')
    assert.notEqual(main(tree, target), sharedMain); assert.equal(province(tree, target), sharedProvince)
    assert.equal(tree.inspect().bitmapBytes, 36)
    assert.deepEqual([...main(tree, source)], [...rgba()])
    tree.setPixel(source, 0, 1, 0x010203, 'main')
    assert.equal(tree.getPixel(target, 0, 1, 'main'), 0x778899)
    tree.setPixel(target, 1, 0, 29, 'province')
    assert.notEqual(province(tree, target), sharedProvince)
    tree.setPixel(source, 0, 1, 31, 'province')
    assert.deepEqual([...province(tree, target)], [3, 29, 7, 11])
    assert.deepEqual([...province(tree, source)], [3, 5, 31, 11])
    assert.equal(tree.inspect().bitmapBytes, 40)
  } finally { tree.clear() }
})

test('independ copies shared planes and leaves exclusive planes intact even when copy is false', () => {
  const tree = new LayerTree(), source = tree.create(0), target = tree.create(0)
  try {
    image(tree, source); tree.assignImages(target, source)
    const sharedMain = main(tree, source), sharedProvince = province(tree, source)
    tree.independImage(target, 'main')
    assert.notEqual(main(tree, target), sharedMain); assert.deepEqual([...main(tree, target)], [...rgba()])
    assert.equal(province(tree, target), sharedProvince)
    tree.independImage(target, 'province')
    assert.notEqual(province(tree, target), sharedProvince); assert.deepEqual([...province(tree, target)], [...provinces()])
    const exclusiveMain = main(tree, target), exclusiveProvince = province(tree, target), before = state(tree, target)
    tree.independImage(target, 'main', false); tree.independImage(target, 'province', false)
    assert.equal(main(tree, target), exclusiveMain); assert.equal(province(tree, target), exclusiveProvince)
    assert.deepEqual(state(tree, target), before)
    tree.assignImages(target, source)
    tree.independImage(target, 'main', false); tree.independImage(target, 'province', false)
    assert.notEqual(main(tree, target), sharedMain); assert.notEqual(province(tree, target), sharedProvince)
    // Native does not promise initialized bytes for shared independ(false).
    // Observe the source, then explicitly write the new destination.
    assert.deepEqual([...main(tree, source)], [...rgba()]); assert.deepEqual([...province(tree, source)], [...provinces()])
    tree.setPixel(target, 0, 0, 0x654321, 'main'); tree.setPixel(target, 0, 0, 37, 'province')
    assert.equal(tree.getPixel(source, 0, 0, 'main'), 0x112233)
    assert.equal(tree.getPixel(source, 0, 0, 'province'), 3)
  } finally { tree.clear() }
})

test('reassigning the same shared image resets only destination clip and does not request another image update', () => {
  const tree = new LayerTree(), source = tree.create(0), target = tree.create(0)
  try {
    image(tree, source)
    tree.bitmap(source).setClip({ x: 1, y: 1, width: 1, height: 1 })
    assert.equal(tree.assignImages(target, source), true)
    const shared = main(tree, target), revision = tree.get(target).revision
    tree.bitmap(target).setClip({ x: 1, y: 0, width: 0, height: 1 })
    tree.set(target, 'imageModified', 0)
    assert.equal(tree.assignImages(target, source), false)
    assert.equal(main(tree, target), shared); assert.equal(tree.get(target).revision, revision)
    assert.equal(tree.get(target).imageModified, true)
    assert.deepEqual(tree.bitmap(target).clip, { x: 0, y: 0, width: 2, height: 2 })
    assert.deepEqual(tree.bitmap(source).clip, { x: 1, y: 1, width: 1, height: 1 })
    assert.equal(tree.inspect().bitmapBytes, 20)
    // Writable backend access also isolates the recipient, without relying on
    // every caller to have separately remembered an independ() call.
    tree.bitmap(target).pixels.data[0] = 201
    tree.get(target).province!.data[0] = 47
    assert.equal(main(tree, source)[0], 17); assert.equal(province(tree, source)[0], 3)
    assert.equal(tree.inspect().bitmapBytes, 40)
    const heldMain = tree.bitmap(source).pixels.data, heldProvince = tree.get(source).province!.data
    tree.assignImages(target, source)
    heldMain[0] = 202; heldProvince[0] = 53
    assert.equal(main(tree, source)[0], 202); assert.equal(province(tree, source)[0], 53)
    assert.equal(main(tree, target)[0], 17); assert.equal(province(tree, target)[0], 3)
    assert.notEqual(main(tree, target), heldMain); assert.notEqual(province(tree, target), heldProvince)
  } finally { tree.clear() }
})

test('resizing and publishing decoded rows cannot mutate a shared source or an earlier row snapshot', () => {
  const tree = new LayerTree(), source = tree.create(0), target = tree.create(0), observer = tree.create(0)
  try {
    image(tree, source); tree.assignImages(target, source); tree.assignImages(observer, source)
    tree.set(target, 'neutralColor', 0x00112233)
    tree.resizeImage(target, 3, 2)
    assert.deepEqual([...main(tree, source)], [...rgba()]); assert.deepEqual([...province(tree, source)], [...provinces()])
    assert.notEqual(main(tree, target), main(tree, source)); assert.notEqual(province(tree, target), province(tree, source))
    assert.equal(tree.getPixel(target, 1, 1, 'main'), 0xaabbcc)
    assert.equal(tree.getPixel(target, 2, 1, 'main'), 0x112233)
    assert.equal(tree.getPixel(target, 2, 1, 'mask'), 0)
    assert.equal(tree.getPixel(target, 2, 1, 'province'), 0)
    const load = tree.beginImageLoad(target)
    assert.equal(tree.sizeImageLoad(load, 2, 2), true)
    assert.equal(tree.rowImageLoad(load, 0, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)), true)
    tree.assignImages(observer, target)
    const partial = main(tree, observer)
    assert.equal(main(tree, target), partial)
    assert.equal(tree.rowImageLoad(load, 1, Uint8Array.of(9, 10, 11, 12, 13, 14, 15, 16)), true)
    assert.notEqual(main(tree, target), partial)
    assert.deepEqual([...partial], [1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0])
    assert.deepEqual([...main(tree, source)], [...rgba()])
    tree.image(target, { width: 1, height: 1, data: Uint8Array.of(91, 92, 93, 94) }, Uint8Array.of(95))
    assert.deepEqual([...main(tree, target)], [91, 92, 93, 94]); assert.deepEqual([...province(tree, target)], [95])
    assert.equal(main(tree, observer), partial); assert.deepEqual([...province(tree, source)], [...provinces()])
  } finally { tree.clear() }
})

test('large assigned images consume one allocation and reject an over-budget write before changing either plane', () => {
  const tree = new LayerTree(), source = tree.create(0), a = tree.create(0), b = tree.create(0), c = tree.create(0)
  try {
    // One 20-MiB main image plus one 5-MiB Province. Four independent copies
    // would need 100 MiB; three ordinary assignments must still own only 25 MiB.
    tree.resizeImage(source, 2560, 2048)
    tree.setPixel(source, 0, 0, 0x112233, 'main'); tree.setPixel(source, 0, 0, 77, 'mask')
    tree.setPixel(source, 0, 0, 17, 'province')
    for (const id of [a, b, c]) tree.assignImages(id, source)
    assert.equal(tree.inspect().bitmapBytes, 25 * MiB)
    tree.setPixel(a, 0, 0, 0xabcdef, 'main')
    assert.equal(tree.inspect().bitmapBytes, 45 * MiB)
    tree.set(b, 'imageModified', 0)
    const before = state(tree, b), sharedMain = main(tree, source), sharedProvince = province(tree, source)
    for (const write of [
      () => tree.setPixel(b, 0, 0, 201, 'mask'),
      () => tree.independImage(b, 'main'),
      () => tree.resizeImage(b, 3072, 2048),
      () => tree.flip(b, true),
    ]) {
      assert.throws(write, /64 MiB budget/)
      assert.deepEqual(state(tree, b), before)
      assert.equal(main(tree, b), sharedMain); assert.equal(province(tree, b), sharedProvince)
    }
    tree.releaseImages(a)
    assert.equal(tree.inspect().bitmapBytes, 25 * MiB)
    tree.setPixel(b, 0, 0, 201, 'mask')
    assert.equal(tree.inspect().bitmapBytes, 45 * MiB)
    assert.equal(tree.getPixel(source, 0, 0, 'mask'), 77); assert.equal(tree.getPixel(c, 0, 0, 'mask'), 77)
    assert.equal(tree.getPixel(b, 0, 0, 'mask'), 201)
  } finally { tree.clear() }
  assert.equal(tree.inspect().bitmapBytes, 0)
})
