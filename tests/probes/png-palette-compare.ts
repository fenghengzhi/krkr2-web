// Hosted comparison against the independent C caller destination, including
// explicit exclusion of the original unwritten tail in packed-key rows.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ImageZlibKernel } from '../../src/backends/image-zlib/kernel.ts'
import { validateImageZlibManifest, type ImageZlibFactory, type ImageZlibManifest } from '../../src/backends/image-zlib/module.ts'
import type { ImageInflater } from '../../src/engine/ports/image-inflater.ts'
import { prepareSelectedPngStream, type PngStreamPlan } from '../../src/formats/image/png.ts'
import { PngStreamReadError } from '../../src/formats/image/png-pull.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../../src/formats/image/selection.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const reference = resolve(process.argv[2] ?? 'out/verification/native-png'),
  output = resolve(process.argv[3] ?? 'out/verification/png-palette-comparison'),
  generated = resolve('.generated/image-zlib'),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  file = (directory: string, name: string) => {
    const value = resolve(directory, name)
    assert(value.startsWith(directory + sep), 'Artifact path escaped its directory')
    return value
  }, json = <T>(directory: string, name: string): T => JSON.parse(readFileSync(file(directory, name), 'utf8')) as T,
  save = (name: string, value: unknown) => writeFileSync(file(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
interface HashEntry { bytes: number; sha256: string }
interface Fixture {
  id: string; path: string; bytes: number; sha256: string; paletteReference?: boolean
  width: number; height: number; mode: 'normal' | 'grayscale'; keyidx: number
  destinationStride: number; comparisonPrefixBytes: number; prefixOnly: boolean
  definition: { control?: boolean; trns?: boolean; interlace?: boolean }
}
interface NativeRecord {
  schema: number; paletteReference: boolean; mode: string; keyidx: number; status: string
  width: number; height: number; sizeCallback: boolean; rowsComplete: number; decodeComplete: boolean
  destination: { initialByte: number; pixelBytes: number; rowStride: number; comparisonPrefixBytes: number
    excludedTailBytesPerRow: number; bytes: number[]; comparisonMask: number[] }
  destinationSnapshots: { event: string; row: number; rowsComplete: number; bytes: number[] }[]
  reads: { offset: number; requested: number; actual: number }[]
  error: { kind: string; phase: string; message: string } | null
}
interface NativeResult {
  id: string; inputSha256: string; exitCode: number; classification: string; mismatches: string[]; record: NativeRecord
}
interface Failure { name: string; message: string; stack?: string; kind: string
  reason?: string; offset?: number; requested?: number; actual?: number }
interface RowEvent { kind: 'write' | 'row'; phase: string; y: number; rowsComplete: number; bytes: number[] }
interface Actual {
  sizes: number; width: number; height: number; complete: boolean; phase: string; rowsComplete: number
  bytes: number[]; image?: number[]; events: RowEvent[]; error?: Failure; cleanup: Failure[]
  zeroTailChecks: number; zeroTailPolicyFailures: string[]
}
function failure(error: unknown): Failure {
  const record = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'ThrownValue', message: String(error) }
  if (error instanceof PngStreamReadError) return { ...record, kind: 'stream-short-read',
    offset: error.offset, requested: error.requested, actual: error.actual }
  if (error instanceof ImageDecodeError) return { ...record, kind: 'libpng', reason: error.reason }
  return { ...record, kind: 'unexpected' }
}
function finish<T>(work: Generator<void, T>): T {
  for (let count = 0; count < 100000; count++) { const next = work.next(); if (next.done) return next.value }
  throw new Error('Palette fixture exceeded its cooperative step budget')
}
function physical(row: Uint8Array, mode: Fixture['mode']): Uint8Array {
  assert.equal(row.length % 4, 0)
  const bytes = new Uint8Array(mode === 'normal' ? row.length : row.length / 4)
  for (let at = 0; at < row.length; at += 4) {
    if (mode === 'normal') bytes.set([row[at + 2]!, row[at + 1]!, row[at]!, row[at + 3]!], at)
    else {
      assert.deepEqual([...row.subarray(at, at + 4)], [row[at], row[at], row[at], 255])
      bytes[at / 4] = row[at]!
    }
  }
  return bytes
}
function observe(fixture: Fixture, input: Uint8Array, kernel: ImageZlibKernel): Actual {
  const actual: Actual = { sizes: 0, width: 0, height: 0, complete: false, phase: 'read_info', rowsComplete: 0,
    bytes: [], events: [], cleanup: [], zeroTailChecks: 0, zeroTailPolicyFailures: [] }
  let destination = new Uint8Array(0), plan: PngStreamPlan | undefined, stream: ImageInflater | undefined
  const policy = (bytes: Uint8Array, y: number) => {
    if (!fixture.prefixOnly) return
    actual.zeroTailChecks++
    if (!bytes.subarray(fixture.comparisonPrefixBytes).every((value) => value === 0))
      actual.zeroTailPolicyFailures.push('Web zero-tail policy differed on row ' + y)
  }, copy = (kind: RowEvent['kind'], y: number, row: Uint8Array) => {
    assert.equal(actual.sizes, 1); assert(Number.isInteger(y) && y >= 0 && y < actual.height)
    assert.equal(row.length, actual.width * 4)
    assert(actual.events.length < 128)
    const bytes = physical(row, fixture.mode)
    policy(bytes, y); destination.set(bytes, y * fixture.destinationStride)
    if (kind === 'row') { assert.equal(y, actual.rowsComplete); actual.rowsComplete++ }
    actual.events.push({ kind, phase: plan?.phase ?? 'read_info', y, rowsComplete: actual.rowsComplete, bytes: [...destination] })
  }, progress: ImageDecodeProgress = {
    size(width, height) {
      actual.sizes++; assert.equal(actual.sizes, 1)
      assert.deepEqual([width, height], [fixture.width, fixture.height])
      actual.width = width; actual.height = height
      destination = new Uint8Array(fixture.destinationStride * height).fill(165)
    },
    write(y, row) { copy('write', y, row) }, row(y, row) { copy('row', y, row) },
  }
  try {
    plan = finish(prepareSelectedPngStream(input, fixture.mode, progress, fixture.keyidx < 0 ? undefined : fixture.keyidx))
    stream = kernel.open()
    const image = finish(plan.decode(stream))
    actual.complete = true
    const pixels = physical(image.data, fixture.mode)
    actual.image = [...pixels]
    for (let y = 0; y < fixture.height; y++) policy(pixels.subarray(y * fixture.destinationStride, (y + 1) * fixture.destinationStride), y)
  } catch (error) { actual.error = failure(error) }
  finally {
    actual.phase = plan?.phase ?? 'read_info'; actual.bytes = [...destination]
    try { stream?.close() } catch (error) { actual.cleanup.push(failure(error)) }
    try { assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0) }
    catch (error) { actual.cleanup.push(failure(error)) }
  }
  return actual
}
function compare(fixture: Fixture, expected: NativeRecord, actual: Actual): string[] {
  const errors: string[] = [], check = (name: string, work: () => void) => {
    try { work() } catch (error) { errors.push(name + ': ' + (error instanceof Error ? error.message : String(error))) }
  }, mask = expected.destination.comparisonMask,
    masked = (bytes: readonly number[]) => {
      assert.equal(bytes.length, mask.length)
      return bytes.filter((_byte, at) => mask[at] === 1)
    }
  check('layout and exclusion domain', () => {
    assert.equal(fixture.prefixOnly, fixture.mode === 'normal' && fixture.keyidx >= 0 && !fixture.definition.trns)
    assert.equal(expected.destination.initialByte, 165)
    assert.deepEqual([expected.width, expected.height, expected.destination.rowStride, expected.destination.comparisonPrefixBytes],
      [fixture.width, fixture.height, fixture.destinationStride, fixture.comparisonPrefixBytes])
    assert.deepEqual(mask, Array.from({ length: fixture.destinationStride * fixture.height }, (_, at) =>
      Number(at % fixture.destinationStride < fixture.comparisonPrefixBytes)))
    assert.equal(mask.includes(0), fixture.prefixOnly)
    assert.equal(expected.destination.excludedTailBytesPerRow, fixture.prefixOnly ? fixture.width : 0)
    assert.equal(actual.sizes, 1); assert.equal(actual.width, expected.width); assert.equal(actual.height, expected.height)
  })
  check(fixture.prefixOnly ? 'native defined prefix' : 'full defined destination', () =>
    assert.deepEqual(masked(actual.bytes), masked(expected.destination.bytes)))
  check('completed-row bytes and order', () => {
    const nativeRows = expected.destinationSnapshots.filter((row) => row.event === 'row-complete' || row.event === 'interlace-row-published')
      .map((row) => ({ y: row.row, rowsComplete: row.rowsComplete, bytes: masked(row.bytes) })),
      actualRows = actual.events.filter((row) => row.kind === 'row')
        .map((row) => ({ y: row.y, rowsComplete: row.rowsComplete, bytes: masked(row.bytes) }))
    assert.deepEqual(actualRows, nativeRows); assert.equal(actual.rowsComplete, expected.rowsComplete)
    if (fixture.mode === 'grayscale' && !fixture.definition.interlace)
      assert(!actual.events.some((row) => row.kind === 'write'), 'Manual gray conversion cannot write the caller before read_row returns')
  })
  check('error phase and exact native reason', () => {
    assert.equal(actual.complete, expected.decodeComplete); assert.equal(actual.complete, expected.status === 'complete')
    if (expected.error) {
      assert(actual.error); assert.equal(actual.phase, expected.error.phase)
      assert.equal(actual.error.kind, expected.error.kind)
      if (expected.error.kind === 'libpng') assert.equal(actual.error.reason, expected.error.message)
      else {
        assert.equal(expected.error.kind, 'stream-short-read')
        const read = expected.reads.at(-1)
        assert(read && read.actual < read.requested)
        assert.deepEqual([actual.error.offset, actual.error.requested, actual.error.actual], [read.offset, read.requested, read.actual])
      }
    } else {
      assert.equal(actual.error, undefined); assert.equal(actual.phase, 'complete'); assert(actual.image)
      assert.deepEqual(masked(actual.image), masked(expected.destination.bytes))
    }
  })
  check('separate Web tail policy', () => {
    assert.deepEqual(actual.zeroTailPolicyFailures, [])
    if (fixture.prefixOnly && actual.events.length) assert(actual.zeroTailChecks > 0)
  })
  check('cleanup', () => assert.deepEqual(actual.cleanup, []))
  return errors
}

mkdirSync(output, { recursive: true })
const results: { id: string; status: string; equality: string; errors: string[] }[] = [], errors: Failure[] = []
let kernel: ImageZlibKernel | undefined, planned = 0, sourceVerified = false
try {
  const manifest = json<ImageZlibManifest>(generated, 'manifest.json'),
    nativeSource = json<{ archiveSha512: string; files: Record<string, HashEntry> }>(reference, 'zlib-source.json'),
    environment = json<{ commit: string; probeSha256: string; paletteFixtureSha256: string; paletteManifestSha256: string }>(reference, 'environment.json'),
    inventory = json<Fixture[]>(reference, 'case-manifest.json').filter((entry) => entry.paletteReference),
    summary = json<{ planned: number; reported: number; failures: string[]; previousReferencePlanned: number;
      paletteReferences: number; paletteValidControls: number; streamReferences: number }>(reference, 'summary.json'),
    converter = json<{ source: HashEntry & { file: string }; range: number[]; headerSha256: string }>(reference, 'palette-converter-extract.json')
  planned = inventory.length
  assert.equal(environment.commit, process.env.GITHUB_SHA)
  assert.equal(environment.probeSha256, hash(readFileSync('tests/native/png-reference.c')))
  assert.equal(environment.paletteFixtureSha256, hash(readFileSync('scripts/native_png_palette_fixtures.py')))
  assert.equal(environment.paletteManifestSha256, hash(readFileSync('tests/native/png-palette-cases.json')))
  assert.equal(planned, 30); assert.equal(new Set(inventory.map((entry) => entry.id)).size, 30)
  assert.equal(inventory.filter((entry) => entry.definition.control).length, 20)
  assert.equal(inventory.filter((entry) => entry.prefixOnly).length, 10)
  assert.equal(summary.planned, 107); assert.equal(summary.reported, 107); assert.deepEqual(summary.failures, [])
  assert.equal(summary.previousReferencePlanned, 77); assert.equal(summary.paletteReferences, 30)
  assert.equal(summary.paletteValidControls, 20); assert.equal(summary.streamReferences, 30)
  validateImageZlibManifest(manifest); assert.equal(manifest.source.archiveSha512, nativeSource.archiveSha512)
  const sameSource: Record<string, HashEntry> = {}
  for (const [name, entry] of Object.entries(nativeSource.files)) {
    if (!name.endsWith('.c') && (!name.endsWith('.h') || name === 'zconf.h')) continue
    assert.deepEqual(manifest.source.files[name], entry, 'Native/WASM source differs: ' + name)
    sameSource[name] = entry
  }
  assert(sameSource['inflate.c'] && sameSource['zlib.h'])
  assert.equal(converter.source.file, 'tvpgl.c'); assert.deepEqual(converter.range, [10322, 10343])
  const sourceBytes = readFileSync(file(reference, 'source/tvpgl.c'))
  assert.equal(sourceBytes.length, converter.source.bytes); assert.equal(hash(sourceBytes), converter.source.sha256)
  assert.equal(converter.source.sha256, '8b1075c88883b76e683fd8d57654ce64fcacc5e8ffa9c6f4cf259dc743deefa0')
  assert.equal(hash(readFileSync(file(reference, 'source/palette-converter.h'))), converter.headerSha256)
  for (const kind of ['mjs', 'wasm'] as const) {
    const entry = manifest.assets[kind], bytes = readFileSync(file(generated, entry.file))
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256)
  }
  sourceVerified = true
  save('source-comparison.json', { sourceVerified, sameSource, archiveSha512: nativeSource.archiveSha512,
    nativeConfiguration: nativeSource.files['zconf.h'], wasmConfiguration: manifest.source.files['zconf.h'], converter,
    scope: 'Fixed original converter source and upstream libpng1.0.6 with same-source zlib1.3.2. Target configuration differs; not original deelibpng binary identity.' })
  const imported = await import(pathToFileURL(file(generated, manifest.assets.mjs.file)).href) as { default: ImageZlibFactory }
  kernel = new ImageZlibKernel(await imported.default({ wasmBinary: new Uint8Array(readFileSync(file(generated, manifest.assets.wasm.file))) }))
  for (const fixture of inventory) {
    const row = { id: fixture.id, status: 'uncompared', equality: fixture.prefixOnly ? 'defined-prefix-only' : 'full-defined-output', errors: [] as string[] }
    results.push(row)
    try {
      assert(/^palette-[a-z0-9-]+$/.test(fixture.id))
      const bytes = readFileSync(file(reference, fixture.path)), native = json<NativeResult>(reference, 'raw/' + fixture.id + '.json')
      assert.equal(bytes.length, fixture.bytes); assert.equal(hash(bytes), fixture.sha256)
      assert.equal(native.id, fixture.id); assert.equal(native.inputSha256, fixture.sha256); assert.equal(native.exitCode, 0)
      assert.equal(native.classification, fixture.prefixOnly ? 'palette-prefix-observed' : 'palette-defined-observed')
      assert.deepEqual(native.mismatches, []); assert.equal(native.record.schema, 2)
      assert.equal(native.record.paletteReference, true); assert.equal(native.record.mode, fixture.mode)
      assert.equal(native.record.keyidx, fixture.keyidx)
      const actual = observe(fixture, bytes, kernel)
      row.errors = compare(fixture, native.record, actual); row.status = row.errors.length ? 'mismatched' : 'matched'
      save(fixture.id + '.json', { ...row, inputSha256: fixture.sha256, actual,
        nativeEqualityDomain: row.equality, excludedTailBytesPerRow: native.record.destination.excludedTailBytesPerRow,
        nativeRecordSha256: hash(readFileSync(file(reference, 'raw/' + fixture.id + '.json'))) })
    } catch (error) {
      row.status = 'uncompared'; row.errors.push(error instanceof Error ? error.message : String(error))
      save(fixture.id + '-driver-error.json', failure(error))
    }
  }
} catch (error) { errors.push(failure(error)) }
finally {
  try { kernel?.dispose() } catch (error) { errors.push(failure(error)) }
  try { if (kernel) { assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0) } }
  catch (error) { errors.push(failure(error)) }
  const failed = !sourceVerified || planned !== 30 || results.length !== planned || errors.length > 0 || results.some((entry) => entry.status !== 'matched')
  save('summary.json', { schema: 1, status: failed ? 'failed' : 'passed', planned, reported: results.length, sourceVerified,
    sourceCommit: process.env.GITHUB_SHA, results, errors,
    scope: 'Compare the final destination (including an incomplete raw row), each completed-row destination snapshot, completed count, and exact error phase/reason. Raw-write and native read snapshots remain evidence, not a one-to-one event-sequence comparison. Prefix-only cases exclude the original unwritten tail; Web zero-tail checks are a separate safety policy, not native equality.' })
  if (failed) process.exitCode = 1
}
