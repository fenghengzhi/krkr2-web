import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { decodePortableAudio } from '../../src/backends/audio/decode.ts'
import { waveRiffFiles, waveRiffNames, waveRiffPcm } from '../helpers/wave-riff-layout.ts'

test('ordinary Wave ignores only the outer RIFF size and selects the original first fmt/data pair in full and streaming decoders', async () => {
  const files = waveRiffFiles(), expected = [waveRiffPcm, waveRiffPcm.map((value) => -value)]
  for (const name of waveRiffNames) {
    const bytes = files[name]!, reads: Array<[number, number]> = [],
      range = await openPortablePcmSource({ size: bytes.length, async read(offset, length) {
        reads.push([offset, length]); return bytes.subarray(offset, offset + length)
      } }, { waveNativeRiff: true })
    assert(range)
    try {
      const full = await decodePortableAudio(bytes, 'wave'); assert(full?.kind === 'pcm')
      assert.equal(range.info.sampleRate, 1000); assert.equal(range.info.sampleCount, 60)
      assert.equal(full.sampleRate, 1000); assert.equal(full.sampleCount, 60)
      assert.deepEqual(full.data.map((plane) => [...plane]), expected)
      for (const [at, count] of [[0, 60], [17, 31], [59, 2], [0, 1]] as const)
        assert.deepEqual((await range.read(at, count)).map((plane) => [...plane]), expected.map((plane) => plane.slice(at, at + count)))
      assert(reads.every(([, length]) => length <= 65536))
    } finally { await range.close() }
  }
})

test('generic WAVE readers retain RIFF bounds, standard alignment and their existing last-chunk selection', async () => {
  const files = waveRiffFiles(), first = files['riff-first.wav']!, full = decodeWav(first)!
  assert.equal(full.sampleRate, 2000); assert.deepEqual([...full.data[0]!], Array(60).fill(-.75))
  const source = await openPortablePcmSource({ size: first.length, read: async (at, count) => first.subarray(at, at + count) })
  assert(source)
  try { assert.equal(source.info.sampleRate, 2000); assert.deepEqual([...(await source.read(0, 60))[0]!], Array(60).fill(-.75)) }
  finally { await source.close() }
  for (const name of ['riff-long.wav', 'riff-unpadded.wav']) {
    const bytes = files[name]!
    assert.throws(() => decodeWav(bytes), /Truncated WAVE/)
    await assert.rejects(openPortablePcmSource({ size: bytes.length, read: async (at, count) => bytes.subarray(at, at + count) }), /Truncated WAVE/)
  }
  assert.equal(decodeWav(files['riff-short.wav']!), undefined)
  const padded = decodeWav(files['riff-padded.wav']!)!
  assert.deepEqual([...padded.data[0]!], waveRiffPcm)
})

test('original RIFF discovery still enforces actual data bytes and stops metadata reads at the selected data header', async () => {
  const files = waveRiffFiles(), bytes = files['riff-first.wav']!,
    firstDataHeader = 12 + 8 + 240 + 24, selectedEnd = firstDataHeader + 8 + 240,
    reads: Array<[number, number]> = [], source = await openPortablePcmSource({ size: bytes.length, async read(at, count) {
      reads.push([at, count]); assert(at + count <= selectedEnd); return bytes.subarray(at, at + count)
    } }, { waveNativeRiff: true })
  assert(source)
  try {
    assert(reads.every(([at, count]) => at + count <= firstDataHeader + 8), 'open must not scan later data or read selected PCM')
    assert.deepEqual([...(await source.read(59, 1))[0]!], [.75])
  } finally { await source.close() }
  const truncated = files['riff-zero.wav']!.slice(0, -1)
  assert.throws(() => decodeWav(truncated, { nativeRiff: true }), /Truncated WAVE data chunk/)
  await assert.rejects(openPortablePcmSource({ size: truncated.length, read: async (at, count) => truncated.subarray(at, at + count) },
    { waveNativeRiff: true }), /Truncated WAVE data chunk/)
  const paddedShort = files['riff-padded.wav']!.slice(0, -1)
  assert.throws(() => decodeWav(paddedShort, { nativeRiff: true }), /Truncated WAVE data chunk/)
  await assert.rejects(openPortablePcmSource({ size: paddedShort.length, read: async (at, count) => paddedShort.subarray(at, at + count) },
    { waveNativeRiff: true }), /Truncated WAVE data chunk/)
  const padded = files['riff-padded.wav']!, later = bytes.subarray(selectedEnd), duplicate = new Uint8Array(padded.length + later.length)
  duplicate.set(padded); duplicate.set(later, padded.length)
  new DataView(duplicate.buffer).setUint32(4, duplicate.length - 8, true)
  assert.equal(decodeWav(duplicate)!.sampleRate, 2000, 'generic last-chunk selection remains a distinct control')
  const selected = decodeWav(duplicate, { nativeRiff: true })!
  assert.equal(selected.sampleRate, 1000); assert.deepEqual([...selected.data[0]!], waveRiffPcm)
  const paddedRange = await openPortablePcmSource({ size: duplicate.length, read: async (at, count) => duplicate.subarray(at, at + count) },
    { waveNativeRiff: true })
  assert(paddedRange)
  try { assert.equal(paddedRange.info.sampleRate, 1000); assert.deepEqual([...(await paddedRange.read(0, 60))[0]!], waveRiffPcm) }
  finally { await paddedRange.close() }
  // An old unpadded scan can land in silent PCM and see many zero-sized
  // pseudo-chunks. Standard long recordings must still reach the bounded
  // padded fallback rather than scanning their entire data payload.
  const header = padded.slice(0, 56), dataBytes = 8 * 1024 * 1024
  new DataView(header.buffer).setUint32(4, dataBytes + 48, true)
  new DataView(header.buffer).setUint32(52, dataBytes, true)
  let readBytes = 0, readCalls = 0
  const silence = await openPortablePcmSource({ size: header.length + dataBytes, async read(at, count) {
    readBytes += count; readCalls++
    const value = new Uint8Array(count)
    if (at < header.length) value.set(header.subarray(at, Math.min(header.length, at + count)))
    return value
  } }, { waveNativeRiff: true })
  assert(silence)
  try {
    assert.equal(silence.info.sampleCount, dataBytes / 4)
    assert(readBytes < 1024 * 1024, 'padded fallback must remain metadata-bounded in long silence')
    assert(readCalls < 256, 'long silence must not require a remote round trip per empty pseudo-chunk')
    assert.deepEqual((await silence.read(0, 1)).map((plane) => [...plane]), [[0], [0]])
  } finally { await silence.close() }
})
