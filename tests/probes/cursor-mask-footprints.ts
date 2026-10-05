// GitHub-hosted Windows only. Summarize native raw planes; no product decoder,
// scaler, candidate kernel, DrawIconEx result, or compatibility-pass inference.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
assert.equal(process.platform, 'win32')

interface Pattern { kind: 'constant' | 'zero-line' | 'zero-point'; axis: 'x' | 'y'; coordinate: number; x: number; y: number; constant: number }
interface Plane { present: boolean; ok: boolean; width: number; height: number; depth: number; stride: number; scanlines: number; topDown: boolean; file: string; paletteRGB: number[] }
interface Sample {
  id: string; file: string; bytes: number; depth: 1 | 32; pattern: Pattern; loaded: boolean; destroyed: boolean
  info: { ok: boolean; width: number; height: number; planesCopied: boolean; bitmapsDeleted: boolean; maskPlane: Plane; colorPlane: Plane }
}
interface AxisGroup {
  depth: number; plane: string; axis: 'x' | 'y'
  rows: { sourceCoordinate: number; zeroCoordinates: number[]; uniform: boolean }[]
  sourceByDestination?: number[][]
}
const directory = resolve(process.argv[2] ?? 'out/ci/native-cursor'),
  file = (name: string) => {
    assert.equal(typeof name, 'string')
    const path = resolve(directory, name)
    assert(path.startsWith(directory + sep), 'Footprint file escapes artifact directory')
    return path
  }, hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  original = readFileSync(file('mask-footprints.json')),
  native = JSON.parse(original.toString()) as {
    schema: number; completed: boolean; cleanupFailed: boolean; failures: number; sourceCommit: string
    globalInputUsed: boolean; drawIconExUsed: boolean; portableCandidatesUsed: boolean
    expectedSamples: number; observedSamples: number; sourceExtent: number; samples: Sample[]
    platform: { systemCursor: { width: number; height: number }; displayBitsPerPixel: number; dpi: { x: number; y: number } }
  }, groups = new Map<string, AxisGroup>(), constants: Record<string, unknown>[] = [],
  points: { id: string; depth: number; plane: string; source: [number, number]; zeroPixels: number[][] }[] = [],
  sourceHashes: { id: string; sha256: string; maskSha256: string; colorSha256?: string }[] = []
const color32 = [65, 33, 17, 0] as const
const pointCoordinates = [0, 4, 5, 252, 253, 255]

const report: Record<string, unknown> = {
  schema: 1, sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  observationSha256: hash(original), status: 'reading',
  scope: 'Native single-zero-line influence by every source coordinate and raw point separability observations; no scaling policy or compatibility pass',
  inventory: { expectedSamples: 1100, axisLines: 1024, constants: 4, points: 72 },
  sourceHashes, constants, groups: [], pointSeparability: [],
}
const save = () => writeFileSync(file('mask-footprint-summary.json'), JSON.stringify(report, null, 2) + '\n')
save()

function sourceBit(pattern: Pattern, x: number, y: number, xor: boolean): number {
  if (pattern.kind === 'constant') return pattern.constant
  if (pattern.kind === 'zero-line') {
    const axis = xor ? (pattern.axis === 'x' ? 'y' : 'x') : pattern.axis
    return Number((axis === 'x' ? x : y) !== pattern.coordinate)
  }
  return Number(x !== (xor ? pattern.y : pattern.x) || y !== (xor ? pattern.x : pattern.y))
}
function verifySource(sample: Sample, bytes: Buffer): void {
  assert.equal(bytes.length, sample.bytes)
  assert.equal(bytes.readUInt16LE(0), 0); assert.equal(bytes.readUInt16LE(2), 2); assert.equal(bytes.readUInt16LE(4), 1)
  assert.equal(bytes[6], 0); assert.equal(bytes[7], 0)
  assert.equal(bytes.readUInt16LE(10), 0); assert.equal(bytes.readUInt16LE(12), 0)
  assert.equal(bytes.readUInt32LE(18), 22); assert.equal(bytes.readUInt32LE(14), bytes.length - 22)
  const dib = 22, colorAt = dib + 40 + (sample.depth === 1 ? 8 : 0),
    colorStride = 256 * sample.depth / 8, maskAt = colorAt + 256 * colorStride
  assert.equal(bytes.readUInt32LE(dib), 40); assert.equal(bytes.readInt32LE(dib + 4), 256)
  assert.equal(bytes.readInt32LE(dib + 8), 512); assert.equal(bytes.readUInt16LE(dib + 12), 1)
  assert.equal(bytes.readUInt16LE(dib + 14), sample.depth); assert.equal(bytes.readUInt32LE(dib + 16), 0)
  assert.equal(maskAt + 8192, bytes.length)
  if (sample.depth === 1) {
    assert.equal(bytes.readUInt32LE(dib + 40), 0); assert.equal(bytes.readUInt32LE(dib + 44), 0x00ffffff)
  } else assert(bytes.subarray(colorAt, maskAt).every((value, index) => value === color32[index & 3]),
    '32-bit fixture must have constant non-grey RGB and zero alpha')
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const byte = (255 - y) * 32 + (x >>> 3), shift = 7 - (x & 7)
    if ((bytes[maskAt + byte]! >>> shift & 1) !== sourceBit(sample.pattern, x, y, false))
      assert.fail(`${sample.id} AND source ${x},${y}`)
    if (sample.depth === 1 && (bytes[colorAt + byte]! >>> shift & 1) !== sourceBit(sample.pattern, x, y, true))
      assert.fail(`${sample.id} XOR source ${x},${y}`)
  }
}
function bits(bytes: Buffer, stride: number, firstRow: number): number[][] {
  return Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) =>
    bytes[(firstRow + y) * stride + (x >>> 3)]! >>> (7 - (x & 7)) & 1))
}

try {
  assert.equal(native.schema, 1); assert.equal(native.completed, true); assert.equal(native.cleanupFailed, false)
  assert.equal(native.failures, 0); assert.equal(native.sourceCommit, process.env.GITHUB_SHA)
  assert.equal(native.globalInputUsed, false); assert.equal(native.drawIconExUsed, false); assert.equal(native.portableCandidatesUsed, false)
  assert.equal(native.sourceExtent, 256); assert.equal(native.expectedSamples, 1100); assert.equal(native.observedSamples, 1100)
  assert.equal(native.samples.length, 1100)
  assert.deepEqual(native.platform.systemCursor, { width: 32, height: 32 })
  assert.equal(native.platform.displayBitsPerPixel, 32); assert.deepEqual(native.platform.dpi, { x: 96, y: 96 })
  const ids = new Set<string>(), patterns = new Set<string>()
  let sourceBytes = 0, lines = 0, pointCount = 0, constantCount = 0
  for (const sample of native.samples) {
    assert(!ids.has(sample.id)); ids.add(sample.id)
    assert(sample.depth === 1 || sample.depth === 32)
    assert(['constant', 'zero-line', 'zero-point'].includes(sample.pattern.kind))
    for (const value of [sample.pattern.coordinate, sample.pattern.x, sample.pattern.y])
      assert(Number.isInteger(value) && value >= 0 && value < 256)
    assert(sample.pattern.axis === 'x' || sample.pattern.axis === 'y')
    const p = sample.pattern, key = `${sample.depth}/${p.kind}/` + (p.kind === 'zero-line'
      ? `${p.axis}/${p.coordinate}` : p.kind === 'zero-point' ? `${p.x}/${p.y}` : p.constant)
    assert(!patterns.has(key)); patterns.add(key)
    if (p.kind === 'constant') { assert(p.constant === 0 || p.constant === 1); constantCount++ }
    else if (p.kind === 'zero-line') lines++
    else { assert(pointCoordinates.includes(p.x) && pointCoordinates.includes(p.y)); pointCount++ }
    assert.equal(sample.loaded, true); assert.equal(sample.destroyed, true)
    assert.equal(sample.info.ok, true); assert.equal(sample.info.planesCopied, true); assert.equal(sample.info.bitmapsDeleted, true)
    assert.equal(sample.info.width, 32); assert.equal(sample.info.height, 32)
    const input = readFileSync(file(sample.file)); verifySource(sample, input); sourceBytes += input.length
    const plane = sample.info.maskPlane
    assert.equal(plane.present, true); assert.equal(plane.ok, true); assert.equal(plane.depth, 1)
    assert.equal(plane.width, 32); assert.equal(plane.height, sample.depth === 1 ? 64 : 32)
    assert.equal(plane.stride, 4); assert.equal(plane.scanlines, plane.height); assert.equal(plane.topDown, true)
    assert.deepEqual(plane.paletteRGB, [0, 0xffffff])
    const raw = readFileSync(file(plane.file)); assert.equal(raw.length, plane.stride * plane.height)
    const record = { id: sample.id, sha256: hash(input), maskSha256: hash(raw), colorSha256: undefined as string | undefined }
    if (sample.depth === 32) {
      const color = sample.info.colorPlane
      assert.equal(color.present, true); assert.equal(color.ok, true)
      assert.equal(color.width, 32); assert.equal(color.height, 32); assert.equal(color.depth, 32)
      assert.equal(color.stride, 128); assert.equal(color.scanlines, 32); assert.equal(color.topDown, true)
      const pixels = readFileSync(file(color.file)); assert.equal(pixels.length, 4096); record.colorSha256 = hash(pixels)
    } else assert.equal(sample.info.colorPlane.present, false)
    sourceHashes.push(record)
    for (const [name, firstRow] of sample.depth === 1 ? [['AND', 0], ['XOR', 32]] as const : [['AND', 0]] as const) {
      const raster = bits(raw, plane.stride, firstRow), zeroPixels: number[][] = []
      raster.forEach((row, y) => row.forEach((value, x) => { if (!value) zeroPixels.push([x, y]) }))
      if (p.kind === 'constant') {
        constants.push({ id: sample.id, depth: sample.depth, plane: name, value: p.constant,
          zeroPixels: zeroPixels.length, unchanged: raster.every((row) => row.every((value) => value === p.constant)) })
      } else if (p.kind === 'zero-line') {
        const axis = name === 'XOR' ? (p.axis === 'x' ? 'y' : 'x') : p.axis,
          key = `${sample.depth}/${name}/${axis}`,
          group: AxisGroup = groups.get(key) ?? { depth: sample.depth, plane: name, axis, rows: [] },
          zeroCoordinates: number[] = []
        let uniform = true
        for (let at = 0; at < 32; at++) {
          const value = axis === 'x' ? raster[0]![at]! : raster[at]![0]!
          if (!value) zeroCoordinates.push(at)
          for (let across = 0; across < 32; across++)
            if ((axis === 'x' ? raster[across]![at] : raster[at]![across]) !== value) uniform = false
        }
        group.rows.push({ sourceCoordinate: p.coordinate, zeroCoordinates, uniform }); groups.set(key, group)
      } else points.push({ id: sample.id, depth: sample.depth, plane: name,
        source: name === 'XOR' ? [p.y, p.x] : [p.x, p.y], zeroPixels })
    }
  }
  assert.equal(lines, 1024); assert.equal(pointCount, 72); assert.equal(constantCount, 4)
  assert.equal(sourceBytes, 157768600)
  assert.equal(groups.size, 6)
  const support = []
  for (const group of groups.values()) {
    group.rows.sort((a, b) => a.sourceCoordinate - b.sourceCoordinate)
    assert.deepEqual(group.rows.map((row) => row.sourceCoordinate), Array.from({ length: 256 }, (_, index) => index))
    const white = constants.find((row) => row.depth === group.depth && row.plane === group.plane && row.value === 1)
    if (white?.unchanged === true && group.rows.every((row) => row.uniform))
      group.sourceByDestination = Array.from({ length: 32 }, (_, at) => group.rows.filter((row) => row.zeroCoordinates.includes(at)).map((row) => row.sourceCoordinate))
    support.push({ ...group, omittedSourceCoordinates: group.rows.filter((row) => !row.zeroCoordinates.length).map((row) => row.sourceCoordinate),
      contiguous: group.sourceByDestination?.every((coordinates) => coordinates.every((value, index) => !index || value === coordinates[index - 1]! + 1)) ?? null })
  }
  report.groups = support
  report.pointSeparability = points.map((point) => {
    const x = groups.get(`${point.depth}/${point.plane}/x`)?.sourceByDestination,
      y = groups.get(`${point.depth}/${point.plane}/y`)?.sourceByDestination
    if (!x || !y) return { ...point, status: 'unresolved-nonuniform-line-response' }
    const predicted: number[][] = []
    for (let dy = 0; dy < 32; dy++) for (let dx = 0; dx < 32; dx++)
      if (x[dx]!.includes(point.source[0]) && y[dy]!.includes(point.source[1])) predicted.push([dx, dy])
    return { ...point, inferredFromAxisLines: predicted,
      status: JSON.stringify(predicted) === JSON.stringify(point.zeroPixels) ? 'consistent' : 'conflict' }
  })
  report.sourceBytes = sourceBytes; report.status = 'observed'; save()
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  save(); throw error
}
