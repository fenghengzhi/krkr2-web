import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { compositeCursor } from '../../src/formats/cursor/index.ts'
import { loadCursorBytes } from '../../src/formats/cursor/load.ts'
import { decodePng } from '../../src/formats/image/png.ts'

interface NativeDraw {
  flags: number
  drawX: number
  drawY: number
  requestedWidth: number
  requestedHeight: number
  backgroundRGB: number
  canvasWidth: number
  canvasHeight: number
  stride: number
  step: number
  rgbBytes: number
  rgbSha256: string
  nativeBgraSha256: Record<string, string>
}
interface NativeFixture {
  id: string
  file: string
  sourceBytes: number
  sourceSha256: string
  source: { width: number; height: number; pngColorType: number; hotspot: { x: number; y: number } }
  native: { width: number; height: number; depth: number; hotspot: { x: number; y: number }; fIcon: boolean }
  nativeDrawCount: number
  uncomparedDrawCount: number
  draws: NativeDraw[]
}
const reference = JSON.parse(readFileSync(new URL('../fixtures/cursor/native-png-boundary.json', import.meta.url), 'utf8')) as {
  schema: number
  sourceRun: string
  sourceCommit: string
  profile: { width: number; height: number; depth: number; dpi: number }
  fixtures: NativeFixture[]
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const expectedIds = [65, 66].flatMap((size) =>
  [[size, size], [size, 48], [48, size], [size, 13], [13, size]].flatMap(([width, height]) =>
    ['rgb', 'alpha'].map((mode) => `png-scale-boundary-${width}x${height}-${mode}`)))

assert.equal(reference.schema, 1)
assert.equal(reference.sourceRun, '37352789584')
assert.equal(reference.sourceCommit, '79b7a27dd4354426bac1c17a07c31b91db513e72')
assert.deepEqual(reference.profile, { width: 32, height: 32, depth: 32, dpi: 96 })
assert.deepEqual(reference.fixtures.map((fixture) => fixture.id), expectedIds)
assert.equal(reference.fixtures.reduce((bytes, fixture) => bytes + fixture.sourceBytes, 0), 174771)

function finish<T>(work: Generator<void, T>): T {
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}

// The CUR files are unchanged native-probe inputs. Expected hashes come only
// from both Windows runners' complete, top-down DrawIconEx BGRA recordings,
// reordered to RGB. Destination alpha and GetIconInfo source-plane alpha are
// deliberately not inferred. Extra flags/scaling and other DPI remain outside
// these 60 natural-size DI_NORMAL observations.
for (const fixture of reference.fixtures) {
  test(`native PNG cursor boundary ${fixture.id} preserves three complete RGB draws`, { timeout: 60000 }, async () => {
    assert.equal(fixture.file, fixture.id + '.cur')
    const raw = readFileSync(new URL('../fixtures/cursor/native-png-boundary/' + fixture.file, import.meta.url))
    assert.equal(raw.length, fixture.sourceBytes)
    assert.equal(hash(raw), fixture.sourceSha256, 'Unchanged original CUR input')
    assert.deepEqual([raw.readUInt16LE(0), raw.readUInt16LE(2), raw.readUInt16LE(4)], [0, 2, 1])
    assert.deepEqual([raw[6], raw[7]], [fixture.source.width, fixture.source.height])
    assert.deepEqual({ x: raw.readUInt16LE(10), y: raw.readUInt16LE(12) }, fixture.source.hotspot)
    const pngOffset = raw.readUInt32LE(18)
    assert.equal(pngOffset, 22)
    assert.equal(raw.readUInt32LE(14), raw.length - pngOffset)
    assert.deepEqual([...raw.subarray(pngOffset, pngOffset + 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(raw.toString('ascii', pngOffset + 12, pngOffset + 16), 'IHDR')
    assert.deepEqual([raw.readUInt32BE(pngOffset + 16), raw.readUInt32BE(pngOffset + 20)],
      [fixture.source.width, fixture.source.height])
    assert.equal(raw[pngOffset + 25], fixture.source.pngColorType)
    assert.equal(fixture.source.pngColorType, fixture.id.endsWith('-alpha') ? 6 : 2)

    let pngCalls = 0
    const loaded = await loadCursorBytes(raw, { png: async (payload) => {
      pngCalls++
      const parser = decodePng(payload)
      assert(parser, 'CUR payload must use the production PNG decoder')
      const plan = finish(parser)
      const expanded = inflateSync(plan.compressed, { maxOutputLength: plan.expandedLength })
      assert.equal(expanded.length, plan.expandedLength)
      return finish(plan.decode(expanded))
    } })
    assert.equal(pngCalls, 1)
    assert.equal(loaded.kind, 'cur')
    assert.equal(loaded.sourceBytes, fixture.sourceBytes)
    assert.equal(loaded.imageCount, 1)
    assert.equal(loaded.frames.length, 1)
    assert.equal(loaded.frames[0]!.images.length, 1)
    assert.deepEqual(loaded.sequence, [0])
    const image = loaded.frames[0]!.images[0]!
    assert.deepEqual([image.width, image.height, image.depth],
      [fixture.native.width, fixture.native.height, fixture.native.depth])
    assert.deepEqual([fixture.native.width, fixture.native.height, fixture.native.depth], [32, 32, 32])
    assert.equal(fixture.native.fIcon, false)
    assert.deepEqual(image.hotspot, fixture.native.hotspot)
    assert.equal(image.data.length, 32 * 32 * 4)
    assert.equal(fixture.nativeDrawCount, 18)
    assert.equal(fixture.uncomparedDrawCount, 15)
    assert.deepEqual(fixture.draws.map((draw) => draw.backgroundRGB), [0, 0xffffff, 0x123456])

    for (const draw of fixture.draws) {
      assert.deepEqual([draw.flags, draw.step, draw.requestedWidth, draw.requestedHeight], [19, 0, 0, 0])
      assert.deepEqual([draw.drawX, draw.drawY, draw.canvasWidth, draw.canvasHeight, draw.stride], [16, 16, 80, 80, 320])
      assert.equal(draw.rgbBytes, 80 * 80 * 3)
      assert.equal(draw.nativeBgraSha256['native-cursor-windows-2022-1'],
        draw.nativeBgraSha256['native-cursor-windows-2025-1'], 'Both complete native draw recordings agree')
      const destination = new Uint8Array(draw.canvasWidth * draw.canvasHeight * 4)
      for (let offset = 0; offset < destination.length; offset += 4) {
        destination[offset] = draw.backgroundRGB >>> 16 & 255
        destination[offset + 1] = draw.backgroundRGB >>> 8 & 255
        destination[offset + 2] = draw.backgroundRGB & 255
        destination[offset + 3] = 255
      }
      // DrawIconEx receives the image origin, not a pointer location: hotspot
      // is compared above and must not be subtracted from this draw position.
      compositeCursor(image, { width: draw.canvasWidth, height: draw.canvasHeight, data: destination }, draw.drawX, draw.drawY)
      const rgb = destination.filter((_, offset) => offset % 4 !== 3)
      assert.equal(rgb.length, draw.rgbBytes)
      assert.equal(hash(rgb), draw.rgbSha256,
        `${fixture.id}: complete 80x80 native RGB on background 0x${draw.backgroundRGB.toString(16)}`)
    }
  })
}
