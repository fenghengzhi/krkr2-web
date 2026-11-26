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

test('a loose release discovers the wrapped game, keeps its patch and retains the manually selected save namespace', async (t) => {
  const archives = createSessionArchiveReader(); t.after(() => archives.dispose())
  const probed: string[] = []
  const reader = { ...archives, probeXp3(file: Resource, check: () => Promise<void>) {
    probed.push(file.name); return archives.probeXp3(file, check)
  } }
  const files = [resource('Setup.exe', ordinaryExe), resource('Edition/Novel.exe', gameExe),
    resource('Edition/patch.xp3', xp3Fixture({ 'route.tjs': '"patch"' }).bytes),
    resource('Edition/Demo/startup.tjs', Buffer.from('demo'))]
  const auto = await prepareProject(files, { mode: 'auto' }, reader, checkpoint)
  assert.equal(auto.resources, files)
  assert.deepEqual(auto.project, { directory: 'Edition/Novel.exe>', executableDirectory: 'Edition/' })
  assert.deepEqual(probed, ['Setup.exe', 'Edition/Novel.exe'])
  const manual = await prepareProject(files, { mode: 'auto', executableDirectory: 'edition/' }, reader, checkpoint)
  assert.equal(await projectIdentity(base, auto.project), await projectIdentity(base, manual.project))
  const saved = await prepareProject(files, { mode: 'root', ...auto.project! }, reader, checkpoint)
  assert.deepEqual(saved.project, manual.project)
})

test('sibling loose editions require a choice and a bare launcher name resolves under its owning directory', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const files = [resource('包/A/Story.exe', ordinaryExe), resource('包/A/data.xp3', xp3Fixture({ 'startup.tjs': '42' }).bytes),
    resource('包/B/Novel.exe', gameExe), resource('包/B/Tools/Setup.exe', ordinaryExe)]
  await assert.rejects(prepareProject(files, { mode: 'auto' }, reader, checkpoint), /多个游戏/)
  for (const name of ['novel.exe', '包/B/Novel.exe']) {
    const choice = await prepareProject(files, { mode: 'auto', executable: name }, reader, checkpoint)
    assert.deepEqual(choice.project, { directory: '包/B/Novel.exe>', executableDirectory: '包/B/' })
  }
  const duplicate = [...files, resource('包/A/Novel.exe', ordinaryExe)]
  await assert.rejects(prepareProject(duplicate, { mode: 'auto', executable: 'Novel.exe' }, reader, checkpoint), /同名程序/)
  const selectedA = await prepareProject(duplicate, { mode: 'auto', executable: 'Novel.exe', executableDirectory: '包/A/' }, reader, checkpoint)
  assert.deepEqual(selectedA.project, { directory: '包/A/data.xp3>', executableDirectory: '包/A/', executable: 'game://./包/A/Novel.exe' })
  await assert.rejects(prepareProject(duplicate, { mode: 'auto', executableDirectory: '包/A/', executable: 'absent.exe' }, reader, checkpoint),
    /未找到指定的游戏程序/)
})

test('existing loose custom-entry roots, non-game collections, and an explicitly selected root retain their layout', async (t) => {
  const archives = createSessionArchiveReader(); t.after(() => archives.dispose())
  const noProbe = { ...archives, async probeXp3() { return assert.fail('A frozen or conventional root must not inspect the bundled tool') } }
  const nested = [resource('Bonus/Novel.exe', gameExe), resource('Bonus/data.xp3', xp3Fixture({ 'startup.tjs': '42' }).bytes)]
  for (const [path, directory] of [['content-data/start-here.tjs', 'content-data/'], ['data/alternate.tjs', 'data/'], ['startup.tjs', '']] as const) {
    const auto = await prepareProject([resource(path, Buffer.from('42')), ...nested], { mode: 'auto' }, noProbe, checkpoint)
    assert.deepEqual(auto.project, { directory, executableDirectory: '' })
  }
  const flat = { directory: '', executableDirectory: '' }
  assert.deepEqual((await prepareProject(nested, { mode: 'root', ...flat }, noProbe, checkpoint)).project, flat)
  assert.deepEqual((await prepareProject([resource('Extras/tool.exe', ordinaryExe)], { mode: 'auto' }, archives, checkpoint)).project, flat)
  assert.equal((await prepareProject(nested, { mode: 'collection' }, noProbe, checkpoint)).project, undefined)
})

test('the chosen startup filename participates in loose directory discovery without displacing an existing entry', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const boot = resource('Edition/Story/Begin.TJS', Buffer.from('42')), selection = { mode: 'auto' as const }
  assert.deepEqual((await prepareProject([boot], selection, reader, checkpoint, 'begin.tjs')).project,
    { directory: 'Edition/Story/', executableDirectory: 'Edition/Story/' })
  const example = resource('Samples/Demo/startup.tjs', Buffer.from('0'))
  for (const entry of ['Begin.tjs', 'scripts/begin.tjs', 'other.xp3>begin.tjs']) {
    const original = resource(entry.split('>')[0]!, Buffer.from('original entry'))
    const result = await prepareProject([example, original], selection, reader, checkpoint, entry)
    assert.deepEqual(result.project, { directory: '', executableDirectory: '' }, entry)
  }
})
