import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { archiveReader, createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { joinArchiveVolumes } from '../../src/backends/files/archive-volumes.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'
import { splitZipFixture } from '../helpers/split-zip.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { centralRecords, zipFixture } from '../helpers/zip-fixtures.ts'

const step = async () => {}
function volume(name: string, bytes: Buffer): Resource {
  const source = new BlobSource(new Blob([Uint8Array.from(bytes).buffer]))
  return { name, size: bytes.length, source, read: () => { throw new Error('Unexpected whole physical volume read') } }
}

test('numbered parts stay lazy, cross exact byte boundaries, and preserve immutable file slices', async () => {
  const files = [volume('art/Face.xp3.002', Buffer.from('defg')), volume('art/Face.xp3.001', Buffer.from('abc')),
    volume('art/Face.xp3.003', Buffer.from('hi'))]
  const [joined] = await joinArchiveVolumes(files, step)
  assert.equal(joined!.name, 'art/Face.xp3')
  assert.equal(joined!.zipDiskOffsets, undefined)
  const source = joined!.source!
  for (const [at, length, expected] of [[0, 9, 'abcdefghi'], [3, 4, 'defg'], [2, 6, 'cdefgh'], [9, 0, '']] as const) {
    assert.equal(Buffer.from(await source.read(at, length)).toString(), expected)
    const blob = await source.borrowBlob!(at, length, step)
    assert(blob instanceof Blob)
    assert.equal(await blob.text(), expected)
  }
  const bytes = await source.read(2, 2)
  bytes.fill(0)
  assert.equal(Buffer.from(await source.read(2, 2)).toString(), 'cd')
  const calls: string[] = []
  const parts = files.map(({ name, size, source }) => ({ ...volume(name, Buffer.alloc(size)), source: {
    size, async read(at: number, n: number) { calls.push(name); return source!.read(at, n) },
  } }))
  const [ranges] = await joinArchiveVolumes(parts, step)
  assert.deepEqual(calls, [])
  assert.equal(ranges!.source!.borrowBlob, undefined)
  assert.equal(Buffer.from(await ranges!.source!.read(6, 2)).toString(), 'gh')
  assert.deepEqual(calls, ['art/Face.xp3.002', 'art/Face.xp3.003'])
  await assert.rejects(joinArchiveVolumes([files[1]!, files[2]!], step), /缺少分卷 2/)
  await assert.rejects(joinArchiveVolumes([files[1]!, files[1]!], step), /重名/)
  await assert.rejects(joinArchiveVolumes([volume('art.z01', Buffer.from([80, 75, 7, 8]))], step), /最后一卷/)
  const unrelated = volume('scripts/assembler.z80', Buffer.from('source'))
  assert.deepEqual(await joinArchiveVolumes([unrelated], step), [unrelated])
  const oldName = volume('title.zip.001', zipFixture())
  assert.deepEqual(await joinArchiveVolumes([oldName], step), [oldName])
  assert.equal((await archiveReader.open(oldName, step))?.kind, 'zip')
})

test('indexed split ZIP reads a physical disk-relative local header, deflated data spanning disks and a central directory spanning disks', async () => {
  const archive = distributionZip([member('one', 'first'), member('two', 'second payload crosses volumes'), member('three', 'third')])
  const { records } = centralRecords(archive)
  const parts = splitZipFixture(archive, [records[1]!.data + 4, records[2]!.at])
  const raw = parts.map((b, i) => volume(['release.Z01', 'release.z02', 'release.Zip'][i]!, b))
  const [joined] = await joinArchiveVolumes(raw.reverse(), step)
  assert.deepEqual(joined!.zipDiskOffsets, [0, parts[0]!.length, parts[0]!.length + parts[1]!.length])
  const index = await archiveReader.open(joined!, step)
  assert.deepEqual(index?.entries.map((f) => f.name), ['one', 'two', 'three'])
  assert.deepEqual(await Promise.all(index!.entries.map(async (f) => Buffer.from(await f.read()).toString())),
    ['first', 'second payload crosses volumes', 'third'])
  const wrong = Buffer.from(parts[2]!)
  wrong.writeUInt16LE(0, wrong.length - 22 + 8)
  const [wrongDirectory] = await joinArchiveVolumes([volume('release.Zip', wrong), ...raw.slice(1)], step)
  await assert.rejects(archiveReader.open(wrongDirectory!, step), /count on disk/)
})

test('ZIP64 locator, directory and member offsets are relative to their own disks', async () => {
  const archive = zipFixture('8-stream0-local640-zip641.zip')
  const end = archive.length - 22, locator = end - 20, record = Number(archive.readBigUInt64LE(locator + 8))
  const central = Number(archive.readBigUInt64LE(record + 48))
  const count = Number(archive.readBigUInt64LE(record + 32))
  // The complete local records live on disk 0; the directory and ZIP64 end
  // record on disk 1, and the locator and classic EOCD on disk 2.
  archive.writeUInt32LE(1, record + 16)
  archive.writeUInt32LE(1, record + 20)
  archive.writeBigUInt64LE(BigInt(count), record + 24)
  archive.writeBigUInt64LE(0n, record + 48)
  archive.writeUInt32LE(1, locator + 4)
  archive.writeBigUInt64LE(BigInt(record - central), locator + 8)
  archive.writeUInt32LE(3, locator + 16)
  archive.writeUInt16LE(2, end + 4)
  archive.writeUInt16LE(1, end + 6)
  archive.writeUInt16LE(0, end + 8)
  archive.writeUInt32LE(0, end + 16)
  const parts = [volume('part.z01', archive.subarray(0, central)), volume('part.z02', archive.subarray(central, locator)),
    volume('part.zip', archive.subarray(locator))]
  const [file] = await joinArchiveVolumes(parts, step), index = await archiveReader.open(file!, step)
  const reference = await archiveReader.open(volume('reference.zip', zipFixture('8-stream0-local640-zip641.zip')), step)
  assert.deepEqual(index!.entries.map((f) => f.name), reference!.entries.map((f) => f.name))
  for (const [i, f] of index!.entries.entries()) assert.deepEqual(await f.read(), await reference!.entries[i]!.read())
})

test('a ZIP release containing numbered data.xp3 parts selects the same project after library reopen', async () => {
  const xp3 = xp3Fixture({ 'startup.tjs': '"game"' }, { compressed: true }).bytes
  const archive = distributionZip([member('Edition/data.xp3.002', xp3.subarray(7)), member('Edition/data.xp3.001', xp3.subarray(0, 7))])
  const inputs = [volume('release.zip.002', archive.subarray(31)), volume('release.zip.001', archive.subarray(0, 31))]
    .map((f) => ({ path: f.name, source: f.source! }))
  const reader = createSessionArchiveReader()
  try {
    const files = await importSources(inputs, step, { lazyArchives: true })
    const mount = await prepareProject(files, { mode: 'auto' }, reader, step)
    assert.deepEqual(mount.project, { directory: 'Edition/data.xp3>', executableDirectory: 'Edition/', distribution: 'release.zip' })
    const replay = await prepareProject(files, { mode: 'root', ...mount.project! }, reader, step)
    assert.deepEqual(replay.project, mount.project)
    const storage = new StorageResolver(mount.project!.directory, false, reader, step)
    try {
      storage.mount(replay.resources)
      const entry = await storage.lookupAsync('startup.tjs')
      assert.equal(Buffer.from(await entry!.read()).toString(), '"game"')
    } finally { storage.dispose() }
    const eager = await importSources(inputs, step)
    assert(eager.some((f) => f.name === 'release.zip' && f.archiveKind === 'zip'))
  } finally { reader.dispose() }
})

test('a stock Info-ZIP split game release opens from all submitted files and verifies a multi-volume stored asset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krkr-infozip-'))
  try {
    await mkdir(join(directory, 'Story/data'), { recursive: true })
    const music = Buffer.alloc(170 * 1024)
    for (let i = 0; i < music.length; i++) music[i] = (i * 31 + (i >>> 9)) & 255
    await writeFile(join(directory, 'Story/data/startup.tjs'), '"infozip"')
    await writeFile(join(directory, 'Story/data/music.bin'), music)
    await promisify(execFile)('zip', ['-q', '-0', '-s', '64k', 'release.zip', 'Story/data/startup.tjs', 'Story/data/music.bin'], { cwd: directory })
    const disks = (await readdir(directory)).filter((name) => name.startsWith('release.')).sort().reverse()
    assert.equal(disks.length, 3)
    const files = await Promise.all(disks.map(async (name) => volume(name, await readFile(join(directory, name)))))
    const mounted = await importSources(files.map((f) => ({ path: f.name, source: f.source! })), step, { lazyArchives: true })
    const release = await prepareProject(mounted, { mode: 'auto' }, archiveReader, step)
    assert.equal(release.project!.directory, 'Story/data/')
    const entry = release.resources.find((f) => f.name.endsWith('/music.bin'))!
    assert.deepEqual(Buffer.from(await entry.read()), music)
    const span = await entry.source!.borrowBlob!(64000, 70000, step)
    assert.deepEqual(Buffer.from(await span.arrayBuffer()), music.subarray(64000, 134000))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
