import test from 'node:test'
import assert from 'node:assert/strict'
import {
  opaqueTransition,
  transitionPixels,
  type TransitionFrame,
} from '../../src/engine/graphics/transition.ts'
import { opaqueUniversalOpacity } from '../../src/engine/graphics/transition-opaque.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { SceneComposer } from '../../src/engine/scene/composer.ts'

const image = (...data: number[]) => ({
  width: data.length / 4,
  height: 1,
  data: Uint8Array.from(data),
})
const frame: TransitionFrame = {
  token: 1,
  destination: 2,
  source: 3,
  destinationType: 1,
  children: false,
  kind: 'crossfade',
  phase: 0.5,
  vague: 64,
  from: 0,
  stay: 0,
}
const blackWhite = image(0, 0, 0, 19, 255, 255, 255, 87)
const whiteBlack = image(255, 255, 255, 203, 0, 0, 0, 61)

test('opaque crossfade uses signed /256 arithmetic after the 255-step phase', () => {
  assert.deepEqual(
    [...transitionPixels(blackWhite, whiteBlack, frame).data],
    [126, 126, 126, 0, 128, 128, 128, 0],
  )
  assert.deepEqual(
    [...transitionPixels(image(254, 17, 3, 9), image(1, 250, 250, 99), frame).data],
    [128, 132, 125, 0],
  )
})

test('opaque crossfade preserves complete source pixels at zero and the final phase', () => {
  for (const phase of [0, 0.001])
    assert.deepEqual(
      [...transitionPixels(blackWhite, whiteBlack, { ...frame, phase }).data],
      [...blackWhite.data],
    )
  assert.deepEqual(
    [...transitionPixels(blackWhite, whiteBlack, { ...frame, phase: 1 }).data],
    [...whiteBlack.data],
  )
  assert.deepEqual(
    [...transitionPixels(blackWhite, whiteBlack, { ...frame, phase: 1 / 255, pixelPhase: 1 }).data],
    [0, 0, 0, 0, 254, 254, 254, 0],
  )
  assert.deepEqual(
    [
      ...transitionPixels(blackWhite, whiteBlack, { ...frame, phase: 254 / 255, pixelPhase: 254 })
        .data,
    ],
    [253, 253, 253, 0, 1, 1, 1, 0],
  )
})

test('opaque universal distinguishes the strict copy threshold from opacity 255', () => {
  const levels = [94, 95, 127, 158, 159],
    before = image(...levels.flatMap(() => [0, 0, 0, 19])),
    after = image(...levels.flatMap(() => [255, 255, 255, 203])),
    rule = image(...levels.flatMap((level) => [level, level, level, 255]))
  assert.deepEqual(
    [...transitionPixels(before, after, { ...frame, kind: 'universal', rule }).data],
    [255, 255, 255, 203, 254, 254, 254, 0, 127, 127, 127, 0, 3, 3, 3, 0, 0, 0, 0, 19],
  )
  assert.equal(opaqueUniversalOpacity(64, 64, 0), 255)
  assert.equal(opaqueUniversalOpacity(65, 64, 0), 256)
})

test('zero-vague universal performs a strict threshold copy without division', () => {
  assert.equal(opaqueUniversalOpacity(127, 0, 126), 256)
  assert.equal(opaqueUniversalOpacity(127, 0, 127), -1)
  assert.equal(opaqueUniversalOpacity(127, 0, 128), -1)
})

test('universal switches from source copies to unconditional table blending at vague 512', () => {
  assert.equal(opaqueUniversalOpacity(543, 511, 31), 256)
  assert.equal(opaqueUniversalOpacity(543, 511, 32), 255)
  assert.equal(opaqueUniversalOpacity(544, 512, 31), 255)
  assert.equal(opaqueUniversalOpacity(544, 512, 32), 255)
  assert.equal(opaqueUniversalOpacity(32, 512, 32), 0)
  assert.equal(opaqueUniversalOpacity(65500, 65535, 255), 254)
})

test('opaque universal retains tiled rule lookup and exact final copies', () => {
  const rule = image(127, 127, 127, 255)
  assert.deepEqual(
    [...transitionPixels(blackWhite, whiteBlack, { ...frame, kind: 'universal', rule }).data],
    [127, 127, 127, 0, 127, 127, 127, 0],
  )
  assert.deepEqual(
    [
      ...transitionPixels(blackWhite, whiteBlack, { ...frame, kind: 'universal', rule, phase: 1 })
        .data,
    ],
    [...whiteBlack.data],
  )
})

test('transition kernels select the captured destination display type independently of pixel alpha', () => {
  for (const destinationType of [0, 1, 3, 4, 5, 8, 9, 10, 11])
    assert.equal(opaqueTransition({ ...frame, destinationType }), true)
  for (const destinationType of [2, 12, ...Array.from({ length: 16 }, (_, i) => i + 13)])
    assert.equal(opaqueTransition({ ...frame, destinationType }), false)
  assert.equal(opaqueTransition({ ...frame, kind: 'scroll' }), false)
  for (const destinationType of [2, 12])
    assert.deepEqual(
      [
        ...transitionPixels(image(0, 0, 0, 255), image(255, 255, 255, 255), {
          ...frame,
          destinationType,
        }).data,
      ],
      [127, 127, 127, 255],
    )
})

for (const children of [false, true])
  test(`opaque ${children ? 'subtree' : 'main-image'} composition ignores source masks and normalizes display alpha`, () => {
    const layers = new LayerTree(),
      root = layers.create(0),
      destination = layers.create(root),
      source = layers.create(root)
    for (const id of [root, destination, source]) {
      layers.resizeImage(id, 1, 1)
      layers.resize(id, 1, 1)
    }
    layers.set(destination, 'type', 1)
    layers.set(destination, 'visible', 1)
    layers.fill(destination, { x: 0, y: 0, width: 1, height: 1 }, 0x13000000)
    layers.fill(source, { x: 0, y: 0, width: 1, height: 1 }, 0x01ffffff)
    const composer = new SceneComposer(layers, (id) =>
      id === destination ? { ...frame, destination, source, children } : undefined,
    )
    assert.deepEqual([...composer.snapshot(destination).data], [126, 126, 126, 0])
    const displayed = composer.frame(1, 1).find((layer) => layer.id === -destination)
    assert(displayed)
    assert.deepEqual([...displayed.pixels.data], [126, 126, 126, 255])
  })
