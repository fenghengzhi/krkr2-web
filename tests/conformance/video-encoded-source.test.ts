import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { VideoEncodedResources, videoEncodedLimits } from '../../src/backends/video/browser/encoded-source.ts'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'

const fixture = () => new Uint8Array(readFileSync(new URL('../fixtures/video/colors-sound.mp4', import.meta.url)))

test('video sources count shared references once and retain independent Blob ownership until its URL is released', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]), resources = new VideoEncodedResources({ sourceBytes: 4, ownedBytes: 8 }),
    first = resources.source(bytes), retained = first.retain(), variant = resources.original(first, 'video/mp4')
  try {
    assert.deepEqual(resources.inspect(), { sources: 1, sourceBytes: 4, ownedBytes: 8 })
    first.release(); first.release()
    assert.throws(() => first.bytes, /closed/)
    assert.equal(retained.bytes, bytes)
    retained.release()
    assert.deepEqual(resources.inspect(), { sources: 0, sourceBytes: 0, ownedBytes: 4 })
    assert.deepEqual(new Uint8Array(await (await fetch(variant.url)).arrayBuffer()), bytes)
  } finally { first.release(); retained.release(); variant.release() }
  assert.deepEqual(resources.inspect(), { sources: 0, sourceBytes: 0, ownedBytes: 0 })
})

test('an actual MP4 selector candidate reserves all four encoded copies before creating a replacement Blob', { timeout: 30000 }, async () => {
  const bytes = fixture(), timeline = await readVideoTimeline(bytes)
  assert.ok(timeline)
  const resources = new VideoEncodedResources({ sourceBytes: bytes.length, ownedBytes: bytes.length * 3 }),
    source = resources.source(bytes), active = resources.original(source, 'video/mp4')
  try {
    await assert.rejects(resources.select(source, 0, timeline, 'video/mp4', () => {}), /owned encoded resource budget/)
    assert.deepEqual(resources.inspect(), { sources: 1, sourceBytes: bytes.length, ownedBytes: bytes.length * 2 })
    assert.deepEqual(new Uint8Array(await (await fetch(active.url)).arrayBuffer()), bytes,
      'a failed selection must preserve the still-active original Blob')
  } finally { active.release(); source.release() }
  assert.equal(resources.inspect().ownedBytes, 0)
})

test('selector cancellation and invalid indexes refund temporary bytes without evicting the source or active URL', { timeout: 30000 }, async () => {
  const bytes = fixture(), timeline = await readVideoTimeline(bytes)
  assert.ok(timeline)
  const resources = new VideoEncodedResources({ sourceBytes: bytes.length, ownedBytes: bytes.length * 4 }),
    source = resources.source(bytes), active = resources.original(source, 'video/mp4')
  let checks = 0
  try {
    await assert.rejects(resources.select(source, 0, timeline, 'video/mp4', () => {
      if (++checks > 1) throw new Error('selection owner expired')
    }), /selection owner expired/)
    await assert.rejects(resources.select(source, 999, timeline, 'video/mp4', () => {}))
    assert.deepEqual(resources.inspect(), { sources: 1, sourceBytes: bytes.length, ownedBytes: bytes.length * 2 })
    const selected = await resources.select(source, 0, timeline, 'video/mp4', () => {})
    assert.equal(resources.inspect().ownedBytes, bytes.length * 3,
      'the selector copy is no longer retained after the new Blob has been returned')
    selected.release()
    assert.equal(resources.inspect().ownedBytes, bytes.length * 2)
  } finally { active.release(); source.release() }
  assert.equal(resources.inspect().ownedBytes, 0)
})

test('video encoded budgets reject before allocation and recover after URL construction throws', () => {
  assert.throws(() => new VideoEncodedResources({ ownedBytes: videoEncodedLimits.ownedBytes + 1 }), /limit/)
  const resources = new VideoEncodedResources({ sourceBytes: 4, ownedBytes: 8 }), source = resources.source(new Uint8Array(4)),
    create = URL.createObjectURL
  try {
    assert.throws(() => resources.source(new Uint8Array(1)), /source resource budget/)
    URL.createObjectURL = () => { throw new Error('URL allocation failed') }
    assert.throws(() => resources.original(source, 'video/mp4'), /URL allocation failed/)
    assert.deepEqual(resources.inspect(), { sources: 1, sourceBytes: 4, ownedBytes: 4 })
  } finally { URL.createObjectURL = create; source.release() }
  assert.equal(resources.inspect().ownedBytes, 0)
})
