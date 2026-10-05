import test from 'node:test'
import assert from 'node:assert/strict'
import { selectProject, copyGameProject, copyProjectSelection } from '../../src/engine/storage/project.ts'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { parseStoragePath, storageWritePath, normalizeResourcePath } from '../../src/engine/storage/public-path.ts'
import { importResources } from '../../src/backends/files/import-resources.ts'
import { resolveFiles } from '../../src/backends/files/source-files.ts'
import { gameIdentity, projectIdentity } from '../../src/player/game-identity.ts'
import { gameSettings, validateRecord, validateSummary, summary, type LibraryRecord } from '../../src/player/library/records.ts'
import { normalizeSystemDataPath, SystemEnvironment } from '../../src/engine/system/environment.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'

const file = (name: string, archiveKind?: Resource['archiveKind']): Resource => ({
  name, archiveKind, size: 1, read: async () => new Uint8Array([1]),
})
const project = (directory: string, executableDirectory = 'bin/') => ({ directory, executableDirectory })

test('project auto selection follows native priority and never searches an arbitrary descendant startup', () => {
  const candidates = [file('bin/content-data/startup.tjs'), file('bin/data.xp3', 'xp3'),
    file('bin/data.exe', 'xp3'), file('bin/game.exe', 'xp3'), file('bin/data/startup.tjs'),
    file('bin/other/startup.tjs')]
  const expected = ['bin/content-data/', 'bin/data.xp3>', 'bin/data.exe>', 'bin/game.exe>', 'bin/data/', 'bin/']
  for (let index = 0; index < expected.length; index++)
    assert.deepEqual(selectProject(candidates.slice(index), { mode: 'auto', executableDirectory: 'bin/',
      ...(index <= 3 ? { executable: 'game.exe' } : {}) }), project(expected[index]!))
  assert.equal(selectProject(candidates), undefined, 'Existing collection startup remains opt-in compatible')
})

test('explicit project roots are canonical, frozen and validated independently of the script entry', () => {
  const files = [file('bundle/data.xp3', 'xp3'), file('bundle/other/startup.tjs')]
  assert.deepEqual(selectProject(files, { mode: 'root', directory: 'game:///bundle/data.xp3>', executableDirectory: 'bundle/' }),
    project('bundle/data.xp3>', 'bundle/'))
  assert.throws(() => selectProject(files, { mode: 'root', directory: 'absent/' }), /not found/)
  assert.throws(() => copyGameProject(project('bundle/', 'data.xp3>')), /Executable/)
  assert.throws(() => copyProjectSelection({ mode: 'root', directory: '../other/' }), /escapes/)
  const copied = copyGameProject(project('bundle/'))!
  assert(Object.isFrozen(copied))
  const selection = copyProjectSelection({ mode: 'auto', executableDirectory: 'bundle/', executable: 'game.exe' })
  assert.deepEqual(copyProjectSelection(selection), selection, 'Repeated wire validation cannot prepend exeDirectory again')
})

test('a selected invalid archive or ambiguous path is an error, never a fallback to another game', () => {
  assert.throws(() => selectProject([file('data.xp3'), file('data/startup.tjs')], { mode: 'auto' }), /not a supported archive/)
  assert.throws(() => selectProject([file('DATA/startup.tjs'), file('Data/startup.tjs')], { mode: 'auto' }), /Ambiguous/)
  assert.deepEqual(selectProject([file('content-data/startup.tjs'), file('data.xp3')], { mode: 'auto' }),
    project('content-data/', ''), 'Selection itself does not test a lower-priority project')
})

test('real imported empty XP3 indices remain selectable without an invented startup member', { timeout: 30000 }, async () => {
  const bytes = xp3Fixture({}).bytes,
    files = await importResources([{ path: 'bin/data.xp3', blob: new Blob([Uint8Array.from(bytes).buffer]) }], async () => {})
  assert.equal(files.find((entry) => entry.name === 'bin/data.xp3')?.archiveKind, 'xp3')
  assert.deepEqual(selectProject(files, { mode: 'auto', executableDirectory: 'bin/' }), project('bin/data.xp3>'))
  const resolver = new StorageResolver('bin/data.xp3>', false)
  resolver.mount(files)
  assert.throws(() => resolver.resolve('startup.tjs'), /not found/)
})

test('relative current directories, media roots and archive roots retain distinct bounds', () => {
  for (const directory of ['bundle/data/', 'bundle/data.xp3>']) {
    assert.equal(parseStoragePath('scene.tjs', directory), directory + 'scene.tjs')
    for (const root of ['/scene.tjs', '\\scene.tjs', '///scene.tjs', '//./scene.tjs', 'game:///scene.tjs', 'game://./scene.tjs'])
      assert.equal(parseStoragePath(root, directory), 'scene.tjs', root)
    assert.throws(() => parseStoragePath('//other/scene.tjs', directory), /domain/)
    assert.throws(() => parseStoragePath('C:\\scene.tjs', directory), /media/)
  }
  assert.equal(parseStoragePath('pack.xp3>scene.tjs', 'bundle/'), 'bundle/pack.xp3>scene.tjs')
  assert.throws(() => parseStoragePath('data.xp3>scene.tjs', 'bundle/data.xp3>'), /Nested/)
  assert.throws(() => parseStoragePath('../escape', 'bundle/data.xp3>'), /escapes/)
  assert.throws(() => storageWritePath('save.txt', 'bundle/data.xp3>'), /read.only/)
  assert.equal(storageWritePath('/savedata/slot.txt', 'bundle/data.xp3>'), 'savedata/slot.txt')
  for (const name of ['/scene.tjs', 'game:///scene.tjs']) assert.throws(() => normalizeResourcePath(name), /Invalid/)
})

test('project lookup disables collection aliases and freezes registered auto paths as canonical identities', () => {
  const resolver = new StorageResolver('bundle/data.xp3>', false)
  resolver.mount([file('bundle/data.xp3>system/base.tjs'), file('bundle/patch.xp3>base.tjs'),
    { ...file('flat.tjs'), aliasOf: 'unrelated.xp3>flat.tjs' }, file('unrelated.xp3>flat.tjs')])
  assert.equal(resolver.exists('flat.tjs'), false)
  resolver.addAutoPath('system/')
  assert.equal(resolver.resolve('base.tjs').name, 'bundle/data.xp3>system/base.tjs')
  resolver.addAutoPath('/bundle/patch.xp3>')
  assert.equal(resolver.resolve('base.tjs').name, 'bundle/patch.xp3>base.tjs')
  resolver.removeAutoPath('game:///bundle/patch.xp3>')
  assert.equal(resolver.resolve('base.tjs').name, 'bundle/data.xp3>system/base.tjs')
  assert.equal(resolver.resolve('game:///bundle/data.xp3>system/base.tjs').name, 'bundle/data.xp3>system/base.tjs')
})

test('project identity separates two roots while preserving collection save identities', { timeout: 30000 }, async () => {
  const input = [{ path: 'a/startup.tjs', blob: new Blob(['same']) }, { path: 'b/startup.tjs', blob: new Blob(['same']) }],
    base = await gameIdentity(await resolveFiles(input, async () => {})),
    a = await projectIdentity(base, project('a/', '')), b = await projectIdentity(base, project('b/', ''))
  assert.equal(await projectIdentity(base), base)
  assert.notEqual(a, b); assert.notEqual(a, base); assert.notEqual(b, base)
  assert.equal(await projectIdentity(base, project('./a/', '')), a)
  assert.notEqual(await projectIdentity(base, project('a/', 'a/')), a)
})

test('library manifests preserve frozen project identity and accept unchanged legacy records', async () => {
  const base = 'game-' + 'a'.repeat(64), selected = project('bin/data.xp3>'),
    old: LibraryRecord = { version: 1, id: 'entry-00000000-0000-4000-8000-000000000000', gameId: base,
      title: 'Game', entry: 'startup.tjs', backend: 'auto', createdAt: 1, size: 0, fileCount: 1,
      files: [{ path: 'empty', size: 0, hashes: [] }] },
    next = { ...old, gameId: await projectIdentity(base, selected), sourceGameId: base, project: selected }
  assert.equal(validateRecord(old), old)
  assert.equal(Object.hasOwn(summary(old), 'project'), false)
  assert.deepEqual(validateSummary(summary(validateRecord(next))).project, selected)
  assert.throws(() => validateRecord({ ...next, sourceGameId: undefined }), /project metadata/)
  assert.throws(() => validateRecord({ ...next, project: project('bin/./data.xp3>') }), /project metadata/)
  assert.throws(() => validateRecord({ ...old, sourceGameId: base }), /Unexpected/)
  assert.equal(gameSettings({ title: 'Game', entry: '../bootstrap.tjs', backend: 'auto' }, project('bin/data/')).entry,
    'game://./bin/bootstrap.tjs')
  assert.equal(gameSettings({ title: 'Game', entry: '/bootstrap.tjs', backend: 'auto' }, selected).entry,
    'game://./bootstrap.tjs')
  assert.throws(() => gameSettings({ title: 'Game', entry: '../bootstrap.tjs', backend: 'auto' }, selected), /escapes/)
  assert.throws(() => gameSettings({ title: 'Game', entry: '../../../bootstrap.tjs', backend: 'auto' }, project('bin/data/')), /escapes/)
})

test('project dataPath resolves executable-relative parents before bounds checking and stays root-anchored', () => {
  assert.equal(normalizeSystemDataPath('../slots', 'games/app/'), 'games/slots/')
  assert.equal(normalizeSystemDataPath('$(exepath)/../slots', 'games/app/'), 'games/slots/')
  assert.equal(normalizeSystemDataPath('/shared', 'games/app/'), 'shared/')
  assert.equal(normalizeSystemDataPath('game:///', ''), '')
  assert.equal(normalizeSystemDataPath('game://./', 'games/app/'), '')
  assert.equal(normalizeSystemDataPath('game:\\\\\\.\\shared\\', 'games/app/'), 'shared/')
  assert.throws(() => normalizeSystemDataPath('../../../outside', 'games/app/'), /escapes/)
  const system = new SystemEnvironment(new Map([['-datapath', '../slots']]), undefined, undefined,
    project('games/app/data.xp3>', 'games/app/'))
  assert.equal(system.exePath, 'game://./games/app/')
  assert.equal(system.dataPath, 'game://./games/slots/')
  assert.equal(system.personalPath, 'game://./games/app/savedata/')
})
