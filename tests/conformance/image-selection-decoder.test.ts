import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodeSelectedImage, type SelectedImageDecoderDependencies } from '../../src/engine/graphics/image-decoder.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { ImageDecodeError, type ImageDecodeSelection } from '../../src/formats/image/selection.ts'
import { decodeBmp } from '../../src/formats/image/bmp.ts'
import { decodePng } from '../../src/formats/image/png.ts'
import { decodeTlg } from '../../src/formats/image/tlg/index.ts'
import { inflateImage } from '../../src/backends/files/blob-source.ts'
import { imageBytes, imageFixture, imageManifest } from '../helpers/image-fixtures.ts'
import { tlgFixture, tlgSds } from '../helpers/tlg-fixtures.ts'
import { tlgCases } from '../helpers/tlg-vectors.ts'

function finish<T>(work: Generator<void, T>): T {
  let step = work.next()
  while (!step.done) step = work.next()
  return step.value
}
const dependencies: SelectedImageDecoderDependencies = {
  async finish<T>(work: Generator<void, T>): Promise<T> { return finish(work) },
  inflate: inflateImage,
  async host() { throw new Error('Unexpected host decoder fallback') },
}
function decode(bytes: Uint8Array, format: ImageDecodeSelection['format'], mode: ImageDecodeSelection['mode'] = 'normal',
  overrides: Partial<SelectedImageDecoderDependencies> = {}) {
  return decodeSelectedImage(bytes, { format, mode }, { ...dependencies, ...overrides })
}
function native(id: string, reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof TvpError)
    assert.deepEqual(error.tvpMessage, { id, args: [reason] })
    assert.ok(error.cause instanceof ImageDecodeError)
    return true
  }
}
function untyped(error: unknown): boolean {
  assert.ok(error instanceof Error)
  assert.ok(!(error instanceof TvpError))
  return true
}
function bmp(depth = 24): Buffer {
  const bytes = Buffer.alloc(62)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(2, 18)
  bytes.writeInt32LE(1, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(depth, 28)
  // Top-left RGB(200,100,50), next RGB(10,20,250), with distinct raw alpha.
  bytes.set(depth === 32 ? [50, 100, 200, 4, 250, 20, 10, 91] : [50, 100, 200, 250, 20, 10, 0, 0], 54)
  return bytes
}
function chunk(type: string, data: Uint8Array): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(type, 4)
  bytes.set(data, 8)
  // Test-only scalar CRC, independent of the portable parser's generator.
  let crc = 0xffffffff
  for (let i = 4; i < 8 + data.length; i++) {
    crc ^= bytes[i]!
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length)
  return bytes
}
function png(color: number, depth: number, samples: readonly number[], width = 2, height = 1): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = depth
  ihdr[9] = color
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, ...samples]))), chunk('IEND', Buffer.alloc(0)),
  ])
}

test('selected normal PNG/BMP retain every independent RGBA/index/metadata reference', { timeout: 30_000 }, async () => {
  for (const entry of imageManifest.entries) {
    if (entry.name.endsWith('.gif')) continue
    const format = entry.name.endsWith('.bmp') ? 'bmp' : 'png',
      image = await decode(imageFixture(entry.name), format),
      pixels = entry.width * entry.height
    assert.equal(image.width, entry.width, entry.name)
    assert.equal(image.height, entry.height, entry.name)
    // This existing fixture is a standard PNG tRNS oracle. The fixed native
    // RGB branch does not request expansion; keep its source bytes unchanged.
    const rgba = entry.name === 'transparent-rgb.png'
      ? Buffer.from([0x12, 0x56, 0x9a, 255, 0x12, 0x56, 0x9a, 255])
      : imageBytes.subarray(entry.rgbaOffset, entry.rgbaOffset + pixels * 4)
    assert.deepEqual(Buffer.from(image.data), rgba, entry.name)
    assert.deepEqual(image.indices && Buffer.from(image.indices), entry.indicesOffset === undefined ? undefined
      : imageBytes.subarray(entry.indicesOffset, entry.indicesOffset + pixels), entry.name)
    assert.equal(!!image.grayscale, entry.grayscale, entry.name)
    assert.deepEqual(image.metadata && Object.fromEntries(image.metadata), entry.metadata, entry.name)
  }
})

test('selected normal TLG5/6 retain the original native-encoder full pixel corpus', { timeout: 30_000 }, async () => {
  for (const item of tlgCases()) {
    const image = await decode(tlgFixture(item.id), 'tlg')
    assert.equal(image.width, item.width, item.id)
    assert.equal(image.height, item.height, item.id)
    assert.deepEqual(image.data, item.data, item.id)
  }
})

test('wrong bytes remain in the chosen handler and ERI is registered but unavailable', async () => {
  await assert.rejects(decode(imageFixture('main.png'), 'bmp'), native('TVPImageLoadError', 'This is not a Windows BMP file or an OS/2 BMP file.'))
  await assert.rejects(decode(bmp(), 'png'), native('TVPPNGLoadError', 'Not a PNG file'))
  await assert.rejects(decode(imageFixture('main.png'), 'tlg'), native('TVPTLGLoadError', 'Invalid TLG header or unsupported TLG version.'))
  await assert.rejects(decode(imageFixture('main.png'), 'jpeg'), untyped)
  await assert.rejects(decode(imageFixture('main.png'), 'eri'), (error: unknown) => {
    assert.ok(error instanceof TvpError)
    assert.deepEqual(error.tvpMessage, { id: 'TVPNotImplemented', args: [] })
    return true
  })
})

test('BMP known header/compression/mode reasons preserve preflight order and do not use another decoder', async () => {
  for (const [offset, value, reason] of [
    [14, 108, 'Non-supported header version.'],
    [30, 3, 'BITFIELDS not supported.'],
    [30, 1, 'Compressed BMP not supported.'],
  ] as const) {
    const bytes = bmp()
    bytes.writeUInt32LE(value, offset)
    await assert.rejects(decode(bytes, 'bmp', 'palettized'), native('TVPImageLoadError', reason))
  }
  await assert.rejects(decode(bmp(), 'bmp', 'palettized'), native('TVPImageLoadError', 'Unsupported color mode for palettized image.'))
  const indexed = Buffer.from(imageFixture('palette-2x1.bmp'))
  indexed.writeUInt32LE(3, 30)
  await assert.rejects(decode(indexed.subarray(0, 54), 'bmp'), untyped)
  await assert.rejects(decode(indexed, 'bmp'), native('TVPImageLoadError', 'BITFIELDS not supported.'))
})

test('BMP grayscale uses native scalar weights and drops alpha without replacing palette indices in palettized mode', async () => {
  for (const depth of [24, 32]) {
    const image = await decode(bmp(depth), 'bmp', 'grayscale')
    assert.deepEqual([...image.data], [117, 117, 117, 255, 34, 34, 34, 255])
    assert.equal(image.grayscale, true)
    assert.equal(image.indices, undefined)
  }
  const palette = await decode(imageFixture('palette-2x1.bmp'), 'bmp', 'palettized')
  assert.deepEqual([...palette.indices!], [0, 1])
  const gray = await decode(imageFixture('palette-2x1.bmp'), 'bmp', 'grayscale')
  assert.deepEqual([...gray.data], [53, 53, 53, 255, 53, 53, 53, 255])
  assert.equal(gray.indices, undefined)
})

test('native CORE BMP grayscale decodes portably without a host fallback', async () => {
  const core = Buffer.alloc(30)
  core.write('BM')
  core.writeUInt32LE(26, 10)
  core.writeUInt32LE(12, 14)
  core.writeUInt16LE(1, 18)
  core.writeUInt16LE(1, 20)
  core.writeUInt16LE(1, 22)
  core.writeUInt16LE(24, 24)
  core.set([50, 100, 200], 26)
  const result = await decode(core, 'bmp', 'grayscale')
  assert.deepEqual([...result.data], [117, 117, 117, 255])
})

test('PNG native grayscale distinguishes RGB blue coefficient from palette TVP weights and strips alpha', async () => {
  for (const bytes of [
    png(2, 8, [200, 100, 50, 10, 20, 250]),
    png(6, 8, [200, 100, 50, 0, 10, 20, 250, 91]),
    png(6, 16, [200, 7, 100, 8, 50, 9, 0, 0, 10, 9, 20, 8, 250, 7, 91, 0]),
  ]) {
    const image = await decode(bytes, 'png', 'grayscale')
    assert.deepEqual([...image.data], [50, 50, 50, 255, 250, 250, 250, 255])
    assert.equal(image.grayscale, true)
  }
  const palette = await decode(imageFixture('palette-2x1.png'), 'png', 'grayscale')
  assert.deepEqual([...palette.data], [53, 53, 53, 255, 53, 53, 53, 255])
  assert.equal(palette.indices, undefined)
  const grayAlpha = await decode(png(4, 8, [17, 0, 149, 71]), 'png', 'grayscale')
  assert.deepEqual([...grayAlpha.data], [17, 17, 17, 255, 149, 149, 149, 255])
})

test('PNG palettized mode retains independent index planes and gray source values', { timeout: 30_000 }, async () => {
  for (const entry of imageManifest.entries.filter((item) => item.indicesOffset !== undefined && !item.name.endsWith('.gif') && !item.name.endsWith('.bmp'))) {
    const image = await decode(imageFixture(entry.name), 'png', 'palettized')
    assert.deepEqual(Buffer.from(image.indices!), imageBytes.subarray(entry.indicesOffset!, entry.indicesOffset! + entry.width * entry.height), entry.name)
    assert.ok(image.data.every((value, i) => i % 4 !== 3 || value === 255))
  }
  const gray = await decode(imageFixture('mask.png'), 'png', 'palettized')
  assert.equal(gray.grayscale, true)
  assert.deepEqual([...gray.data], [0, 0, 0, 255, 128, 128, 128, 255])
})

test('PNG known signature/mode/size reasons stay separate from short reads and Web limits', async () => {
  const ascii = Buffer.from(imageFixture('main.png'))
  ascii[7] = 11
  await assert.rejects(decode(ascii, 'png'), native('TVPPNGLoadError', 'PNG file corrupted by ASCII conversion'))
  await assert.rejects(decode(imageFixture('png-0-16-0-1x1'), 'png', 'palettized'), native('TVPPNGLoadError', 'Unsupported color type for palattized image'))
  await assert.rejects(decode(png(2, 8, [1, 2, 3], 65536), 'png'), native('TVPPNGLoadError', 'Too large image'))
  await assert.rejects(decode(png(2, 8, [1, 2, 3], 4097), 'png'), untyped)
  await assert.rejects(decode(imageFixture('main.png').subarray(0, 7), 'png'), untyped)
  await assert.rejects(decode(imageFixture('main.png'), 'png', 'palettized'), untyped)
})

test('TLG5/6 modes reject before body decode including SDS, without rejecting normal direct decoding', async () => {
  const reason = 'TLG cannot be used as universal transition rule, province(_p) or mask(_m) images.'
  for (const version of [5, 6]) {
    const bytes = tlgFixture(`${version}-4-solid-1x1-auto`)
    for (const mode of ['grayscale', 'palettized'] as const)
      for (const source of [bytes.subarray(0, 11), tlgSds(bytes, []), tlgSds(bytes, []).subarray(0, 26)])
        await assert.rejects(decode(source, 'tlg', mode), native('TVPTLGLoadError', reason))
    assert.deepEqual((await decode(bytes, 'tlg')).data, finish(decodeTlg(bytes)!).data)
  }
  await assert.rejects(decode(Buffer.from('TLG9.0\x00raw\x1a'), 'tlg', 'grayscale'), native('TVPTLGLoadError', 'Invalid TLG header or unsupported TLG version.'))
})

test('TLG selected structural reasons retain native field order and literal quirks', async () => {
  const five = Buffer.from(tlgFixture('5-3-solid-1x1-auto'))
  five[11] = 2
  await assert.rejects(decode(five, 'tlg'), native('TVPTLGLoadError', 'Unsupported color type.'))
  for (const [offset, value, reason] of [
    [11, 2, 'Unsupported color count : 2'],
    [12, 1, 'Data flag must be 0 (any flags are not yet supported)'],
    [13, 7, 'Unsupported color type : 0'],
    [14, 1, 'External golomb bit length table is not yet supported.'],
  ] as const) {
    const bytes = Buffer.from(tlgFixture('6-3-solid-1x1-auto'))
    bytes[offset] = value
    await assert.rejects(decode(bytes, 'tlg'), native('TVPTLGLoadError', reason))
  }
  const six = Buffer.from(tlgFixture('6-3-solid-1x1-auto'))
  six.writeUInt32LE(0x40000001, 31 + six.readUInt32LE(27))
  await assert.rejects(decode(six, 'tlg'), native('TVPTLGLoadError', 'Unsupported entropy coding method'))
  await assert.rejects(decode(six.subarray(0, 35 + six.readUInt32LE(27)), 'tlg'), untyped)
  for (const [text, reason] of [
    ['1!a=1:b,', 'missing colon after name length'],
    ['1:a!1:b,', 'missing equals after name'],
    ['1:a=1!b,', 'missing colon after value length'],
    ['1:a=1:b!', 'missing comma after a tag'],
  ]) await assert.rejects(decode(tlgSds(tlgFixture('6-3-solid-1x1-auto'), [['tags', Buffer.from(text!)]]), 'tlg'),
    native('TVPTLGLoadError', `Malformed TLG SDS tag structure, ${reason}`))
})

test('JPEG selected mode snapshots survive await; gray is explicit Web RGB approximation and host errors remain original', async () => {
  await assert.rejects(decode(new Uint8Array(), 'jpeg', 'palettized'), native('TVPJPEGLoadError', 'JPEG does not support palettized image'))
  const selection: { format: ImageDecodeSelection['format']; mode: ImageDecodeSelection['mode'] } = { format: 'jpeg', mode: 'grayscale' },
    bytes = Uint8Array.of(255, 216, 255, 217)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const pending = decodeSelectedImage(bytes, selection, { ...dependencies, async host(actual, selected) {
    assert.equal(actual, bytes)
    await gate
    assert.deepEqual(selected, { format: 'jpeg', mode: 'grayscale' })
    return { width: 2, height: 1, data: Uint8Array.of(255, 0, 0, 0, 0, 0, 255, 1) }
  } })
  selection.format = 'png'
  selection.mode = 'normal'
  release()
  const image = await pending
  assert.deepEqual([...image.data], [76, 76, 76, 255, 29, 29, 29, 255])
  const failure = new Error('same-format browser decoding failed')
  await assert.rejects(decode(bytes, 'jpeg', 'normal', { async host() { throw failure } }), (error) => error === failure)
})

test('cancellation, inflate failure, short read and decoder budgets retain identities without host fallback', async () => {
  const cancelled = new Error('checkpoint cancelled'), budget = new Error('image allocation limit'), inflate = new Error('inflate provider rejected')
  await assert.rejects(decode(imageFixture('main.png'), 'png', 'normal', { async finish() { throw cancelled } }), (error) => error === cancelled)
  await assert.rejects(decode(imageFixture('main.png'), 'png', 'normal', { async inflate() { throw inflate } }), (error) => error === inflate)
  await assert.rejects(decode(Uint8Array.of(255, 216, 255), 'jpeg', 'normal', { async host() { throw budget } }), (error) => error === budget)
  for (const format of ['bmp', 'png', 'tlg'] as const)
    await assert.rejects(decode(new Uint8Array(1), format), untyped)
  const over = Buffer.from(tlgFixture('6-3-solid-1x1-auto'))
  over.writeUInt32LE(4097, 15)
  await assert.rejects(decode(over, 'tlg'), untyped)
  // Direct embedding codecs retain their existing sniff API, distinct from
  // native filename selection, rather than becoming mutually recursive.
  assert.equal(decodeBmp(imageFixture('main.png')), undefined)
  assert.equal(decodePng(bmp()), undefined)
  assert.equal(decodeTlg(bmp()), undefined)
})
