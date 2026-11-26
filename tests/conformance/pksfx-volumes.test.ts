import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { archiveReader, createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { joinArchiveVolumes } from '../../src/backends/files/archive-volumes.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { projectIdentity } from '../../src/player/game-identity.ts'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'
import { headless } from '../helpers/headless.ts'
import { splitZipFixture } from '../helpers/split-zip.ts'
import { centralRecords } from '../helpers/zip-fixtures.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

const step = async () => {}, hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function volume(name: string, bytes: Buffer, calls?: { name: string; offset: number; length: number }[]): Resource {
  const blob = new BlobSource(new Blob([Uint8Array.from(bytes).buffer]))
  return { name, size: bytes.length, source: { size: bytes.length,
    async read(offset, length) { calls?.push({ name, offset, length }); return blob.read(offset, length) },
    borrowBlob: (offset, length, checkpoint) => blob.borrowBlob(offset, length, checkpoint),
  }, read: () => { throw new Error('Physical PKSFX volume must stay range-backed') } }
}

function authored(binary = false) {
  const payload = Buffer.alloc(96 * 1024 + 17)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + (i >>> 7) * 13) & 255
  const program = 'System.exitOnNoWindowStartup=false;var route=Scripts.evalStorage("chapter.tjs");["disk-save:7"].save(System.dataPath+"slot.txt","utf-8");',
    zip = distributionZip([
      member('Release/data/payload.bin', payload),
      member('Release/data/startup.tjs', binary
        ? 'Scripts.compileStorage("program.tjs",System.dataPath+"program.cjs",false,true,false);Scripts.execStorage(System.dataPath+"program.cjs");'
        : 'Scripts.execStorage("program.tjs");'),
      member('Release/data/program.tjs', program), member('Release/data/chapter.tjs', '"opening from disks"'),
      member('Release/Tools/startup.tjs', 'throw "Wrong bundled sample";'),
      member('Extras/demo.xp3', xp3Fixture({ 'startup.tjs': 'throw "Embedded archive is not the distribution";' }).bytes),
    ]), prefix = Buffer.alloc(4096), { end, central, records } = centralRecords(zip)
  prefix.write('MZ inert PKSFX first volume; no executable code.\r\n', 'ascii')
  // In a real PKSFX, disk-zero addresses include its executable stub. Patch
  // the independent classic writer before converting addresses into disks.
  for (const row of records) zip.writeUInt32LE(row.local + prefix.length, row.at + 42)
  zip.writeUInt32LE(central + prefix.length, end + 16)
  return { bytes: Buffer.concat([prefix, zip]), payload }
}

function pksfx(disks: 2 | 3, binary = false) {
  const input = authored(binary), { records } = centralRecords(input.bytes), data = records[0]!,
    packed = input.bytes.readUInt32LE(data.at + 20), cut = data.data + Math.floor(packed / 2),
    parts = splitZipFixture(input.bytes, disks === 2 ? [cut] : [cut, records[1]!.at]),
    names = disks === 2 ? ['bundle/Game.EXE', 'bundle/game.Zip'] : ['bundle/Game.EXE', 'bundle/game.z02', 'bundle/game.Zip']
  return { ...input, parts, names }
}

for (const disks of [2, 3] as const) test(`${disks}-disk PKSFX joins EXE first, retains relative addresses and starts the selected game`, { timeout: 60000 }, async (t) => {
  const binary = disks === 3, fixture = pksfx(disks, binary), originals = fixture.parts.map((bytes) => Buffer.from(bytes)),
    calls: { name: string; offset: number; length: number }[] = [],
    files = fixture.parts.map((bytes, i) => volume(fixture.names[i]!, bytes, calls)).reverse(),
    reader = createSessionArchiveReader()
  try {
    const [joined] = await joinArchiveVolumes(files, step)
    assert.equal(joined!.name, 'bundle/game.Zip')
    const starts = [0]
    for (const part of fixture.parts.slice(0, -1)) starts.push(starts.at(-1)! + part.length)
    assert.deepEqual(joined!.zipDiskOffsets, starts)
    const complete = Buffer.concat(fixture.parts)
    for (const boundary of starts.slice(1)) {
      assert.deepEqual(Buffer.from(await joined!.source!.read(boundary - 5, 13)), complete.subarray(boundary - 5, boundary + 8))
      assert.deepEqual(Buffer.from(await (await joined!.source!.borrowBlob!(boundary - 5, 13, step)).arrayBuffer()), complete.subarray(boundary - 5, boundary + 8))
    }
    const copy = await joined!.source!.read(0, 2); copy.fill(0)
    assert.deepEqual([...await joined!.source!.read(0, 2)], [77, 90])
    const beforeProbe = calls.length
    assert.equal(await archiveReader.probeXp3(joined!, step), false)
    assert.equal(calls.length, beforeProbe, 'a confirmed PKZIP volume set never scans its game files for an XP3 executable')
    const index = await reader.open(joined!, step)
    assert.equal(index?.kind, 'zip')
    assert.deepEqual(Buffer.from(await index!.entries.find((entry) => entry.name.endsWith('/payload.bin'))!.read()), fixture.payload)
    const resources = await importSources(files.map((file) => ({ path: file.name, source: file.source! })), step, { lazyArchives: true }),
      mount = await prepareProject(resources, { mode: 'auto' }, reader, step)
    assert.deepEqual(mount.project, { directory: 'Release/data/', executableDirectory: 'Release/', distribution: 'bundle/game.Zip' })
    const replay = await prepareProject(resources, { mode: 'root', ...mount.project! }, reader, step)
    assert.deepEqual(replay.project, mount.project)
    const base = 'game-' + 'd'.repeat(64)
    assert.equal(await projectIdentity(base, replay.project), await projectIdentity(base, mount.project))
    const { session, events } = await headless({}, { project: replay.project })
    try {
      session.mount(replay.resources); await session.start()
      assert.equal(await session.evaluate('route'), 'opening from disks')
      assert.equal(await session.evaluate('System.exePath+"|"+System.dataPath'), 'game://./Release/|game://./Release/savedata/')
      assert.equal(await session.evaluate('[].load(System.dataPath+"slot.txt")[0]'), 'disk-save:7')
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((file) => file.path.endsWith('/program.cjs'))!.bytes).toString('ascii', 0, 4), 'TJS2')
      assert.deepEqual(events.filter((event) => event.type === 'error'), [])
    } finally { await session.stop() }
    const eager = await importSources(files.map((file) => ({ path: file.name, source: file.source! })), step)
    assert(eager.some((entry) => entry.name === 'bundle/game.Zip' && entry.archiveKind === 'zip'))
    for (const [i, bytes] of fixture.parts.entries()) assert.deepEqual(bytes, originals[i])
    assert(calls.every((call) => call.length <= 1024 * 1024))
    t.diagnostic(JSON.stringify({ disks, binary, parts: fixture.parts.map((bytes, i) => ({ name: fixture.names[i], bytes: bytes.length, sha256: hash(bytes) })),
      diskOffsets: starts, calls, scope: 'Inert MZ bytes only; independent PKZIP disk addressing, real Session script and data-directory save.' }))
  } finally { reader.dispose() }
})

test('PKSFX requires its named middle disks and MZ first volume without consuming original resources', async () => {
  const fixture = pksfx(3), files = fixture.parts.map((bytes, i) => volume(fixture.names[i]!, bytes))
  await assert.rejects(joinArchiveVolumes([files[0]!, files[2]!], step), /缺少分卷 2/)
  await assert.rejects(joinArchiveVolumes([files[1]!, files[2]!], step), /缺少分卷 1/)
  await assert.rejects(joinArchiveVolumes([files[0]!, files[1]!], step), /最后一卷/)
  await assert.rejects(joinArchiveVolumes([...files, volume('bundle/game.exe', fixture.parts[0]!)], step), /重名/)
  const two = pksfx(2), notMz = Buffer.from(two.parts[0]!); notMz[0] = 0
  const ordinary = [volume('bundle/game.exe', notMz), volume('bundle/game.zip', two.parts[1]!)]
  assert.deepEqual(await joinArchiveVolumes(ordinary, step), ordinary)
  await assert.rejects(archiveReader.open(ordinary[1]!, step), /缺少分卷|卷号/)
  const extra = [...files, volume('bundle/game.z03', Buffer.from('unrelated extra disk'))]
  await assert.rejects(joinArchiveVolumes(extra, step), /编号与最后一卷/)
  const before = files.map((file) => file.name)
  await assert.rejects(joinArchiveVolumes(files, async () => { throw new Error('cancelled fixture import') }), /cancelled fixture import/)
  assert.deepEqual(files.map((file) => file.name), before)
  const unavailable: Resource = { ...files[2]!, source: { size: files[2]!.size,
    read: async () => { throw new Error('known disk unavailable') } } }
  await assert.rejects(joinArchiveVolumes([files[0]!, files[1]!, unavailable], step), /known disk unavailable/)
})

test('ordinary matching EXE and ZIP stay independent, z01 takes precedence, and byte-split EXEs remain logical streams', async () => {
  const installer = volume('Game.exe', Buffer.from('MZ independent installer')), normal = volume('game.zip', distributionZip([member('startup.tjs', '42')])),
    ordinary = [installer, normal]
  assert.deepEqual(await joinArchiveVolumes(ordinary, step), ordinary)
  const unsupported: Resource = { ...normal, source: { size: normal.size,
    read: async () => { throw new Error('Optional archive resource is unavailable') } } }
  assert.deepEqual(await joinArchiveVolumes([installer, unsupported], step), [installer, unsupported])
  let cancelled = false
  const interrupted: Resource = { ...normal, source: { size: normal.size,
    read: async () => { cancelled = true; throw new Error('Read interrupted') } } }
  await assert.rejects(joinArchiveVolumes([installer, interrupted], async () => {
    if (cancelled) throw new Error('Cancelled while detecting optional volumes')
  }), /Cancelled while detecting optional volumes/)
  const zip = distributionZip([member('data.bin', 'split ordinary data')]), { records } = centralRecords(zip),
    parts = splitZipFixture(zip, [records[0]!.data + 3]), z01 = volume('game.z01', parts[0]!), final = volume('game.zip', parts[1]!),
    joined = await joinArchiveVolumes([installer, final, z01], step)
  assert.equal(joined.length, 2); assert.equal(joined[0], installer)
  assert.deepEqual(joined[1]!.zipDiskOffsets, [0, parts[0]!.length])
  assert.deepEqual(await joinArchiveVolumes(joined, step), joined, 'an already joined ZIP cannot consume the independent EXE on a second preparation')
  assert.equal(Buffer.from(await (await archiveReader.open(joined[1]!, step))!.entries[0]!.read()).toString(), 'split ordinary data')
  const raw = Buffer.from('MZ byte-split executable container'), a = volume('release.exe.001', raw.subarray(0, 5)), b = volume('release.exe.002', raw.subarray(5)),
    [stream] = await joinArchiveVolumes([b, a], step)
  assert.equal(stream!.name, 'release.exe'); assert.equal(stream!.zipDiskOffsets, undefined)
  assert.deepEqual(Buffer.from(await stream!.source!.read(0, raw.length)), raw)
})

test('PKSFX uses a ZIP64 locator disk count when classic final-disk fields are saturated', async () => {
  const input = authored(), { end, central, records } = centralRecords(input.bytes), size = end - central,
    record = Buffer.alloc(56), locator = Buffer.alloc(20), eocd = Buffer.alloc(22)
  record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4)
  record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14)
  record.writeUInt32LE(1, 16); record.writeUInt32LE(1, 20)
  record.writeBigUInt64LE(BigInt(records.length), 24); record.writeBigUInt64LE(BigInt(records.length), 32)
  record.writeBigUInt64LE(BigInt(size), 40); record.writeBigUInt64LE(0n, 48)
  locator.writeUInt32LE(0x07064b50); locator.writeUInt32LE(1, 4)
  locator.writeBigUInt64LE(BigInt(size), 8); locator.writeUInt32LE(2, 16)
  eocd.writeUInt32LE(0x06054b50)
  for (const at of [4, 6, 8, 10]) eocd.writeUInt16LE(0xffff, at)
  eocd.writeUInt32LE(0xffffffff, 12); eocd.writeUInt32LE(0xffffffff, 16)
  const first = input.bytes.subarray(0, central), directory = Buffer.from(input.bytes.subarray(central, end)),
    last = Buffer.concat([directory, record, locator, eocd]),
    [joined] = await joinArchiveVolumes([volume('large.zip', last), volume('large.exe', first)], step)
  assert.deepEqual(joined!.zipDiskOffsets, [0, first.length])
  const reader = createSessionArchiveReader()
  try {
    const index = await reader.open(joined!, step)
    assert.equal(index?.kind, 'zip'); assert.equal(index!.entries.length, records.length)
    assert.deepEqual(Buffer.from(await index!.entries[0]!.read()), input.payload)
  } finally { reader.dispose() }
})
