import test from 'node:test'
import assert from 'node:assert/strict'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { readProjectConfig } from '../../src/engine/system/project-config.ts'
import { findProjectExecutable } from '../../src/engine/storage/project.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { projectIdentity } from '../../src/player/game-identity.ts'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { readText } from '../../src/backends/files/text-codecs.ts'
import { embedXp3, xp3Fixture } from '../helpers/xp3-fixtures.ts'

const project = { directory: 'Game/Data/', executableDirectory: 'Game/' }
const file = (name: string, bytes: Uint8Array = new Uint8Array()): Resource => ({ name, size: bytes.length, read: async () => bytes })
const ascii = (name: string, value: string) => file(name, new TextEncoder().encode(value))
const reader = { saved: () => undefined, decode: (bytes: Uint8Array) => readText(bytes, '', 'shift_jis', 'plain'),
  check: () => {}, warn: (message: string) => assert.fail(message) }

test('an explicit launcher survives a frozen project reopen alongside an installer, keeping the existing save identity', async () => {
  const reader = createSessionArchiveReader(), files = [file('Game/Install.exe'), file('Game/Story.EXE'), file('Game/Data/startup.tjs')]
  try {
    const location = { mode: 'root' as const, ...project }, base = 'game-' + '0'.repeat(64)
    const auto = (await prepareProject(files, location, reader, async () => {})).project!
    assert.equal(findProjectExecutable(files, auto), undefined)
    const chosen = (await prepareProject(files, { ...location, executable: 'story.exe' }, reader, async () => {})).project!
    assert.equal(chosen.executable, 'game://./Game/Story.EXE')
    const reopened = (await prepareProject(files, { mode: 'root', ...chosen }, reader, async () => {})).project!
    assert.deepEqual(reopened, chosen)
    assert.equal(findProjectExecutable(files, reopened), 'Game/Story.EXE')
    assert.equal(await projectIdentity(base, chosen), await projectIdentity(base, project))
  } finally { reader.dispose() }
})

test('a single loose combined executable uses its own XP3 ahead of data/ while an ordinary EXE uses the loose game', async () => {
  const archives = createSessionArchiveReader(), loose = file('Data/startup.tjs')
  try {
    for (const [bytes, directory] of [
      [embedXp3(xp3Fixture({ 'startup.tjs': '42' }).bytes), 'Story.exe>'],
      [Uint8Array.of(77, 90), 'Data/'],
    ] as const) {
      const selected = await prepareProject([file('Story.exe', bytes), loose], { mode: 'auto' }, archives, async () => {})
      assert.equal(selected.project?.directory, directory)
      assert.equal(findProjectExecutable(selected.resources, selected.project!), 'Story.exe')
    }
  } finally { archives.dispose() }
})

test('configuration reads only matching loose paths, decodes Windows Japanese and ignores archive member aliases', async () => {
  const unused = (name: string): Resource => ({ name, size: 0, read: async () => { throw new Error('unrelated read: ' + name) } })
  const files = [unused('Game/Story.exe'), unused('Tools/Other.exe'), unused('Game/Data/Story.cfu'),
    { ...unused('Game/Story.cf'), aliasOf: 'Game/data.xp3>Story.cf' },
    file('Game/STORY.CF', Uint8Array.of(...new TextEncoder().encode('name='), 0x82, 0xa0)),
    ascii('Game/savedata/Story.cfu', 'flag')]
  const result = await readProjectConfig(project, files, new Map(), reader)
  assert.equal(result?.arguments.get('-name'), 'あ')
  assert.equal(result?.arguments.get('-flag'), 'yes')
  assert.equal(result?.dataDirectory, 'Game/savedata/')
})

test('optional configuration read errors are reported, cancellation and ambiguous paths stop startup', async () => {
  const errors: string[] = [], files = [file('Game/Story.exe'), { ...file('Game/Story.cf'), read: async () => { throw new Error('read failed') } }]
  const result = await readProjectConfig(project, files, new Map(), { ...reader, warn: (error) => errors.push(error) })
  assert.match(errors.join('\n'), /Story.cf.*read failed/)
  assert.equal(result?.arguments.size, 0)
  let cancelled = false
  await assert.rejects(readProjectConfig(project, [files[0]!, { ...files[1]!, read: async () => {
    cancelled = true; throw new Error('cancelled read')
  } }], new Map(), { ...reader, check() { if (cancelled) throw new Error('stopped') } }), /stopped/)
  await assert.rejects(readProjectConfig(project, [files[0]!, file('Game/STORY.cf'), file('Game/Story.CF')],
    new Map(), reader), /Ambiguous engine configuration/)
})
