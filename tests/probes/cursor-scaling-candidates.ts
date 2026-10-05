// Measurement only. Execute in the GitHub-hosted Windows reference job after
// native capture. No candidate is selected as production policy by this probe.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import { decodeCursor, type CursorImage } from '../../src/formats/cursor/index.ts'
import { decodePng } from '../../src/formats/image/png.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
assert.equal(process.platform, 'win32')

type Mapping = 'endpoint' | 'center'
type Direction = 'top-down' | 'bottom-up'
type Arithmetic = 'absolute-f64' | 'incremental-f64' | 'absolute-f32' | 'incremental-f32' | 'incremental-f32-step-f64'
type Kernel =
  | 'weighted-x-y' | 'weighted-y-x' | 'lerp-x-y' | 'lerp-y-x'
  | 'floor-weighted-x-y' | 'floor-weighted-y-x' | 'floor-lerp-x-y' | 'floor-lerp-y-x'
  | 'floor-each-four-tap' | 'nearest' | 'horizontal-term-floor-except-fy-zero'
interface Candidate {
  id: string
  mapping: Mapping
  direction: Direction
  xArithmetic: Arithmetic
  yArithmetic: Arithmetic
  kernel: Kernel
}
interface Plane {
  present: boolean; ok: boolean; width: number; height: number; depth: number
  stride: number; scanlines: number; topDown: boolean; file: string
}
interface NativeInfo {
  ok: boolean; width: number; height: number; planesCopied: boolean
  colorPlane?: Plane; maskPlane?: Plane
}
interface NativeFixture {
  id: string; file: string; kind: string; loaded: boolean; entries: unknown[]
  info?: NativeInfo
  ani?: { frameEntries: unknown[][] }
  steps: { step: number; frameInfo?: { available: boolean; ok?: boolean; info?: NativeInfo } }[]
}
interface Observation {
  schema: number; sourceCommit: string; completed: boolean; cleanupFailed: boolean
  expectedFixtures: number; observedFixtures: number
  platform: {
    systemCursor: { width: number; height: number }
    displayBitsPerPixel: number; dpi: { x: number; y: number }
  }
  fixtures: NativeFixture[]
}
interface GeometryObservation {
  schema: number; sourceCommit: string; completed: boolean; cleanupFailed: boolean; failures: number
  expectedSamples: number; observedSamples: number; platform: Observation['platform']
  samples: Array<{ id: string; file: string; depth: number; width: number; height: number; loaded: boolean
    pattern: { kind: string; plane: string; constant: number }; info: NativeInfo }>
}
interface Difference {
  x: number; y: number; actual: number[]; candidate: number[]
}
interface Metrics {
  comparedPixels: number; comparedChannels: number
  differentPixels: number; differentChannels: number
  absoluteError: number; maximumChannelDifference: number
  firstDifference: Difference | null
}
interface Ranking extends Omit<Metrics, 'firstDifference'> {
  candidateId: string; targets: number; targetsWithDifferences: number
  fixtureIds: Set<string>; differingFixtureIds: Set<string>
}
interface FixtureMeasurement extends Omit<Metrics, 'firstDifference'> {
  candidateId: string; targets: number
  firstDifference: (Difference & { step: number; frameIndex: number }) | null
}

const directory = resolve(process.argv[2] ?? 'out/ci/native-cursor'),
  file = (name: string) => {
    assert.equal(typeof name, 'string')
    const result = resolve(directory, name)
    assert(result.startsWith(directory + sep), 'Reference filename escapes artifact directory')
    return result
  },
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  candidates: Candidate[] = [],
  kernels: Kernel[] = [
    'weighted-x-y', 'weighted-y-x', 'lerp-x-y', 'lerp-y-x',
    'floor-weighted-x-y', 'floor-weighted-y-x', 'floor-lerp-x-y', 'floor-lerp-y-x',
    'floor-each-four-tap', 'nearest',
  ]

function add(mapping: Mapping, direction: Direction, xArithmetic: Arithmetic, yArithmetic: Arithmetic, kernel: Kernel) {
  candidates.push({ id: `${mapping}/${direction}/x-${xArithmetic}/y-${yArithmetic}/${kernel}`,
    mapping, direction, xArithmetic, yArithmetic, kernel })
}
// 120 Cartesian candidates, plus 8 explicitly bounded endpoint supplements.
for (const mapping of ['endpoint', 'center'] as const)
  for (const direction of ['top-down', 'bottom-up'] as const)
    for (const arithmetic of ['absolute-f64', 'incremental-f64', 'incremental-f32'] as const)
      for (const kernel of kernels) add(mapping, direction, arithmetic, arithmetic, kernel)
for (const direction of ['top-down', 'bottom-up'] as const) {
  for (const kernel of ['weighted-x-y', 'weighted-y-x'] as const)
    add('endpoint', direction, 'absolute-f32', 'absolute-f32', kernel)
  add('endpoint', direction, 'incremental-f32', 'incremental-f64', 'weighted-x-y')
  // A separate manual hypothesis from raw-plane inspection: integral Y uses
  // one horizontal floor; fractional Y floors each horizontal contribution.
  add('endpoint', direction, 'incremental-f64', 'incremental-f64', 'horizontal-term-floor-except-fy-zero')
}
assert.equal(candidates.length, 128)
const legacyCandidateIds = candidates.map((candidate) => candidate.id),
  precisionArithmetic = ['absolute-f64', 'incremental-f64', 'absolute-f32', 'incremental-f32'] as const,
  precisionCombinationIds: string[] = [], precisionReusedIds: string[] = [], precisionAddedIds: string[] = []
// The staged kernel was previously measured only with incremental binary64
// coordinates. Complete its independent X/Y precision matrix without deleting
// or reordering any historical candidate. Pixel arithmetic remains binary64.
for (const direction of ['top-down', 'bottom-up'] as const)
  for (const xArithmetic of precisionArithmetic) for (const yArithmetic of precisionArithmetic) {
    const kernel = 'horizontal-term-floor-except-fy-zero',
      id = `endpoint/${direction}/x-${xArithmetic}/y-${yArithmetic}/${kernel}`
    precisionCombinationIds.push(id)
    if (candidates.some((candidate) => candidate.id === id)) precisionReusedIds.push(id)
    else {
      add('endpoint', direction, xArithmetic, yArithmetic, kernel)
      precisionAddedIds.push(id)
    }
  }
assert.equal(precisionCombinationIds.length, 32)
assert.equal(precisionReusedIds.length, 2)
assert.equal(precisionAddedIds.length, 30)
assert.equal(candidates.length, 158)
assert.deepEqual(candidates.slice(0, 128).map((candidate) => candidate.id), legacyCandidateIds)
assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, candidates.length)
const previousCandidateIds = candidates.map((candidate) => candidate.id),
  stepArithmetic: readonly Arithmetic[] = [...precisionArithmetic, 'incremental-f32-step-f64'],
  stepCombinationIds: string[] = [], stepAddedIds: string[] = [], stepReusedIds: string[] = []
// 086's constant-color raw planes preserve only their first column and bottom
// row on six smooth geometries, including the final X coordinate. A rounded
// binary32 step accumulated in binary64 is distinct from both earlier paths.
// Measure its complete X/Y matrix; do not select it as production policy.
for (const direction of ['top-down', 'bottom-up'] as const)
  for (const xArithmetic of stepArithmetic) for (const yArithmetic of stepArithmetic) {
    const kernel: Kernel = 'horizontal-term-floor-except-fy-zero',
      id: string = `endpoint/${direction}/x-${xArithmetic}/y-${yArithmetic}/${kernel}`
    stepCombinationIds.push(id)
    if (candidates.some((candidate) => candidate.id === id)) stepReusedIds.push(id)
    else { add('endpoint', direction, xArithmetic, yArithmetic, kernel); stepAddedIds.push(id) }
  }
assert.equal(stepCombinationIds.length, 50); assert.equal(stepReusedIds.length, 32); assert.equal(stepAddedIds.length, 18)
assert.equal(candidates.length, 176)
assert.deepEqual(candidates.slice(0, 158).map((candidate) => candidate.id), previousCandidateIds)
assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, candidates.length)

function axis(source: number, target: number, mapping: Mapping, arithmetic: Arithmetic): number[] {
  const f32 = arithmetic.endsWith('f32'), round = f32 ? Math.fround : (value: number) => value,
    stepRound = f32 || arithmetic === 'incremental-f32-step-f64' ? Math.fround : (value: number) => value,
    increment = stepRound(mapping === 'endpoint' ? (target === 1 ? 0 : (source - 1) / (target - 1)) : source / target),
    origin = mapping === 'endpoint' ? 0 : round(round(increment * 0.5) - 0.5),
    values: number[] = []
  let position = origin
  for (let at = 0; at < target; at++) {
    const value = arithmetic.startsWith('absolute')
      ? round(origin + round(at * increment)) : position
    // Clamp only to the source extent; never snap a near-integer coordinate.
    values.push(Math.max(0, Math.min(source - 1, value)))
    if (arithmetic.startsWith('incremental')) position = round(position + increment)
  }
  return values
}

function blend(a: number, b: number, fraction: number, lerp: boolean): number {
  return lerp ? a + (b - a) * fraction : a * (1 - fraction) + b * fraction
}

function sample(image: CursorImage, x: number, y: number, channel: number, candidate: Candidate): number {
  const x0 = Math.floor(x), x1 = Math.min(image.width - 1, x0 + 1),
    y0 = Math.floor(y), y1 = Math.min(image.height - 1, y0 + 1), fx = x - x0, fy = y - y0,
    at = (sx: number, sy: number) => {
      const logicalY = candidate.direction === 'bottom-up' ? image.height - 1 - sy : sy
      return image.data[(logicalY * image.width + sx) * 4 + channel]!
    }
  if (candidate.kernel === 'nearest') return at(Math.round(x), Math.round(y))
  const a = at(x0, y0), b = at(x1, y0), c = at(x0, y1), d = at(x1, y1)
  let value: number
  if (candidate.kernel === 'horizontal-term-floor-except-fy-zero') {
    value = fy === 0 ? blend(a, b, fx, false)
      : (Math.floor(a * (1 - fx)) + Math.floor(b * fx)) * (1 - fy) +
        (Math.floor(c * (1 - fx)) + Math.floor(d * fx)) * fy
  } else if (candidate.kernel === 'floor-each-four-tap') {
    // Multiplication order is explicit: byte * horizontal weight * vertical weight.
    value = Math.floor(a * (1 - fx) * (1 - fy)) + Math.floor(b * fx * (1 - fy)) +
      Math.floor(c * (1 - fx) * fy) + Math.floor(d * fx * fy)
  } else {
    const lerp = candidate.kernel.includes('lerp'), staged = candidate.kernel.startsWith('floor-'),
      horizontalFirst = candidate.kernel.endsWith('x-y'),
      first = horizontalFirst ? blend(a, b, fx, lerp) : blend(a, c, fy, lerp),
      second = horizontalFirst ? blend(c, d, fx, lerp) : blend(b, d, fy, lerp)
    value = blend(staged ? Math.floor(first) : first, staged ? Math.floor(second) : second,
      horizontalFirst ? fy : fx, lerp)
  }
  // Only coordinates use f32 candidates. Pixel arithmetic remains JS binary64
  // in every kernel, with precisely the floors named above and this final floor.
  return Math.max(0, Math.min(255, Math.floor(value)))
}

function compare(image: CursorImage, actual: Uint8Array, width: number, height: number, candidate: Candidate): Metrics {
  const channels = image.mode === 'alpha' ? 4 : 3,
    xs = axis(image.width, width, candidate.mapping, candidate.xArithmetic),
    ys = axis(image.height, height, candidate.mapping, candidate.yArithmetic),
    result: Metrics = { comparedPixels: width * height, comparedChannels: width * height * channels,
      differentPixels: 0, differentChannels: 0, absoluteError: 0,
      maximumChannelDifference: 0, firstDifference: null }
  for (let memoryY = 0; memoryY < height; memoryY++) {
    const logicalY = candidate.direction === 'bottom-up' ? height - 1 - memoryY : memoryY
    for (let x = 0; x < width; x++) {
      let different = false
      const observed: number[] = [], predicted: number[] = []
      for (let channel = 0; channel < channels; channel++) {
        const value = sample(image, xs[x]!, ys[memoryY]!, channel, candidate),
          nativeValue = actual[(logicalY * width + x) * 4 + channel]!,
          difference = Math.abs(value - nativeValue)
        observed.push(nativeValue)
        predicted.push(value)
        if (difference) { different = true; result.differentChannels++ }
        result.absoluteError += difference
        result.maximumChannelDifference = Math.max(result.maximumChannelDifference, difference)
      }
      if (different) {
        result.differentPixels++
        result.firstDifference ??= { x, y: logicalY, actual: observed, candidate: predicted }
      }
    }
  }
  return result
}

function emptyRanking(candidateId: string): Ranking {
  return { candidateId, targets: 0, targetsWithDifferences: 0,
    fixtureIds: new Set(), differingFixtureIds: new Set(), comparedPixels: 0, comparedChannels: 0,
    differentPixels: 0, differentChannels: 0, absoluteError: 0, maximumChannelDifference: 0 }
}
const allRanks = new Map(candidates.map(({ id }) => [id, emptyRanking(id)])),
  resizedRanks = new Map(candidates.map(({ id }) => [id, emptyRanking(id)]))
function aggregate(rank: Ranking, fixtureId: string, metrics: Metrics): void {
  rank.targets++
  rank.fixtureIds.add(fixtureId)
  if (metrics.differentPixels) { rank.targetsWithDifferences++; rank.differingFixtureIds.add(fixtureId) }
  for (const field of ['comparedPixels', 'comparedChannels', 'differentPixels', 'differentChannels', 'absoluteError'] as const)
    rank[field] += metrics[field]
  rank.maximumChannelDifference = Math.max(rank.maximumChannelDifference, metrics.maximumChannelDifference)
}
function ranking(source: Map<string, Ranking>) {
  return [...source.values()].filter((value) => value.targets).map(({ fixtureIds, differingFixtureIds, ...metrics }) => ({
    ...metrics, fixtures: fixtureIds.size, fixturesWithDifferences: differingFixtureIds.size,
  })).sort((a, b) => a.differentPixels - b.differentPixels || a.differentChannels - b.differentChannels ||
    a.absoluteError - b.absoluteError || (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0))
}

function finish<T>(work: Generator<void, T>): T {
  for (;;) { const step = work.next(); if (step.done) return step.value }
}
function readPlane(plane: Plane | undefined, depth: number, label: string) {
  assert(plane?.present && plane.ok, `${label}: complete native plane is missing`)
  assert.equal(plane.depth, depth, `${label}: unexpected native plane depth`)
  assert(Number.isSafeInteger(plane.width) && plane.width > 0 && plane.width <= 256)
  assert(Number.isSafeInteger(plane.height) && plane.height > 0 && plane.height <= 256)
  assert.equal(plane.stride, Math.ceil(plane.width * depth / 32) * 4, `${label}: invalid stride`)
  assert.equal(plane.scanlines, plane.height, `${label}: partial plane capture`)
  assert.equal(typeof plane.topDown, 'boolean')
  const bytes = readFileSync(file(plane.file))
  assert.equal(bytes.length, plane.stride * plane.height, `${label}: incomplete plane file`)
  return { plane, bytes, sha256: hash(bytes) }
}
function nativePixels(info: NativeInfo | undefined, label: string) {
  assert(info?.ok && info.planesCopied, `${label}: GetIconInfo planes were not completely copied`)
  const color = readPlane(info.colorPlane, 32, `${label}/color`),
    mask = readPlane(info.maskPlane, 1, `${label}/mask`),
    width = color.plane.width, height = color.plane.height,
    rgba = new Uint8Array(width * height * 4)
  assert.equal(info.width, width)
  assert.equal(info.height, height)
  assert.equal(mask.plane.width, width)
  assert.equal(mask.plane.height, height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = color.plane.topDown ? y : height - 1 - y,
      source = row * color.plane.stride + x * 4, target = (y * width + x) * 4
    rgba[target] = color.bytes[source + 2]!
    rgba[target + 1] = color.bytes[source + 1]!
    rgba[target + 2] = color.bytes[source]!
    rgba[target + 3] = color.bytes[source + 3]!
  }
  return { width, height, rgba, colorPlane: { ...color.plane, sha256: color.sha256 },
    maskPlane: { ...mask.plane, sha256: mask.sha256 } }
}

const fixtures: Record<string, unknown>[] = [], errors: Record<string, unknown>[] = []
let observationSha256: string | undefined, geometryObservationSha256: string | undefined,
  geometryFixtures = 0, observedFixtures = 0, eligibleFixtures = 0,
  comparedTargets = 0, resizedTargets = 0, status = 'diagnostic-running', fatalError: unknown
const describeError = (error: unknown) => error instanceof Error
  ? { message: error.message, stack: error.stack } : { message: String(error) }
const save = () => writeFileSync(file('scaling-candidates.json'), JSON.stringify({
  schema: 1, sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  observationSha256, geometryObservationSha256, status, fatalError,
  scope: 'Raw GetIconInfo color-plane scaling measurements for native-loaded, single-image 32bpp sources; not drawing, selection, hotspot, mask, or playback compatibility',
  interpretation: 'Ranking is diagnostic only. No closest candidate is selected as policy. The independent strict load comparison remains authoritative.',
  channelContract: 'Actual BGRA is normalized to top-down straight RGBA. and-xor compares RGB; alpha compares RGBA. Mask capture is validated but not scored.',
  design: {
    mainMatrix: '2 mappings x 2 source/output row directions x 3 coordinate arithmetics x 10 kernels = 120',
    supplements: '8 endpoint candidates: 4 absolute-f32 weighted kernels across both axis orders/directions; 2 weighted-X-Y with incremental-f32 X/incremental-f64 Y; 2 double-incremental horizontal-term-floor-except-fy-zero hypotheses, one per row direction',
    legacyPrefix: { count: 128, ids: legacyCandidateIds },
    precisionSupplement: {
      mapping: 'endpoint', kernel: 'horizontal-term-floor-except-fy-zero',
      directions: ['top-down', 'bottom-up'], xArithmetic: precisionArithmetic, yArithmetic: precisionArithmetic,
      combinations: 32, reused: 2, added: 30,
      combinationIds: precisionCombinationIds, reusedIds: precisionReusedIds, addedIds: precisionAddedIds,
    },
    roundedStepSupplement: {
      mapping: 'endpoint', kernel: 'horizontal-term-floor-except-fy-zero',
      directions: ['top-down', 'bottom-up'], arithmetic: stepArithmetic,
      combinations: 50, reused: 32, added: 18,
      combinationIds: stepCombinationIds, reusedIds: stepReusedIds, addedIds: stepAddedIds,
      previousPrefix: { count: 158, ids: previousCandidateIds },
    },
    geometryInput: 'One original constant-1, 32bpp AND fixture per each of the seven mask geometries; all mask variants share its observed color plane',
    axisRules: 'endpoint: step=(source-1)/(target-1), origin=0; center: step=source/target, origin=step/2-1/2; f32 rounds ratio, origin, and every multiply/add or accumulation; incremental-f32-step-f64 rounds only the ratio to binary32 and accumulates in binary64; no near-integer snapping',
    directionRules: 'bottom-up starts at the bottom source/output memory row and accumulates positive Y; raw reference is independently normalized to top-down',
    kernelRules: 'weighted=(1-f)*a+f*b; lerp=a+(b-a)*f; staged floors first-axis results before second-axis blend; four-tap floors each byte*Xweight*Yweight; horizontal-term-floor-except-fy-zero floors each horizontal term before vertical weighting unless fy==0, where it floors the complete horizontal sum only; all interpolators floor final bytes; nearest rounds clamped coordinates',
    pixelArithmetic: 'binary64; f32 variants change axis arithmetic only',
    rankingOrder: ['differentPixels', 'differentChannels', 'absoluteError', 'candidateId'],
  }, candidateCount: candidates.length, candidates,
  observedFixtures, geometryFixtures, eligibleFixtures, comparedTargets, resizedTargets,
  rankings: { allTargets: ranking(allRanks), resizedTargets: ranking(resizedRanks) },
  zeroDifferenceCandidates: ranking(allRanks).filter((entry) => !entry.differentPixels).map((entry) => entry.candidateId),
  errors, fixtures,
}, null, 2) + '\n')

try {
  const bytes = readFileSync(file('observations.json')), native = JSON.parse(bytes.toString()) as Observation
  observationSha256 = hash(bytes)
  assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/i, 'Expected workflow commit is missing')
  assert.equal(native.schema, 1)
  assert.equal(native.sourceCommit, process.env.GITHUB_SHA, 'Native observation commit differs from this workflow')
  assert.equal(native.completed, true, 'Native capture did not complete')
  assert.equal(native.cleanupFailed, false, 'Native capture cleanup failed')
  assert(Array.isArray(native.fixtures) && native.fixtures.length > 0 && native.fixtures.length <= 512)
  assert.equal(native.observedFixtures, native.expectedFixtures)
  assert.equal(native.fixtures.length, native.expectedFixtures)
  assert.deepEqual(native.platform.systemCursor, { width: 32, height: 32 })
  assert.equal(native.platform.displayBitsPerPixel, 32)
  assert.deepEqual(native.platform.dpi, { x: 96, y: 96 })
  observedFixtures = native.fixtures.length
  const geometryBytes = readFileSync(file('mask-geometry.json')),
    geometry = JSON.parse(geometryBytes.toString()) as GeometryObservation,
    shapeNames = new Set(['64x64', '48x48', '13x9', '64x48', '48x64', '64x13', '13x64']),
    extra: NativeFixture[] = []
  geometryObservationSha256 = hash(geometryBytes)
  assert.equal(geometry.schema, 1); assert.equal(geometry.sourceCommit, native.sourceCommit)
  assert.equal(geometry.completed, true); assert.equal(geometry.cleanupFailed, false); assert.equal(geometry.failures, 0)
  assert.equal(geometry.expectedSamples, 2670); assert.equal(geometry.observedSamples, 2670)
  assert.equal(geometry.samples.length, 2670)
  assert.deepEqual(geometry.platform.systemCursor, native.platform.systemCursor)
  assert.equal(geometry.platform.displayBitsPerPixel, native.platform.displayBitsPerPixel)
  assert.deepEqual(geometry.platform.dpi, native.platform.dpi)
  for (const sample of geometry.samples) {
    if (sample.depth !== 32 || sample.pattern.kind !== 'constant' || sample.pattern.plane !== 'AND' || sample.pattern.constant !== 1) continue
    const shape: string = `${sample.width}x${sample.height}`
    assert(shapeNames.delete(shape), 'Duplicate or unexpected constant-color geometry')
    assert.equal(sample.loaded, true)
    extra.push({ id: sample.id, file: sample.file, kind: 'cur', loaded: sample.loaded,
      entries: [{ width: sample.width, height: sample.height, depth: sample.depth }], info: sample.info, steps: [{ step: 0 }] })
  }
  assert.equal(shapeNames.size, 0); assert.equal(extra.length, 7)
  geometryFixtures = extra.length
  const ids = new Set<string>()
  save()
  for (const fixture of [...native.fixtures, ...extra]) {
    const targets: Record<string, unknown>[] = [], excludedSteps: Record<string, unknown>[] = [],
      fixtureMetrics = new Map<string, FixtureMeasurement>(candidates.map(({ id }) => [id, {
        candidateId: id, targets: 0, comparedPixels: 0, comparedChannels: 0,
        differentPixels: 0, differentChannels: 0, absoluteError: 0,
        maximumChannelDifference: 0, firstDifference: null,
      }])),
      record: Record<string, unknown> = { id: fixture.id, file: fixture.file,
        nativeLoaded: fixture.loaded, status: 'inspecting', targets, excludedSteps }
    fixtures.push(record)
    try {
      assert.equal(typeof fixture.id, 'string')
      assert(!ids.has(fixture.id), 'Duplicate native fixture identity')
      ids.add(fixture.id)
      if (!fixture.loaded) { record.status = 'excluded-native-rejected'; continue }
      const raw = readFileSync(file(fixture.file))
      record.sourceSha256 = hash(raw)
      // The recorded directory is used only to exclude ambiguous selection,
      // never to choose a source image or synthesize an expected color plane.
      if (fixture.kind === 'cur') {
        assert(raw.length >= 6)
        if (raw.readUInt16LE(4) !== 1) { record.status = 'excluded-multiple-directory-images'; continue }
      } else {
        assert.equal(fixture.kind, 'ani')
        assert(Array.isArray(fixture.ani?.frameEntries) && fixture.ani.frameEntries.length > 0)
        assert(fixture.ani.frameEntries.every((entries) => Array.isArray(entries)), 'Incomplete ANI directory metadata')
        if (fixture.ani.frameEntries.some((entries) => entries.length !== 1)) {
          record.status = 'excluded-multiple-directory-images'
          continue
        }
      }
      const asset = await decodeCursor(raw, { png: async (payload) => {
        const parser = decodePng(payload)
        assert(parser, 'Selected source has no PNG decoder')
        const plan = finish(parser)
        return finish(plan.decode(inflateSync(plan.compressed, { maxOutputLength: plan.expandedLength })))
      } })
      assert.equal(asset.kind, fixture.kind)
      assert(asset.frames.every((frame) => frame.images.length === 1), 'Decoded directory differs from single-image metadata')
      record.source = { kind: asset.kind, sequence: asset.sequence, rates: asset.rates,
        frames: asset.frames.map((frame) => frame.images.map(({ width, height, depth, encoding, mode }) =>
          ({ width, height, depth, encoding, mode }))) }
      assert(Array.isArray(fixture.steps))
      assert(asset.sequence.length > 0 && asset.sequence.length <= 32, 'Unbounded source animation')
      for (let step = 0; step < asset.sequence.length; step++) {
        const frameIndex = asset.sequence[step]!, image = asset.frames[frameIndex]!.images[0]!
        if (image.depth !== 32) { excludedSteps.push({ step, frameIndex, reason: 'source depth is not 32bpp', depth: image.depth }); continue }
        const references = fixture.steps.filter((entry) => entry.step === step)
        assert.equal(references.length, 1, `${fixture.id}: missing or duplicate native step ${step}`)
        const reference = references[0]!,
          info = asset.kind === 'cur' ? reference.frameInfo?.info ?? fixture.info
            : reference.frameInfo?.available && reference.frameInfo.ok ? reference.frameInfo.info : undefined,
          actual = nativePixels(info, `${fixture.id}/step-${step}`),
          resized = image.width !== actual.width || image.height !== actual.height,
          measurements: Record<string, unknown>[] = []
        assert.equal(actual.width, 32)
        assert.equal(actual.height, 32)
        assert(comparedTargets < 4096, 'Diagnostic target budget exceeded')
        targets.push({ step, frameIndex, resized, mode: image.mode,
          sourceSize: { width: image.width, height: image.height },
          targetSize: { width: actual.width, height: actual.height },
          channels: image.mode === 'alpha' ? 'RGBA' : 'RGB',
          colorPlane: actual.colorPlane, maskPlane: actual.maskPlane, measurements })
        for (const candidate of candidates) {
          const metrics = compare(image, actual.rgba, actual.width, actual.height, candidate),
            total = fixtureMetrics.get(candidate.id)!
          measurements.push({ candidateId: candidate.id, ...metrics })
          total.targets++
          for (const field of ['comparedPixels', 'comparedChannels', 'differentPixels', 'differentChannels', 'absoluteError'] as const)
            total[field] += metrics[field]
          total.maximumChannelDifference = Math.max(total.maximumChannelDifference, metrics.maximumChannelDifference)
          if (!total.firstDifference && metrics.firstDifference)
            total.firstDifference = { ...metrics.firstDifference, step, frameIndex }
          aggregate(allRanks.get(candidate.id)!, fixture.id, metrics)
          if (resized) aggregate(resizedRanks.get(candidate.id)!, fixture.id, metrics)
        }
        comparedTargets++
        if (resized) resizedTargets++
      }
      record.extraObservedSteps = fixture.steps.filter((entry) => entry.step < 0 || entry.step >= asset.sequence.length).map((entry) => entry.step)
      record.status = targets.length ? 'measured' : 'excluded-no-32bpp-source'
      if (targets.length) eligibleFixtures++
    } catch (error) {
      record.status = 'diagnostic-input-error'
      record.error = describeError(error)
      errors.push({ fixture: fixture.id, ...describeError(error) })
    } finally {
      record.measurements = [...fixtureMetrics.values()].filter((entry) => entry.targets)
      save()
    }
  }
  assert(eligibleFixtures > 0 && comparedTargets > 0, 'No single-image 32bpp fixture was measured')
  assert(resizedTargets > 0, 'No actual scaling target was measured')
  assert.equal(errors.length, 0, 'Incomplete diagnostic input; see scaling-candidates.json')
  // Even when every candidate has differences, the diagnostic is complete.
  // This is not a compatibility verdict and cannot make the strict load gate green.
  status = 'diagnostic-complete'
  save()
  process.stdout.write(`Cursor scaling diagnostic complete: ${eligibleFixtures} fixtures, ${comparedTargets} targets, ${candidates.length} candidates; no policy selected.\n`)
} catch (error) {
  status = 'diagnostic-failed'
  fatalError = describeError(error)
  save()
  throw error
}
