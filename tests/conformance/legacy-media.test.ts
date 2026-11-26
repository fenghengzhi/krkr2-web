import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { convertLegacyMovie } from '../../src/backends/video/legacy/convert.ts'
import { validateLegacyMediaManifest, type LegacyMediaFactory, type LegacyMediaManifest } from '../../src/backends/video/legacy/module.ts'
import { readVideoTimelineBlob } from '../../src/formats/video/mp4.ts'

interface InputReference {
  file: string; bytes: number; sha256: string; audioCodec: string | null; videoCodec: string
  normalizedVideoTimes: number[]
}

test('the actual single-thread legacy WASM decodes authored MPEG and AVI into complete selectable MP4 timelines', { timeout: 600000 }, async () => {
  const directory = resolve('.generated/legacy-media'), fixtures = resolve('out/verification/video-tracks'),
    output = resolve('out/ci/legacy-media'), hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as LegacyMediaManifest,
    reference = JSON.parse(readFileSync(resolve(fixtures, 'legacy-video-reference.json'), 'utf8')) as {
      complete: boolean; frames: number; fps: number; width: number; height: number; fixtures: InputReference[]; cinepak: unknown
    }, observations: unknown[] = [], failures: unknown[] = []
  mkdirSync(output, { recursive: true })
  validateLegacyMediaManifest(manifest)
  assert.equal(reference.complete, true)
  for (const kind of ['mjs', 'wasm'] as const) {
    const bytes = readFileSync(resolve(directory, manifest.assets[kind].file))
    assert.equal(bytes.length, manifest.assets[kind].bytes); assert.equal(hash(bytes), manifest.assets[kind].sha256)
  }
  const { default: factory } = await import(pathToFileURL(resolve(directory, manifest.assets.mjs.file)).href) as { default: LegacyMediaFactory },
    wasmBinary = new Uint8Array(readFileSync(resolve(directory, manifest.assets.wasm.file)))
  assert(reference.fixtures.some((entry) => entry.file === 'legacy-program.mpg'))
  assert(reference.fixtures.some((entry) => entry.file === 'legacy-mjpeg.avi'))
  assert(reference.fixtures.some((entry) => entry.file === 'legacy-elementary.m1v'))
  for (const entry of reference.fixtures) {
    const log: string[] = [], observation: Record<string, unknown> = { input: entry.file, videoCodec: entry.videoCodec, audioCodec: entry.audioCodec }
    observations.push(observation)
    try {
      const bytes = new Uint8Array(readFileSync(resolve(fixtures, entry.file)))
      assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256)
      // Each CLI invocation is a fresh native process, as in the real Worker.
      const module = await factory({ wasmBinary, noInitialRun: true, print: (line) => log.push(line), printErr: (line) => log.push(line),
        locateFile: (name) => resolve(directory, name) }),
        blob = convertLegacyMovie(module, bytes, entry.file.endsWith('.avi') ? 'avi' : entry.file.endsWith('.m1v') ? 'mpegvideo' : 'mpeg', log),
        converted = new Uint8Array(await blob.arrayBuffer()), timeline = await readVideoTimelineBlob(blob)
      writeFileSync(resolve(output, entry.file + '.mp4'), converted)
      assert.equal(blob.type, 'video/mp4'); assert.equal(String.fromCharCode(...converted.subarray(4, 8)), 'ftyp')
      assert(timeline)
      assert.equal(timeline.videoStreams, 1); assert.equal(timeline.audioStreams, entry.audioCodec ? 1 : 0)
      assert.equal(timeline.times.length, reference.frames)
      assert.equal(timeline.videoTracks![0]!.width, reference.width)
      assert.equal(timeline.videoTracks![0]!.height, reference.height)
      assert(Math.abs(timeline.frameDuration - 1000 / reference.fps) < .001)
      const expected = entry.normalizedVideoTimes.map((time) => time * 1000)
      assert.equal(expected.length, reference.frames)
      assert(expected.every(Number.isFinite))
      for (const [index, time] of timeline.times.entries())
        assert(Math.abs(time - expected[index]!) < .1, `${entry.file} frame ${index}: ${time} ms / independent source ${expected[index]} ms`)
      Object.assign(observation, { matched: true, outputBytes: converted.length, outputSha256: hash(converted), timeline, expectedTimes: expected })
    } catch (error) { observation.error = String(error); failures.push(error) }
    finally { observation.log = log }
  }
  writeFileSync(resolve(output, 'comparison.json'), JSON.stringify({ complete: !failures.length, manifest, cinepak: reference.cinepak,
    scope: 'Real pinned WASM decoding and encoding; independent input frame timestamps. Browser tests separately require visible frame markers, shared full RGBA and actual audio. Lossy conversion is not original DirectShow sample identity.',
    observations }, null, 2) + '\n')
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Legacy movie conversions failed', { cause: failures[0] })
})
