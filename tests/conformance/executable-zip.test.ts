import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { member, distributionZip } from '../helpers/deflated-distribution.ts'
import { centralRecords, zipFixture } from '../helpers/zip-fixtures.ts'

const step = async () => {}
const game = xp3Fixture({ 'startup.tjs': 'var chapter=7;' }).bytes
const prefixLength = 1024 * 1024 + 5 // First stored XP3 in classic samples lands on a 16-byte boundary.

// Python writes its own ZIP structures and independently reads the finished
// executable package. Appending to an existing file produces adjusted offsets.
function release(adjusted: boolean, large: boolean): Buffer {
  return execFileSync('python3', ['-c', [
    'import io, sys, zipfile',
    'adjusted, large = (v == "1" for v in sys.argv[1:3])',
    'prefix = b"MZ" + bytes(int(sys.argv[3]) - 2)',
    'stream = io.BytesIO(prefix if adjusted else b"")',
    'if large: zipfile.ZIP64_LIMIT = 1',
    'game = sys.stdin.buffer.read()',
    'with zipfile.ZipFile(stream, "a", allowZip64=True) as z:',
    ' z.writestr("Game/data.xp3", game, zipfile.ZIP_STORED)',
    ' z.writestr("Game/manual.txt", "chapter 7", zipfile.ZIP_DEFLATED)',
    ' z.comment = b"edition notes"',
    'result = (b"" if adjusted else prefix) + stream.getvalue()',
    'with zipfile.ZipFile(io.BytesIO(result)) as z:',
    ' assert z.testzip() is None and z.read("Game/data.xp3") == game',
    'sys.stdout.buffer.write(result)',
  ].join('\n'), String(Number(adjusted)), String(Number(large)), String(prefixLength)], { input: game, maxBuffer: 4 * 1024 * 1024 })
}

function physical(name: string, bytes: Buffer): Resource {
  const source = new BlobSource(new Blob([Uint8Array.from(bytes).buffer]))
  return { name, size: bytes.length, source, read: async () => { throw new Error('Unexpected whole distribution read') } }
}

for (const adjusted of [false, true]) for (const large of [false, true])
  test(`self-extracting ${large ? 'ZIP64' : 'ZIP'} with ${adjusted ? 'adjusted' : 'archive-relative'} offsets opens and reopens the inner XP3`, async (t) => {
    const bytes = release(adjusted, large), file = physical('Release.EXE', bytes)
    const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
    const expected = { directory: 'Game/data.xp3>', executableDirectory: 'Game/', distribution: 'Release.EXE' }
    if (!large) assert.equal(bytes.indexOf(game) % 16, 0)
    const reads: number[] = [], source = file.source!
    const outer = { ...file, source: { ...source, size: source.size,
      read: (at: number, count: number) => { reads.push(count); return source.read(at, count) },
      borrowBlob: source.borrowBlob?.bind(source),
    } }
    assert.equal(await reader.probeXp3(outer, step), false, 'A stored XP3 belongs to its ZIP entry')
    const result = await prepareProject([outer], { mode: 'auto' }, reader, step)
    assert.deepEqual(result.project, expected)
    const data = result.resources.find((item) => item.name === 'Game/data.xp3')!
    const inner = await reader.open(data, step)
    assert.equal(Buffer.from(await inner!.entries[0]!.read()).toString(), 'var chapter=7;')
    const view = await data.source!.borrowBlob!(1, 12, step)
    assert.deepEqual(Buffer.from(await view.arrayBuffer()), game.subarray(1, 13))
    const replay = await prepareProject([outer], { mode: 'root', ...expected }, reader, step)
    assert.deepEqual(replay.project, expected)
    assert.equal(Buffer.from(await replay.resources.find((f) => f.name.endsWith('manual.txt'))!.read()).toString(), 'chapter 7')
    assert(Math.max(...reads) <= 65557, 'No full executable or linear native signature scan')
    const collection = await importSources([{ path: outer.name, source: outer.source }], step)
    assert.equal(collection.find((item) => item.name === 'Release.EXE')?.archiveKind, 'zip')
    assert.deepEqual(Buffer.from(await collection.find((item) => item.name === 'Release.EXE>Game/data.xp3')!.read()), game)
  })

test('package selection keeps loose games first and can select one of two installers by path', async (t) => {
  const bytes = release(false, false), first = physical('A/play.exe', bytes), second = physical('B/play.exe', bytes)
  const loose = physical('data/startup.tjs', Buffer.from('loose')), note = physical('readme.txt', Buffer.from('setup'))
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const mount = (files: Resource[], executable?: string) => prepareProject(files, { mode: 'auto', executable }, reader, step)
  assert.deepEqual((await mount([first, loose])).project, { directory: 'data/', executableDirectory: '' })
  assert.equal((await mount([first, note])).project?.distribution, first.name)
  await assert.rejects(mount([first, second, note]), /多个自解压 ZIP/)
  assert.equal((await mount([first, second, note], 'B/play.exe')).project?.distribution, second.name)
  const variant = physical('A/PLAY.exe', bytes)
  assert.equal((await mount([first, variant], 'A/PLAY.exe')).project?.distribution, variant.name)
  await assert.rejects(mount([first, variant], 'A/Play.exe'), /Ambiguous executable/)
  const parts = [physical('book.exe.002', bytes.subarray(prefixLength + 87)), physical('book.exe.001', bytes.subarray(0, prefixLength + 87))]
  const files = await importSources(parts.map((p) => ({ path: p.name, source: p.source! })), step, { lazyArchives: true })
  assert.equal((await mount(files)).project?.distribution, 'book.exe')
})

test('relative ZIP64 locator handles an extensible end record and preserves local record verification', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const original = zipFixture('optional-zip64.zip'), locator = original.length - 22 - 20
  const at = Number(original.readBigUInt64LE(locator + 8)), extra = Buffer.alloc(70000)
  const extended = Buffer.concat([original.subarray(0, locator), extra, original.subarray(locator)])
  extended.writeBigUInt64LE(original.readBigUInt64LE(at + 4) + BigInt(extra.length), at + 4)
  const prefix = Buffer.alloc(100000); prefix.write('MZ')
  const archive = await reader.open(physical('Edition.exe', Buffer.concat([prefix, extended])), step)
  const entry = archive!.entries.find((file) => file.name === 'startup.tjs')!
  const baseline = await reader.open(physical('Edition.zip', original), step)
  assert.deepEqual(await entry.read(), await baseline!.entries.find((file) => file.name === entry.name)!.read())
  const classic = zipFixture(), slot = centralRecords(classic).records.find((file) => file.name === 'startup.tjs')!
  classic[slot.local] = 0
  const broken = await reader.open(physical('Edition.exe', Buffer.concat([prefix, classic])), step)
  await assert.rejects(broken!.entries.find((file) => file.name === 'startup.tjs')!.read(), /Invalid ZIP local header/)
})

test('optional ZIP64 end records identify the first central entry when classic offsets also fit', async (t) => {
  const firstName = 'a'.repeat(26) + '.tjs'
  const zip = distributionZip([member(firstName, 'first'), member('startup.tjs', 'second')])
  const { end, central } = centralRecords(zip), wide = Buffer.alloc(56), locator = Buffer.alloc(20)
  // A 76-byte central record equals the space occupied by the ZIP64 end
  // and locator. Looking only at the classic fields would select entry two.
  wide.writeUInt32LE(0x06064b50, 0); wide.writeBigUInt64LE(44n, 4)
  wide.writeUInt16LE(45, 12); wide.writeUInt16LE(45, 14)
  wide.writeBigUInt64LE(2n, 24); wide.writeBigUInt64LE(2n, 32)
  wide.writeBigUInt64LE(BigInt(end - central), 40); wide.writeBigUInt64LE(BigInt(central), 48)
  locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(end), 8); locator.writeUInt32LE(1, 16)
  const prefix = Buffer.alloc(320); prefix.write('MZ')
  const bytes = Buffer.concat([prefix, zip.subarray(0, end), wide, locator, zip.subarray(end)])
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const opened = await reader.open(physical('TwoScripts.exe', bytes), step)
  assert.deepEqual(opened!.entries.map((entry) => entry.name), [firstName, 'startup.tjs'])
  assert.equal(Buffer.from(await opened!.entries[0]!.read()).toString(), 'first')
})

test('a ZIP-shaped byte sequence inside an installer comment cannot replace the located game directory', async (t) => {
  const zip = distributionZip([member('startup.tjs', 'chapter')])
  const fake = Buffer.alloc(22, 255)
  fake.writeUInt32LE(0x06054b50); fake.writeUInt16LE(0, 20)
  zip.writeUInt16LE(fake.length, zip.length - 2)
  const prefix = Buffer.from('MZ game installer')
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const wrapped = await reader.open(physical('Story.exe', Buffer.concat([prefix, zip, fake])), step)
  assert.equal(Buffer.from(await wrapped!.entries[0]!.read()).toString(), 'chapter')
})
