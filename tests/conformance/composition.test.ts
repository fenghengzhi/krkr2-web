import test from 'node:test'
import assert from 'node:assert/strict'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { SceneComposer } from '../../src/engine/scene/composer.ts'
import { transitionPixels, type TransitionFrame } from '../../src/engine/graphics/transition.ts'
function solid(red: number, green: number, blue: number, width = 2) {
  return {
    width,
    height: 1,
    data: Uint8Array.from(Array.from({ length: width }, () => [red, green, blue, 255]).flat()),
  }
}
test('parent opacity applies once to an overlapping subtree and snapshots ignore the root visibility', () => {
  const layers = new LayerTree(),
    root = layers.create(0),
    group = layers.create(root),
    child = layers.create(group)
  for (const id of [root, group, child]) layers.resize(id, 2, 1)
  layers.set(group, 'visible', 1)
  layers.set(child, 'visible', 1)
  layers.set(group, 'opacity', 128)
  layers.fill(group, { x: 0, y: 0, width: 2, height: 1 }, 0xffff0000)
  layers.fill(child, { x: 0, y: 0, width: 1, height: 1 }, 0xff0000ff)
  const composer = new SceneComposer(layers),
    frame = composer.frame(2, 1)
  assert.equal(frame.length, 2)
  assert.equal(frame[1]!.opacity, 128 / 255)
  assert.deepEqual([...frame[1]!.pixels.data], [0, 0, 255, 255, 255, 0, 0, 255])
  layers.set(group, 'visible', 0)
  assert.deepEqual([...composer.snapshot(group).data], [0, 0, 255, 255, 255, 0, 0, 255])
  layers.setPixel(child, 0, 0, 0x00ff00, 'main')
  assert.deepEqual([...composer.snapshot(group).data.subarray(0, 4)], [0, 255, 0, 255])
})
test('a complete leaf snapshot preserves low-alpha RGB bytes without premultiplication loss', () => {
  const layers = new LayerTree(),
    root = layers.create(0)
  layers.resizeImage(root, 1, 1)
  layers.fill(root, { x: 0, y: 0, width: 1, height: 1 }, 0x01010203)
  assert.deepEqual([...new SceneComposer(layers).snapshot(root).data], [1, 2, 3, 1])
  const source = layers.create(0), child = layers.create(root)
  layers.resizeImage(source, 1, 1)
  layers.fill(source, { x: 0, y: 0, width: 1, height: 1 }, 0xffc9cacb)
  layers.resize(child, 0, 0)
  layers.position(child, 20, 20)
  for (const children of [false, true]) {
    const composer = new SceneComposer(layers, (id) => id === root ? {
      token: 1, destination: root, source, destinationType: 1, children,
      kind: 'crossfade', phase: 0.5, vague: 0, from: 0, stay: 0,
    } : undefined)
    layers.set(child, 'visible', 0)
    assert.deepEqual([...composer.snapshot(root).data], [1, 2, 3, 1])
    layers.set(child, 'visible', 1); layers.set(child, 'opacity', 0)
    assert.deepEqual([...composer.snapshot(root).data], [1, 2, 3, 1])
    layers.set(child, 'opacity', 255)
    // Native seen-count includes this zero-size, off-rectangle child. It is
    // enough to require completion, while contributing no image of its own.
    assert.deepEqual([...composer.snapshot(root).data], [100, 101, 102, 0])
  }
})
test('a snapshot keeps the raw parent plane beside a child fading to another layer', () => {
  const layers = new LayerTree(), root = layers.create(0), parent = layers.create(root),
    front = layers.create(parent), back = layers.create(parent)
  for (const id of [root, parent, front, back]) {
    const width = id === front || id === back ? 1 : 2
    layers.resizeImage(id, width, 1)
    layers.resize(id, width, 1)
  }
  layers.set(front, 'visible', 1)
  layers.fill(parent, { x: 0, y: 0, width: 2, height: 1 }, 0x01123456)
  layers.fill(front, { x: 0, y: 0, width: 1, height: 1 }, 0xffff0000)
  layers.fill(back, { x: 0, y: 0, width: 1, height: 1 }, 0xff0000ff)
  const composer = new SceneComposer(layers, (id) => id === front ? {
    token: 1, destination: front, source: back, destinationType: 2, children: false,
    kind: 'crossfade', phase: 0.5, vague: 0, from: 0, stay: 0,
  } : undefined)
  assert.deepEqual([...composer.snapshot(parent).data], [87, 0, 167, 255, 18, 52, 86, 1])
  const third = layers.create(parent)
  layers.resizeImage(third, 1, 1); layers.resize(third, 1, 1)
  layers.fill(third, { x: 0, y: 0, width: 1, height: 1 }, 0xff00ff00)
  for (const children of [false, true]) {
    const nested = new SceneComposer(layers, (id) => id === front ? {
      token: 1, destination: front, source: back, destinationType: 2, children,
      kind: 'crossfade', phase: 0.5, vague: 0, from: 0, stay: 0,
    } : id === back ? {
      token: 2, destination: back, source: third, destinationType: 2, children: false,
      kind: 'crossfade', phase: 0.5, vague: 0, from: 0, stay: 0,
    } : undefined)
    // Main-only source sampling reads back.MainImage. With children it calls
    // Complete(back), whose full-leaf shortcut returns that same original.
    // An external parent's actual Draw still displays front's transition.
    assert.deepEqual([...nested.snapshot(back).data], [0, 0, 255, 255])
    assert.deepEqual([...nested.snapshot(parent).data], [87, 0, 167, 255, 18, 52, 86, 1])
  }
})
test('transition kernels preserve endpoints, tiled rules and scroll coverage', () => {
  const before = solid(255, 0, 0),
    after = solid(0, 0, 255),
    frame: TransitionFrame = {
      token: 1,
      destination: 1,
      source: 2,
      destinationType: 2,
      children: true,
      kind: 'crossfade',
      phase: 0.5,
      vague: 0,
      from: 0,
      stay: 0,
    }
  assert.deepEqual(
    [...transitionPixels(before, after, { ...frame, phase: 0 }).data],
    [...before.data],
  )
  assert.deepEqual(
    [...transitionPixels(before, after, { ...frame, phase: 1 }).data],
    [...after.data],
  )
  assert.deepEqual(
    [...transitionPixels(before, after, frame).data],
    [87, 0, 167, 255, 87, 0, 167, 255],
  )
  const rule = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) }
  assert.deepEqual(
    [...transitionPixels(before, after, { ...frame, kind: 'universal', rule }).data],
    [0, 0, 255, 255, 255, 0, 0, 255],
  )
  assert.deepEqual(
    [
      ...transitionPixels(before, after, {
        ...frame,
        kind: 'universal',
        rule: solid(255, 0, 0),
        phase: 64 / 255,
      }).data,
    ],
    [...after.data],
  )
  assert.deepEqual(
    [...transitionPixels(before, after, { ...frame, kind: 'scroll' }).data],
    [0, 0, 255, 255, 255, 0, 0, 255],
  )
  for (const from of [0, 1, 2, 3])
    for (const stay of [0, 1, 2]) {
      const output = transitionPixels(before, after, { ...frame, kind: 'scroll', from, stay })
      for (let at = 3; at < output.data.length; at += 4) assert.equal(output.data[at], 255)
    }
})
test('scroll rectangles preserve raw channels and the moving plane wins each stay overlap', () => {
  const pixel = (value: number) => [value, 255 - value, value + 1, value === 130 ? 0 : value]
  const leftOrTop = [[130, 10, 20], [130, 20, 30], [110, 10, 20]]
  const rightOrBottom = [[20, 30, 110], [10, 20, 110], [20, 30, 130]]
  for (const from of [0, 1, 2, 3]) {
    const horizontal = from === 0 || from === 2
    const image = (values: number[]) => ({
      width: horizontal ? 3 : 1, height: horizontal ? 1 : 3, data: Uint8Array.from(values.flatMap(pixel)),
    })
    for (const [stay, expected] of (from < 2 ? leftOrTop : rightOrBottom).entries()) {
      const frame: TransitionFrame = { token: 1, destination: 1, source: 2, destinationType: 2, children: false,
        kind: 'scroll', phase: 1 / 3, pixelPhase: 1, vague: 0, from, stay }
      const result = transitionPixels(image([10, 20, 30]), image([110, 120, 130]), frame)
      assert.deepEqual([...result.data], expected.flatMap(pixel), `from=${from}, stay=${stay}`)
    }
  }
})
test('structural exchanges keep a single primary tree for siblings and ancestors', () => {
  for (const withChildren of [false, true])
    for (const depth of [1, 3]) {
      const layers = new LayerTree(),
        root = layers.create(0)
      let descendant = root
      for (let i = 0; i < depth; i++) descendant = layers.create(descendant)
      const leaf = layers.create(descendant)
      layers.exchange(root, descendant, withChildren)
      assert.equal(layers.get(descendant).primary, true)
      assert.equal(layers.get(root).primary, false)
      for (const id of layers.ids()) {
        assert.equal(layers.contains(descendant, id), true)
        for (const child of layers.get(id).children) assert.equal(layers.get(child).parent, id)
      }
      assert.equal(layers.get(leaf).parent, withChildren ? descendant : root)
    }
})
test('scroll stay modes keep the selected image stationary rather than swapping the two flags', () => {
  const before = {
      width: 4,
      height: 1,
      data: new Uint8Array([10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255]),
    },
    after = {
      width: 4,
      height: 1,
      data: new Uint8Array([110, 0, 0, 255, 120, 0, 0, 255, 130, 0, 0, 255, 140, 0, 0, 255]),
    }
  const frame: TransitionFrame = {
    token: 1,
    destination: 1,
    source: 2,
    destinationType: 2,
    children: true,
    kind: 'scroll',
    phase: 0.5,
    vague: 0,
    from: 0,
    stay: 1,
  }
  const red = (image: { data: Uint8Array }) => [...image.data].filter((_, index) => index % 4 === 0)
  assert.deepEqual(red(transitionPixels(before, after, frame)), [130, 140, 30, 40])
  assert.deepEqual(red(transitionPixels(before, after, { ...frame, stay: 2 })), [110, 120, 10, 20])
})
