import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadCursorBytes } from '../../src/formats/cursor/load.ts'
import { cursorDib, cursorFile } from '../helpers/cursor-fixtures.ts'

interface Reference {
  id: string
  width: number
  height: number
  alpha: boolean
  sourceSha256: string
  rgbSha256: string
  rgbaSha256: string | null
  maskSha256: string
  hotspot: { x: number; y: number }
}
const reference = JSON.parse(readFileSync(new URL('../fixtures/cursor/native-scaling-boundary.json', import.meta.url), 'utf8')) as {
  sourceRun: string
  fixtures: Reference[]
}, hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// Author only the native probe's independent source field. Expected planes
// come from its archived GetIconInfo bytes, never from a candidate resizer.
function source(fixture: Reference): Buffer {
  const { width, height, alpha } = fixture,
    xorRows: number[][] = [], andRows: number[][] = []
  for (let row = 0; row < height; row++) {
    const y = height - 1 - row, xor: number[] = [], mask = Array<number>(Math.ceil(width / 8)).fill(0)
    for (let x = 0; x < width; x++) {
      xor.push((127 * x + 61 * y + 113) & 255, (73 * x + 11 * y + 91) & 255,
        (17 * x + 37 * y + 3) & 255, alpha ? (x + y * width) & 255 : 0)
      if (y >= Math.floor(height / 2)) mask[x >>> 3]! |= 1 << (7 - (x & 7))
    }
    xorRows.push(xor); andRows.push(mask)
  }
  const payload = cursorDib({ width, height, depth: 32, xorRows, andRows })
  // The native INFO header stores the complete XOR+AND byte count.
  payload.writeUInt32LE(payload.length - 40, 20)
  return cursorFile([{ width, height, hotspot: [Math.floor(width / 3), Math.floor(height / 4)], payload }])
}

for (const alpha of [false, true]) {
  test(`native 32px cursor scaling boundary preserves complete ${alpha ? 'RGBA' : 'RGB/AND-XOR'} planes`, { timeout: 60000 }, async () => {
    assert.equal(reference.sourceRun, '37344510171')
    assert.equal(reference.fixtures.length, 168)
    const samples = reference.fixtures.filter((fixture) => fixture.alpha === alpha)
    // The two older 80x80/127x255 alpha entries pair with independent
    // color-stage fixtures in the native inventory, not scale-policy IDs.
    assert.equal(samples.length, alpha ? 85 : 83)
    assert(samples.some((fixture) => fixture.width === 65 && fixture.height === 65))
    for (const fixture of samples) {
      const raw = source(fixture)
      assert.equal(hash(raw), fixture.sourceSha256, fixture.id + ': independent source bytes')
      const result = await loadCursorBytes(raw, { png: async () => { throw new Error('DIB fixture unexpectedly requested PNG') } }),
        loaded = result.frames[0]!.images[0]!
      assert.deepEqual([loaded.width, loaded.height], [32, 32], fixture.id)
      assert.equal(loaded.mode, alpha ? 'alpha' : 'and-xor', fixture.id)
      assert.deepEqual(loaded.hotspot, fixture.hotspot, fixture.id)
      assert.equal(hash(loaded.data.filter((_, at) => at % 4 !== 3)), fixture.rgbSha256, fixture.id + ': native RGB')
      assert.equal(hash(loaded.andMask), fixture.maskSha256, fixture.id + ': native mask')
      if (alpha) assert.equal(hash(loaded.data), fixture.rgbaSha256, fixture.id + ': native RGBA')
      else assert(loaded.data.every((value, at) => at % 4 !== 3 || value === 255), fixture.id)
    }
  })
}
