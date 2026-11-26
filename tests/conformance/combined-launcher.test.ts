import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { findProjectExecutable } from '../../src/engine/storage/project.ts'
import { projectIdentity } from '../../src/player/game-identity.ts'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'
import { embedXp3, xp3Fixture } from '../helpers/xp3-fixtures.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'

const ordinaryExe = Buffer.from([77, 90, 0, 0])
const gameExe = embedXp3(xp3Fixture({ 'startup.tjs': '42' }).bytes)
const resource = (name: string, bytes: Buffer): Resource => ({
  name, size: bytes.length, source: { size: bytes.length, read: async (at, n) => bytes.subarray(at, at + n) },
  read: async () => { throw new Error('Unexpected whole-file read: ' + name) },
})
const checkpoint = async () => {}
const base = 'game-' + '1'.repeat(64)

test('an embedded game among loose tools wins over data/ and matches the manually selected save namespace', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const files = [resource('Story/SETUP.EXE', ordinaryExe), resource('Story/Novel.EXE', gameExe),
    resource('Story/data/startup.tjs', Buffer.from('fallback')), resource('Other/Other.exe', gameExe)]
  const directory = { mode: 'auto' as const, executableDirectory: 'story/' }
  const auto = (await prepareProject(files, directory, reader, checkpoint)).project!
  const manual = (await prepareProject(files, { ...directory, executable: 'novel.exe' }, reader, checkpoint)).project!
  assert.deepEqual(auto, { directory: 'Story/Novel.EXE>', executableDirectory: 'Story/' })
  assert.equal(findProjectExecutable(files, auto), 'Story/Novel.EXE')
  assert.deepEqual(manual, auto)
  assert.equal(await projectIdentity(base, manual), await projectIdentity(base, auto))
  const plain = (await prepareProject(files.filter((file) => !file.name.endsWith('Novel.EXE')), directory, reader, checkpoint)).project!
  assert.equal(plain.directory, 'Story/data/')
})

test('ZIP discovery recognizes a wrapped game before its bundled examples and probes each candidate only once', async (t) => {
  const archives = createSessionArchiveReader(); t.after(() => archives.dispose())
  const probes: string[] = [], opens: string[] = []
  const reader = { ...archives, probeXp3(file: Resource, check: () => Promise<void>) {
    probes.push(file.name); return archives.probeXp3(file, check)
  }, open(file: Resource, check: () => Promise<void>) {
    opens.push(file.name); return archives.open(file, check)
  } }
  const zip = resource('bundle.zip', distributionZip([member('Edition/Setup.exe', ordinaryExe), member('Edition/Novel.exe', gameExe),
    member('Edition/Samples/Data/startup.tjs', 'sample'), member('Edition/Tools/Preview.exe', gameExe)]))
  const selected = (await prepareProject([zip], { mode: 'auto' }, reader, checkpoint)).project!
  assert.deepEqual(selected, { directory: 'Edition/Novel.exe>', executableDirectory: 'Edition/', distribution: 'bundle.zip' })
  assert.deepEqual(probes.sort(), ['Edition/Novel.exe', 'Edition/Setup.exe'])
  assert.deepEqual(opens, ['bundle.zip'])
  const saved = (await prepareProject([zip], { mode: 'root', ...selected }, reader, checkpoint)).project
  assert.deepEqual(saved, selected); assert.equal(probes.length, 2)
})

test('multiple combined executables require a choice, while conventional data and explicit roots never probe unrelated launchers', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const editions = [resource('A.exe', gameExe), resource('B.exe', gameExe)]
  await assert.rejects(prepareProject(editions, { mode: 'auto' }, reader, checkpoint), /多个内嵌 XP3/)
  const chosen = (await prepareProject(editions, { mode: 'auto', executable: 'b.exe' }, reader, checkpoint)).project!
  assert.equal(chosen.directory, 'B.exe>')
  const noScan = { ...reader, probeXp3: async () => assert.fail('Higher-priority selection must not probe an EXE') }
  for (const path of ['content-data/startup.tjs', 'data.xp3', 'data.exe']) {
    const game = await prepareProject([...editions, resource(path, ordinaryExe)], { mode: 'auto' }, noScan, checkpoint)
    assert.equal(game.project?.directory, path.startsWith('content-data') ? 'content-data/' : path + '>')
  }
  assert.deepEqual((await prepareProject(editions, { mode: 'root', ...chosen }, noScan, checkpoint)).project, chosen)
})

test('a combined game and a separate loose game in the same release can each be launched by directory', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const zip = resource('editions.zip', distributionZip([member('First/Novel.exe', gameExe),
    member('First/Setup.exe', ordinaryExe), member('Second/data/startup.tjs', 'second')]))
  await assert.rejects(prepareProject([zip], { mode: 'auto' }, reader, checkpoint), /多个游戏/)
  for (const [dir, expected] of [['First/', 'First/Novel.exe>'], ['Second/', 'Second/data/']]) {
    const selected = (await prepareProject([zip], { mode: 'auto', executableDirectory: dir }, reader, checkpoint)).project!
    assert.equal(selected.directory, expected)
    assert.equal(selected.executableDirectory, dir)
  }
})

test('an interrupted launcher search publishes no choice and a subsequent import can select the game', async (t) => {
  const archives = createSessionArchiveReader(); t.after(() => archives.dispose())
  const zip = resource('release.zip', distributionZip([member('Setup.exe', ordinaryExe), member('Novel.exe', gameExe)]))
  let cancel = false
  const reader = { ...archives, async probeXp3(file: Resource, check: () => Promise<void>) {
    const result = await archives.probeXp3(file, check)
    cancel = true
    return result
  } }
  await assert.rejects(prepareProject([zip], { mode: 'auto' }, reader, async () => {
    if (cancel) throw new Error('launch cancelled')
  }), /launch cancelled/)
  assert.equal((await prepareProject([zip], { mode: 'auto' }, archives, checkpoint)).project?.directory, 'Novel.exe>')
})
