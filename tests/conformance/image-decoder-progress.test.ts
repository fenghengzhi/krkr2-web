import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodeSelectedImage, type SelectedImageDecoderDependencies } from '../../src/engine/graphics/image-decoder.ts'
import { ImageDecodeError, type ImageDecodeProgress, type ImageDecodeSelection } from '../../src/formats/image/selection.ts'
import { inflateImage } from '../../src/backends/files/blob-source.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { imageFixture, imageManifest, imageBytes } from '../helpers/image-fixtures.ts'
import { tlgFixture, tlgSds } from '../helpers/tlg-fixtures.ts'
import { tlgCases } from '../helpers/tlg-vectors.ts'

const options = { timeout: 30000 }
const dependencies: SelectedImageDecoderDependencies = {
  async finish<T>(work: Generator<void, T>): Promise<T> {
    let next = work.next()
    while (!next.done) next = work.next()
    return next.value
  },
  inflate: inflateImage,
  async host() { throw new Error('Unexpected selected-codec fallback') },
}
function observation() {
  const sizes: number[][] = [], rows: { y: number; data: number[]; indices?: number[] }[] = [],
    progress: ImageDecodeProgress = {
      size(width, height) { sizes.push([width, height]) },
      row(y, data, indices) { rows.push({ y, data: [...data], ...(indices ? { indices: [...indices] } : {}) }) },
    }
  return { sizes, rows, progress }
}
function decode(bytes: Uint8Array, format: ImageDecodeSelection['format'], progress: ImageDecodeProgress,
  mode: ImageDecodeSelection['mode'] = 'normal', extra: Partial<SelectedImageDecoderDependencies> = {}) {
  return decodeSelectedImage(bytes, { format, mode }, { ...dependencies, ...extra }, progress)
}
function chunk(type: string, data: Uint8Array): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length); bytes.write(type, 4); bytes.set(data, 8)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, 8 + data.length)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length)
  return bytes
}
function png(rows: readonly number[], height = 2, interlaced = false, badTail = false): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 6; header[12] = Number(interlaced)
  const end = chunk('IEND', new Uint8Array())
  if (badTail) end[end.length - 1] = end[end.length - 1]! ^ 1
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))), end])
}
function bmp(topDown: boolean, presentRows = 17): Buffer {
  // One 24-bit pixel plus one padding byte per file-order row.
  const bytes = Buffer.alloc(54 + presentRows * 4)
  bytes.write('BM'); bytes.writeUInt32LE(54 + 17 * 4, 2); bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(1, 18); bytes.writeInt32LE(topDown ? -17 : 17, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28)
  for (let row = 0; row < presentRows; row++) bytes.set([33 + row, 22, 11, 0], 54 + row * 4)
  return bytes
}
function tlg5(): Buffer {
  const header = Buffer.alloc(32)
  header.write('TLG5.0\0raw\x1a', 'binary'); header[11] = 3
  header.writeUInt32LE(1, 12); header.writeUInt32LE(2, 16); header.writeUInt32LE(1, 20)
  header.writeUInt32LE(18, 24); header.writeUInt32LE(18, 28)
  const plane = (value: number) => Buffer.from([1, 1, 0, 0, 0, value])
  return Buffer.concat([header, ...[10, 20, 30, 1, 2, 3].map(plane)])
}

test('selected PNG/BMP progress retains every independent full RGBA and index reference', options, async () => {
  for (const entry of imageManifest.entries) {
    if (entry.name.endsWith('.gif')) continue
    const observed = observation(), format = entry.name.endsWith('.bmp') ? 'bmp' : 'png',
      image = await decode(imageFixture(entry.name), format, observed.progress)
    assert.deepEqual(observed.sizes, [[entry.width, entry.height]], entry.name)
    assert.equal(observed.rows.length, entry.height, entry.name)
    assert.equal(new Set(observed.rows.map((row) => row.y)).size, entry.height)
    const rgba = entry.name === 'transparent-rgb.png'
      ? Uint8Array.from([0x12, 0x56, 0x9a, 255, 0x12, 0x56, 0x9a, 255])
      : new Uint8Array(imageBytes.subarray(entry.rgbaOffset, entry.rgbaOffset + entry.width * entry.height * 4))
    for (const row of observed.rows) {
      const offset = row.y * entry.width * 4
      assert.deepEqual(row.data, [...rgba.subarray(offset, offset + entry.width * 4)], entry.name)
      if (entry.indicesOffset !== undefined) {
        const at = entry.indicesOffset + row.y * entry.width
        assert.deepEqual(row.indices, [...imageBytes.subarray(at, at + entry.width)], entry.name)
      }
    }
    assert.deepEqual(image.data, rgba)
  }
})

test('BMP partial writes follow complete eight-line file-order batches in both orientations', options, async () => {
  for (const topDown of [false, true]) for (const presentRows of [7, 9, 17]) {
    const observed = observation(), work = decode(bmp(topDown, presentRows), 'bmp', observed.progress)
    if (presentRows === 17) await work
    else await assert.rejects(work, { message: 'Truncated BMP pixels or palette' })
    const count = presentRows === 17 ? 17 : presentRows === 9 ? 8 : 0
    assert.deepEqual(observed.sizes, [[1, 17]])
    assert.deepEqual(observed.rows, Array.from({ length: count }, (_, row) => ({
      y: topDown ? row : 16 - row, data: [11, 22, 33 + row, 255],
    })))
  }
})

test('PNG invalid second filter keeps the completed first row without claiming the failing row', options, async () => {
  const observed = observation()
  await assert.rejects(decode(png([0, 20, 40, 60, 80, 5, 90, 100, 110, 120]), 'png', observed.progress),
    { message: 'Unsupported PNG scanline filter' })
  assert.deepEqual(observed.sizes, [[1, 2]])
  assert.deepEqual(observed.rows, [{ y: 0, data: [20, 40, 60, 80] }])
})

test('PNG noninterlaced read-end CRC failure preserves all completed rows', options, async () => {
  for (const truncated of [false, true]) {
    const observed = observation(), bytes = png([0, 20, 40, 60, 80, 0, 90, 100, 110, 120], 2, false, true)
    await assert.rejects(decode(truncated ? bytes.subarray(0, bytes.length - 3) : bytes,
      'png', observed.progress), { message: truncated ? 'Truncated PNG chunk' : 'PNG chunk CRC mismatch' })
    assert.deepEqual(observed.sizes, [[1, 2]])
    assert.deepEqual(observed.rows, [{ y: 0, data: [20, 40, 60, 80] }, { y: 1, data: [90, 100, 110, 120] }])
  }
})

test('interlaced PNG publishes no rows until its final read-end check succeeds', options, async () => {
  // A one-pixel Adam7 image contains only pass zero; its independent row is
  // unambiguous while exercising the native all-image-before-copy boundary.
  for (const badTail of [true, false]) {
    const observed = observation(), pending = decode(png([0, 20, 40, 60, 80], 1, true, badTail), 'png', observed.progress)
    if (badTail) await assert.rejects(pending, { message: 'PNG chunk CRC mismatch' })
    else await pending
    assert.deepEqual(observed.sizes, [[1, 1]])
    assert.deepEqual(observed.rows, badTail ? [] : [{ y: 0, data: [20, 40, 60, 80] }])
  }
})

test('PNG size precedes a short first IDAT payload and preserves an original asynchronous inflate rejection', options, async () => {
  const encoded = png([0, 20, 40, 60, 80], 1)
  // Signature (8) + IHDR (25) then an IDAT header (8): independent offsets.
  for (const [length, sized, message] of [[40, false, 'Truncated PNG chunk'],
    [41, true, 'Truncated PNG chunk'], [45, true, 'Truncated PNG chunk data']] as const) {
    const partial = observation()
    await assert.rejects(decode(encoded.subarray(0, length), 'png', partial.progress), { message })
    assert.deepEqual(partial.sizes, sized ? [[1, 1]] : [])
    assert.deepEqual(partial.rows, [])
  }
  const observed = observation(), cause = new Error('real inflater rejected'), order: string[] = []
  await assert.rejects(decode(png([0, 20, 40, 60, 80], 1), 'png', {
    size(w, h) { observed.progress.size(w, h); order.push('size') }, row: observed.progress.row,
  }, 'normal', { async inflate() { order.push('inflate'); await Promise.resolve(); throw cause } }), (error) => error === cause)
  assert.deepEqual(order, ['size', 'inflate'])
  assert.deepEqual(observed.sizes, [[1, 1]])
  assert.deepEqual(observed.rows, [])
})

test('TLG5 commits only complete decoded blocks and retains rows before truncated later planes', options, async () => {
  for (const truncate of [true, false]) {
    const observed = observation(), bytes = tlg5(),
      pending = decode(truncate ? bytes.subarray(0, 55) : bytes, 'tlg', observed.progress)
    if (truncate) await assert.rejects(pending, { message: 'Truncated or invalid binary data' })
    else await pending
    assert.deepEqual(observed.sizes, [[1, 2]])
    assert.deepEqual(observed.rows, [{ y: 0, data: [50, 20, 30, 255] },
      ...(!truncate ? [{ y: 1, data: [55, 22, 33, 255] }] : [])])
  }
})

test('TLG6 size precedes filter/plane reads and complete native-reference rows remain unchanged', options, async () => {
  const head = Buffer.alloc(27)
  head.write('TLG6.0\0raw\x1a', 'binary'); head[11] = 3
  head.writeUInt32LE(1, 15); head.writeUInt32LE(1, 19); head.writeUInt32LE(32, 23)
  const early = observation()
  await assert.rejects(decode(head, 'tlg', early.progress), { message: 'Truncated or invalid binary data' })
  assert.deepEqual(early.sizes, [[1, 1]]); assert.deepEqual(early.rows, [])
  for (const item of tlgCases()) {
    const observed = observation(), image = await decode(tlgFixture(item.id), 'tlg', observed.progress)
    assert.deepEqual(observed.sizes, [[item.width, item.height]], item.id)
    assert.deepEqual(observed.rows.map((row) => row.y), Array.from({ length: item.height }, (_, y) => y))
    for (const row of observed.rows)
      assert.deepEqual(row.data, [...item.data.subarray(row.y * item.width * 4, (row.y + 1) * item.width * 4)], item.id)
    assert.deepEqual(image.data, item.data, item.id)
  }
})

test('TLG SDS malformed trailing metadata preserves pixels but never turns the failure into success', options, async () => {
  const observed = observation(), body = tlg5(), bad = tlgSds(body, [['tags', Buffer.from('1:x=1:y;')]])
  await assert.rejects(decode(bad, 'tlg', observed.progress), (error: unknown) => {
    assert.ok(error instanceof TvpError)
    assert.deepEqual(error.tvpMessage, { id: 'TVPTLGLoadError', args: ['Malformed TLG SDS tag structure, missing comma after a tag'] })
    return true
  })
  assert.deepEqual(observed.sizes, [[1, 2]])
  assert.deepEqual(observed.rows, [{ y: 0, data: [50, 20, 30, 255] }, { y: 1, data: [55, 22, 33, 255] }])
})

test('gray and palette callbacks preserve their actual selected planes before any caller key or mask', options, async () => {
  const gray = observation()
  await decode(png([0, 20, 40, 60, 80], 1), 'png', gray.progress, 'grayscale')
  assert.deepEqual(gray.rows, [{ y: 0, data: [60, 60, 60, 255] }])
  for (const format of ['bmp', 'png'] as const) {
    const observed = observation(), name = format === 'bmp' ? 'palette-2x1.bmp' : 'palette-2x1.png',
      image = await decode(imageFixture(name), format, observed.progress, 'palettized')
    assert.deepEqual(observed.rows.map((row) => row.indices), [[...image.indices!]])
    assert.equal(observed.rows[0]!.data[3], 255)
  }
})

test('progress sink exceptions including codec-looking errors escape by exact identity and stop further rows', options, async () => {
  for (const [format, bytes] of [['bmp', bmp(true)], ['png', png([0, 20, 40, 60, 80, 0, 90, 100, 110, 120])],
    ['tlg', tlg5()]] as const) for (const phase of ['size', 'row']) {
    const cause = new ImageDecodeError('png', 'PNG chunk CRC mismatch'), events: string[] = []
    await assert.rejects(decode(bytes, format, {
      size() { events.push('size'); if (phase === 'size') throw cause },
      row(y) { events.push('row:' + y); throw cause },
    }), (error) => error === cause)
    assert.deepEqual(events, phase === 'size' ? ['size'] : ['size', 'row:0'])
  }
})

test('preflight and Web bounds fail before size while a successful JPEG host publishes only converted output', options, async () => {
  const observed = observation(), tooWide = bmp(true)
  tooWide.writeInt32LE(4097, 18)
  await assert.rejects(decode(tooWide, 'bmp', observed.progress))
  await assert.rejects(decode(new Uint8Array(2), 'png', observed.progress))
  await assert.rejects(decode(tlg5(), 'tlg', observed.progress, 'grayscale'))
  await assert.rejects(decode(new Uint8Array(), 'eri', observed.progress))
  assert.deepEqual(observed.sizes, []); assert.deepEqual(observed.rows, [])
  await decode(new Uint8Array([255, 216, 255]), 'jpeg', observed.progress, 'grayscale', {
    async host() { return { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 17]) } },
  })
  assert.deepEqual(observed.sizes, [[1, 1]])
  assert.deepEqual(observed.rows, [{ y: 0, data: [76, 76, 76, 255] }])
})
