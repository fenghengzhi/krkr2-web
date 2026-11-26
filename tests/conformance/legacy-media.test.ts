import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { convertLegacyMovie } from '../../src/backends/video/legacy/convert.ts'
import { validateLegacyMediaManifest, type LegacyMediaFactory, type LegacyMediaManifest } from '../../src/backends/video/legacy/module.ts'
import { readVideoTimelineBlob } from '../../src/formats/video/mp4.ts'
import { legacyVideoFormat } from '../../src/backends/video/legacy/format.ts'
import { inspectLegacyAudio } from '../helpers/legacy-audio-reference.ts'
import { inspectLegacyPictures } from '../helpers/legacy-picture-reference.ts'

interface InputReference {
  file: string; bytes: number; sha256: string; audioCodec: string | null; videoCodec: string; videoTag: string
  fps: number; normalizedVideoTimes: number[]
  audioInputOffset: number
  audioTracks?: { index: number; codec: string; streamId: string; tone: number }[]
}

for (const group of [
  { label: 'MPEG and AVI', reference: 'legacy-video-reference.json', output: 'legacy-media',
    required: ['legacy-program.mpg', 'legacy-mjpeg.avi', 'legacy-elementary.m1v', 'legacy-ntsc.mpv'] },
  { label: 'MPEG-2 program streams and Xvid AVI', reference: 'mpeg2-xvid-reference.json', output: 'mpeg2-xvid',
    required: ['legacy-mpeg2.mpg', 'legacy-xvid.avi'] },
  { label: 'ASF with WMV1/WMA1 and WMV2/WMA2', reference: 'windows-media-reference.json', output: 'windows-media',
    required: ['legacy-wmv1.wmv', 'legacy-wmv2.wmv'] },
  { label: 'QuickTime Animation and MPEG-4 Part 2', reference: 'quicktime-reference.json', output: 'quicktime',
    required: ['legacy-animation.mov', 'legacy-part2.mp4'] },
  { label: 'Windows Media 9', reference: 'wmv9-reference.json', output: 'wmv9', required: ['legacy-wmv9.wmv'] },
  { label: 'VC-1 Advanced Profile with WMA Professional', reference: 'vc1-reference.json', output: 'vc1', required: ['legacy-vc1.wmv'] },
  { label: 'AVI with MS Video 1/IMA ADPCM and DivX 3/Microsoft ADPCM', reference: 'avi-adpcm-reference.json', output: 'avi-adpcm',
    required: ['legacy-msvideo1.avi', 'legacy-div3.avi'] },
  { label: 'MPEG-2 with selectable AC-3 and DVD LPCM', reference: 'dvd-audio-reference.json', output: 'dvd-audio',
    required: ['legacy-bilingual.mpg'] },
]) test(`the actual single-thread legacy WASM decodes authored ${group.label} into complete selectable MP4 timelines`, { timeout: 600000 }, async () => {
  const directory = resolve('.generated/legacy-media'), fixtures = resolve('out/verification/video-tracks'),
    output = resolve('out/ci', group.output), hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as LegacyMediaManifest,
    reference = JSON.parse(readFileSync(resolve(fixtures, group.reference), 'utf8')) as {
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
  for (const name of group.required) assert(reference.fixtures.some((entry) => entry.file === name))
  if (group.output === 'windows-media')
    assert.deepEqual(reference.fixtures.map((entry) => [entry.videoCodec, entry.audioCodec]), [['wmv1', 'wmav1'], ['wmv2', 'wmav2']])
  if (group.output === 'quicktime')
    assert.deepEqual(reference.fixtures.map((entry) => [entry.videoCodec, entry.videoTag, entry.audioCodec]),
      [['qtrle', 'rle ', 'pcm_s16be'], ['mpeg4', 'mp4v', 'aac']])
  if (group.output === 'wmv9' || group.output === 'vc1')
    assert.deepEqual(reference.fixtures.map((entry) => [entry.videoCodec, entry.videoTag, entry.audioCodec]),
      [group.output === 'wmv9' ? ['wmv3', 'WMV3', 'wmav2'] : ['vc1', 'WVC1', 'wmapro']])
  if (group.output === 'mpeg2-xvid') {
    assert.deepEqual(reference.fixtures.map((entry) => [entry.videoCodec, entry.audioCodec]), [['mpeg2video', 'mp2'], ['mpeg4', 'mp3']])
    assert.equal(reference.fixtures.find((entry) => entry.file === 'legacy-xvid.avi')?.videoTag, 'XVID')
  }
  if (group.output === 'avi-adpcm')
    assert.deepEqual(reference.fixtures.map((entry) => [entry.videoCodec, entry.videoTag, entry.audioCodec]),
      [['msvideo1', 'MSVC', 'adpcm_ima_wav'], ['msmpeg4v3', 'DIV3', 'adpcm_ms']])
  for (const entry of reference.fixtures) {
    const log: string[] = [], observation: Record<string, unknown> = { input: entry.file, videoCodec: entry.videoCodec, audioCodec: entry.audioCodec }
    observations.push(observation)
    try {
      const bytes = new Uint8Array(readFileSync(resolve(fixtures, entry.file)))
      assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256)
      // Each CLI invocation is a fresh native process, as in the real Worker.
      const format = group.output === 'quicktime' ? 'mov' : legacyVideoFormat(entry.file)
      assert(format)
      const module = await factory({ wasmBinary, noInitialRun: true, print: (line) => log.push(line), printErr: (line) => log.push(line),
        locateFile: (name) => resolve(directory, name) }),
        blob = convertLegacyMovie(module, bytes, format, log),
        converted = new Uint8Array(await blob.arrayBuffer()), timeline = await readVideoTimelineBlob(blob)
      const moviePath = resolve(output, entry.file + '.mp4')
      writeFileSync(moviePath, converted)
      Object.assign(observation, { outputBytes: converted.length, outputSha256: hash(converted), timeline })
      assert.equal(blob.type, 'video/mp4'); assert.equal(String.fromCharCode(...converted.subarray(4, 8)), 'ftyp')
      assert(timeline)
      assert.equal(timeline.videoStreams, 1); assert.equal(timeline.audioStreams, entry.audioTracks?.length ?? (entry.audioCodec ? 1 : 0))
      if (group.output === 'dvd-audio') {
        assert.equal(entry.videoCodec, 'mpeg2video')
        assert.deepEqual(entry.audioTracks!.map((track, index) => {
          assert.equal(track.index, index)
          return [track.codec, Number(track.streamId), track.tone]
        }).sort(), [['ac3', 0x80, 440], ['pcm_dvd', 0xa0, 880]])
      }
      assert.equal(timeline.times.length, reference.frames)
      assert.equal(timeline.videoTracks![0]!.width, reference.width)
      assert.equal(timeline.videoTracks![0]!.height, reference.height)
      const fps = entry.file === 'legacy-ntsc.mpv' ? 30000 / 1001 : reference.fps
      assert.equal(entry.fps, fps)
      assert(Math.abs(timeline.frameDuration - 1000 / fps) < .001)
      const expected = entry.normalizedVideoTimes.map((time) => time * 1000)
      observation.expectedTimes = expected
      assert.equal(expected.length, reference.frames)
      assert(expected.every(Number.isFinite))
      for (const [index, time] of timeline.times.entries())
        assert(Math.abs(time - expected[index]!) < .1, `${entry.file} frame ${index}: ${time} ms / independent source ${expected[index]} ms`)
      const decodedFailures: unknown[] = []
      if (['windows-media', 'wmv9', 'vc1', 'quicktime', 'dvd-audio'].includes(group.output)) try { inspectLegacyPictures(moviePath, entry.normalizedVideoTimes, observation) }
      catch (error) { decodedFailures.push(error) }
      for (const track of entry.audioTracks ?? (entry.audioCodec ? [undefined] : [])) try {
        inspectLegacyAudio(moviePath, entry.audioInputOffset, observation, track)
      }
      catch (error) { decodedFailures.push(error) }
      if (decodedFailures.length === 1) throw decodedFailures[0]
      if (decodedFailures.length) throw new AggregateError(decodedFailures, 'Independent picture and audio comparisons failed', { cause: decodedFailures[0] })
      observation.matched = true
    } catch (error) { observation.error = String(error); failures.push(error) }
    finally { observation.log = log }
  }
  writeFileSync(resolve(output, 'comparison.json'), JSON.stringify({ complete: !failures.length, manifest, cinepak: reference.cinepak,
    scope: 'Real pinned WASM decoding and encoding, independent source timestamps and system FFmpeg audio readback. Windows Media and bilingual MPEG check all 100 picture markers and display timestamps within 0.1 ms. Bilingual MPEG also checks independent silence and tone windows for each decoded audio track.',
    observations }, null, 2) + '\n')
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Legacy movie conversions failed', { cause: failures[0] })
})
