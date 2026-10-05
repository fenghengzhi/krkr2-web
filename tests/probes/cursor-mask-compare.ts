// Run only on GitHub-hosted Windows. Native raw planes are the expectations;
// no candidate kernel or generated portable golden is used here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { loadCursorBytes } from '../../src/formats/cursor/load.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
assert.equal(process.platform, 'win32')

interface Plane { present: boolean; ok: boolean; width: number; height: number; depth: number
  stride: number; scanlines: number; topDown: boolean; file: string; paletteRGB: number[] }
interface Sample {
  id: string; file: string; bytes: number; depth: number; width: number; height: number
  pattern: { plane: string; kind: string; axis: string; coordinate: number; x: number; y: number; constant: number }
  loaded: boolean; destroyed: boolean
  info: { ok: boolean; width: number; height: number; planesCopied: boolean; bitmapsDeleted: boolean; maskPlane: Plane }
}
interface Observation {
  completed: boolean; cleanupFailed: boolean; failures: number; sourceCommit: string
  expectedSamples: number; observedSamples: number; samples: Sample[]
  platform: { systemCursor: { width: number; height: number }; displayBitsPerPixel: number; dpi: { x: number; y: number } }
}
const directory = resolve(process.argv[2] ?? 'out/ci/native-cursor'),
  file = (name: string) => {
    const path = resolve(directory, name)
    assert(path.startsWith(directory + sep), 'Mask observation path escapes artifact directory')
    return path
  }, hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  rows: Record<string, unknown>[] = [], inputs: Record<string, unknown>[] = [],
  report = { schema: 1, sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    status: 'running', scope: 'Exact AND and monochrome XOR loading against native GetIconInfo planes; no color or animation pass claim',
    inputs, rows, compared: 0, matched: 0, failed: 0, error: undefined as string | undefined },
  save = () => writeFileSync(file('mask-load-comparison.json'), JSON.stringify(report, null, 2) + '\n')
save()
function verifyPattern(sample: Sample, bytes: Buffer): void {
  const width = sample.width, height = sample.height, p = sample.pattern,
    stride = Math.ceil(width / 32) * 4, colorStride = Math.ceil(width * sample.depth / 32) * 4,
    colorAt = 22 + 40 + (sample.depth === 1 ? 8 : 0), andAt = colorAt + colorStride * height,
    expected = (x: number, y: number, xor: boolean) => {
      const plane = xor ? 'XOR' : 'AND', crossed = p.plane === 'crossed'
      if (!crossed && p.plane !== plane) return 1
      if (p.kind === 'constant') return p.constant
      const px = crossed && xor ? y : x, py = crossed && xor ? x : y
      return p.kind === 'zero-line' ? Number((p.axis === 'x' ? px : py) !== p.coordinate)
        : Number(px !== p.x || py !== p.y)
    }
  assert.equal(bytes.readUInt32LE(18), 22); assert.equal(bytes.readUInt32LE(22), 40)
  assert.equal(bytes.readUInt32LE(38), 0); assert.equal(bytes.length, andAt + stride * height)
  assert(['crossed', 'AND', 'XOR'].includes(p.plane))
  assert(['constant', 'zero-line', 'zero-point'].includes(p.kind))
  if (sample.depth === 1) {
    assert.equal(bytes.readUInt32LE(62), 0); assert.equal(bytes.readUInt32LE(66), 0xffffff)
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = height - 1 - y, shift = 7 - (x & 7)
    if ((bytes[andAt + row * stride + (x >>> 3)]! >>> shift & 1) !== expected(x, y, false))
      assert.fail(`${sample.id}: original AND ${x},${y}`)
    if (sample.depth === 1) {
      if ((bytes[colorAt + row * colorStride + (x >>> 3)]! >>> shift & 1) !== expected(x, y, true))
        assert.fail(`${sample.id}: original XOR ${x},${y}`)
    } else {
      const at = colorAt + row * colorStride + x * 4
      if (bytes[at] !== 65 || bytes[at + 1] !== 33 || bytes[at + 2] !== 17 || bytes[at + 3] !== 0)
        assert.fail(`${sample.id}: original constant BGRA ${x},${y}`)
    }
  }
}
function verifyInventory(sample: Sample, geometry: boolean, seen: Set<string>): void {
  const { width, height, depth, pattern: p } = sample,
    shapes = geometry ? ['64x64', '48x48', '13x9', '64x48', '48x64', '64x13', '13x64'] : ['256x256']
  assert(shapes.includes(`${width}x${height}`))
  assert(depth === 1 || depth === 32)
  assert(geometry ? p.plane === 'AND' || (depth === 1 && p.plane === 'XOR') : p.plane === 'crossed')
  let suffix: string
  if (p.kind === 'constant') {
    assert(p.constant === 0 || p.constant === 1)
    suffix = String(p.constant)
  } else if (p.kind === 'zero-line') {
    assert(p.axis === 'x' || p.axis === 'y')
    assert(Number.isSafeInteger(p.coordinate) && p.coordinate >= 0 && p.coordinate < (p.axis === 'x' ? width : height))
    suffix = `${p.axis}/${p.coordinate}`
  } else {
    assert.equal(p.kind, 'zero-point')
    const xs = geometry ? [0, 1, 4, 5, width - 2, width - 1] : [0, 4, 5, 252, 253, 255],
      ys = geometry ? [0, 1, 4, 5, height - 2, height - 1] : [0, 4, 5, 252, 253, 255]
    assert(xs.includes(p.x) && ys.includes(p.y))
    suffix = `${p.x}/${p.y}`
  }
  const key = `${width}x${height}/${depth}/${p.plane}/${p.kind}/${suffix}`
  assert(!seen.has(key), 'Duplicate mask source pattern'); seen.add(key)
}
try {
  for (const [name, expected, encodedBytes] of [
    ['mask-footprints.json', 1100, 157768600], ['mask-geometry.json', 2670, 10186428],
  ] as const) {
    const source = readFileSync(file(name)), observation = JSON.parse(source.toString()) as Observation
    inputs.push({ file: name, sha256: hash(source), expectedSamples: expected, sourceBytes: encodedBytes })
    assert.equal(observation.completed, true); assert.equal(observation.cleanupFailed, false)
    assert.equal(observation.failures, 0); assert.equal(observation.sourceCommit, process.env.GITHUB_SHA)
    assert.equal(observation.expectedSamples, expected); assert.equal(observation.observedSamples, expected)
    assert.equal(observation.samples.length, expected)
    assert.deepEqual(observation.platform.systemCursor, { width: 32, height: 32 })
    assert.equal(observation.platform.displayBitsPerPixel, 32)
    assert.deepEqual(observation.platform.dpi, { x: 96, y: 96 })
    const ids = new Set<string>(), patterns = new Set<string>()
    let totalBytes = 0
    for (const sample of observation.samples) {
      assert(!ids.has(sample.id)); ids.add(sample.id)
      const row: Record<string, unknown> = { id: sample.id, source: sample.pattern,
        dimensions: [sample.width, sample.height], depth: sample.depth }
      rows.push(row)
      try {
        verifyInventory(sample, name === 'mask-geometry.json', patterns)
        assert.equal(sample.loaded, true); assert.equal(sample.destroyed, true)
        assert.equal(sample.info.ok, true); assert.equal(sample.info.planesCopied, true); assert.equal(sample.info.bitmapsDeleted, true)
        assert(sample.depth === 1 || sample.depth === 32)
        const input = readFileSync(file(sample.file)), plane = sample.info.maskPlane
        assert.equal(input.length, sample.bytes); totalBytes += input.length
        assert.equal(input.readUInt16LE(2), 2); assert.equal(input.readUInt16LE(4), 1)
        assert.equal(input.readInt32LE(26), sample.width); assert.equal(input.readInt32LE(30), sample.height * 2)
        assert.equal(input.readUInt16LE(36), sample.depth)
        verifyPattern(sample, input)
        assert.equal(plane.present, true); assert.equal(plane.ok, true); assert.equal(plane.depth, 1)
        assert.equal(plane.width, 32); assert.equal(plane.height, sample.depth === 1 ? 64 : 32)
        assert.equal(plane.stride, 4); assert.equal(plane.scanlines, plane.height); assert.equal(plane.topDown, true)
        assert.deepEqual(plane.paletteRGB, [0, 0xffffff])
        const raw = readFileSync(file(plane.file))
        assert.equal(raw.length, plane.stride * plane.height)
        row.sourceSha256 = hash(input); row.nativeMaskSha256 = hash(raw)
        const loaded = await loadCursorBytes(input, { png: async () => { throw new Error('Unexpected PNG in native DIB mask observation') } }),
          image = loaded.frames[0]!.images[0]!
        assert.equal(image.width, 32); assert.equal(image.height, 32)
        assert.equal(image.mode, 'and-xor')
        let differentPixels = 0, differentPlanes = 0
        const first: { x: number; y: number; plane: string; native: number; portable: number }[] = []
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
          let different = false
          for (const label of sample.depth === 1 ? ['AND', 'XOR'] : ['AND']) {
            const value = ((raw[(y + (label === 'XOR' ? 32 : 0)) * 4 + (x >>> 3)]! >>> (7 - (x & 7))) & 1) * 255,
              portable = label === 'AND' ? image.andMask[y * 32 + x]! : image.data[(y * 32 + x) * 4]!
            if (label === 'XOR') {
              assert.equal(image.data[(y * 32 + x) * 4 + 1], portable)
              assert.equal(image.data[(y * 32 + x) * 4 + 2], portable)
            }
            if (value !== portable) {
              different = true; differentPlanes++
              if (first.length < 8) first.push({ x, y, plane: label, native: value, portable })
            }
          }
          if (different) differentPixels++
        }
        row.differentPixels = differentPixels; row.differentPlanes = differentPlanes; row.firstDifferences = first
        row.status = differentPixels ? 'mismatch' : 'matched'
        report.compared++
        if (differentPixels) report.failed++; else report.matched++
      } catch (error) {
        row.status = 'error'; row.error = error instanceof Error ? error.message : String(error); report.failed++
      }
      if (!(rows.length % 32)) save()
    }
    assert.equal(totalBytes, encodedBytes, `${name}: source byte inventory changed`)
  }
  report.status = report.failed ? 'failed' : 'matched'
  save()
  assert.equal(report.failed, 0, 'Native mask loading differs; see complete mask-load-comparison.json')
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error)
  save(); throw error
}
