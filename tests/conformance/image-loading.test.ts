import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { decodePng } from '../../src/formats/image/png.ts'
import { decodeGif } from '../../src/formats/image/gif.ts'
import { decodeBmp } from '../../src/formats/image/bmp.ts'
import { inflateImage } from '../../src/backends/files/blob-source.ts'
import { imageBytes, imageManifest, imageFixture } from '../helpers/image-fixtures.ts'
import {
  applyImageKey,
  applyImageMask,
  matteImage,
  provincePixels,
} from '../../src/engine/graphics/loading.ts'

function finish<T>(work: Generator<void, T>): T {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
async function decode(bytes: Uint8Array) {
  const png = decodePng(bytes)
  if (png) {
    const plan = finish(png)
    return finish(plan.decode(await inflateImage(plan.compressed, plan.expandedLength)))
  }
  const gif = decodeGif(bytes)
  if (gif) return finish(gif)
  const bmp = decodeBmp(bytes)
  assert.ok(bmp)
  return bmp
}

test('PNG, GIF and indexed BMP match independent encoders, including Adam7, 16-bit and all PNG filters', async () => {
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  assert.equal(hash(imageBytes), imageManifest.sha256)
  for (const entry of imageManifest.entries) {
    const bytes = imageFixture(entry.name),
      image = await decode(bytes),
      count = entry.width * entry.height
    assert.equal(hash(bytes), entry.sha256, entry.name)
    assert.equal(image.width, entry.width, entry.name)
    assert.equal(image.height, entry.height, entry.name)
    assert.deepEqual(
      Buffer.from(image.data),
      imageBytes.subarray(entry.rgbaOffset, entry.rgbaOffset + count * 4),
      entry.name,
    )
    if (entry.indicesOffset !== undefined)
      assert.deepEqual(
        Buffer.from(image.indices!),
        imageBytes.subarray(entry.indicesOffset, entry.indicesOffset + count),
        entry.name,
      )
    else assert.equal(image.indices, undefined, entry.name)
    assert.equal(!!image.grayscale, entry.grayscale, entry.name)
    assert.deepEqual(
      image.metadata ? Object.fromEntries(image.metadata) : undefined,
      entry.metadata,
      entry.name,
    )
  }
})

test('key, mask and matting order preserves RGB and distinguishes duplicate palette colors', async () => {
  const indexed = await decode(imageFixture('palette-2x1.png'))
  assert.deepEqual([...indexed.data], [255, 0, 0, 0, 255, 0, 0, 255])
  finish(applyImageKey(indexed, 0x03000001))
  assert.deepEqual([...indexed.data], [255, 0, 0, 255, 255, 0, 0, 0])
  finish(applyImageKey(indexed, 0xff0000))
  assert.deepEqual([...indexed.data], [255, 0, 0, 0, 255, 0, 0, 0])
  const main = await decode(imageFixture('main.png'))
  finish(applyImageKey(main, 0xc86432))
  assert.deepEqual([...main.data], [200, 100, 50, 0, 201, 101, 51, 255])
  finish(applyImageMask(main, await decode(imageFixture('mask.png'))))
  assert.deepEqual([...main.data], [200, 100, 50, 0, 201, 101, 51, 128])
  finish(matteImage(main, 0x04ffffff))
  assert.deepEqual([...main.data], [255, 255, 255, 255, 228, 178, 153, 255])
  assert.equal(main.metadata!.get('offs_y'), '-7')
})

test('adaptive key counts the first row, has deterministic ties and replaces old alpha', () => {
  const image = {
    width: 4,
    height: 2,
    data: new Uint8Array([
      9, 8, 7, 1, 1, 2, 3, 2, 9, 8, 7, 3, 1, 2, 3, 4, 9, 8, 7, 5, 9, 8, 7, 6, 9, 8, 7, 7, 1, 2, 3,
      8,
    ]),
  }
  finish(applyImageKey(image, 0x01ffffff))
  assert.deepEqual(
    [...image.data.filter((_, i) => i % 4 === 3)],
    [255, 0, 255, 0, 255, 255, 255, 0],
  )
})

test('color key, companion mask and matte arithmetic match independent TVP scalar pixels', () => {
  const bytes = readFileSync(new URL('../fixtures/loading-reference.bin', import.meta.url)),
    metadata = JSON.parse(
      readFileSync(new URL('../fixtures/loading-reference.json', import.meta.url), 'utf8'),
    )
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256)
  assert.equal(bytes.length, metadata.cases * 16)
  for (let at = 0; at < bytes.length; at += 16) {
    const operation = bytes.readUInt32LE(at),
      key = bytes.readUInt32LE(at + 8),
      image = { width: 1, height: 1, data: new Uint8Array(bytes.subarray(at + 4, at + 8)) }
    if (operation === 0) finish(matteImage(image, 0x04000000 + key))
    else if (operation === 1) finish(applyImageKey(image, key))
    else {
      const mask = image.data[3]!
      finish(
        applyImageMask(image, {
          width: 1,
          height: 1,
          data: new Uint8Array([mask, mask, mask, 255]),
        }),
      )
    }
    assert.deepEqual(
      Buffer.from(image.data),
      bytes.subarray(at + 12, at + 16),
      `reference ${at / 16}`,
    )
  }
})

test('province maps preserve palette indices, tile smaller sources and reject oversized or truecolor maps', async () => {
  const image = await decode(imageFixture('palette-2x1.gif'))
  assert.deepEqual([...finish(provincePixels(image, 3, 2))], [0, 1, 0, 0, 1, 0])
  const gray = await decode(imageFixture('mask.png'))
  assert.deepEqual([...finish(provincePixels(gray, 3, 2))], [0, 128, 0, 0, 128, 0])
  assert.throws(() => finish(provincePixels(image, 1, 1)), /size mismatch/)
  const color = await decode(imageFixture('main.png'))
  assert.throws(() => finish(provincePixels(color, 2, 1)), /palette or grayscale/)
})

test('PNG and GIF reject truncation, corrupt lengths, CRCs and invalid code streams', async () => {
  for (const name of ['main.png', 'palette-2x1.gif']) {
    const bytes = imageFixture(name)
    for (let length = 6; length < bytes.length; length++)
      await assert.rejects(() => decode(bytes.subarray(0, length)), name + ': ' + length)
  }
  const png = Buffer.from(imageFixture('main.png'))
  png[29] ^= 1
  await assert.rejects(() => decode(png), /CRC/)
  png.writeUInt32BE(0xffffffff, 8)
  await assert.rejects(() => decode(png), /Truncated/)
  const gif = Buffer.from(imageFixture('palette-2x1.gif'))
  gif[6] = 0
  gif[7] = 0
  await assert.rejects(() => decode(gif), /dimensions/)
})

test('GIF repeated clear codes yield before a malformed stream reaches its end', () => {
  const codes = [...Array.from({ length: 4096 }, () => 4), 5],
    packed = Buffer.alloc(Math.ceil((codes.length * 3) / 8))
  let bit = 0
  for (const code of codes)
    for (let i = 0; i < 3; i++, bit++) packed[bit >>> 3]! |= ((code >>> i) & 1) << (bit & 7)
  const blocks = []
  for (let at = 0; at < packed.length; at += 255) {
    const part = packed.subarray(at, at + 255)
    blocks.push(Buffer.from([part.length]), part)
  }
  const file = Buffer.concat([
      Buffer.from('GIF87a'),
      Buffer.from([
        2, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 44, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2,
      ]),
      ...blocks,
      Buffer.from([0, 59]),
    ]),
    work = decodeGif(file)!
  assert.equal(work.next().done, false)
  assert.throws(() => finish(work), /output size mismatch/)
})

test('PNG reassembles consecutive one-byte and empty IDAT chunks', async () => {
  const original = imageFixture('main.png'),
    parts = [original.subarray(0, 8)]
  function chunk(data: Buffer) {
    const body = Buffer.concat([Buffer.from('IDAT'), data]),
      result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    body.copy(result, 4)
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let n = 0; n < 8; n++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  for (let at = 8; at < original.length;) {
    const length = original.readUInt32BE(at)
    if (original.toString('ascii', at + 4, at + 8) === 'IDAT') {
      parts.push(chunk(Buffer.alloc(0)))
      for (let i = 0; i < length; i++) parts.push(chunk(original.subarray(at + 8 + i, at + 9 + i)))
    } else parts.push(original.subarray(at, at + length + 12))
    at += length + 12
  }
  assert.deepEqual(await decode(Buffer.concat(parts)), await decode(original))
})
