import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { normalizeSystemDataPath } from '../../src/engine/system/environment.ts'
import { projectIdentity } from '../../src/player/game-identity.ts'
import { gameSettings } from '../../src/player/library/records.ts'
import { discBootInput } from '../helpers/disc-boot.ts'

function media(name: string, bytes: Uint8Array, reads: number[] = []): Resource {
  return { name, size: bytes.length, source: { size: bytes.length, read: async (at, length) => {
    reads.push(length)
    return bytes.subarray(at, at + length)
  } }, read: async () => {
    if (/\.iso$/i.test(name)) throw new Error('A complete boot image was requested')
    return bytes
  } }
}
const step = async () => {}
const base = 'game-' + 'a'.repeat(64)

test('a single boot disc opens in collection and automatic mode without replacing an installed game', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const reads: number[] = [], { files } = discBootInput(false), image = media('Disc1.ISO', files[0]!.buffer, reads)
  const expected = { bootDisc: 'Disc1.ISO', directory: 'file://./d/discgame/data.xp3>', executableDirectory: 'file://./d/discgame/' }
  for (const mode of ['collection', 'auto'] as const) {
    const mounted = await prepareProject([image], { mode }, reader, step)
    assert.deepEqual(mounted.project, expected); assert.equal(mounted.resources[0], image)
  }
  assert(reads.length > 0 && Math.max(...reads) <= 65536)
  reads.length = 0
  const installed = media('data.xp3', Uint8Array.of(1))
  const loose = await prepareProject([installed, image], { mode: 'auto' }, reader, step)
  assert.deepEqual(loose.project, { directory: 'data.xp3>', executableDirectory: '' })
  assert.deepEqual(reads, [])
  assert.equal(normalizeSystemDataPath(undefined, expected.executableDirectory), 'savedata/')
  assert.equal(normalizeSystemDataPath('$(exepath)/slots', expected.executableDirectory), 'slots/')
  const nonGame = media('plain.iso', readFileSync(new URL('../../out/verification/disc-volumes/plain.iso', import.meta.url)))
  assert.equal((await prepareProject([nonGame], { mode: 'collection' }, reader, step)).project, undefined)
})

test('CUE plus its data file is one game; a second distinct disc requires a choice; a saved disc follows its new letter', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const original = discBootInput(true).files.map(({ name, buffer }) => media('media/' + name, buffer))
  const source = media('second.iso', discBootInput(false).files[0]!.buffer)
  const automatic = await prepareProject(original, { mode: 'auto' }, reader, step)
  assert.equal(automatic.project?.bootDisc, 'media/boot.cue')
  const both = [...original, source]
  await assert.rejects(prepareProject(both, { mode: 'auto' }, reader, step), /多张可启动/)
  const selected = await prepareProject(both, { mode: 'auto', executable: 'media/boot.cue' }, reader, step, 'startup.tjs',
    [{ drive: 'G', cue: 'media/boot.cue' }, { drive: 'H', cue: 'second.iso' }])
  assert.equal(selected.project?.directory, 'file://./g/discgame/data.xp3>')
  const replay = await prepareProject(both, { mode: 'root', ...selected.project! }, reader, step, 'startup.tjs',
    [{ drive: 'J', cue: 'media/boot.cue' }])
  assert.equal(replay.project?.directory, 'file://./j/discgame/data.xp3>')
  assert.equal(await projectIdentity(base, selected.project), await projectIdentity(base, replay.project))
  assert.equal(gameSettings({ title: 'CD', entry: 'G:/DiscGame/data.xp3>startup.tjs', backend: 'auto' },
    selected.project).entry, 'file://./g/discgame/data.xp3>startup.tjs')
  const alternate = await prepareProject(both, { mode: 'auto', executable: 'SECOND.ISO' }, reader, step)
  assert.notEqual(await projectIdentity(base, selected.project), await projectIdentity(base, alternate.project))
  await assert.rejects(prepareProject([source], { mode: 'root', ...selected.project! }, reader, step), /找不到启动光盘/)
  await assert.rejects(prepareProject(both, { mode: 'root', ...selected.project! }, reader, step, 'startup.tjs', []), /没有绑定/)
})
