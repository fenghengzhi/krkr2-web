import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { blendPixel } from '../../src/engine/graphics/blend.ts'
import { blendCases } from '../helpers/blend-vectors.ts'
import { Bitmap } from '../../src/engine/graphics/bitmap.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { SceneComposer } from '../../src/engine/scene/composer.ts'

test('TVP image operations match the independent native scalar reference', () => {
  const reference = readFileSync(new URL('../fixtures/blend-reference.bin', import.meta.url))
  const metadata = JSON.parse(
    readFileSync(new URL('../fixtures/blend-reference.json', import.meta.url), 'utf8'),
  )
  assert.equal(createHash('sha256').update(reference).digest('hex'), metadata.sha256)
  const destination = Buffer.alloc(4),
    source = Buffer.alloc(4)
  const failures: unknown[] = []
  let index = 0,
    mismatches = 0
  for (const c of blendCases()) {
    destination.writeUInt32LE(c.destination)
    source.writeUInt32LE(c.source)
    blendPixel(destination, 0, source, 0, c.mode, c.face, c.opacity, c.hold)
    const actual = destination.readUInt32LE(),
      expected = reference.readUInt32LE(index++ * 4)
    if (actual !== expected) {
      mismatches++
      if (failures.length < 20) failures.push({ ...c, actual, expected })
    }
  }
  assert.equal(index, metadata.cases)
  assert.equal(mismatches, 0, JSON.stringify({ mismatches, failures }, null, 2))
})

test('additive alpha onto straight alpha preserves coverage and clamps excess emission', () => {
  const dest = new Uint8Array([20, 80, 140, 0])
  blendPixel(dest, 0, new Uint8Array([64, 32, 0, 128]), 0, 12, 0, 255, false)
  assert.deepEqual([...dest], [128, 64, 0, 128])
  blendPixel(dest, 0, new Uint8Array([255, 255, 255, 0]), 0, 12, 0, 255, false)
  assert.deepEqual([...dest], [255, 255, 255, 128])
})

test('rectangle operations clip both images and read overlapping self-copies before writing', () => {
  const bitmap = new Bitmap(5, 1, 0x49304050)
  for (let x = 0; x < 5; x++) bitmap.setPixel(x, 0, (x + 1) * 0x101010, 'main')
  bitmap.operate(bitmap.pixels, 1, 0, { x: 0, y: 0, width: 4, height: 1 }, 3, 1, 255, true)
  assert.deepEqual(
    Array.from({ length: 5 }, (_, x) => bitmap.getPixel(x, 0, 'main')),
    [0x101010, 0x303030, 0x505050, 0x707070, 0x909090],
  )
  bitmap.setClip({ x: 2, y: 0, width: 2, height: 1 })
  const source = new Bitmap(1, 1, 0x00ff0000)
  bitmap.operate(source.pixels, 1, 0, { x: -2, y: 0, width: 4, height: 1 }, 1, 1, 255, true)
  assert.deepEqual(
    Array.from({ length: 5 }, (_, x) => bitmap.getPixel(x, 0, 'main')),
    [0x101010, 0x303030, 0x505050, 0xff0000, 0x909090],
  )
  assert.equal(bitmap.getPixel(3, 0, 'mask'), 73)
  const revision = bitmap.revision
  assert.equal(
    bitmap.operate(source.pixels, 2, 0, { x: 0, y: 0, width: 1, height: 1 }, 3, 1, 0),
    false,
  )
  assert.equal(bitmap.revision, revision)
  assert.throws(() => bitmap.operate(source.pixels, 0, 0, bitmap.clip, 128, 1), /operation mode/)
  assert.throws(() => bitmap.operate(source.pixels, 0, 0, bitmap.clip, 2, 3), /dfAlpha/)
})

test('destination-dependent scene modes and snapshots match the native scalar drawing result', () => {
  const reference = readFileSync(new URL('../fixtures/blend-reference.bin', import.meta.url))
  let index = 0
  for (const c of blendCases()) {
    const expected = reference.subarray(index++ * 4, index * 4)
    if (
      [1, 2, 12].includes(c.mode) ||
      c.face !== 1 ||
      c.hold ||
      c.destination !== 0x807f0080 ||
      c.source !== 0x7f80ff7f ||
      ![127, 255].includes(c.opacity)
    )
      continue
    const layers = new LayerTree(),
      root = layers.create(0),
      child = layers.create(root)
    layers.resize(root, 1, 1)
    layers.resize(child, 1, 1)
    layers.set(child, 'type', c.mode)
    layers.set(child, 'visible', 1)
    layers.set(child, 'opacity', c.opacity)
    const dest = Buffer.alloc(4),
      source = Buffer.alloc(4)
    dest.writeUInt32LE(c.destination)
    source.writeUInt32LE(c.source)
    layers.image(root, { width: 1, height: 1, data: dest })
    layers.image(child, { width: 1, height: 1, data: source })
    const composer = new SceneComposer(layers),
      frame = composer.frame(1, 1)
    assert.equal(frame.length, 1)
    assert.deepEqual(
      [...composer.snapshot(root).data],
      [...expected],
      `snapshot mode=${c.mode} opacity=${c.opacity}`,
    )
    assert.deepEqual(
      [...frame[0]!.pixels.data],
      [...expected.subarray(0, 3), 255],
      `display mode=${c.mode} opacity=${c.opacity}`,
    )
  }
})

test('binders pass destination-dependent children through their clip and cache invalidates on image edits', () => {
  const layers = new LayerTree(),
    root = layers.create(0),
    binder = layers.create(root),
    child = layers.create(binder)
  layers.resize(root, 3, 1)
  layers.fill(root, { x: 0, y: 0, width: 3, height: 1 }, 0xff808080)
  layers.resize(binder, 1, 1)
  layers.set(binder, 'type', 0)
  layers.set(binder, 'visible', 1)
  layers.set(binder, 'left', 1)
  layers.resize(child, 3, 1)
  layers.set(child, 'type', 5)
  layers.set(child, 'visible', 1)
  layers.fill(child, { x: 0, y: 0, width: 3, height: 1 }, 0x00808080)
  const composer = new SceneComposer(layers)
  assert.deepEqual(
    [...composer.frame(3, 1)[0]!.pixels.data],
    [128, 128, 128, 255, 64, 64, 64, 255, 128, 128, 128, 255],
  )
  layers.setPixel(child, 0, 0, 0x404040, 'main')
  assert.deepEqual([...composer.frame(3, 1)[0]!.pixels.data.subarray(4, 8)], [32, 32, 32, 255])
})
