// Run with --expose-gc to verify eviction releases actual JS ownership before stop.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { FontService } from '../../src/engine/graphics/fonts.ts'
import type { FontSpec } from '../../src/engine/ports/graphics.ts'
if (!global.gc) throw new Error('Run this probe with --expose-gc')
const references: WeakRef<object>[] = [],
  resources = new Map(
    Array.from({ length: 64 }, (_, i) => [
      'font' + i,
      { name: 'font' + i, size: 1, read: async () => new Uint8Array([i]) },
    ]),
  )
let loaded = 0,
  released = 0
const service = new FontService(
  (name) => resources.get(name)!,
  {
    async decode() {
      throw new Error('Unexpected image decode')
    },
    text() {
      throw new Error('Unexpected raster')
    },
    measure() {
      return { width: 8, height: 8, ascent: 6 }
    },
    async loadFont() {
      const ownership = { released: false }
      references.push(new WeakRef(ownership))
      loaded++
      return {
        face: 'face' + loaded,
        dispose() {
          ownership.released = true
          released++
        },
      }
    },
  },
  async <T>(work: Generator<void, T>): Promise<T> => {
    while (true) {
      const next = work.next()
      if (next.done) return next.value
    }
  },
)
const spec: FontSpec = {
  face: 'font0',
  faceIsFileName: true,
  height: 8,
  angle: 0,
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
}
for (let i = 0; i < 64; i++) await service.measure('A', { ...spec, face: 'font' + i })
for (let i = 0; i < 4; i++) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  global.gc()
}
const evictedCollected = references.slice(0, 32).filter((ref) => ref.deref() === undefined).length,
  residentAlive = references.slice(32).filter((ref) => ref.deref() !== undefined).length
assert.equal(evictedCollected, 32)
assert.equal(residentAlive, 32)
assert.equal(released, 32)
await service.measure('A', { ...spec, face: 'font63' })
assert.equal(loaded, 64)
service.dispose()
assert.equal(released, 64)
const result = {
  date: new Date().toISOString(),
  loaded,
  evictedCollected,
  residentAlive,
  released,
  scope:
    'Explicit V8 GC of synthetic backend ownership sentinels; browser FontFace internal allocations are not measured.',
}
await writeFile('out/verification/fonts/lifetime.json', JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
