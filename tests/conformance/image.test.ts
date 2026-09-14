import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeBmp, decodeBmp } from '../../src/formats/image/bmp.ts'
import { stretchPixels } from '../../src/engine/graphics/resample.ts'
const rect = (width: number, height = 1) => ({ x: 0, y: 0, width, height })
test('BMP writers use padded bottom-up rows, preserve masks and encode the fixed palette', () => {
  const source = {
    width: 3,
    height: 2,
    data: new Uint8Array([
      255, 0, 0, 64, 0, 255, 0, 128, 0, 0, 255, 192, 255, 255, 255, 255, 0, 0, 0, 0, 17, 91, 211, 7,
    ]),
  }
  const bmp = encodeBmp(source, 'bmp24'),
    view = new DataView(bmp.buffer)
  assert.equal(bmp.length, 78)
  assert.equal(view.getUint32(10, true), 54)
  assert.deepEqual([...bmp.subarray(54, 66)], [255, 255, 255, 0, 0, 0, 211, 91, 17, 0, 0, 0])
  assert.deepEqual([...bmp.subarray(66)], [0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0])
  const indexed = encodeBmp(source, 'bmp8')
  assert.equal(indexed.length, 1086)
  assert.deepEqual([...indexed.subarray(1082)], [5, 36, 210, 0])
  assert.deepEqual([...indexed.subarray(54 + 5 * 4, 54 + 6 * 4)], [0, 0, 255, 0])
  const rgba = encodeBmp(source)
  assert.deepEqual(decodeBmp(rgba), source)
  assert.deepEqual([...rgba.subarray(54, 58)], [255, 255, 255, 255])
  assert.equal(decodeBmp(indexed)!.data[0], 255)
  assert.throws(() => decodeBmp(rgba.subarray(0, 60)), /Truncated/)
})
test('stretch filters preserve mapping under clipping, reversal and reference-edge control', () => {
  const source = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 64, 0, 0, 255, 192]) }
  assert.deepEqual(
    [...stretchPixels(source, rect(4), rect(2), rect(4), 0).pixels.data],
    [255, 0, 0, 64, 255, 0, 0, 64, 0, 0, 255, 192, 0, 0, 255, 192],
  )
  assert.deepEqual(
    [...stretchPixels(source, rect(4), rect(2), rect(4), 2).pixels.data],
    [255, 0, 0, 64, 191, 0, 64, 96, 64, 0, 191, 160, 0, 0, 255, 192],
  )
  assert.deepEqual(
    [
      ...stretchPixels(source, { x: 2, y: 0, width: -2, height: 1 }, rect(2), rect(2), 0).pixels
        .data,
    ],
    [0, 0, 255, 192, 255, 0, 0, 64],
  )
  const strip = {
    width: 4,
    height: 1,
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]),
  }
  const crop = { x: 1, y: 0, width: 2, height: 1 }
  assert.deepEqual(
    [...stretchPixels(strip, rect(4), crop, rect(4), 2).pixels.data.subarray(0, 4)],
    [0, 255, 0, 255],
  )
  assert.deepEqual(
    [...stretchPixels(strip, rect(4), crop, rect(4), 2 | 0x10000).pixels.data.subarray(0, 4)],
    [64, 191, 0, 255],
  )
  const full = stretchPixels(strip, rect(8), rect(4), rect(8), 3).pixels.data
  const partial = stretchPixels(strip, rect(8), rect(4), { x: 2, y: 0, width: 3, height: 1 }, 3)
  assert.equal(partial.left, 2)
  assert.deepEqual(partial.pixels.data, full.slice(8, 20))
  assert.equal(stretchPixels(strip,rect(4),rect(0),rect(4),0).pixels.width,0)
  const outside=stretchPixels(strip,rect(4),{x:-2,y:0,width:4,height:1},rect(4),0)
  assert.equal(outside.left,2);assert.equal(outside.pixels.width,2)
  assert.deepEqual([...outside.pixels.data],[255,0,0,255,0,255,0,255])
})
test('all resampling kernels normalize constant channels and area averaging retains pixel coverage', () => {
  const source = {
    width: 2,
    height: 2,
    data: Uint8Array.from(Array.from({ length: 4 }, () => [17, 91, 211, 64]).flat()),
  }
  for (let mode = 0; mode < 20; mode++) {
    const output = stretchPixels(source, rect(7, 5), rect(2, 2), rect(7, 5), mode).pixels.data
    for (let at = 0; at < output.length; at += 4)
      assert.deepEqual([...output.subarray(at, at + 4)], [17, 91, 211, 64], `filter ${mode}`)
  }
  const strip = {
    width: 4,
    height: 1,
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
  }
  assert.deepEqual(
    [...stretchPixels(strip, rect(1), rect(4), rect(1), 14).pixels.data],
    [128, 128, 128, 255],
  )
})
