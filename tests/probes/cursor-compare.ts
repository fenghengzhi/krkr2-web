// Read the same bytes passed to Win32; execute only in the hosted reference job.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import { decodeCursor, compositeCursor } from '../../src/formats/cursor/index.ts'
import { decodePng } from '../../src/formats/image/png.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const directory = resolve(process.argv[2] ?? 'out/ci/native-cursor'),
  file = (name: string) => {
    const result = resolve(directory, name)
    assert(result.startsWith(directory + sep), 'Reference filename escapes artifact directory')
    return result
  },
  bytes = readFileSync(file('observations.json')),
  native = JSON.parse(bytes.toString()) as {
    schema: number
    sourceCommit: string
    completed: boolean
    expectedFixtures: number
    observedFixtures: number
    cleanupFailed: boolean
    fixtures: {
      id: string; file: string; loaded: boolean
      info?: { ok: boolean; width: number; height: number; hotspot: { x: number; y: number } }
      steps: {
        step: number
        frameInfo?: { available: boolean; ok?: boolean; rateJiffies?: number; steps?: number
          info?: { ok: boolean; width: number; height: number; hotspot: { x: number; y: number } } }
        draws: {
          flags: number; drawX: number; drawY: number; requestedWidth: number; requestedHeight: number
          backgroundRGB: number; canvasWidth: number; canvasHeight: number; stride: number
          ok: boolean; pixelsFile: string
        }[]
      }[]
    }[]
  }
assert.equal(native.schema, 1)
assert.equal(native.completed, true, 'Native observation process did not complete')
assert.equal(native.cleanupFailed, false, 'Native observation process reported cleanup failure')
assert(Array.isArray(native.fixtures) && native.fixtures.length)
assert.equal(native.observedFixtures, native.expectedFixtures)
assert.equal(native.fixtures.length, native.expectedFixtures)
assert.equal(native.sourceCommit, process.env.GITHUB_SHA)

function finish<T>(work: Generator<void, T>): T {
  for (;;) { const step = work.next(); if (step.done) return step.value }
}
const results: Record<string, unknown>[] = []
let failures = 0, compared = 0, unscaledMatches = 0
let status: 'running' | 'passed' | 'failed' = 'running'
const save = () => writeFileSync(file('portable-comparison.json'), JSON.stringify({
  schema: 1, sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  observationSha256: createHash('sha256').update(bytes).digest('hex'),
  scope: 'Unscaled DI_NORMAL RGB against the same CUR/ANI bytes; scaled and ambiguous selection remain observations',
  status, fixtures: results, failures, compared, unscaledMatches,
}, null, 2) + '\n')
save()
for (const fixture of native.fixtures) {
  const raw = readFileSync(file(fixture.file)),
    record: Record<string, unknown> = {
      id: fixture.id, sourceSha256: createHash('sha256').update(raw).digest('hex'),
      nativeLoaded: fixture.loaded, status: 'decoding', draws: [],
    }
  results.push(record)
  save()
  try {
    const asset = await decodeCursor(raw, { png: async (payload) => {
      const parser = decodePng(payload)
      assert(parser)
      const plan = finish(parser), expanded = inflateSync(plan.compressed, { maxOutputLength: plan.expandedLength })
      return finish(plan.decode(expanded))
    } })
    record.asset = {
      kind: asset.kind, sequence: asset.sequence, rates: asset.rates,
      durationJiffies: asset.durationJiffies, decodedBytes: asset.decodedBytes,
      frames: asset.frames.map((frame) => frame.images.map(({ width, height, hotspot, depth, encoding, mode }) =>
        ({ width, height, hotspot, depth, encoding, mode }))),
    }
    if (!fixture.loaded) {
      record.status = 'native-rejected-portable-accepted'
      // This is an acceptance difference, never a native rendering pass.
      continue
    }
    record.status = 'observed'
    assert.equal(fixture.info?.ok, true, 'Native cursor dimensions or hotspot could not be queried')
    const draws = record.draws as Record<string, unknown>[]
    for (const step of fixture.steps) {
      const frameIndex = asset.sequence[step.step % asset.sequence.length]!, frame = asset.frames[frameIndex]!,
        info = step.frameInfo?.info ?? fixture.info,
        hotspotComparable = asset.kind === 'cur' || step.step === 0 || !!step.frameInfo?.info
      for (const draw of step.draws) {
        const row: Record<string, unknown> = {
          step: step.step, frameIndex, pixelsFile: draw.pixelsFile,
          flags: draw.flags, status: 'uncompared', reason: '',
          rateJiffies: asset.rates[step.step],
          nativeFrameMetadata: step.frameInfo,
        }
        draws.push(row)
        if (step.step < 0 || step.step >= asset.sequence.length) { row.reason = 'Out-of-range native step characterization'; continue }
        if ((draw.flags & 3) !== 3) { row.reason = 'Separate native mask/image observation'; continue }
        if (!info || !info.ok) {
          row.status = 'missing-reference'; row.reason = 'Missing native dimensions'; failures++; continue
        }
        const width = draw.requestedWidth || info.width, height = draw.requestedHeight || info.height,
          candidates = frame.images.map((image, index) => ({ image, index }))
            .filter(({ image }) => image.width === width && image.height === height &&
              image.width === info.width && image.height === info.height)
        if (!candidates.length) { row.reason = 'OS resized the selected image; scaling contract is still pending'; continue }
        if (!draw.ok) {
          row.reason = 'In-range native DI_NORMAL drawing failed'
          if (frame.images.length === 1) { row.status = 'missing-reference'; failures++ }
          continue
        }
        const observed = readFileSync(file(draw.pixelsFile)), pixels = draw.canvasWidth * draw.canvasHeight
        assert(draw.stride === draw.canvasWidth * 4 && observed.length === pixels * 4)
        const comparisons = []
        for (const { image, index } of candidates) {
          const expected = new Uint8Array(pixels * 4)
          for (let pixel = 0; pixel < pixels; pixel++) {
            expected[pixel * 4] = draw.backgroundRGB >>> 16 & 255
            expected[pixel * 4 + 1] = draw.backgroundRGB >>> 8 & 255
            expected[pixel * 4 + 2] = draw.backgroundRGB & 255
            expected[pixel * 4 + 3] = 255
          }
          compositeCursor(image, { width: draw.canvasWidth, height: draw.canvasHeight, data: expected }, draw.drawX, draw.drawY)
          let differentPixels = 0, maximumChannelDifference = 0
          const firstDifferences: Record<string, unknown>[] = []
          for (let pixel = 0; pixel < pixels; pixel++) {
            const at = pixel * 4, rgb = [observed[at + 2]!, observed[at + 1]!, observed[at]!],
              wanted = [...expected.subarray(at, at + 3)]
            if (rgb.some((value, c) => value !== wanted[c])) {
              differentPixels++
              maximumChannelDifference = Math.max(maximumChannelDifference,
                ...rgb.map((value, c) => Math.abs(value - wanted[c]!)))
              if (firstDifferences.length < 16) firstDifferences.push({ x: pixel % draw.canvasWidth,
                y: Math.floor(pixel / draw.canvasWidth), observed: rgb, expected: wanted })
            }
          }
          comparisons.push({ index, differentPixels, maximumChannelDifference, firstDifferences,
            hotspotCompared: hotspotComparable,
            hotspotMatches: hotspotComparable ? image.hotspot.x === info.hotspot.x && image.hotspot.y === info.hotspot.y : null })
        }
        row.candidates = comparisons
        if (frame.images.length !== 1) { row.reason = 'Multiple source images: selection policy is not inferred from the closest pixel result'; continue }
        compared++
        const match = comparisons[0]!
        if (match.differentPixels || match.hotspotMatches === false) { row.status = 'mismatch'; failures++ }
        else { row.status = 'matched'; unscaledMatches++ }
        row.reason = 'Single candidate, unchanged dimensions, actual native RGB and hotspot comparison'
      }
    }
  } catch (error) {
    record.status = record.asset ? 'comparison-error'
      : fixture.loaded ? 'native-accepted-portable-rejected' : 'both-rejected'
    record.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    // These are candidate semantics. Preserve every rejection for review; a
    // native-accepted fixture cannot silently disappear from a green result.
    if (fixture.loaded) failures++
  } finally { save() }
}
status = failures || !compared ? 'failed' : 'passed'
save()
assert(compared > 0, 'No unscaled single-candidate native pixels were compared')
assert.equal(failures, 0, 'Native cursor comparison found candidate differences; see portable-comparison.json')
