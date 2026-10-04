import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import {
  compositeCursor, cursorLimits, cursorStep, decodeCursor,
  type CursorDecodeOptions,
} from '../../src/formats/cursor/index.ts'
import { decodePng } from '../../src/formats/image/png.ts'
import type { Pixels } from '../../src/engine/ports/graphics.ts'
import {
  animatedCursor, cursorDib, cursorFile, cursorPng, riffChunk, words,
} from '../helpers/cursor-fixtures.ts'

// These are format tests only. They make no claim about cursor UI integration.
function finish<T>(work: Generator<void, T>): T {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
const png: CursorDecodeOptions['png'] = async (bytes) => {
  const work = decodePng(bytes)
  assert.ok(work, 'fixture must be a real PNG')
  const plan = finish(work)
  return finish(plan.decode(inflateSync(plan.compressed, { maxOutputLength: plan.expandedLength })))
}
function solid(red: number, green: number, blue: number): Buffer {
  return cursorFile([{
    width: 1, height: 1,
    payload: cursorDib({ width: 1, height: 1, depth: 24, xorRows: [[blue, green, red]] }),
  }])
}
function surface(width: number, height: number, data: readonly number[]): Pixels {
  return { width, height, data: new Uint8Array(data) }
}

test('CUR monochrome preserves all four AND/XOR operations on different backgrounds', async () => {
  const bytes = cursorFile([{
      width: 4, height: 1, hotspot: [2, 0],
      payload: cursorDib({ width: 4, height: 1, depth: 1,
        palette: [[0, 0, 0], [255, 255, 255]], xorRows: [[0x50]], andRows: [[0x30]] }),
    }]),
    asset = await decodeCursor(bytes, { png }), image = asset.frames[0]!.images[0]!
  assert.equal(asset.kind, 'cur')
  assert.deepEqual(asset.sequence, [0])
  assert.deepEqual(asset.rates, [1])
  assert.equal(asset.imageCount, 1)
  assert.equal(asset.decodedBytes, 20)
  assert.equal(asset.sourceBytes, bytes.length)
  assert.deepEqual(image.hotspot, { x: 2, y: 0 })
  assert.equal(image.mode, 'and-xor')
  assert.deepEqual([...image.andMask], [0, 0, 255, 255])
  assert.deepEqual([...image.data], [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255])
  const first = surface(4, 1, [18, 52, 86, 255, 18, 52, 86, 255, 18, 52, 86, 255, 18, 52, 86, 255])
  compositeCursor(image, first, 0, 0)
  assert.deepEqual([...first.data], [0, 0, 0, 255, 255, 255, 255, 255, 18, 52, 86, 255, 237, 203, 169, 255])
  const second = surface(4, 1, [200, 17, 0, 255, 200, 17, 0, 255, 200, 17, 0, 255, 200, 17, 0, 255])
  compositeCursor(image, second, 0, 0)
  assert.deepEqual([...second.data], [0, 0, 0, 255, 255, 255, 255, 255, 200, 17, 0, 255, 55, 238, 255, 255])
  assert.equal(cursorStep(asset, 987654321), 0)
})

test('CUR 4-bit palette nibbles retain colored destination XOR', async () => {
  const asset = await decodeCursor(cursorFile([{
    width: 3, height: 1,
    payload: cursorDib({ width: 3, height: 1, depth: 4,
      palette: [[0, 0, 0], [240, 15, 85], [18, 52, 86], [170, 204, 0]],
      xorRows: [[0x12, 0x30, 0xde, 0xad]], andRows: [[0xa0]] }),
  }]), { png }), image = asset.frames[0]!.images[0]!
  assert.deepEqual([...image.data], [240, 15, 85, 255, 18, 52, 86, 255, 170, 204, 0, 255])
  const target = surface(3, 1, [15, 240, 170, 255, 15, 240, 170, 255, 15, 240, 170, 255])
  compositeCursor(image, target, 0, 0)
  assert.deepEqual([...target.data], [255, 255, 255, 255, 18, 52, 86, 255, 165, 60, 170, 255])
})

test('CUR 8-bit palettes honor the declared table and ignore row padding', async () => {
  const payload = cursorDib({ width: 3, height: 1, depth: 8,
      palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255]], xorRows: [[2, 0, 1, 0xee]] }),
    asset = await decodeCursor(cursorFile([{ width: 3, height: 1, payload }]), { png })
  assert.deepEqual([...asset.frames[0]!.images[0]!.data], [0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255])
  const bad = Buffer.from(payload)
  bad[40 + 3 * 4] = 3
  await assert.rejects(decodeCursor(cursorFile([{ width: 3, height: 1, payload: bad }]), { png }), /palette index/)
})

test('CUR accepts BITMAPCOREHEADER with three-byte palette entries', async () => {
  const asset = await decodeCursor(cursorFile([{
    width: 1, height: 1,
    payload: cursorDib({ width: 1, height: 1, depth: 1, core: true,
      palette: [[0, 0, 0], [255, 255, 255]], xorRows: [[0x80]] }),
  }]), { png })
  assert.deepEqual([...asset.frames[0]!.images[0]!.data], [255, 255, 255, 255])
})

test('CUR 24-bit bottom-up and top-down DIBs decode rows and AND masks independently of padding', async () => {
  const top = [0, 0, 255, 0, 255, 0, 255, 0, 0, 0xde, 0xad, 0xbe],
    bottom = [255, 255, 0, 255, 0, 255, 0, 255, 255, 0xfa, 0xce, 0xed]
  for (const topDown of [false, true]) {
    const asset = await decodeCursor(cursorFile([{
      width: 3, height: 2,
      payload: cursorDib({ width: 3, height: 2, depth: 24, topDown,
        xorRows: topDown ? [top, bottom] : [bottom, top],
        andRows: topDown ? [[0xa0], [0x40]] : [[0x40], [0xa0]] }),
    }]), { png }), image = asset.frames[0]!.images[0]!
    assert.deepEqual([...image.data], [
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 0, 255,
    ], `topDown=${topDown}`)
    assert.deepEqual([...image.andMask], [255, 0, 255, 0, 255, 0])
  }
})

test('CUR 16-bit RGB555 and explicit RGB565 fields replicate high channel bits', async () => {
  const ordinary = cursorDib({ width: 4, height: 1, depth: 16,
      xorRows: [[0x00, 0x7c, 0xe0, 0x03, 0x1f, 0x00, 0x10, 0x42]] }),
    fields = cursorDib({ width: 4, height: 1, depth: 16, masks: [0xf800, 0x07e0, 0x001f],
      xorRows: [[0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0x10, 0x84]] }),
    asset = await decodeCursor(cursorFile([
      { width: 4, height: 1, payload: ordinary }, { width: 4, height: 1, payload: fields },
    ]), { png })
  assert.deepEqual([...asset.frames[0]!.images[0]!.data], [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 132, 132, 132, 255,
  ])
  assert.deepEqual([...asset.frames[0]!.images[1]!.data], [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 132, 130, 132, 255,
  ])
})

test('CUR RGB555/565 low channel values match the hosted Win32 byte expansion', async () => {
  // 079 native-cursor-windows-{2022,2025}-1: dib-info-16 at (23,16)
  // is RGB(57,66,123), not the former ratio-rounded RGB(58,66,123).
  // dib-bitfields-16 at (16,41) expands source 31 26 to RGB(33,199,140),
  // so the 6-bit green channel also distinguishes replication from rounding.
  const asset = await decodeCursor(cursorFile([
    { width: 2, height: 1, payload: cursorDib({ width: 2, height: 1, depth: 16,
      xorRows: [[0x0f, 0x1d, 0x17, 0x5e]] }) },
    { width: 2, height: 1, payload: cursorDib({ width: 2, height: 1, depth: 16,
      masks: [0xf800, 0x07e0, 0x001f], xorRows: [[0x2f, 0x3a, 0x31, 0x26]] }) },
  ]), { png })
  assert.deepEqual([...asset.frames[0]!.images[0]!.data], [57, 66, 123, 255, 189, 132, 189, 255])
  assert.deepEqual([...asset.frames[0]!.images[1]!.data], [57, 69, 123, 255, 33, 199, 140, 255])
})

test('CUR rejects overlapping, noncontiguous and out-of-depth bit fields', async () => {
  for (const [masks, message] of [
    [[0xf800, 0xf800, 0x001f], /overlapping/],
    [[0xa000, 0x07e0, 0x001f], /noncontiguous/],
    [[0x10000, 0x07e0, 0x001f], /exceeds pixel depth/],
    [[0, 0x07e0, 0x001f], /empty RGB/],
  ] as const) {
    const payload = cursorDib({ width: 1, height: 1, depth: 16, masks, xorRows: [[0, 0]] })
    await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 1, payload }]), { png }), message)
  }
})

test('CUR 32-bit all-zero alpha retains legacy AND/XOR instead of becoming invisible', async () => {
  const asset = await decodeCursor(cursorFile([{
    width: 2, height: 1,
    payload: cursorDib({ width: 2, height: 1, depth: 32,
      xorRows: [[0, 0, 255, 0, 255, 0, 0, 0]], andRows: [[0x40]] }),
  }]), { png }), image = asset.frames[0]!.images[0]!
  assert.equal(image.mode, 'and-xor')
  assert.deepEqual([...image.data], [255, 0, 0, 255, 0, 0, 255, 255])
  const target = surface(2, 1, [10, 20, 30, 255, 100, 150, 200, 255])
  compositeCursor(image, target, 0, 0)
  assert.deepEqual([...target.data], [255, 0, 0, 255, 100, 150, 55, 255])
})

test('CUR 32-bit nonzero alpha selects source-over and preserves fully transparent pixels', async () => {
  const asset = await decodeCursor(cursorFile([{
    width: 2, height: 1,
    payload: cursorDib({ width: 2, height: 1, depth: 32,
      xorRows: [[0, 0, 255, 128, 0, 255, 0, 0]], andRows: [[0xc0]] }),
  }]), { png }), image = asset.frames[0]!.images[0]!
  assert.equal(image.mode, 'alpha')
  assert.deepEqual([...image.andMask], [255, 255])
  assert.deepEqual([...image.data], [255, 0, 0, 128, 0, 255, 0, 0])
  const target = surface(2, 1, [10, 20, 30, 255, 100, 150, 200, 255])
  compositeCursor(image, target, 0, 0)
  assert.deepEqual([...target.data], [133, 10, 15, 255, 100, 150, 200, 255])
})

test('CUR permits an absent AND plane only for genuine 32-bit alpha and rejects partial masks', async () => {
  const payload = cursorDib({ width: 1, height: 1, depth: 32,
    xorRows: [[30, 20, 10, 255]], andRows: null })
  const image = (await decodeCursor(cursorFile([{ width: 1, height: 1, payload }]), { png })).frames[0]!.images[0]!
  assert.deepEqual([...image.data], [10, 20, 30, 255])
  assert.deepEqual([...image.andMask], [0])
  for (const incomplete of [Buffer.concat([payload, Buffer.from([0])]), Buffer.concat([payload, Buffer.from([0, 0, 0])])])
    await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 1, payload: incomplete }]), { png }), /AND mask/)
  const noAlpha = Buffer.from(payload)
  noAlpha[43] = 0
  await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 1, payload: noAlpha }]), { png }), /AND mask/)
})

test('CUR PNG uses real bounded decoding, retains transparency, and owns host pixel storage', async () => {
  const encoded = cursorFile([{ width: 2, height: 1,
    payload: cursorPng(2, 1, [200, 100, 50, 0, 201, 101, 51, 128]), hotspot: [1, 0] }])
  let hostPixels: Pixels | undefined
  const asset = await decodeCursor(encoded, { png: async (bytes) => {
    const decoded = await png(bytes)
    hostPixels = { ...decoded, data: Buffer.from(decoded.data) }
    return hostPixels
  } }), image = asset.frames[0]!.images[0]!
  assert.equal(image.encoding, 'png')
  assert.equal(image.mode, 'alpha')
  assert.deepEqual(image.hotspot, { x: 1, y: 0 })
  hostPixels!.data.fill(0)
  assert.deepEqual([...image.data], [200, 100, 50, 0, 201, 101, 51, 128])
  const target = surface(2, 1, [10, 20, 30, 255, 100, 150, 200, 255])
  compositeCursor(image, target, 0, 0)
  assert.deepEqual([...target.data], [10, 20, 30, 255, 150, 125, 125, 255])
})

test('CUR DIB and PNG alpha quantize source premultiplication before background blending', async () => {
  // The two hosted Windows versions agree for dib-alpha-40-1 pixel(17,16):
  // source BGRA is 72 47 28 80, native black BGRA is 39 23 14 ff.
  // Include the already-premultiplied source fixture too: loading multiplies
  // it again, so its input bytes must not be reinterpreted as premultiplied.
  for (const [rgba, expected] of [
    [[40, 71, 114, 128], [[20, 35, 57], [147, 162, 184], [29, 61, 100]]],
    [[20, 35, 57, 128], [[10, 17, 28], [137, 144, 155], [19, 43, 71]]],
  ] as const) {
    const [r, g, b, a] = rgba
    for (const payload of [
      cursorDib({ width: 1, height: 1, depth: 32, xorRows: [[b, g, r, a]], andRows: [[0x80]] }),
      cursorPng(1, 1, rgba),
    ]) {
      const image = (await decodeCursor(cursorFile([{ width: 1, height: 1, payload }]), { png })).frames[0]!.images[0]!
      for (const [index, rgb] of [[0, [0, 0, 0]], [1, [255, 255, 255]], [2, [18, 52, 86]]] as const) {
        const target = surface(1, 1, [...rgb, 255])
        compositeCursor(image, target, 0, 0)
        assert.deepEqual([...target.data], [...expected[index], 255])
      }
    }
  }
})

test('CUR preflights PNG directory dimensions and budgets before calling its decoder', async () => {
  const payload = cursorPng(1, 1, [10, 20, 30, 255])
  let calls = 0
  const counted: CursorDecodeOptions = { png: async (bytes) => { calls++; return png(bytes) } }
  await assert.rejects(decodeCursor(cursorFile([{ width: 2, height: 1, payload }]), counted), /PNG dimensions/)
  const oversized = Buffer.from(payload)
  oversized.writeUInt32BE(0xffffffff, 16)
  await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 1, payload: oversized }]), counted), /PNG dimensions/)
  await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 1, payload: payload.subarray(0, 32) }]), counted), /truncated/)
  await assert.rejects(decodeCursor(cursorFile([
    { width: 1, height: 1, payload }, { width: 1, height: 1, payload },
  ]), { ...counted, limits: { imagesPerFrame: 1 } }), /directory budget/)
  assert.equal(calls, 0)
  const valid = cursorFile([{ width: 1, height: 1, payload }])
  for (const invalid of [surface(2, 1, [0, 0, 0, 255]), surface(1, 1, [0, 0, 0])])
    await assert.rejects(decodeCursor(valid, { png: async () => invalid }), /inconsistent pixels/)
  const corrupt = Buffer.from(payload)
  corrupt[29] ^= 1
  await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 1, payload: corrupt }]), { png }), /CRC/)
})

test('CUR keeps distinct image sizes, pixels, and hotspots in one directory', async () => {
  const asset = await decodeCursor(cursorFile([
    { width: 1, height: 1, hotspot: [0, 0],
      payload: cursorDib({ width: 1, height: 1, depth: 24, xorRows: [[0, 0, 255]] }) },
    { width: 2, height: 2, hotspot: [1, 0],
      payload: cursorDib({ width: 2, height: 2, depth: 24,
        xorRows: [[255, 0, 0, 255, 255, 255], [0, 0, 255, 0, 255, 0]] }) },
    { width: 3, height: 1, hotspot: [2, 0],
      payload: cursorPng(3, 1, [10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0]) },
  ]), { png })
  assert.equal(asset.frames.length, 1)
  assert.equal(asset.imageCount, 3)
  assert.equal(asset.decodedBytes, 40)
  assert.deepEqual(asset.frames[0]!.images.map((i) => [i.width, i.height, i.hotspot.x, i.hotspot.y]), [
    [1, 1, 0, 0], [2, 2, 1, 0], [3, 1, 2, 0],
  ])
  assert.deepEqual([...asset.frames[0]!.images[1]!.data], [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ])
  assert.deepEqual([...asset.frames[0]!.images[2]!.data], [10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0])
})

test('CUR composition clips without wrapping rows and rejects malformed destinations', async () => {
  const asset = await decodeCursor(cursorFile([{ width: 2, height: 2,
    payload: cursorDib({ width: 2, height: 2, depth: 24,
      xorRows: [[255, 0, 0, 255, 255, 255], [0, 0, 255, 0, 255, 0]] }) }]), { png }),
    image = asset.frames[0]!.images[0]!, target = surface(2, 1, [1, 2, 3, 255, 4, 5, 6, 255])
  compositeCursor(image, target, -1, -1)
  assert.deepEqual([...target.data], [255, 255, 255, 255, 4, 5, 6, 255])
  compositeCursor(image, target, 2, 1)
  assert.deepEqual([...target.data], [255, 255, 255, 255, 4, 5, 6, 255])
  for (const destination of [surface(0, 1, []), surface(-1, -1, [0, 0, 0, 0]), surface(1, 1, [0])])
    assert.throws(() => compositeCursor(image, destination, 0, 0), /destination/)
  assert.throws(() => compositeCursor(image, target, 0.5, 0), /destination/)
})

test('ANI preserves repeated frame sequence, per-step rates, and exact loop boundaries', async () => {
  const bytes = animatedCursor([solid(255, 0, 0), solid(0, 255, 0)], {
      sequence: [1, 0, 1, 1], rates: [3, 6, 9, 12], defaultRate: 99,
      extraChunks: [riffChunk('JUNK', Buffer.from([0xa5]))],
    }), asset = await decodeCursor(bytes, { png })
  assert.equal(asset.kind, 'ani')
  assert.equal(asset.frames.length, 2)
  assert.deepEqual(asset.sequence, [1, 0, 1, 1])
  assert.deepEqual(asset.rates, [3, 6, 9, 12])
  assert.equal(asset.durationJiffies, 30)
  assert.equal(asset.sourceBytes, bytes.length)
  assert.equal(asset.decodedBytes, 10)
  assert.equal(asset.imageCount, 2)
  assert.deepEqual([...asset.frames[0]!.images[0]!.data], [255, 0, 0, 255])
  assert.deepEqual([...asset.frames[1]!.images[0]!.data], [0, 255, 0, 255])
  assert.deepEqual(asset.animation, { width: 0, height: 0, depth: 0, planes: 0, flags: 3 })
  for (const [time, step, frame] of [
    [0, 0, 1], [49.999, 0, 1], [50, 1, 0], [149.999, 1, 0],
    [150, 2, 1], [299.999, 2, 1], [300, 3, 1], [499.999, 3, 1],
    [500, 0, 1], [550, 1, 0], [1000, 0, 1], [1050, 1, 0],
  ]) {
    assert.equal(cursorStep(asset, time!), step, `time=${time}`)
    assert.equal(asset.sequence[cursorStep(asset, time!)], frame, `frame at ${time}`)
  }
  for (const time of [-1, Infinity, NaN]) assert.throws(() => cursorStep(asset, time), /animation time/)
})

test('ANI defaults to directory order and header rate when seq and rate chunks are absent', async () => {
  const asset = await decodeCursor(animatedCursor([solid(1, 2, 3), solid(4, 5, 6)], { defaultRate: 6 }), { png })
  assert.deepEqual(asset.sequence, [0, 1])
  assert.deepEqual(asset.rates, [6, 6])
  assert.equal(asset.durationJiffies, 12)
  assert.equal(cursorStep(asset, 99.999), 0)
  assert.equal(cursorStep(asset, 100), 1)
  assert.equal(cursorStep(asset, 199.999), 1)
  assert.equal(cursorStep(asset, 200), 0)
})

test('ANI sequence chunk presence takes precedence over its advisory sequence flag', async () => {
  const frames = [solid(1, 2, 3), solid(4, 5, 6), solid(7, 8, 9)],
    absent = await decodeCursor(animatedCursor(frames, { flags: 3 }), { png }),
    present = await decodeCursor(animatedCursor(frames, { flags: 1, sequence: [2, 0, 2, 1, 0],
      rates: [1, 4, 7, 2, 9] }), { png })
  assert.deepEqual(absent.sequence, [0, 1, 2])
  assert.deepEqual(absent.rates, [6, 6, 6])
  assert.equal(absent.animation!.flags, 3)
  assert.deepEqual(present.sequence, [2, 0, 2, 1, 0])
  assert.deepEqual(present.rates, [1, 4, 7, 2, 9])
  assert.equal(present.animation!.flags, 1)
})

test('ANI retains native zero rates for indexed frames without inventing wall-clock timing', async () => {
  const frames = [solid(1, 2, 3), solid(4, 5, 6), solid(7, 8, 9)]
  for (const rates of [[0, 1, 0], undefined]) {
    const asset = await decodeCursor(animatedCursor(frames, { defaultRate: 0, rates }), { png })
    assert.deepEqual(asset.sequence, [0, 1, 2])
    assert.deepEqual(asset.rates, rates ?? [0, 0, 0])
    assert.equal(asset.durationJiffies, rates ? 1 : 0)
    assert.deepEqual(asset.frames.map((frame) => [...frame.images[0]!.data]), [
      [1, 2, 3, 255], [4, 5, 6, 255], [7, 8, 9, 255],
    ])
    for (const elapsed of [0, 1, 1000])
      assert.throws(() => cursorStep(asset, elapsed), /zero-rate playback timing is not calibrated/)
  }
})

test('ANI one-jiffy steps keep exact 50ms and 100ms boundaries over many loops', async () => {
  const asset = await decodeCursor(animatedCursor([solid(255, 0, 0), solid(0, 0, 255)], {
    rates: [1, 1],
  }), { png })
  assert.equal(asset.durationJiffies, 2)
  for (const [milliseconds, step] of [
    [0, 0], [16, 0], [1000 / 60, 1], [33, 1], [1000 / 30, 0],
    [50, 1], [100, 0], [150, 1], [1000, 0], [1050, 1], [60000, 0], [60050, 1],
  ]) assert.equal(cursorStep(asset, milliseconds!), step, `milliseconds=${milliseconds}`)
})

test('ANI accepts embedded ICO frames with centered hotspots but standalone ICO is not CUR', async () => {
  const icon = cursorFile([{ width: 2, height: 1,
    payload: cursorPng(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]) }], 1),
    asset = await decodeCursor(animatedCursor([icon]), { png })
  assert.deepEqual(asset.frames[0]!.images[0]!.hotspot, { x: 1, y: 0 })
  assert.deepEqual([...asset.frames[0]!.images[0]!.data], [255, 0, 0, 255, 0, 0, 255, 255])
  await assert.rejects(decodeCursor(icon, { png }), /CUR directory/)
})

test('CUR preserves unsigned hotspots outside the image bounds', async () => {
  for (const hotspot of [[33, 40], [65535, 65535]] as const) {
    const image = (await decodeCursor(cursorFile([{ width: 1, height: 1, hotspot,
      payload: cursorDib({ width: 1, height: 1, depth: 24, xorRows: [[30, 20, 10]] }),
    }]), { png })).frames[0]!.images[0]!
    assert.deepEqual(image.hotspot, { x: hotspot[0], y: hotspot[1] })
    const target = surface(1, 1, [1, 2, 3, 255])
    compositeCursor(image, target, -hotspot[0], -hotspot[1])
    assert.deepEqual([...target.data], [1, 2, 3, 255])
  }
})

test('CUR rejects truncation, unsafe offsets, and extra DIB data', async () => {
  const valid = solid(10, 20, 30)
  for (const length of [0, 1, 5, 6, 21, 22, 33, valid.length - 1])
    await assert.rejects(decodeCursor(valid.subarray(0, length), { png }), /Cursor:/, `length=${length}`)
  for (const [offset, value, message] of [
    [18, 0xffffffff, /truncated/], [18, 21, /directory entry/],
    [14, 0xffffffff, /truncated/], [14, 0, /directory entry/],
  ] as const) {
    const bytes = Buffer.from(valid)
    bytes.writeUInt32LE(value, offset)
    await assert.rejects(decodeCursor(bytes, { png }), message)
  }
  const reserved = Buffer.from(valid)
  reserved[9] = 1
  await assert.rejects(decodeCursor(reserved, { png }), /directory entry/)
  const extraPayload = Buffer.concat([valid.subarray(22), Buffer.from([0])])
  await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 1, payload: extraPayload }]), { png }), /extra DIB/)
})

test('ANI rejects truncated RIFF/chunks, missing frames, invalid sequence/rates, and duplicates', async () => {
  const frames = [solid(1, 2, 3), solid(4, 5, 6)], valid = animatedCursor(frames)
  for (const length of [4, 11, 12, 24, valid.length - 1])
    await assert.rejects(decodeCursor(valid.subarray(0, length), { png }), /Cursor:/)
  const truncatedChunk = Buffer.from(valid)
  truncatedChunk.writeUInt32LE(0xffffffff, 16)
  await assert.rejects(decodeCursor(truncatedChunk, { png }), /truncated/)
  for (const [options, message] of [
    [{ sequence: [0, 2] }, /missing frame/],
    [{ sequence: [0], steps: 2 }, /sequence length/],
    [{ rates: [6] }, /rate length/],
    [{ steps: 3 }, /missing its frame sequence/],
    [{ frameCount: 3, steps: 3 }, /frame count/],
    [{ flags: 0 }, /unsupported ANI/],
    [{ flags: 5 }, /unsupported ANI/],
    [{ sequence: [0, 1], extraChunks: [riffChunk('seq ', words([1, 0]))] }, /duplicate ANI seq/],
    [{ rates: [6, 6], extraChunks: [riffChunk('rate', words([6, 6]))] }, /duplicate ANI rate/],
    [{ extraChunks: [riffChunk('LIST', Buffer.from('fram'))] }, /one frame list/],
  ] satisfies [Parameters<typeof animatedCursor>[1], RegExp][]) {
    await assert.rejects(decodeCursor(animatedCursor(frames, options), { png }), message)
  }
  const missingOddPad = animatedCursor(frames, { extraChunks: [riffChunk('JUNK', Buffer.from([1]))] })
  // A RIFF body ending in an odd-size chunk still requires its pad byte.
  const oddTail = Buffer.concat([missingOddPad, Buffer.from('JUNK'), words([1]), Buffer.from([1])])
  oddTail.writeUInt32LE(oddTail.length - 8, 4)
  await assert.rejects(decodeCursor(oddTail, { png }), /truncated/)
})

test('CUR and ANI enforce reduced source, pixel, image, frame, step, and duration budgets', async () => {
  const one = solid(1, 2, 3), two = animatedCursor([one, one])
  await assert.rejects(decodeCursor(one, { png, limits: { sourceBytes: one.length - 1 } }), /source byte budget/)
  await assert.rejects(decodeCursor(two, { png, limits: { frames: 1 } }), /frame or step budget/)
  await assert.rejects(decodeCursor(two, { png, limits: { steps: 1 } }), /frame or step budget/)
  await assert.rejects(decodeCursor(two, { png, limits: { images: 1 } }), /decoded image budget/)
  await assert.rejects(decodeCursor(two, { png, limits: { pixels: 1 } }), /decoded image budget/)
  await assert.rejects(decodeCursor(two, { png, limits: { durationJiffies: 11 } }), /duration budget/)
  for (const limits of [{ pixels: 0 }, { pixels: -1 }, { pixels: 1.5 }, { pixels: NaN },
    { pixels: Infinity }, { pixels: cursorLimits.pixels + 1 }])
    await assert.rejects(decodeCursor(one, { png, limits }), /invalid decoder budget/)
  const asset = await decodeCursor(two, { png, limits: { frames: 2, steps: 2, images: 2, pixels: 2, durationJiffies: 12 } })
  assert.equal(asset.imageCount, 2)
})

test('CUR snapshots an offset Buffer view before the first asynchronous checkpoint', async () => {
  const file = solid(10, 20, 30), backing = Buffer.concat([Buffer.from([99, 98]), file, Buffer.from([97])]),
    source = backing.subarray(2, 2 + file.length)
  let release!: () => void
  const paused = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const result = decodeCursor(source, { png, checkpoint: () => ++calls === 1 ? paused : undefined })
  source.fill(0)
  release()
  const asset = await result
  assert.deepEqual([...asset.frames[0]!.images[0]!.data], [10, 20, 30, 255])
  assert.equal(asset.sourceBytes, file.length)
  assert.equal(backing[0], 99)
  assert.equal(backing[backing.length - 1], 97)
})

test('CUR cancellation checkpoints stop DIB row work and reject after awaited PNG decode', async () => {
  const cancelled = new Error('cursor decode cancelled'),
    payload = cursorDib({ width: 1, height: 16, depth: 24,
      xorRows: Array.from({ length: 16 }, () => [30, 20, 10]) })
  let checkpoints = 0
  await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 16, payload }]), {
    png, checkpoint: () => { if (++checkpoints === 3) throw cancelled },
  }), (error) => error === cancelled)
  assert.equal(checkpoints, 3)
  let decoded = false
  await assert.rejects(decodeCursor(cursorFile([{ width: 1, height: 1,
    payload: cursorPng(1, 1, [10, 20, 30, 255]) }]), {
    png: async (bytes) => { const result = await png(bytes); decoded = true; return result },
    checkpoint: () => { if (decoded) throw cancelled },
  }), (error) => error === cancelled)
  assert.equal(decoded, true)
})
