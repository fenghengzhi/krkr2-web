import assert from 'node:assert/strict'
import test from 'node:test'
import { Bitmap } from '../../src/engine/graphics/bitmap.ts'
import { BitmapFontMetrics } from '../../src/engine/graphics/font-metrics.ts'

test('bitmap text metrics keep successful empty state, retry preparation errors and do not retain a retired measurement', async () => {
  const bitmap = new Bitmap(2, 2), cache = new BitmapFontMetrics(), failure = new Error('Font preparation failed')
  let loads = 0, revision = 0
  const load = async () => { loads++; return { width: 7, height: 24 } }
  await assert.rejects(cache.measure(bitmap, 'font', () => revision, '', async () => { loads++; throw failure }), (error) => error === failure)
  assert.deepEqual(await cache.measure(bitmap, 'font', () => revision, '', load), { width: 0, height: 0 })
  assert.equal(loads, 2)
  assert.deepEqual(await cache.measure(bitmap, 'font', () => revision, '', load), { width: 0, height: 0 })
  assert.equal(loads, 2)
  assert.deepEqual(await cache.measure(bitmap, 'font', () => revision, 'A', load), { width: 7, height: 24 })
  assert.deepEqual(await cache.measure(bitmap, 'font', () => revision, '', async () => ({ width: 0, height: 24 })), { width: 0, height: 24 })
  let release!: (value: { width: number; height: number }) => void
  const pending = cache.measure(bitmap, 'font', () => revision, 'B', () => new Promise((resolve) => { release = resolve }))
  cache.changed(bitmap)
  release({ width: 9, height: 24 })
  assert.deepEqual(await pending, { width: 9, height: 24 })
  assert.deepEqual(await cache.measure(bitmap, 'font', () => revision, '', load), { width: 0, height: 0 })
  await cache.measure(bitmap, 'font', () => revision, 'A', load)
  revision++
  assert.deepEqual(await cache.measure(bitmap, 'font', () => revision, '', load), { width: 0, height: 0 })
  cache.clear()
})
