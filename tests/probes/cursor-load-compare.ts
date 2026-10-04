// Compare actual LoadCursorFromFile handles, including selection and resizing.
// Run only on GitHub-hosted Windows; never infer success from unexamined draws.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import { decodeCursor, compositeCursor, type CursorAsset } from '../../src/formats/cursor/index.ts'
import { loadCursorAsset, windowsDesktopCursorProfile } from '../../src/formats/cursor/load.ts'
import { decodePng } from '../../src/formats/image/png.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const directory = resolve(process.argv[2] ?? 'out/ci/native-cursor'),
  file = (name: string) => {
    const path = resolve(directory, name)
    assert(path.startsWith(directory + sep), 'Reference filename escapes artifact directory')
    return path
  }, bytes = readFileSync(file('observations.json'))
interface NativeInfo {
  ok: boolean; width: number; height: number; hotspot: { x: number; y: number }
}
interface NativeDraw {
  flags: number; drawX: number; drawY: number; requestedWidth: number; requestedHeight: number
  backgroundRGB: number; canvasWidth: number; canvasHeight: number; stride: number
  ok: boolean; pixelsFile: string
}
const native = JSON.parse(bytes.toString()) as {
  schema: number; sourceCommit: string; completed: boolean; cleanupFailed: boolean
  expectedFixtures: number; observedFixtures: number
  platform: { systemCursor: { width: number; height: number }; displayBitsPerPixel: number; dpi: { x: number; y: number } }
  fixtures: { id: string; file: string; loaded: boolean; info?: NativeInfo; ani?: { steps: number }
    steps: { step: number; frameInfo?: { available: boolean; ok?: boolean; info?: NativeInfo }; draws: NativeDraw[] }[] }[]
}
assert.equal(native.schema, 1)
assert.equal(native.completed, true)
assert.equal(native.cleanupFailed, false)
assert.equal(native.sourceCommit, process.env.GITHUB_SHA)
assert.equal(native.observedFixtures, native.expectedFixtures)
assert.equal(native.fixtures.length, native.expectedFixtures)
assert(native.fixtures.length > 0)
assert.deepEqual(native.platform.systemCursor, { width: 32, height: 32 })
assert.equal(native.platform.displayBitsPerPixel, 32)
assert.deepEqual(native.platform.dpi, { x: 96, y: 96 })

function finish<T>(work: Generator<void, T>): T {
  for (;;) { const step = work.next(); if (step.done) return step.value }
}
const results: Record<string, unknown>[] = []
let failures = 0, compared = 0, matches = 0, uncompared = 0
let status: 'running' | 'passed' | 'failed' = 'running'
const save = () => writeFileSync(file('load-comparison.json'), JSON.stringify({
  schema: 1, sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  observationSha256: createHash('sha256').update(bytes).digest('hex'), profile: windowsDesktopCursorProfile,
  scope: 'File-load acceptance and natural-size DI_NORMAL RGB/hotspot after native-profile selection and scaling; not wall-clock playback',
  status, failures, compared, matches, uncompared, fixtures: results,
}, null, 2) + '\n')
save()
for (const fixture of native.fixtures) {
  const raw = readFileSync(file(fixture.file)), record: Record<string, unknown> = {
    id: fixture.id, sourceSha256: createHash('sha256').update(raw).digest('hex'),
    nativeLoaded: fixture.loaded, status: 'loading', draws: [],
  }
  results.push(record)
  save()
  let asset: CursorAsset
  try {
    const source = await decodeCursor(raw, { png: async (payload) => {
      const parser = decodePng(payload)
      assert(parser)
      const plan = finish(parser), expanded = inflateSync(plan.compressed, { maxOutputLength: plan.expandedLength })
      return finish(plan.decode(expanded))
    } })
    asset = await loadCursorAsset(source)
  } catch (error) {
    record.status = fixture.loaded ? 'native-accepted-portable-rejected' : 'both-rejected'
    record.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    if (fixture.loaded) failures++
    save()
    continue
  }
  if (!fixture.loaded) {
    record.status = 'native-rejected-portable-accepted'
    failures++
    save()
    continue
  }
  try {
    record.status = 'loaded'
    record.asset = { sequence: asset.sequence, rates: asset.rates, decodedBytes: asset.decodedBytes,
      frames: asset.frames.map((frame) => frame.images.map(({ width, height, hotspot, depth, encoding, mode }) =>
        ({ width, height, hotspot, depth, encoding, mode }))) }
    const draws = record.draws as Record<string, unknown>[], expectedSteps = fixture.ani?.steps ?? 1,
      requiredSteps = new Set<number>()
    assert(Number.isSafeInteger(expectedSteps) && expectedSteps > 0 && expectedSteps < 32,
      'The bounded reference must capture every source ANI step')
    for (let step = 0; step < expectedSteps; step++) requiredSteps.add(step)
    if (asset.sequence.length !== expectedSteps) {
      record.stepCountMismatch = { expected: expectedSteps, actual: asset.sequence.length }
      failures++
    }
    for (const step of fixture.steps) for (const draw of step.draws) {
      const row: Record<string, unknown> = { step: step.step, pixelsFile: draw.pixelsFile, status: 'uncompared' }
      draws.push(row)
      if (step.step < 0 || step.step >= expectedSteps || (draw.flags & 3) !== 3 ||
          draw.requestedWidth !== 0 || draw.requestedHeight !== 0) {
        row.reason = 'Extra DrawIconEx scaling, isolated mask/image, or out-of-range step is outside this load comparison'
        uncompared++
        continue
      }
      requiredSteps.delete(step.step)
      compared++
      if (!Number.isSafeInteger(asset.sequence[step.step]) || !asset.frames[asset.sequence[step.step]!]) {
        row.status = 'missing-portable-frame'
        failures++
        continue
      }
      const frameIndex = asset.sequence[step.step]!, frame = asset.frames[frameIndex]!,
        image = frame.images[0]!, info = step.frameInfo?.info ?? fixture.info,
        hotspotComparable = asset.kind === 'cur' || step.step === 0 || !!step.frameInfo?.info
      assert.equal(frame.images.length, 1, 'Loaded handle must select exactly one image per frame')
      assert(info?.ok && draw.ok, 'Required native dimensions or drawing are missing')
      row.frameIndex = frameIndex
      row.nativeInfo = info
      row.dimensionsMatch = image.width === info.width && image.height === info.height
      row.hotspotCompared = hotspotComparable
      row.hotspotMatches = hotspotComparable
        ? image.hotspot.x === info.hotspot.x && image.hotspot.y === info.hotspot.y : null
      const observed = readFileSync(file(draw.pixelsFile)), pixels = draw.canvasWidth * draw.canvasHeight,
        expected = new Uint8Array(pixels * 4)
      assert(draw.stride === draw.canvasWidth * 4 && observed.length === pixels * 4)
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
          maximumChannelDifference = Math.max(maximumChannelDifference, ...rgb.map((value, c) => Math.abs(value - wanted[c]!)))
          if (firstDifferences.length < 32) firstDifferences.push({ x: pixel % draw.canvasWidth,
            y: Math.floor(pixel / draw.canvasWidth), observed: rgb, expected: wanted })
        }
      }
      Object.assign(row, { differentPixels, maximumChannelDifference, firstDifferences })
      if (!hotspotComparable) {
        row.status = 'missing-reference'
        row.reason = 'A noninitial ANI frame hotspot was not observed; RGB alone is not a full match'
        failures++
      } else if (differentPixels || !row.dimensionsMatch || row.hotspotMatches === false) {
        row.status = 'mismatch'
        failures++
      } else { row.status = 'matched'; matches++ }
    }
    assert.equal(requiredSteps.size, 0, 'A required native frame has no natural-size DI_NORMAL observation')
  } catch (error) {
    record.status = 'comparison-error'
    record.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    failures++
  } finally { save() }
}
status = failures || !compared ? 'failed' : 'passed'
save()
assert(compared > 0, 'No natural-size loaded cursor image was compared')
assert.equal(failures, 0, 'Native cursor loading differs; see load-comparison.json')
