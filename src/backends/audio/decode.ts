import type { AudioAsset, SoundKind } from '../../engine/ports/audio.ts'
import { emptyLoops } from '../../engine/ports/audio.ts'
import { decodeWav } from '../../formats/audio/wav.ts'
import { decodeMidi } from '../../formats/audio/midi.ts'
import { encodedSampleRate } from '../../formats/audio/encoded-rate.ts'

/** Runs in the session Worker (or headless host), never the realtime worklet. */
export async function decodePortableAudio(
  bytes: Uint8Array,
  kind: SoundKind,
): Promise<AudioAsset | undefined> {
  if (kind === 'midi') return decodeMidi(bytes)
  const wave = decodeWav(bytes)
  if (wave) return wave
  if (bytes.length < 28 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'OggS') return
  const header = 27 + bytes[26]!
  if (
    bytes[header] !== 1 ||
    String.fromCharCode(...bytes.subarray(header + 1, header + 7)) !== 'vorbis'
  )
    return
  const sampleRate = encodedSampleRate(bytes)!,
    channels = bytes[header + 11]!
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let expected: bigint | undefined
  for (let at = 0; at < bytes.length;) {
    const count = bytes[at + 26]!,
      body = at + 27 + count
    let length = 0
    for (let i = 0; i < count; i++) length += bytes[at + 27 + i]!
    if (bytes[at + 5]! & 4) {
      expected = view.getBigUint64(at + 6, true)
      if (body + length !== bytes.length) throw new Error('Data after the Ogg end-of-stream page')
    }
    at = body + length
  }
  if (expected === undefined) throw new Error('Vorbis file has no end-of-stream position')
  if (
    channels < 1 ||
    channels > 8 ||
    expected < 1n ||
    expected * BigInt(channels) * 4n > 128n * 1024n * 1024n
  )
    throw new Error('Vorbis exceeds the channel or decoded PCM budget')
  const { OggVorbisDecoder } = await import('@wasm-audio-decoders/ogg-vorbis')
  const decoder = new OggVorbisDecoder()
  try {
    await decoder.ready
    const samples = Number(expected),
      decoded = Array.from({ length: channels }, () => new Float32Array(samples))
    let position = 0
    const append = (result: Awaited<ReturnType<typeof decoder.decode>>) => {
      if (result.errors.length)
        throw new Error(`Vorbis decode failed: ${result.errors[0]!.message}`)
      if (!result.samplesDecoded) return
      if (
        result.sampleRate !== sampleRate ||
        result.channelData.length !== channels ||
        position + result.samplesDecoded > samples
      )
        throw new Error('Vorbis decoded format disagrees with its stream header')
      for (let channel = 0; channel < channels; channel++)
        decoded[channel]!.set(result.channelData[channel]!, position)
      position += result.samplesDecoded
    }
    // Bounded input chunks avoid retaining a second full decoded file and
    // reject output beyond the advertised granule/memory budget while decoding.
    for (let at = 0; at < bytes.length; at += 16384)
      append(await decoder.decode(bytes.subarray(at, at + 16384)))
    append(await decoder.flush())
    if (position !== samples)
      throw new Error('Vorbis decoded length disagrees with its end position')
    // Convert Vorbis speaker order to the WAVE/Web Audio order used by the mixer.
    const order: Record<number, number[]> = {
      3: [0, 2, 1],
      5: [0, 2, 1, 3, 4],
      6: [0, 2, 1, 5, 3, 4],
      7: [0, 2, 1, 6, 3, 4, 5],
      8: [0, 2, 1, 7, 5, 6, 3, 4],
    }
    const data = order[channels]?.map((index) => decoded[index]!) ?? decoded
    return {
      kind: 'pcm',
      sampleRate,
      sampleCount: samples,
      channels,
      bits: 16,
      data,
      loops: emptyLoops(),
    }
  } finally {
    decoder.free()
  }
}
