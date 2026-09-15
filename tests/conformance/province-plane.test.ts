import test from 'node:test'
import assert from 'node:assert/strict'
import { ProvincePlane } from '../../src/engine/graphics/province.ts'

test('province storage owns its input view and exposes its writable byte plane', () => {
  const input = new Uint8Array([99, 1, 2, 3, 4, 88])
  const plane = new ProvincePlane(2, 2, input.subarray(1, 5))
  assert.deepEqual([plane.width, plane.height, plane.bytes], [2, 2, 4])
  assert.deepEqual(Array.from(plane.data), [1, 2, 3, 4])
  input[1] = 42
  assert.equal(plane.getPixel(0, 0), 1)
  plane.data[1] = 23
  assert.equal(plane.getPixel(1, 0), 23)
  assert.equal(input[2], 2)
  assert.deepEqual(Array.from(new ProvincePlane(2, 1).data), [0, 0])
})

test('province dimensions accept zero and the limit but reject invalid sizes and byte lengths', () => {
  for (const [width, height] of [
    [0, 4],
    [4, 0],
    [4096, 0],
    [0, 4096],
  ]) {
    const plane = new ProvincePlane(width!, height!)
    assert.deepEqual([plane.width, plane.height, plane.bytes], [width, height, 0])
    assert.equal(plane.data.length, 0)
  }
  for (const invalid of [-1, 0.5, 4097, NaN, Infinity, -Infinity]) {
    assert.throws(() => new ProvincePlane(invalid, 1))
    assert.throws(() => new ProvincePlane(1, invalid))
  }
  assert.throws(() => new ProvincePlane(2, 2, new Uint8Array(3)))
  assert.throws(() => new ProvincePlane(2, 2, new Uint8Array(5)))
  assert.throws(() => new ProvincePlane(0, 2, new Uint8Array(1)))
})

test('province resize preserves only the upper-left intersection and zeroes new storage', () => {
  const plane = new ProvincePlane(3, 2, new Uint8Array([1, 2, 3, 4, 5, 6]))
  plane.resize(2, 3)
  assert.deepEqual([plane.width, plane.height, plane.bytes], [2, 3, 6])
  assert.deepEqual(Array.from(plane.data), [1, 2, 4, 5, 0, 0])
  plane.resize(4, 1)
  assert.deepEqual(Array.from(plane.data), [1, 2, 0, 0])
  assert.deepEqual([plane.width, plane.height, plane.bytes], [4, 1, 4])
  for (const [width, height] of [
    [-1, 1],
    [4, 1.5],
    [4097, 1],
    [4, NaN],
  ]) {
    assert.throws(() => plane.resize(width!, height!))
    assert.deepEqual([plane.width, plane.height, plane.bytes], [4, 1, 4])
    assert.deepEqual(Array.from(plane.data), [1, 2, 0, 0])
  }
  plane.resize(4, 0)
  assert.deepEqual([plane.width, plane.height, plane.bytes], [4, 0, 0])
  plane.resize(2, 1)
  assert.deepEqual(Array.from(plane.data), [0, 0])
})

test('province pixel writes retain the low byte and invalid coordinates cannot alias a row', () => {
  const plane = new ProvincePlane(2, 2)
  plane.setPixel(0, 0, 0x1234)
  plane.setPixel(1, 0, -1)
  plane.setPixel(0, 1, 256)
  plane.setPixel(1, 1, -257)
  assert.deepEqual(Array.from(plane.data), [0x34, 255, 0, 255])
  for (const [x, y] of [
    [-1, 1],
    [2, 0],
    [0, -1],
    [0, 2],
    [0.5, 0],
    [0, 0.5],
    [NaN, 0],
    [0, Infinity],
  ]) {
    assert.equal(plane.getPixel(x!, y!), 0)
    assert.throws(() => plane.setPixel(x!, y!, 9))
  }
  assert.deepEqual(Array.from(plane.data), [0x34, 255, 0, 255])
})

test('province fill clips negative origins to its own bounds and reports writes even for equal bytes', () => {
  const plane = new ProvincePlane(4, 3)
  const rect = { x: -1, y: -1, width: 3, height: 3 }
  assert.equal(plane.fill(rect, 0x107), true)
  assert.deepEqual(Array.from(plane.data), [7, 7, 0, 0, 7, 7, 0, 0, 0, 0, 0, 0])
  assert.equal(plane.fill(rect, 7), true)
  assert.deepEqual(rect, { x: -1, y: -1, width: 3, height: 3 })
  assert.equal(plane.fill({ x: 3, y: 2, width: 5, height: 5 }, -1), true)
  assert.equal(plane.getPixel(3, 2), 255)
  for (const empty of [
    { x: 0, y: 0, width: 0, height: 3 },
    { x: 0, y: 0, width: 2, height: -1 },
    { x: -3, y: 0, width: 3, height: 2 },
    { x: 0, y: 3, width: 2, height: 1 },
  ]) {
    assert.equal(plane.fill(empty, 42), false)
  }
  assert.deepEqual(Array.from(plane.data), [7, 7, 0, 0, 7, 7, 0, 0, 0, 0, 0, 255])
})

test('province copy clips source and destination together without shifting their correspondence', () => {
  const source = new ProvincePlane(
    5,
    4,
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
  )
  const target = new ProvincePlane(3, 3, new Uint8Array(9).fill(90))
  const rect = { x: -1, y: -1, width: 7, height: 6 }
  assert.equal(target.copy(source, -2, 0, rect), true)
  assert.deepEqual(Array.from(target.data), [90, 90, 90, 2, 3, 4, 7, 8, 9])
  assert.deepEqual(rect, { x: -1, y: -1, width: 7, height: 6 })
  assert.deepEqual([target.width, target.height, target.bytes], [3, 3, 9])
  assert.deepEqual([source.width, source.height, source.bytes], [5, 4, 20])
  assert.equal(source.getPixel(1, 0), 2)
})

test('province copy reports an existing rectangle even when bytes agree and rejects empty intersections', () => {
  const source = new ProvincePlane(2, 2, new Uint8Array([1, 2, 3, 4]))
  const target = source.clone()
  assert.equal(target.copy(source, 0, 0, { x: 0, y: 0, width: 2, height: 2 }), true)
  assert.equal(target.copy(source, 2, 0, { x: 0, y: 0, width: 2, height: 2 }), false)
  assert.equal(target.copy(source, 0, -2, { x: 0, y: 0, width: 2, height: 2 }), false)
  assert.equal(target.copy(source, 0, 0, { x: 2, y: 0, width: 1, height: 2 }), false)
  assert.equal(target.copy(source, 0, 0, { x: 0, y: 0, width: -1, height: 2 }), false)
  assert.equal(target.copy(source, 0, 0, { x: 0, y: 0, width: 2, height: 0 }), false)
  assert.equal(
    target.copy(new ProvincePlane(0, 2), 0, 0, { x: 0, y: 0, width: 2, height: 2 }),
    false,
  )
  assert.deepEqual(Array.from(target.data), [1, 2, 3, 4])
})

test('horizontal province self-copy snapshots both rows when shifting in either direction', () => {
  const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const right = new ProvincePlane(5, 2, input)
  assert.equal(right.copy(right, 1, 0, { x: 0, y: 0, width: 4, height: 2 }), true)
  assert.deepEqual(Array.from(right.data), [1, 1, 2, 3, 4, 6, 6, 7, 8, 9])
  const left = new ProvincePlane(5, 2, input)
  assert.equal(left.copy(left, 0, 0, { x: 1, y: 0, width: 4, height: 2 }), true)
  assert.deepEqual(Array.from(left.data), [2, 3, 4, 5, 5, 7, 8, 9, 10, 10])
})

test('vertical province self-copy reads original rows in either direction', () => {
  const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
  const down = new ProvincePlane(3, 3, input)
  assert.equal(down.copy(down, 0, 1, { x: 0, y: 0, width: 3, height: 2 }), true)
  assert.deepEqual(Array.from(down.data), [1, 2, 3, 1, 2, 3, 4, 5, 6])
  const up = new ProvincePlane(3, 3, input)
  assert.equal(up.copy(up, 0, 0, { x: 0, y: 1, width: 3, height: 2 }), true)
  assert.deepEqual(Array.from(up.data), [4, 5, 6, 7, 8, 9, 7, 8, 9])
})

test('province clones retain dimensions while writes and resizing remain independently owned', () => {
  const original = new ProvincePlane(2, 2, new Uint8Array([1, 2, 3, 4]))
  const clone = original.clone()
  assert.notEqual(clone.data, original.data)
  assert.notEqual(clone.data.buffer, original.data.buffer)
  assert.deepEqual([clone.width, clone.height, clone.bytes], [2, 2, 4])
  clone.setPixel(0, 0, 99)
  original.setPixel(1, 1, 88)
  clone.resize(3, 1)
  assert.deepEqual(Array.from(original.data), [1, 2, 3, 88])
  assert.deepEqual(Array.from(clone.data), [99, 2, 0])
  assert.deepEqual([original.width, original.height, original.bytes], [2, 2, 4])
})

test('province flips cover the full odd-sized plane and preserve its central row and column', () => {
  const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
  const plane = new ProvincePlane(3, 3, input)
  plane.flip(true)
  assert.deepEqual(Array.from(plane.data), [3, 2, 1, 6, 5, 4, 9, 8, 7])
  plane.flip(false)
  assert.deepEqual(Array.from(plane.data), [9, 8, 7, 6, 5, 4, 3, 2, 1])
  plane.flip(false)
  plane.flip(true)
  assert.deepEqual(plane.data, input)
})

test('province flips handle one-pixel and empty axes without changing dimensions', () => {
  const column = new ProvincePlane(1, 3, new Uint8Array([1, 2, 3]))
  column.flip(true)
  assert.deepEqual(Array.from(column.data), [1, 2, 3])
  column.flip(false)
  assert.deepEqual(Array.from(column.data), [3, 2, 1])
  const row = new ProvincePlane(3, 1, new Uint8Array([4, 5, 6]))
  row.flip(false)
  assert.deepEqual(Array.from(row.data), [4, 5, 6])
  row.flip(true)
  assert.deepEqual(Array.from(row.data), [6, 5, 4])
  for (const [width, height] of [
    [0, 3],
    [3, 0],
  ]) {
    const empty = new ProvincePlane(width!, height!)
    empty.flip(true)
    empty.flip(false)
    assert.deepEqual([empty.width, empty.height, empty.bytes], [width, height, 0])
    assert.equal(empty.data.length, 0)
  }
})
