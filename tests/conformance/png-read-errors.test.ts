import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, inflateSync } from 'node:zlib'
import { decodePng, decodeSelectedPng, prepareSelectedPngStream } from '../../src/formats/image/png.ts'
import { PngStreamReadError } from '../../src/formats/image/png-pull.ts'
import { ImageReadError } from '../../src/formats/image/read-error.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../../src/formats/image/selection.ts'

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), options = { timeout: 30000 }
function finish<T>(work: Generator<void, T>): T {
  for (let step = 0; step < 10000; step++) { const value = work.next(); if (value.done) return value.value }
  throw new Error('PNG fixture exceeded its generator-step bound')
}
function u32(value: number) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes }
function chunk(type: string, data: Uint8Array): Buffer {
  const bytes = Buffer.concat([u32(data.length), Buffer.from(type), data, Buffer.alloc(4)])
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}
function header(color = 6): Buffer {
  const data = Buffer.alloc(13); data.writeUInt32BE(1); data.writeUInt32BE(1, 4)
  data[8] = 8; data[9] = color
  return Buffer.concat([signature, chunk('IHDR', data)])
}
function png(): Buffer {
  return Buffer.concat([header(), chunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 255]))), chunk('IEND', Buffer.alloc(0))])
}
function selected(bytes: Uint8Array, stream: boolean, progress?: ImageDecodeProgress) {
  if (stream) return finish(prepareSelectedPngStream(bytes, 'normal', progress))
  return finish(decodeSelectedPng(bytes, 'normal', progress))
}
function short(work: () => unknown, stream: boolean, offset: number, requested: number, actual: number, message?: string) {
  assert.throws(work, (error: unknown) => {
    assert(error instanceof ImageReadError)
    assert.equal(error instanceof PngStreamReadError, stream)
    assert.deepEqual([error.format, error.offset, error.requested, error.actual], ['png', offset, requested, actual])
    if (message !== undefined) assert.equal(error.message, message)
    return true
  })
}

test('selected PNG required signature and header fields retain each actual source-read offset and length', options, () => {
  const ihdr = header(), cases: [Buffer, number, number, number][] = [
    [signature.subarray(0, 3), 0, 8, 3],
    [Buffer.concat([signature, Buffer.from([0, 0])]), 8, 4, 2],
    [Buffer.concat([signature, u32(13), Buffer.from('I')]), 12, 4, 1],
    [ihdr.subarray(0, 23), 16, 13, 7],
    [ihdr.subarray(0, 31), 29, 4, 2],
    [Buffer.concat([ihdr, Buffer.from([0, 0])]), 33, 4, 2],
    [Buffer.concat([ihdr, u32(1), Buffer.from('ID')]), 37, 4, 2],
  ]
  for (const stream of [false, true]) for (const [bytes, offset, requested, actual] of cases)
    short(() => selected(bytes, stream), stream, offset, requested, actual)
})

test('selected PNG handlers reject impossible headers before asking for their missing payload or CRC', options, () => {
  const palette = header(3), cases: [Buffer, string][] = [
    [Buffer.concat([signature, u32(12), Buffer.from('IHDR')]), 'Invalid IHDR chunk'],
    [Buffer.concat([header(), u32(13), Buffer.from('IHDR')]), 'Out of place IHDR'],
    [Buffer.concat([header(), u32(100), Buffer.from('IEND')]), 'No image in file'],
    [Buffer.concat([signature, u32(6), Buffer.from('PLTE')]), 'Missing IHDR before PLTE'],
    [Buffer.concat([palette, u32(4), Buffer.from('PLTE')]), 'Invalid palette chunk'],
    [Buffer.concat([palette, chunk('PLTE', Uint8Array.of(1, 2, 3)), u32(3), Buffer.from('PLTE')]), 'Duplicate PLTE chunk'],
    [Buffer.concat([palette, u32(100), Buffer.from('IDAT')]), 'Missing PLTE before IDAT'],
    [Buffer.concat([signature, u32(100), Buffer.from('IDAT')]), 'Missing IHDR before IDAT'],
  ]
  for (const stream of [false, true]) for (const [bytes, reason] of cases)
    assert.throws(() => selected(bytes, stream), (error: unknown) => {
      assert(error instanceof ImageDecodeError); assert.equal(error.reason, reason)
      assert(!(error instanceof ImageReadError)); return true
    })
})

test('audited palette triples, skipped metadata windows and unknown-callback payloads retain their distinct read granularity', options, () => {
  for (const stream of [false, true]) {
    short(() => selected(Buffer.concat([header(3), u32(6), Buffer.from('PLTE'), Buffer.alloc(5)]), stream), stream, 44, 3, 2)
    short(() => selected(Buffer.concat([header(), u32(9000), Buffer.from('pHYs'), Buffer.alloc(8200)]), stream), stream, 8233, 808, 8)
    short(() => selected(Buffer.concat([header(), u32(9), Buffer.from('vpAg'), Buffer.alloc(8)]), stream), stream, 41, 9, 8)
    const unrecognizedCritical = Buffer.concat([header(), u32(8), Buffer.from('VpAg'), Buffer.alloc(8)])
    assert.throws(() => selected(unrecognizedCritical, stream), (error: unknown) => {
      assert(error instanceof ImageDecodeError)
      assert.equal(error.reason, 'VpAg: unknown critical chunk')
      return true
    })
  }
})

test('a pull PNG stops at the complete first IDAT header while legacy bulk shortages preserve prior diagnostics', options, () => {
  const bytes = png(), compressedLength = bytes.readUInt32BE(33)
  let sizes = 0, rows = 0
  const progress: ImageDecodeProgress = {
    size(w, h) { sizes++; assert.deepEqual([w, h], [1, 1]) }, row() { rows++ },
  }, plan = finish(prepareSelectedPngStream(bytes.subarray(0, 41), 'normal', progress))
  assert.equal(plan.expandedLength, 5); assert.equal(plan.phase, 'read_row')
  assert.equal(sizes, 1); assert.equal(rows, 0)
  for (const [length, sized, offset, requested, actual, message] of [
    [40, 0, 37, 4, 3, 'Truncated PNG chunk'],
    [41, 1, 41, compressedLength, 0, 'Truncated PNG chunk'],
    [45, 1, 41, compressedLength, 4, 'Truncated PNG chunk data'],
  ] as const) {
    sizes = 0
    short(() => selected(bytes.subarray(0, length), false, progress), false, offset, requested, actual, message)
    assert.equal(sizes, sized); assert.equal(rows, 0)
  }
})

test('selected legacy read-end shortages keep the completed rows and expose the required CRC read as a structured cause', options, () => {
  const bytes = png(), rows: number[][] = [], plan = finish(decodeSelectedPng(bytes.subarray(0, bytes.length - 3), 'normal', {
    size(w, h) { assert.deepEqual([w, h], [1, 1]) }, row(y, rgba) { assert.equal(y, 0); rows.push([...rgba]) },
  }))
  short(() => finish(plan.decode(inflateSync(plan.compressed))), false, bytes.length - 4, 4, 1, 'Truncated PNG chunk')
  assert.deepEqual(rows, [[10, 20, 30, 255]])
})

test('generic PNG validation remains plain and consumer callback exceptions are never reclassified as source reads', options, () => {
  const shortHeader = header().subarray(0, 23), generic = decodePng(shortHeader)
  assert(generic)
  assert.throws(() => finish(generic), (error: unknown) => {
    assert(error instanceof Error); assert(!(error instanceof ImageReadError))
    assert.equal(error.message, 'Truncated PNG chunk data'); return true
  })
  const cause = new Error('consumer-size-failure'), bytes = png()
  for (const stream of [false, true]) assert.throws(() => selected(bytes, stream, {
    size() { throw cause }, row() { throw new Error('Unexpected row') },
  }), (error: unknown) => error === cause)
  const valid = decodePng(bytes)
  assert(valid)
  const plan = finish(valid)
  assert.deepEqual([...finish(plan.decode(inflateSync(plan.compressed))).data], [10, 20, 30, 255])
})
