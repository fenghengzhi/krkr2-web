// Hosted-only independent fixed-C-caller vs actual WASM JPEG comparison.
// A C warning/recovery observation is not predicted from a fixture filename.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ImageJpegKernel } from '../../src/backends/image-jpeg/kernel.ts'
import { validateImageJpegManifest, type ImageJpegFactory, type ImageJpegManifest } from '../../src/backends/image-jpeg/module.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const reference = resolve(process.argv[2] ?? 'out/verification/native-jpeg'),
  output = resolve(process.argv[3] ?? 'out/verification/jpeg-comparison'),
  generated = resolve('.generated/image-jpeg'),
  sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex'),
  file = (directory: string, name: string) => {
    const path = resolve(directory, name)
    assert(path.startsWith(directory + sep), 'Artifact path escaped its directory')
    return path
  },
  read = <T>(directory: string, name: string): T => JSON.parse(readFileSync(file(directory, name), 'utf8')) as T,
  save = (name: string, value: unknown) => writeFileSync(file(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

interface Hash { bytes: number; sha256: string }
interface Case extends Hash {
  id: string; path: string; mode: 'normal' | 'grayscale'; precision: 'normal' | 'low' | 'high'
  expect: 'complete' | 'codec-error' | 'observed'; width: number | null; height: number | null; constant?: number
}
interface Native {
  schema: number; version: number; status: 'complete' | 'error'; sizeCallback: boolean
  mode: Case['mode']; precision: Case['precision']; width: number; height: number
  rowsComplete: number; destination: number[] | null; destinationSentinel: number
  rows: { y: number; batch: number; bytes: number[] }[]
  batches: { start: number; end: number; requested: number; returned: number; failed: boolean }[]
  warnings: { count: number; lastCode: number }
  error: { kind: string; phase: string; code: number } | null
  originalCleanup: { destroyed: boolean; liveAllocations: number; liveBytes: number; badFrees: number }
}
interface NativeResult { id: string; inputSha256: string; status: string; failures: string[]; record: Native }
interface ErrorRecord { name: string; message: string; stack?: string }
interface Actual {
  status: 'incomplete' | 'complete' | 'codec-error' | 'driver-error'; sizes: number; width: number; height: number
  rowsComplete: number; destination: number[] | null; rows: { y: number; bytes: number[] }[]
  batches: { start: number; end: number; returned: number }[]
  warnings: { count: number; lastCode: number }; phase: string; code?: number
  offeredBytes: number; inputUsed: number; steps: unknown[]; errors: ErrorRecord[]; cleanup: ErrorRecord[]
}
const errorRecord = (error: unknown): ErrorRecord => error instanceof Error
  ? { name: error.name, message: error.message, stack: error.stack } : { name: 'ThrownValue', message: String(error) }

function physical(rgba: Uint8Array, mode: Case['mode']): Uint8Array {
  assert.equal(rgba.length % 4, 0)
  const bytes = new Uint8Array(mode === 'normal' ? rgba.length : rgba.length / 4)
  for (let at = 0; at < rgba.length; at += 4) {
    assert.equal(rgba[at + 3], 255, 'JPEG cannot produce alpha')
    if (mode === 'normal') bytes.set([rgba[at + 2]!, rgba[at + 1]!, rgba[at]!, 255], at)
    else {
      assert.equal(rgba[at], rgba[at + 1]); assert.equal(rgba[at], rgba[at + 2])
      bytes[at / 4] = rgba[at]!
    }
  }
  return bytes
}

function observe(entry: Case, input: Uint8Array, kernel: ImageJpegKernel): Actual {
  const actual: Actual = { status: 'incomplete', sizes: 0, width: 0, height: 0, rowsComplete: 0,
    destination: null, rows: [], batches: [], warnings: { count: 0, lastCode: 0 }, phase: 'header',
    offeredBytes: 0, inputUsed: 0, steps: [], errors: [], cleanup: [] }
  let decoder: ReturnType<ImageJpegKernel['open']> | undefined, needsInput = true,
    at = 0, destination: Uint8Array | undefined
  try {
    decoder = kernel.open(entry.mode, entry.precision)
    for (let count = 0; count < 10000; count++) {
      const offered = needsInput ? input.subarray(at, Math.min(input.length, at + 8192)) : new Uint8Array(),
        step = decoder.step(offered, at + offered.length === input.length)
      assert(Number.isInteger(step.inputUsed) && step.inputUsed >= 0 && step.inputUsed <= offered.length)
      at += step.inputUsed; actual.offeredBytes += offered.length; actual.inputUsed = at
      needsInput = step.needsInput; actual.phase = step.phase
      actual.warnings = { count: step.warnings.count, lastCode: step.warnings.lastCode ?? 0 }
      actual.steps.push({ status: step.status, phase: step.phase, inputUsed: step.inputUsed, needsInput,
        offered: offered.length, offset: at, startRow: step.startRow, rowCount: step.rowCount, warnings: actual.warnings })
      if (step.status === 'size') {
        actual.sizes++; assert.equal(actual.sizes, 1)
        assert(typeof step.width === 'number' && typeof step.height === 'number')
        assert(Number.isInteger(step.width) && Number.isInteger(step.height) && step.width > 0 && step.height > 0)
        actual.width = step.width; actual.height = step.height
        assert.equal(actual.width, entry.width); assert.equal(actual.height, entry.height)
        destination = new Uint8Array(step.width * step.height * (entry.mode === 'normal' ? 4 : 1)).fill(165)
      } else if (step.status === 'rows') {
        assert(destination); assert.equal(actual.sizes, 1)
        const start = step.startRow, count = step.rowCount
        assert(typeof start === 'number' && typeof count === 'number' && Number.isInteger(start) && Number.isInteger(count))
        assert.equal(start, actual.rowsComplete); assert(count > 0 && start + count <= actual.height)
        assert(step.data instanceof Uint8Array); assert.equal(step.data.length, actual.width * count * 4)
        const bytes = physical(step.data, entry.mode), stride = actual.width * (entry.mode === 'normal' ? 4 : 1)
        for (let row = 0; row < count; row++) {
          const slice = bytes.subarray(row * stride, (row + 1) * stride)
          destination.set(slice, (start + row) * stride)
          actual.rows.push({ y: start + row, bytes: [...slice] }); actual.rowsComplete++
        }
        actual.batches.push({ start, end: start + count, returned: count })
      } else if (step.status === 'done') {
        actual.status = 'complete'; break
      } else if (step.status === 'codec-error') {
        assert(typeof step.code === 'number' && Number.isInteger(step.code) && step.code > 0)
        actual.status = 'codec-error'; actual.code = step.code; break
      } else if (step.status === 'budget-error') {
        throw new Error('Product budget error on bounded independent fixture')
      } else assert.equal(step.status, 'progress')
    }
    assert.notEqual(actual.status, 'incomplete', 'JPEG exceeded10000 bounded progress steps')
  } catch (error) { actual.status = 'driver-error'; actual.errors.push(errorRecord(error)) }
  finally {
    actual.destination = destination ? [...destination] : null
    try { decoder?.close() } catch (error) { actual.cleanup.push(errorRecord(error)) }
    try { assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0) }
    catch (error) { actual.cleanup.push(errorRecord(error)) }
  }
  return actual
}

function compare(expected: Native, actual: Actual): string[] {
  const failures: string[] = [], check = (label: string, run: () => void) => {
    try { run() } catch (error) { failures.push(label + ': ' + (error instanceof Error ? error.message : String(error))) }
  }
  check('no driver/kernel budget error', () => assert.deepEqual(actual.errors, []))
  check('size phase', () => {
    assert.equal(actual.sizes, Number(expected.sizeCallback))
    if (expected.sizeCallback) assert.deepEqual([actual.width, actual.height], [expected.width, expected.height])
  })
  check('full defined caller destination', () => assert.deepEqual(actual.destination, expected.destination))
  check('completed rows', () => {
    assert.equal(actual.rowsComplete, expected.rowsComplete)
    assert.deepEqual(actual.rows, expected.rows.map(({ y, bytes }) => ({ y, bytes })))
  })
  check('read_scanlines publication batches', () => assert.deepEqual(actual.batches,
    expected.batches.filter((batch) => !batch.failed).map(({ start, end, returned }) => ({ start, end, returned }))))
  check('warning policy', () => assert.deepEqual(actual.warnings, expected.warnings))
  check('native completion or exact numeric error', () => {
    if (expected.error) {
      assert.equal(expected.error.kind, 'codec'); assert.equal(actual.status, 'codec-error')
      assert.equal(actual.phase, expected.error.phase); assert.equal(actual.code, expected.error.code)
    } else { assert.equal(expected.status, 'complete'); assert.equal(actual.status, 'complete'); assert.equal(actual.phase, 'complete') }
  })
  check('Web cleanup independent of original outside-try leakage', () => assert.deepEqual(actual.cleanup, []))
  return failures
}

mkdirSync(output, { recursive: true })
const results: { id: string; status: string; failures: string[] }[] = [], errors: ErrorRecord[] = []
let kernel: ImageJpegKernel | undefined, sourceVerified = false, planned = 0
try {
  const manifest = read<ImageJpegManifest>(generated, 'manifest.json'),
    environment = read<{ commit: string; probeSha256: string; driverSha256: string; fixtureSourceSha256: string;
      sourceManifestSha256: string; caseManifestSha256: string }>(reference, 'environment.json'),
    effective = read<{ archive: { sha256: string }; files: Record<string, Hash> }>(reference, 'effective-source.json'),
    source = JSON.parse(readFileSync('native/image-jpeg/source.json', 'utf8')) as { decoderSources: string[]; originalHeaders: (Hash & { file: string })[] },
    inventory = read<Case[]>(reference, 'case-manifest.json'),
    summary = read<{ planned: number; reported: number; failures: string[] }>(reference, 'summary.json')
  planned = inventory.length
  assert.equal(environment.commit, process.env.GITHUB_SHA)
  for (const [key, path] of [
    ['probeSha256', 'tests/native/jpeg-reference.c'], ['driverSha256', 'scripts/run-native-jpeg-reference.py'],
    ['fixtureSourceSha256', 'scripts/native_jpeg_fixtures.py'], ['sourceManifestSha256', 'native/image-jpeg/source.json'],
    ['caseManifestSha256', 'tests/native/jpeg-cases.json'],
  ] as const) assert.equal(environment[key], sha(readFileSync(path)))
  assert.equal(planned, 43); assert.equal(new Set(inventory.map((entry) => entry.id)).size, 43)
  assert.equal(summary.planned, 43); assert.equal(summary.reported, 43); assert.deepEqual(summary.failures, [])
  validateImageJpegManifest(manifest)
  assert.equal(manifest.source.kernelSha256, sha(readFileSync('native/image-jpeg/kernel.c')))
  assert.equal(manifest.source.archiveSha256, effective.archive.sha256)
  assert.equal(effective.archive.sha256, '75c3ec241e9996504fe02a9ed4d12f16b74ade713972f3db9e65ce95cd27e35d')
  const sameSource: Record<string, Hash> = {}
  for (const [name, value] of Object.entries(effective.files)) {
    if (!name.endsWith('.c') && !name.endsWith('.h')) continue
    assert.deepEqual(manifest.source.files[name], value, 'Native/WASM effective source differs: ' + name)
    sameSource[name] = value
  }
  for (const name of source.decoderSources) assert(sameSource[name], 'Missing compiled decoder source: ' + name)
  for (const entry of source.originalHeaders) {
    assert.deepEqual(manifest.source.originalHeaders[entry.file], { bytes: entry.bytes, sha256: entry.sha256 })
    assert.deepEqual(sameSource[entry.file], { bytes: entry.bytes, sha256: entry.sha256 })
  }
  for (const kind of ['mjs', 'wasm'] as const) {
    const entry = manifest.assets[kind], data = readFileSync(file(generated, entry.file))
    assert.equal(data.length, entry.bytes); assert.equal(sha(data), entry.sha256)
  }
  sourceVerified = true
  save('source-comparison.json', { sourceVerified, sameSource, archiveSha256: effective.archive.sha256,
    scope: 'Fixed IJG6b C and actual WASM with original configured headers. Same-source/compiler-scope comparison, not original Borland binary/float identity.' })
  const imported = await import(pathToFileURL(file(generated, manifest.assets.mjs.file)).href) as { default: ImageJpegFactory }
  kernel = new ImageJpegKernel(await imported.default({ wasmBinary: new Uint8Array(readFileSync(file(generated, manifest.assets.wasm.file))) }))
  for (const entry of inventory) {
    const result = { id: entry.id, status: 'uncompared', failures: [] as string[] }; results.push(result)
    try {
      assert(/^[a-z0-9-]+$/.test(entry.id)); assert.equal(entry.path, 'inputs/' + entry.id + '.jpg')
      const input = readFileSync(file(reference, entry.path)), native = read<NativeResult>(reference, 'raw/' + entry.id + '.json')
      assert.equal(input.length, entry.bytes); assert.equal(sha(input), entry.sha256)
      assert.equal(native.id, entry.id); assert.equal(native.inputSha256, entry.sha256); assert.equal(native.status, 'observed')
      assert.deepEqual(native.failures, []); assert.equal(native.record.schema, 1); assert.equal(native.record.version, 62)
      assert.equal(native.record.mode, entry.mode); assert.equal(native.record.precision, entry.precision)
      assert.equal(native.record.destinationSentinel, 165)
      const actual = observe(entry, input, kernel)
      result.failures = compare(native.record, actual); result.status = result.failures.length ? 'mismatched' : 'matched'
      save(entry.id + '.json', { ...result, inputSha256: entry.sha256, actual,
        nativeRecordSha256: sha(readFileSync(file(reference, 'raw/' + entry.id + '.json'))),
        nativeOriginalCleanup: native.record.originalCleanup,
        equalityDomain: 'defined caller bytes, completed-row batches, warning counts and exact error code/phase; Web cleanup separately required' })
    } catch (error) { result.failures.push(error instanceof Error ? error.message : String(error)); save(entry.id + '-driver-error.json', errorRecord(error)) }
  }
} catch (error) { errors.push(errorRecord(error)) }
finally {
  try { kernel?.dispose() } catch (error) { errors.push(errorRecord(error)) }
  try { if (kernel) { assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0) } }
  catch (error) { errors.push(errorRecord(error)) }
  const failed = !sourceVerified || planned !== 43 || results.length !== 43 || errors.length > 0 || results.some((entry) => entry.status !== 'matched')
  save('summary.json', { schema: 1, status: failed ? 'failed' : 'passed', planned, reported: results.length, sourceVerified,
    sourceCommit: process.env.GITHUB_SHA, results, errors,
    scope: 'Exact configured-source comparison; original outside-try retained memory is recorded, never reproduced as a Web leak. Missing/uncompared/mismatched cases fail; no retry or tolerance.' })
  if (failed) process.exitCode = 1
}
