import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { projectIdentity } from '../../src/player/game-identity.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { member, distributionZip } from '../helpers/deflated-distribution.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'
import { embedXp3, xp3Fixture } from '../helpers/xp3-fixtures.ts'

const checkpoint = async () => {}
function packed(bytes: Buffer, name = 'release.ZIP'): Resource {
  return { name, size: bytes.length, source: { size: bytes.length, read: async (at, n) => bytes.subarray(at, at + n) },
    read: async () => { throw new Error('Unexpected whole ZIP read') } }
}

test('distribution discovery preserves native startup priority, independent choices and saved project identity', async () => {
  const reader = createSessionArchiveReader(), opens: string[] = []
  const tracked = { ...reader, async open(resource: Resource, check: () => Promise<void>) {
    opens.push(resource.name); return reader.open(resource, check)
  } }
  const base = 'game-' + 'a'.repeat(64)
  const zip = packed(distributionZip(['Story/data.xp3', 'Story/data/startup.tjs', 'Story/content-data/startup.tjs',
    'Story/examples/A/startup.tjs', 'license.txt'].map((name) => member(name, 'fixture'))))
  try {
    const collection = await prepareProject([zip], { mode: 'collection' }, tracked, checkpoint)
    assert.deepEqual(collection.resources, [zip]); assert.equal(collection.project, undefined); assert.deepEqual(opens, [])
    const mount = await prepareProject([zip], { mode: 'auto' }, tracked, checkpoint)
    assert.deepEqual(mount.project, { executableDirectory: 'Story/', directory: 'Story/content-data/', distribution: 'release.ZIP' })
    assert.deepEqual(opens, ['release.ZIP'], 'Selection only needs the outer directory, including with a lower-priority data.xp3')
    assert.equal(mount.resources[0]?.name, 'Story/data.xp3')
    const replay = await prepareProject([zip], { mode: 'root', ...mount.project! }, tracked, checkpoint)
    assert.deepEqual(replay.project, mount.project)
    assert.equal(await projectIdentity(base, replay.project), await projectIdentity(base, mount.project))
    assert.notEqual(await projectIdentity(base, mount.project), await projectIdentity(base, {
      executableDirectory: 'Story/', directory: 'Story/content-data/',
    }))
    const two = packed(distributionZip([member('One/data.xp3', 'a'), member('Two/DATA/startup.tjs', 'b')]))
    await assert.rejects(prepareProject([two], { mode: 'auto' }, tracked, checkpoint), /多个游戏/)
    assert.equal((await prepareProject([two], { mode: 'auto', executableDirectory: 'two/' }, tracked, checkpoint)).project?.directory, 'Two/DATA/')
    const self = packed(distributionZip([member('Edition/Adventure.exe', embedXp3(xp3Fixture({ 'startup.tjs': '42' }).bytes))]))
    assert.deepEqual((await prepareProject([self], { mode: 'auto' }, tracked, checkpoint)).project,
      { directory: 'Edition/Adventure.exe>', executableDirectory: 'Edition/', distribution: self.name })
    await assert.rejects(prepareProject([], { mode: 'root', ...mount.project! }, tracked, checkpoint), /ZIP is missing/)
  } finally { reader.dispose() }
})

test('a named ZIP launcher resolves beside its game, and duplicate filenames require the program directory', async () => {
  const reader = createSessionArchiveReader()
  const launch = { mode: 'auto' as const, executable: 'story.exe' }
  const inputs = [member('Release/Story.EXE', 'launcher'), member('Release/Setup.exe', 'installer'), member('Release/data.xp3', 'game')]
  try {
    const zip = packed(distributionZip(inputs))
    const selected = (await prepareProject([zip], launch, reader, checkpoint)).project!
    assert.equal(selected.directory, 'Release/data.xp3>')
    assert.equal(selected.executable, 'game://./Release/Story.EXE')
    const ambiguous = packed(distributionZip([...inputs, member('Extras/Story.exe', 'demo')]))
    await assert.rejects(prepareProject([ambiguous], launch, reader, checkpoint), /程序所在目录/)
    const explicit = (await prepareProject([ambiguous], { ...launch, executableDirectory: 'Release/' }, reader, checkpoint)).project!
    assert.equal(explicit.executable, selected.executable)
  } finally { reader.dispose() }
})

test('ZIP method 8 checks every byte before exposing a requested prefix and supports independent caller ranges', async () => {
  const reader = createSessionArchiveReader()
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 23)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + (i >>> 13)) & 255
    const good = member('music.bin', bytes)
    const bad = packed(distributionZip([{ ...good, crc: (good.crc ^ 1) >>> 0 }]))
    const corrupt = (await reader.open(bad, checkpoint))!.entries[0]!
    await assert.rejects(corrupt.source!.read(0, 4), /ZIP CRC32 mismatch: music.bin/)
    await assert.rejects(corrupt.source!.read(bytes.length - 1, 1), /CRC32 mismatch/)
    const short = (await reader.open(packed(distributionZip([{ ...good, size: good.size + 1 }])), checkpoint))!.entries[0]!
    await assert.rejects(short.source!.read(0, 1), /ZIP decompressed size mismatch/)
    const item = (await reader.open(packed(distributionZip([good])), checkpoint))!.entries[0]!
    const offsets = [23, bytes.length - 39, 1024 * 1024 + 53, 0]
    const ranges = await Promise.all(offsets.map((offset) => item.source!.read(offset, 31)))
    for (const [i, offset] of offsets.entries())
      assert.deepEqual(Buffer.from(ranges[i]!), bytes.subarray(offset, offset + 31))
    ranges[0]!.fill(0)
    assert.deepEqual(Buffer.from(await item.source!.read(23, 31)), bytes.subarray(23, 54))
    reader.compact()
    assert.deepEqual(Buffer.from(await item.source!.read(7, 31)), bytes.subarray(7, 38))
    for (const file of ['8-stream1-local640-zip640.zip', '8-stream1-local641-zip640.zip', '8-stream1-local640-zip641.zip']) {
      const entry = (await reader.open(packed(zipFixture(file)), checkpoint))!.entries.find((item) => item.name === 'startup.tjs')!
      assert.deepEqual(await entry.source!.read(2, 19), (await entry.read()).slice(2, 21))
    }
  } finally { reader.dispose() }
})

for (const blocked of ['local header', 'compressed payload']) test(`retiring a ZIP decoder releases a pending ${blocked} read`, { timeout: 30000 }, async () => {
  const reader = createSessionArchiveReader(), item = member('music.wav', 'an authored piece of music'), zip = distributionZip([item])
  let hold = false, release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve }), waiting = new Promise<void>((resolve) => { entered = resolve })
  const resource: Resource = { ...packed(zip), source: { size: zip.length, async read(at, n) {
    if (hold && at === (blocked === 'local header' ? 0 : 30 + Buffer.byteLength(item.name))) { entered(); await gate }
    return zip.subarray(at, at + n)
  } } }
  try {
    const file = (await reader.open(resource, checkpoint))!.entries[0]!
    hold = true
    const operation = file.source!.read(0, 4)
    await Promise.race([waiting, operation.then(() => { throw new Error('ZIP data read was never held') })])
    reader.dispose()
    await assert.rejects(operation, /disposed/)
  } finally { hold = false; release(); reader.dispose() }
})
