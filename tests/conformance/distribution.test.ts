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

test('a normal game ZIP beside documents ignores unreadable and non-game side packages', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const game = packed(distributionZip([member('Story/data/startup.tjs', '"selected game"'), member('Story/readme.txt', 'game notes')]), 'editions/Story.zip'),
    note = packed(Buffer.from('choose a game'), 'readme.txt'), bad = packed(Buffer.from('not a ZIP'), 'broken.zip'),
    documentation = packed(distributionZip([member('manual.txt', 'documentation')]), 'manuals.zip'),
    tools = packed(distributionZip([member('tools/setup.exe', 'MZ ordinary utility')]), 'tools.zip'),
    incomplete = packed(distributionZip([member('asset.zip.001', 'a'), member('asset.zip.003', 'c')]), 'partial-assets.zip'),
    files = [note, tools, incomplete, bad, game, documentation], originalNames = files.map((file) => file.name)
  const mounted = await prepareProject(files, { mode: 'auto' }, reader, checkpoint)
  assert.deepEqual(mounted.project, { directory: 'Story/data/', executableDirectory: 'Story/', distribution: 'editions/Story.zip' })
  assert.equal(Buffer.from(await mounted.resources.find((file) => file.name.endsWith('/startup.tjs'))!.read()).toString(), '"selected game"')
  assert.deepEqual(files.map((file) => file.name), originalNames)
  const replay = await prepareProject([...files].reverse(), { mode: 'root', ...mounted.project! }, reader, checkpoint, 'unrelated.tjs')
  assert.deepEqual(replay.project, mounted.project)
  const base = 'game-' + 'c'.repeat(64)
  assert.equal(await projectIdentity(base, replay.project), await projectIdentity(base, mounted.project))
  const none = [note, tools, documentation, bad]
  assert.deepEqual((await prepareProject(none, { mode: 'auto' }, reader, checkpoint)).project, { directory: '', executableDirectory: '' })
  await assert.rejects(prepareProject(files, { mode: 'auto', executable: 'broken.zip' }, reader, checkpoint), /ZIP/)
})

test('several normal ZIP games require an explicit package and retain confirmed game errors and cancellation', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const first = packed(distributionZip([member('First/data/boot.tjs', '"first"')]), 'first.zip'),
    second = packed(distributionZip([member('Second/data/boot.tjs', '"second"')]), 'second.zip'),
    note = packed(Buffer.from('editions'), 'README.txt'), files = [first, note, second]
  await assert.rejects(prepareProject(files, { mode: 'auto' }, reader, checkpoint, 'boot.tjs'),
    (error: unknown) => error instanceof Error && /多个 ZIP 游戏发行包/.test(error.message) && error.message.includes('first.zip') && error.message.includes('second.zip'))
  const selected = await prepareProject(files, { mode: 'auto', executable: 'SECOND.ZIP' }, reader, checkpoint, 'boot.tjs')
  assert.deepEqual(selected.project, { directory: 'Second/data/', executableDirectory: 'Second/', distribution: 'second.zip' })
  const ambiguousInside = packed(distributionZip([member('One/data/boot.tjs', '1'), member('Two/data/boot.tjs', '2')]), 'both.zip')
  await assert.rejects(prepareProject([note, ambiguousInside, first], { mode: 'auto' }, reader, checkpoint, 'boot.tjs'), /多个游戏/)
  const brokenGame = packed(distributionZip([member('Game/data/boot.tjs', '0'), member('assets.zip.001', 'a'), member('assets.zip.003', 'c')]), 'broken-game.zip')
  await assert.rejects(prepareProject([note, brokenGame, first], { mode: 'auto' }, reader, checkpoint, 'boot.tjs'), /缺少分卷 2/)
  const cancelled = new DOMException('Cancelled optional package read', 'AbortError'), aborting = { ...reader,
    async open(resource: Resource, check: () => Promise<void>) {
      if (resource === first) throw cancelled
      return reader.open(resource, check)
    } }
  await assert.rejects(prepareProject([note, first, second], { mode: 'auto' }, aborting, checkpoint, 'boot.tjs'), (error: unknown) => error === cancelled)
})

test('ordinary ZIP discovery does not displace loose native projects, XP3 inputs or an existing SFX choice', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const bytes = distributionZip([member('Wrapped/data/startup.tjs', '"zip game"')]), zip = packed(bytes, 'release.zip'),
    note = packed(Buffer.from('notes'), 'README.txt'), observed: string[] = [], tracked = { ...reader,
      async open(resource: Resource, check: () => Promise<void>) { observed.push(resource.name); return reader.open(resource, check) } }
  for (const native of [packed(Buffer.from('"loose"'), 'data/startup.tjs'),
    packed(xp3Fixture({ 'startup.tjs': '"native"' }).bytes, 'data.xp3'),
    packed(embedXp3(xp3Fixture({ 'startup.tjs': '"combined"' }).bytes), 'Novel.exe')]) {
    const baseline = await prepareProject([native, note], { mode: 'auto' }, reader, checkpoint)
    observed.length = 0
    const actual = await prepareProject([zip, native, note], { mode: 'auto' }, tracked, checkpoint)
    assert.deepEqual(actual.project, baseline.project); assert.deepEqual(observed, [])
    const base = 'game-' + 'e'.repeat(64)
    assert.equal(await projectIdentity(base, actual.project), await projectIdentity(base, baseline.project))
  }
  const unselected = packed(xp3Fixture({ 'startup.tjs': '42' }).bytes, 'patch.xp3')
  assert.equal((await prepareProject([zip, unselected, note], { mode: 'auto' }, tracked, checkpoint)).project?.distribution, undefined)
  const sfx = packed(Buffer.concat([Buffer.from('MZ inert prefix'), bytes]), 'Release.exe')
  observed.length = 0
  assert.equal((await prepareProject([zip, note, sfx], { mode: 'auto' }, tracked, checkpoint)).project?.distribution, 'Release.exe')
  assert.deepEqual(observed, [], 'the existing SFX choice is settled before ordinary sibling ZIPs are inspected')
})

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

test('a ZIP honors the same custom startup hint as its loose tree without selecting a bundled tools sample', async () => {
  const reader = createSessionArchiveReader(), base = 'game-' + 'b'.repeat(64)
  try {
    for (const [path, entry, directory, executableDirectory] of [
      ['boot.tjs', 'boot.tjs', '', ''],
      ['Release/boot.tjs', 'boot.tjs', 'Release/', 'Release/'],
      ['Release/DATA/Boot.TJS', 'boot.tjs', 'Release/DATA/', 'Release/'],
      ['Release/boot.tjs', 'game://./Release/boot.tjs', '', ''],
      ['Release/engine.xp3', 'engine.xp3>boot.tjs', 'Release/', 'Release/'],
    ] as const) {
      const inputs = [member(path, 'selected entry'), member('Release/Tools/startup.tjs', 'wrong sample')],
        zip = packed(distributionZip(inputs)), selected = await prepareProject([zip], { mode: 'auto' }, reader, checkpoint, entry),
        loose = inputs.map((file) => ({ name: file.name, size: 1, read: async () => new Uint8Array([0]) })),
        unpacked = await prepareProject(loose, { mode: 'auto' }, reader, checkpoint, entry)
      assert.deepEqual(selected.project, { directory, executableDirectory, distribution: zip.name })
      assert.deepEqual(unpacked.project, { directory, executableDirectory })
      assert.deepEqual(selected.resources.map((file) => file.name), inputs.map((file) => file.name))
      const replay = await prepareProject([zip], { mode: 'root', ...selected.project! }, reader, checkpoint, 'unrelated.tjs')
      assert.deepEqual(replay.project, selected.project)
      assert.equal(await projectIdentity(base, replay.project), await projectIdentity(base, selected.project))
    }
    const zip = packed(distributionZip([member('Release/boot.tjs', 'game'), member('Release/Tools/startup.tjs', 'sample')]))
    assert.equal((await prepareProject([zip], { mode: 'auto' }, reader, checkpoint)).project!.directory, 'Release/Tools/')
    assert.equal((await prepareProject([zip], { mode: 'auto', executableDirectory: 'Release/Tools/' }, reader, checkpoint, 'boot.tjs')).project!.directory, 'Release/Tools/')
    assert.deepEqual(await prepareProject([zip], { mode: 'collection' }, reader, checkpoint, 'boot.tjs'), { resources: [zip] })
    const outer = await prepareProject([zip], { mode: 'auto' }, reader, checkpoint, 'release.ZIP>Release/boot.tjs')
    assert.deepEqual(outer, { resources: [zip], project: { directory: '', executableDirectory: '' } })
    const frozen = await prepareProject([zip], { mode: 'root', directory: 'Release/', executableDirectory: 'Release/', distribution: zip.name },
      reader, checkpoint, 'release.ZIP>Release/boot.tjs')
    assert.equal(frozen.project!.distribution, zip.name, 'an existing frozen distribution takes precedence over new import hints')
    assert.equal(frozen.resources.some((file) => file.name === 'Release/boot.tjs'), true)
    const two = packed(distributionZip([member('One/boot.tjs', 'one'), member('Two/boot.tjs', 'two')]))
    await assert.rejects(prepareProject([two], { mode: 'auto' }, reader, checkpoint, 'boot.tjs'), /多个游戏/)
  } finally { reader.dispose() }
})

test('a multi-component relative startup address identifies the working directory of a wrapped release', async () => {
  const inputs = [member('Bundle/Story/DATA/Scripts/Boot.tjs', 'boot'), member('Extras/Tools/startup.tjs', 'sample')]
  const reader = createSessionArchiveReader()
  try {
    for (const [entry, directory, executableDirectory] of [
      ['scripts/boot.tjs', 'Bundle/Story/DATA/', 'Bundle/Story/'],
      ['data/scripts/boot.tjs', 'Bundle/Story/', 'Bundle/Story/'],
      ['Bundle/Story/DATA/Scripts/Boot.tjs', '', ''],
    ] as const) {
      const loose = inputs.map((input) => ({ name: input.name, size: input.size, read: async () => input.packed }))
      const tree = await prepareProject(loose, { mode: 'auto' }, reader, checkpoint, entry)
      const wrapped = await prepareProject([packed(distributionZip(inputs))], { mode: 'auto' }, reader, checkpoint, entry)
      assert.deepEqual(tree.project, { directory, executableDirectory })
      assert.deepEqual(wrapped.project, { directory, executableDirectory, distribution: 'release.ZIP' })
    }
    const two = packed(distributionZip([...inputs, member('Other/Scripts/boot.tjs', 'second')]))
    await assert.rejects(prepareProject([two], { mode: 'auto' }, reader, checkpoint, 'scripts/boot.tjs'), /多个匹配的入口脚本/)
    assert.equal((await prepareProject([two], { mode: 'auto', executableDirectory: 'Bundle/Story/' }, reader, checkpoint, 'scripts/boot.tjs')).project?.directory,
      'Bundle/Story/DATA/')
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
