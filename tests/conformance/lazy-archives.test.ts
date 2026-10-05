import test from 'node:test'
import assert from 'node:assert/strict'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { StorageArchives } from '../../src/engine/storage/archives.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { archiveReader } from '../../src/backends/files/archive-reader.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { selectProjectLazy } from '../../src/engine/storage/project.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import type { ArchiveReader, Resource } from '../../src/engine/ports/storage.ts'
import { malformedXp3 } from '../helpers/lazy-archives.ts'
const bytesResource = (name: string, value: Uint8Array = new Uint8Array([1])): Resource => {
  const source = new BlobSource(new Blob([Uint8Array.from(value).buffer]))
  return { name, size: value.length, cacheToken: {}, source, read: () => source.read(0, source.size) }
}
const archive = (name: string, entries: Record<string, string> = { 'value.tjs': '42' }) => bytesResource(name, xp3Fixture(entries).bytes)
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes }); return { promise, resolve } }

test('lazy import/project selection publish raw containers without reading any index or lower-priority malformed package', async () => {
  let reads = 0
  const source = { size: malformedXp3.length, async read(offset: number, length: number) { reads++; return malformedXp3.slice(offset, offset + length) } },
    files = await importSources([{ path: 'data.xp3', source }, { path: 'content-data/startup.tjs', source }], async () => {}, { lazyArchives: true })
  assert.equal(reads, 0)
  assert.equal(files.length, 2)
  assert.deepEqual(await selectProjectLazy(files, { mode: 'auto' }, archiveReader, async () => {}),
    { directory: 'content-data/', executableDirectory: '' })
  assert.equal(reads, 0)
  assert.deepEqual(await selectProjectLazy(files.slice(0, 1), { mode: 'auto' }, archiveReader, async () => {}),
    { directory: 'data.xp3>', executableDirectory: '' }, 'Selected bad archive fails on access, not selection fallback')
  assert.equal(reads, 0)
})

test('raw exists and direct hits avoid archive IO; first AutoPath miss rebuilds all paths in registration order', async () => {
  const opened: string[] = [], reader: ArchiveReader = { ...archiveReader,
    async open(resource, checkpoint) { opened.push(resource.name); return archiveReader.open(resource, checkpoint) } },
    resolver = new StorageResolver('', false, reader)
  resolver.mount([bytesResource('direct.tjs'), bytesResource('bad.xp3', malformedXp3), archive('good.xp3')])
  assert.equal((await resolver.lookupAsync('bad.xp3'))?.name, 'bad.xp3')
  resolver.addAutoPath('bad.xp3>'); resolver.addAutoPath('good.xp3>')
  assert.equal((await resolver.lookupAsync('direct.tjs'))?.name, 'direct.tjs')
  assert.deepEqual(opened, [])
  await assert.rejects(resolver.lookupAsync('value.tjs'), /Unsupported XP3 index compression: 7/)
  assert.deepEqual([...opened], ['bad.xp3'])
  await assert.rejects(resolver.lookupAsync('value.tjs'), /Unsupported XP3 index compression: 7/)
  assert.deepEqual([...opened], ['bad.xp3', 'bad.xp3'], 'Failed index is retried, never cached as missing')
  resolver.removeAutoPath('bad.xp3>')
  assert.equal((await resolver.lookupAsync('value.tjs'))?.name, 'good.xp3>value.tjs')
  assert.deepEqual([...opened], ['bad.xp3', 'bad.xp3', 'good.xp3'])
  resolver.dispose()
})

test('64-success LRU really releases resolver member inventory while held immutable readers can finish', async () => {
  const opened = new Map<string, number>(), reader: ArchiveReader = { ...archiveReader,
    async open(resource, checkpoint) { opened.set(resource.name, (opened.get(resource.name) ?? 0) + 1); return archiveReader.open(resource, checkpoint) } },
    resolver = new StorageResolver('', false, reader)
  resolver.mount(Array.from({ length: 65 }, (_, index) => archive(`${index}.xp3`)))
  const first = await resolver.findAsync('0.xp3>value.tjs')
  for (let index = 1; index < 65; index++) await resolver.findAsync(`${index}.xp3>value.tjs`)
  assert.equal(resolver.knownResources().filter((resource) => resource.name.includes('>')).length, 64)
  assert.equal(resolver.knownResources().some((resource) => resource.name === '0.xp3>value.tjs'), false)
  assert.equal(new TextDecoder().decode(await first!.read()), '42')
  const fresh = await resolver.findAsync('0.xp3>value.tjs')
  assert.equal(opened.get('0.xp3'), 2)
  assert.notEqual(first!.cacheToken, fresh!.cacheToken)
  assert.equal(resolver.knownResources().filter((resource) => resource.name.includes('>')).length, 64)
  resolver.dispose()
})

test('same-container opens share one parser and probes share its bounded execution slot', { timeout: 30000 }, async () => {
  const entered = gate(), release = gate(), trace: string[] = [], reader: ArchiveReader = {
    probeXp3: async () => false,
    async open(resource) { trace.push('open:' + resource.name); entered.resolve(); await release.promise; return { kind: 'xp3', entries: [bytesResource('x')] } },
    async probeArchive(resource) { trace.push('probe:' + resource.name); return true },
  }, registry = new StorageArchives(reader, async () => {}, () => ({ entries: 250000, units: 16 * 1024 * 1024 })),
    raw = bytesResource('a.xp3'), a = registry.open(raw), b = registry.open(raw)
  try {
    await entered.promise
    const probing = registry.candidate(bytesResource('unknown.data'))
    await Promise.resolve()
    assert.deepEqual(trace, ['open:a.xp3'])
    release.resolve()
    const [first, second] = await Promise.all([a, b])
    assert.equal(first, second)
    assert.equal(await probing, true)
    assert.deepEqual([...trace], ['open:a.xp3', 'probe:unknown.data'])
  } finally { release.resolve(); registry.dispose(); await Promise.allSettled([a, b]) }
})

test('Stop rejects opening and queued waiters before actual IO completes and ignores the late index', { timeout: 30000 }, async () => {
  const entered = gate(), release = gate(), reader: ArchiveReader = { probeXp3: async () => false,
    async open() { entered.resolve(); await release.promise; return { kind: 'xp3', entries: [bytesResource('x')] } } },
    registry = new StorageArchives(reader, async () => {}, () => ({ entries: 250000, units: 16 * 1024 * 1024 })),
    opening = registry.open(bytesResource('first.xp3')),
    rejected = assert.rejects(opening, /disposed/)
  try {
    await entered.promise
    const queued = registry.open(bytesResource('second.xp3')), rejectedQueue = assert.rejects(queued, /disposed/)
    await Promise.resolve(); registry.dispose()
    await Promise.all([rejected, rejectedQueue])
    assert.deepEqual(registry.known(), [])
    release.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.deepEqual(registry.known(), [])
  } finally { release.resolve(); registry.dispose(); await rejected }
})

test('directory discovery probes unusual suffixes but opens only the entered archive and preserves canonical case', async () => {
  const opened: string[] = [], reader: ArchiveReader = { ...archiveReader,
    async open(resource, checkpoint) { opened.push(resource.name); return archiveReader.open(resource, checkpoint) } },
    resolver = new StorageResolver('', false, reader)
  resolver.mount([archive('Bundle.data', { 'Scene/first.tjs': '42' }), bytesResource('bad.xp3', malformedXp3)])
  const root = await resolver.listDirectory('')
  assert(root.directories.includes('Bundle.data>')); assert(root.directories.includes('bad.xp3>'))
  assert.deepEqual(opened, [])
  const folder = await resolver.listDirectory('bundle.data>scene/')
  assert.equal(folder.name, 'Bundle.data>Scene/')
  assert.deepEqual(folder.entries.map((entry) => entry.name), ['Bundle.data>Scene/first.tjs'])
  assert.deepEqual([...opened], ['Bundle.data'])
  await assert.rejects(resolver.listDirectory('bad.xp3>'), /Unsupported XP3 index compression: 7/)
  await assert.rejects(resolver.listDirectory('Bundle.data>absent/'), /Storage directory not found/)
  resolver.mount([bytesResource('Foo/a'), bytesResource('foo/b')])
  const saved = bytesResource('FOo/new.sav'), exact = await resolver.listDirectory('FOo/', [saved])
  assert.equal(exact.name, 'FOo/')
  assert.deepEqual(exact.entries.map((entry) => entry.name), ['FOo/new.sav'])
  resolver.dispose()
})

test('new overlay files join rebuilt AutoPath tables and raw replacement retires the previous immutable index', async () => {
  const resolver = new StorageResolver('', false, archiveReader), saved = new Map<string, Resource>(),
    lookup = (name: string) => saved.get(name)
  resolver.mount([archive('data.xp3', { 'value.tjs': '"old"' })])
  resolver.addAutoPath('slots/')
  assert.equal(await resolver.lookupAsync('save.tjs', lookup, [...saved.values()]), undefined)
  saved.set('slots/save.tjs', bytesResource('slots/save.tjs')); resolver.invalidateSearch()
  assert.equal((await resolver.lookupAsync('save.tjs', lookup, [...saved.values()]))?.name, 'slots/save.tjs')
  const old = await resolver.findAsync('data.xp3>value.tjs', lookup)
  saved.set('data.xp3', archive('data.xp3', { 'value.tjs': '"new"' })); resolver.invalidateSearch()
  const next = await resolver.findAsync('data.xp3>value.tjs', lookup)
  assert.equal(new TextDecoder().decode(await old!.read()), '"old"')
  assert.equal(new TextDecoder().decode(await next!.read()), '"new"')
  assert.notEqual(old!.cacheToken, next!.cacheToken)
  resolver.dispose()
})

test('collection aliases remain an explicit final fallback, never a way to bypass registered bad packages', async () => {
  const resolver = new StorageResolver('', true, archiveReader)
  resolver.mount([archive('data.xp3'), bytesResource('loose.tjs')])
  assert.equal((await resolver.lookupAsync('loose.tjs'))?.name, 'loose.tjs')
  assert.equal((await resolver.lookupAsync('value.tjs'))?.name, 'data.xp3>value.tjs')
  resolver.mount([bytesResource('bad.xp3', malformedXp3)])
  resolver.addAutoPath('bad.xp3>')
  await assert.rejects(resolver.lookupAsync('value.tjs'), /Unsupported XP3 index compression: 7/)
  resolver.dispose()
})
