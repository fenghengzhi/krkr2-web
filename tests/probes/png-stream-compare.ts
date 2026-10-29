// Hosted differential: independent C destination bytes are the oracle. Never
// predict how many rows a malformed stream should publish from its filename.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ImageZlibKernel } from '../../src/backends/image-zlib/kernel.ts'
import { validateImageZlibManifest, type ImageZlibFactory, type ImageZlibManifest } from '../../src/backends/image-zlib/module.ts'
import type { DecodedImage } from '../../src/engine/ports/graphics.ts'
import type { ImageInflater } from '../../src/engine/ports/image-inflater.ts'
import { prepareSelectedPngStream, type PngStreamPlan } from '../../src/formats/image/png.ts'
import { PngStreamReadError } from '../../src/formats/image/png-pull.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../../src/formats/image/selection.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const reference = resolve(process.argv[2] ?? 'out/verification/native-png'),
  output = resolve(process.argv[3] ?? 'out/verification/png-stream-comparison'),
  generated = resolve('.generated/image-zlib'),
  hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex'),
  file = (directory: string, name: string) => {
    const path = resolve(directory, name)
    assert(path.startsWith(directory + sep), 'Artifact path escaped its directory')
    return path
  },
  json = <T>(directory: string, name: string): T => JSON.parse(readFileSync(file(directory, name), 'utf8')) as T,
  save = (name: string, value: unknown) => writeFileSync(file(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

interface HashEntry { bytes: number; sha256: string }
interface Fixture {
  id: string; path: string; bytes: number; sha256: string; streamReference?: boolean
  width: number; height: number; definition: { control?: boolean }
}
interface Snapshot {
  id: number; row: number; rowsComplete: number; phase: string; event: string; bgra: number[]
}
interface ReadObservation { offset: number; requested: number; actual: number; phase: string }
interface NativeRecord {
  schema: number; status: string; sizeCallback: boolean; width: number; height: number
  rowsComplete: number; decodeComplete: boolean; rgba: number[]
  destination: { initialByte: number; rgba: number[] } | null
  destinationSnapshots: Snapshot[]; reads: ReadObservation[]
  error: { phase: string; kind: string; message: string } | null
}
interface ReferenceResult {
  id: string; inputSha256: string; exitCode: number; classification: string; mismatches: string[]
  record: NativeRecord
}
interface ObservedError {
  name: string; message: string; stack?: string; kind: string
  reason?: string; format?: string; offset?: number; requested?: number; actual?: number
}
interface RowEvent { kind: 'write' | 'row'; y: number; rowsComplete: number; rgba: number[] }
interface Actual {
  sizeCalls: number; width: number; height: number; rowsComplete: number
  phase: string; complete: boolean; destination: number[]; completedPrefix: number[]
  events: RowEvent[]; image?: number[]; error?: ObservedError; cleanupErrors: ObservedError[]
  kernel?: ReturnType<ImageZlibKernel['inspect']>
}
function errorRecord(error: unknown): ObservedError {
  const detail = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'ThrownValue', message: String(error) }
  if (error instanceof PngStreamReadError) return { ...detail, kind: 'stream-short-read',
    offset: error.offset, requested: error.requested, actual: error.actual }
  if (error instanceof ImageDecodeError) return { ...detail, kind: 'libpng', format: error.format, reason: error.reason }
  return { ...detail, kind: 'unexpected' }
}
function finish<T>(work: Generator<void, T>): T {
  for (let step = 0; step < 100_000; step++) {
    const next = work.next(); if (next.done) return next.value
  }
  throw new Error('PNG fixture exceeded its 100000 cooperative-step bound')
}
function rgba(bgra: readonly number[]): number[] {
  assert.equal(bgra.length % 4, 0)
  const result = new Array<number>(bgra.length)
  for (let at = 0; at < bgra.length; at += 4) {
    result[at] = bgra[at + 2]!; result[at + 1] = bgra[at + 1]!
    result[at + 2] = bgra[at]!; result[at + 3] = bgra[at + 3]!
  }
  return result
}
function observe(bytes: Uint8Array, kernel: ImageZlibKernel): Actual {
  const actual: Actual = { sizeCalls: 0, width: 0, height: 0, rowsComplete: 0, phase: 'read_info',
    complete: false, destination: [], completedPrefix: [], events: [], cleanupErrors: [] }
  let destination = new Uint8Array(0), plan: PngStreamPlan | undefined, inflater: ImageInflater | undefined
  const snapshot = (kind: RowEvent['kind'], y: number) => {
    assert(actual.events.length < 128, 'Unexpectedly unbounded row publication')
    actual.events.push({ kind, y, rowsComplete: actual.rowsComplete, rgba: [...destination] })
  }, copy = (y: number, row: Uint8Array) => {
    assert.equal(actual.sizeCalls, 1)
    assert(Number.isInteger(y) && y >= 0 && y < actual.height)
    assert.equal(row.length, actual.width * 4)
    destination.set(row, y * actual.width * 4)
  }, progress: ImageDecodeProgress = {
    size(width, height) {
      actual.sizeCalls++; assert.equal(actual.sizeCalls, 1)
      assert(Number.isInteger(width) && width > 0 && width <= 32)
      assert(Number.isInteger(height) && height > 0 && height <= 32)
      actual.width = width; actual.height = height
      destination = new Uint8Array(width * height * 4).fill(165)
    },
    write(y, row) { copy(y, row); snapshot('write', y) },
    row(y, row) {
      assert.equal(y, actual.rowsComplete, 'Completed rows must publish in native order')
      copy(y, row); actual.rowsComplete++; snapshot('row', y)
    },
  }
  try {
    plan = finish(prepareSelectedPngStream(bytes, 'normal', progress))
    inflater = kernel.open()
    const image: DecodedImage = finish(plan.decode(inflater))
    actual.complete = true; actual.image = [...image.data]
  } catch (error) {
    actual.error = errorRecord(error)
  } finally {
    actual.phase = plan?.phase ?? 'read_info'
    actual.destination = [...destination]
    actual.completedPrefix = [...destination.subarray(0, actual.rowsComplete * actual.width * 4)]
    try { inflater?.close() } catch (error) { actual.cleanupErrors.push(errorRecord(error)) }
    try {
      actual.kernel = kernel.inspect()
      assert.equal(actual.kernel.active, 0); assert.equal(actual.kernel.allocatedBytes, 0)
    } catch (error) { actual.cleanupErrors.push(errorRecord(error)) }
  }
  return actual
}
function compare(expected: NativeRecord, actual: Actual): string[] {
  const failures: string[] = [], check = (name: string, work: () => void) => {
    try { work() } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))) }
  }
  check('size callback', () => {
    assert.equal(actual.sizeCalls, expected.sizeCallback ? 1 : 0)
    assert.equal(actual.width, expected.width); assert.equal(actual.height, expected.height)
  })
  check('raw destination', () => {
    assert.equal(expected.destination?.initialByte, 165)
    assert.deepEqual(actual.destination, expected.destination?.rgba)
  })
  check('row completion', () => {
    assert.equal(actual.rowsComplete, expected.rowsComplete)
    assert.deepEqual(actual.completedPrefix, expected.rgba)
  })
  check('completed row snapshots', () => {
    const nativeRows = expected.destinationSnapshots.filter((event) =>
      event.event === 'row-complete' || event.event === 'interlace-row-published')
      .map((event) => ({ y: event.row, rowsComplete: event.rowsComplete, rgba: rgba(event.bgra) })),
      webRows = actual.events.filter((event) => event.kind === 'row')
        .map(({ y, rowsComplete, rgba }) => ({ y, rowsComplete, rgba }))
    assert.deepEqual(webRows, nativeRows)
  })
  check('outcome', () => {
    assert.equal(actual.complete, expected.decodeComplete)
    assert.equal(actual.complete, expected.status === 'complete')
    if (expected.error) {
      assert(actual.error, 'Missing expected native error')
      assert.equal(actual.phase, expected.error.phase)
      assert.equal(actual.error.kind, expected.error.kind)
      if (expected.error.kind === 'libpng') {
        assert.equal(actual.error.format, 'png')
        assert.equal(actual.error.reason, expected.error.message)
      } else {
        assert.equal(expected.error.kind, 'stream-short-read')
        const read = expected.reads[expected.reads.length - 1]
        assert(read && read.actual < read.requested)
        assert.equal(actual.error.offset, read.offset)
        assert.equal(actual.error.requested, read.requested)
        assert.equal(actual.error.actual, read.actual)
      }
    } else {
      assert.equal(actual.error, undefined); assert.equal(actual.phase, 'complete')
      assert.deepEqual(actual.image, expected.destination?.rgba)
    }
  })
  check('cleanup', () => assert.deepEqual(actual.cleanupErrors, []))
  return failures
}

mkdirSync(output, { recursive: true })
let kernel: ImageZlibKernel | undefined
const results: { id: string; status: string; failures: string[] }[] = [], errors: ObservedError[] = []
let planned = 0, sourceVerified = false
try {
  const environment = json<{ commit: string }>(reference, 'environment.json'),
    manifest = json<ImageZlibManifest>(generated, 'manifest.json'),
    source = json<{ archiveSha512: string; files: Record<string, HashEntry> }>(reference, 'zlib-source.json'),
    fixtures = json<Fixture[]>(reference, 'case-manifest.json').filter((item) => item.streamReference),
    summary = json<{ failures: string[]; planned: number; reported: number; streamReferences: number;
      previousReferencePlanned: number; paletteReferencePlanned: number; paletteReferences: number }>(reference, 'summary.json')
  planned = fixtures.length
  assert.equal(environment.commit, process.env.GITHUB_SHA, 'Reference belongs to a different source revision')
  assert.equal(planned, 30); assert.equal(new Set(fixtures.map((item) => item.id)).size, planned)
  assert.equal(fixtures.filter((item) => item.definition.control).length, 9)
  assert.equal(summary.planned, 107); assert.equal(summary.reported, 107)
  assert.equal(summary.previousReferencePlanned, 77)
  assert.equal(summary.paletteReferencePlanned, 30); assert.equal(summary.paletteReferences, 30)
  assert.deepEqual(summary.failures, []); assert.equal(summary.streamReferences, 30)
  validateImageZlibManifest(manifest)
  assert.equal(source.archiveSha512, manifest.source.archiveSha512)
  const sameSource: Record<string, HashEntry> = {}
  for (const [name, original] of Object.entries(source.files)) {
    if (!name.endsWith('.c') && (!name.endsWith('.h') || name === 'zconf.h')) continue
    assert.deepEqual(manifest.source.files[name], original, 'Native/WASM source mismatch: ' + name)
    sameSource[name] = original
  }
  assert(sameSource['inflate.c'] && sameSource['zlib.h'] && source.files['zconf.h'] && manifest.source.files['zconf.h'])
  const assets = Object.fromEntries((['mjs', 'wasm'] as const).map((kind) => {
    const entry = manifest.assets[kind], bytes = readFileSync(file(generated, entry.file))
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256)
    return [kind, bytes]
  })) as Record<'mjs' | 'wasm', Buffer>
  sourceVerified = true
  save('source-comparison.json', { sourceVerified, sourceCommit: environment.commit,
    archiveSha512: source.archiveSha512, sameSource,
    nativeConfiguration: source.files['zconf.h'], wasmConfiguration: manifest.source.files['zconf.h'],
    scope: 'Same zlib C/header source; native gcc -m32 archive zconf.h and Emscripten port zconf.h differ intentionally. This is not original deelibpng binary equivalence.',
    manifestSha256: hash(readFileSync(file(generated, 'manifest.json'))),
    nativeManifestSha256: hash(readFileSync(file(reference, 'zlib-source.json'))) })
  const imported = await import(pathToFileURL(file(generated, manifest.assets.mjs.file)).href) as { default: ImageZlibFactory }
  kernel = new ImageZlibKernel(await imported.default({ wasmBinary: new Uint8Array(assets.wasm) }))
  for (const fixture of fixtures) {
    const row = { id: fixture.id, status: 'uncompared', failures: [] as string[] }
    results.push(row)
    try {
      assert(/^stream-[a-z0-9-]+$/.test(fixture.id), 'Invalid retained fixture ID')
      const bytes = readFileSync(file(reference, fixture.path)),
        native = json<ReferenceResult>(reference, 'raw/' + fixture.id + '.json')
      assert.equal(bytes.length, fixture.bytes); assert.equal(hash(bytes), fixture.sha256)
      assert.equal(native.id, fixture.id); assert.equal(native.inputSha256, fixture.sha256)
      assert.equal(native.classification, 'stream-reference-observed'); assert.equal(native.exitCode, 0)
      assert.deepEqual(native.mismatches, []); assert.equal(native.record.schema, 2)
      const actual = observe(bytes, kernel), failures = compare(native.record, actual)
      row.failures = failures; row.status = failures.length ? 'mismatched' : 'matched'
      save(fixture.id + '.json', { id: fixture.id, inputSha256: fixture.sha256, status: row.status, failures,
        nativeRecordSha256: hash(readFileSync(file(reference, 'raw/' + fixture.id + '.json'))), actual })
    } catch (error) {
      row.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
      row.status = 'uncompared'
      save(fixture.id + '-driver-error.json', { id: fixture.id, error: errorRecord(error) })
    }
  }
} catch (error) {
  errors.push(errorRecord(error))
} finally {
  try { kernel?.dispose() } catch (error) { errors.push(errorRecord(error)) }
  try {
    if (kernel) { assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0) }
  } catch (error) { errors.push(errorRecord(error)) }
  const failed = !sourceVerified || planned !== 30 || results.length !== planned || errors.length > 0 ||
    results.some((result) => result.status !== 'matched')
  save('summary.json', { schema: 1, status: failed ? 'failed' : 'passed', planned, reported: results.length,
    matched: results.filter((result) => result.status === 'matched').length,
    sourceVerified, results, errors, sourceCommit: process.env.GITHUB_SHA,
    scope: '30 independent normal-main PNG references: full sentinel destination and every completed row snapshot, completion count, exact codec reason or structured short-read, phase, cleanup. Mask temporary/manual palette-gray are outside this reference.' })
  if (failed) process.exitCode = 1
}
