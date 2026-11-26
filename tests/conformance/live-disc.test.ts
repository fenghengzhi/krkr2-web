import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { decodePlainText } from '../../src/backends/files/blob-source.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { CddaDiscs } from '../../src/engine/storage/cdda.ts'
import { StorageArchives } from '../../src/engine/storage/archives.ts'

const checkpoint = async () => {}
function input(name: string, bytes: Uint8Array): Resource {
  return { name, size: bytes.length, read: async () => bytes, source: { size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length) } }
}
function media() {
  const get = (edition: string) => readFileSync(new URL('../../out/verification/disc-volumes/swap-' + edition + '.iso', import.meta.url))
  const a = input('D1.iso', get('A')), b = input('D2.iso', get('B'))
  const discs = new CddaDiscs({ exists: async () => false, cues: async () => [a.name], currentDirectory: '',
    exact: async (name) => [a, b].find((file) => file.name === name), decodeText: decodePlainText, read: (file) => file.read(), checkpoint })
  return { discs, b }
}

test('a drive keeps its original media until a replacement is readable, and reset restores its auto-discovered disc', async () => {
  const { discs, b } = media(), committed: string[] = []
  const changed = (drive: string) => { committed.push(drive) }
  try {
    const first = await discs.prepare('D:1')
    assert(first && discs.current(first))
    assert.equal(await discs.searchVolume('KRKR_SWAP_A'), 'D')
    const sheet = (name: string) => input('pressing.cue', new TextEncoder().encode('FILE "' + name + '" BINARY\nTRACK 01 MODE1/2048\nINDEX 01 00:00:00\n'))
    await assert.rejects(discs.change({ kind: 'insert', drive: 'D', cue: 'pressing.cue' }, async () => [sheet('absent.bin')], changed))
    // The mounted game contains D1.iso, but a picked CUE must have its own tracks.
    await assert.rejects(discs.change({ kind: 'insert', drive: 'D', cue: 'pressing.cue' }, async () => [sheet('D1.iso')], changed))
    await assert.rejects(discs.change({ kind: 'insert', drive: 'D', cue: 'unknown.iso' }, undefined, changed))
    assert.equal(committed.length, 0); assert(discs.current(first))
    await discs.change({ kind: 'insert', drive: 'd', cue: 'pressing.cue' }, async () => [sheet(b.name), b], changed)
    assert(!discs.current(first)); assert.equal(await discs.searchVolume('KRKR_SWAP_B'), 'D')
    await discs.change({ kind: 'eject', drive: 'D' }, undefined, changed)
    assert.deepEqual(await discs.drives(), ['D']); assert.equal(await discs.filesystem('D'), undefined)
    assert.equal(await discs.searchVolume('KRKR_SWAP_A'), ''); assert.equal(await discs.searchVolume('KRKR_SWAP_B'), '')
    await discs.change({ kind: 'reset', drive: 'D' }, undefined, changed)
    assert.equal(await discs.searchVolume('KRKR_SWAP_A'), 'D'); assert(!discs.current(first))
    assert.deepEqual(committed, ['D', 'D', 'D'])
  } finally { discs.dispose() }
})

test('a slow picker cannot overwrite a newer choice on the same drive', async () => {
  const { discs, b } = media(), committed: string[] = []
  const changed = (drive: string) => { committed.push(drive) }
  let finish!: (files: Resource[]) => void
  const files = new Promise<Resource[]>((resolve) => { finish = resolve })
  try {
    const slow = discs.change({ kind: 'insert', drive: 'D', cue: b.name }, () => files, changed)
    await discs.change({ kind: 'insert', drive: 'E', cue: b.name }, undefined, changed)
    await discs.change({ kind: 'eject', drive: 'D' }, undefined, changed)
    finish([b])
    await assert.rejects(slow, /取代/)
    assert.equal(await discs.searchVolume('KRKR_SWAP_B'), 'E')
    assert.equal(await discs.filesystem('D'), undefined); assert.deepEqual(committed, ['E', 'D'])
  } finally { finish([]); discs.dispose() }
})

test('a retiring optical index may finish its own read without replacing the next disc or another drive', async () => {
  const path = 'file://./d/chapters.zip', old = input(path, Uint8Array.of(1)), next = input(path, Uint8Array.of(2)),
    other = input('file://./e/music.zip', Uint8Array.of(3))
  let start!: () => void, finish!: () => void
  const entered = new Promise<void>((resolve) => { start = resolve }), gate = new Promise<void>((resolve) => { finish = resolve })
  const cache = new StorageArchives({ probeXp3: async () => false,
    async open(file) {
      if (file === old) { start(); await gate }
      return { kind: 'zip', entries: [input('track.dat', await file.read())] }
    },
  }, checkpoint, () => ({ units: 10000, entries: 100 }))
  try {
    const first = cache.open(old)
    await entered
    const unaffected = cache.open(other)
    cache.forgetDrive('D')
    const replaced = cache.open(next)
    finish()
    const [a, b, c] = await Promise.all([first, unaffected, replaced])
    assert.deepEqual(await a!.entries.get('track.dat')!.read(), Uint8Array.of(1))
    assert.deepEqual(await b!.entries.get('track.dat')!.read(), Uint8Array.of(3))
    assert.deepEqual(await c!.entries.get('track.dat')!.read(), Uint8Array.of(2))
    assert.equal(await cache.open(other), b); assert.equal(await cache.open(next), c)
    assert(!cache.known().includes(a!))
  } finally { finish(); cache.dispose() }
})
