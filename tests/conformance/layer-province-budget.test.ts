import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { LayerTree } from '../../src/engine/scene/layers.ts'

function imageState(tree: LayerTree, id: number) {
  const layer = tree.get(id),
    bitmap = layer.bitmap,
    province = layer.province
  return {
    geometry: [layer.left, layer.top, layer.width, layer.height, layer.imageLeft, layer.imageTop],
    type: layer.type,
    neutralColor: layer.neutralColor,
    clip: { ...(bitmap?.clip ?? layer.clipBeforeRelease) },
    imageModified: layer.imageModified,
    revision: layer.revision,
    provinceGeneration: layer.provinceGeneration,
    main: bitmap && {
      width: bitmap.width,
      height: bitmap.height,
      revision: bitmap.revision,
      bytes: bitmap.bytes,
      hash: createHash('sha256').update(bitmap.pixels.data).digest('hex'),
    },
    province: province && {
      width: province.width,
      height: province.height,
      bytes: province.bytes,
      hash: createHash('sha256').update(province.data).digest('hex'),
    },
    accounting: tree.inspect(),
  }
}

test('joint main and Province resize rejects the full budget delta before changing either plane', () => {
  const tree = new LayerTree(),
    id = tree.create(0)
  try {
    tree.resizeImage(id, 2, 2)
    tree.setPixel(id, 1, 1, 0x123456, 'main')
    tree.setPixel(id, 1, 1, 37, 'province')
    tree.bitmap(id).setClip({ x: 1, y: 0, width: 1, height: 2 })
    tree.set(id, 'imageModified', 0)
    const bitmap = tree.bitmap(id),
      pixels = bitmap.pixels.data,
      province = tree.get(id).province!,
      provinceData = province.data,
      before = imageState(tree, id)
    assert.equal(before.accounting.bitmapBytes, 20)

    // The requested persistent pair would be 80 MiB. Budget rejection must
    // happen before either the 64 MiB main or the 16 MiB Province is allocated.
    assert.throws(() => tree.resizeImage(id, 4096, 4096), /64 MiB budget/)
    assert.equal(tree.get(id).bitmap, bitmap)
    assert.equal(bitmap.pixels.data, pixels)
    assert.equal(tree.get(id).province, province)
    assert.equal(province.data, provinceData)
    assert.deepEqual(imageState(tree, id), before)
  } finally {
    tree.clear()
  }
})

test('restoring a main image preflights its combined budget with an existing independent Province', () => {
  const tree = new LayerTree(),
    id = tree.create(0)
  try {
    tree.bitmap(id).setClip({ x: 1, y: 1, width: 2, height: 2 })
    tree.set(id, 'hasImage', 0)
    tree.resize(id, 4096, 4096)
    // This ordinary first write owns one 16 MiB plane and keeps the saved clip.
    tree.setPixel(id, 1, 1, 53, 'province')
    tree.set(id, 'imageModified', 0)
    const province = tree.get(id).province!,
      provinceData = province.data,
      before = imageState(tree, id)
    assert.equal(before.main, undefined)
    assert.equal(before.accounting.bitmapBytes, 16 * 1024 * 1024)

    assert.throws(() => tree.set(id, 'hasImage', 1), /64 MiB budget/)
    assert.equal(tree.get(id).bitmap, undefined)
    assert.equal(tree.get(id).province, province)
    assert.equal(province.data, provinceData)
    assert.deepEqual(imageState(tree, id), before)

    // Opaque -> Alpha also allocates MainImage; a rejected allocation must
    // preserve the original type and neutral color as well as both plane states.
    assert.throws(() => tree.set(id, 'type', 2), /64 MiB budget/)
    assert.equal(tree.get(id).bitmap, undefined)
    assert.equal(tree.get(id).province, province)
    assert.equal(province.data, provinceData)
    assert.deepEqual(imageState(tree, id), before)

    tree.releaseImages(id)
    assert.equal(tree.inspect().bitmapBytes, 0)
    tree.resize(id, 2, 2)
    tree.set(id, 'hasImage', 1)
    tree.image(id, { width: 1, height: 1, data: new Uint8Array([12, 34, 56, 78]) })
    assert.equal(tree.inspect().bitmapBytes, 4)
    assert.equal(tree.get(id).province, undefined)
    assert.deepEqual([...tree.bitmap(id).pixels.data], [12, 34, 56, 78])
  } finally {
    tree.clear()
  }
})
