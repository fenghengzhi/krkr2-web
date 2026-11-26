import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { decodePlainText } from '../../src/backends/files/blob-source.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { CddaDiscs } from '../../src/engine/storage/cdda.ts'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { member, distributionZip } from '../helpers/deflated-distribution.ts'

function file(name: string, content: string | Uint8Array): Resource {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return { name, size: bytes.length, read: async () => bytes }
}
const cue = 'FILE "theme.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n'
const checkpoint = async () => {}

test('the chosen CUE owns its FILE references across colliding and missing release members', async (t) => {
  const reader = createSessionArchiveReader(), project = new StorageResolver('', false, reader)
  const imports = new StorageResolver('', false, reader)
  t.after(() => { project.dispose(); imports.dispose(); reader.dispose() })
  const pressing = (value: string) => distributionZip([member('Media/story.cue', cue), member('Media/theme.wav', value)])
  project.mount([file('Media/story.cue', cue), file('Install/Extras.zip', pressing('project soundtrack'))])
  imports.mount([file('Extras.zip', pressing('companion soundtrack')), file('Media/theme.wav', 'unrelated loose file')])
  const mounts = (directory: string, name: string) => new CddaDiscs({
    currentDirectory: directory, exact: (path) => project.findAsync(path), exists: async () => false, cues: async () => [],
    read: (resource) => resource.read(), decodeText: decodePlainText, checkpoint,
  }, [{ drive: 'G', cue: name }], 'Release.zip', imports)
  const missing = (name: string) => (error: unknown) => error instanceof TvpError &&
    error.tvpMessage.id === 'TVPCannotOpenStorage' && error.tvpMessage.args[0] === 'game://./' + name
  await assert.rejects(mounts('Install/', 'Release.zip>Media/story.cue').prepare('G:1'), missing('Media/theme.wav'))
  for (const [directory, expected] of [['Install/', 'project soundtrack'], ['', 'companion soundtrack']] as const) {
    const selection = await mounts(directory, 'Extras.zip>Media/story.cue').prepare('G:1')
    const part = selection?.parts?.[0]
    assert(part?.kind === 'file')
    assert.equal(Buffer.from(await part.resource.read()).toString(), expected)
  }
  await assert.rejects(mounts('Install/data.xp3>', 'Extras.zip>missing.cue').prepare('G:1'), missing('Extras.zip>missing.cue'))
})

test('two separately supplied data images require a drive mapping', async (t) => {
  const reader = createSessionArchiveReader(), imports = new StorageResolver('', false, reader)
  t.after(() => { imports.dispose(); reader.dispose() })
  imports.mount([file('Disc1.iso', ''), file('Disc2.iso', '')])
  const mount = (cues: string[]) => new CddaDiscs({ currentDirectory: '', exact: async () => undefined,
    exists: async () => false, cues: async () => cues, read: (resource) => resource.read(),
    decodeText: decodePlainText, checkpoint }, undefined, 'Story.zip', imports)
  assert.deepEqual(await mount([]).drives(), [])
  await assert.rejects(mount([]).prepare('1'), /require explicit/)
  assert.deepEqual(await mount(['installed.cue']).drives(), ['D'])
})

test('automatic companion ZIP selection counts separate pressings and skips a non-game archive', async (t) => {
  const reader = createSessionArchiveReader(), opens: string[] = []
  const imports = new StorageResolver('', false, { ...reader, open(resource, check) {
    opens.push(resource.name); return reader.open(resource, check)
  } })
  t.after(() => { imports.dispose(); reader.dispose() })
  const makeDiscs = () => new CddaDiscs({ currentDirectory: '', exact: async () => undefined,
    exists: async () => false, cues: async () => [], read: (resource) => resource.read(),
    decodeText: decodePlainText, checkpoint }, undefined, 'Game.zip', imports)
  imports.mount([file('Manual.zip', 'unavailable manual'), file('Disc1.zip', distributionZip([
    member('CD/Play.cue', cue), member('CD/theme.wav', 'first recording'),
  ]))])
  const discs = makeDiscs()
  assert.deepEqual(opens, [])
  const chosen = await discs.prepare('1')
  assert.equal(chosen?.cue, 'Disc1.zip>CD/Play.cue'); assert.equal(chosen?.drive, 'D')
  const first = [...opens]
  assert(first.includes('Disc1.zip'))
  assert.deepEqual(await discs.drives(), ['D']); assert.deepEqual(opens, first)
  imports.mount([file('Disc2.zip', distributionZip([member('CD/Extra.iso', 'second disc')]))])
  await assert.rejects(makeDiscs().prepare('1'), /require explicit/)
})
