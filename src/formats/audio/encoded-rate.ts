/** Original sample clock for formats delegated to the browser decoder.
 * decodeAudioData resamples to its context rate, so SLI positions require a
 * decoding context at the source rate, independently of the output device. */
export function encodedSampleRate(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number, count: number) => String.fromCharCode(...bytes.subarray(at, at + count))
  const checked = (rate: number) => {
    if (rate < 1000 || rate > 384000) throw new Error('Encoded audio sample rate is outside range')
    return rate
  }
  if (text(0, 4) === 'OggS') {
    let serial: number | undefined, rate: number | undefined
    for (let at = 0; at < bytes.length;) {
      if (at + 27 > bytes.length || text(at, 4) !== 'OggS' || bytes[at + 4] !== 0)
        throw new Error('Malformed Ogg page')
      const count = bytes[at + 26]!,
        body = at + 27 + count
      if (body > bytes.length) throw new Error('Truncated Ogg segment table')
      let length = 0
      for (let i = 0; i < count; i++) length += bytes[at + 27 + i]!
      if (body + length > bytes.length) throw new Error('Truncated Ogg page')
      const stream = view.getUint32(at + 14, true)
      if (at > 0 && bytes[at + 5]! & 2)
        throw new Error('Chained or multiplexed Ogg audio is not supported')
      if (serial !== undefined && serial !== stream)
        throw new Error('Chained or multiplexed Ogg audio is not supported')
      if (serial === undefined) {
        if (!(bytes[at + 5]! & 2) || bytes[at + 5]! & 1 || !count)
          throw new Error('Ogg audio must begin with its identification packet')
        serial = stream
        const first = bytes[at + 27]!
        if (first >= 30 && bytes[body] === 1 && text(body + 1, 6) === 'vorbis') {
          if (view.getUint32(body + 7, true) !== 0 || !bytes[body + 11] || !(bytes[body + 29]! & 1))
            throw new Error('Invalid Vorbis identification header')
          rate = checked(view.getUint32(body + 12, true))
        } else if (first >= 19 && text(body, 8) === 'OpusHead') {
          if (bytes[body + 8]! > 15 || !bytes[body + 9])
            throw new Error('Invalid Opus identification header')
          rate = 48000 // Opus granule clock; its input-rate field is informational.
        } else return
      }
      at = body + length
    }
    return rate
  }
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') {
    const end = view.getUint32(4, true) + 8
    if (end > bytes.length) throw new Error('Truncated WAVE file')
    for (let at = 12; at + 8 <= end;) {
      const length = view.getUint32(at + 4, true),
        start = at + 8
      if (start + length > end) throw new Error('Truncated WAVE chunk')
      if (text(at, 4) === 'fmt ' && length >= 16) return checked(view.getUint32(start + 4, true))
      at = start + length + (length & 1)
    }
  }
  // MPEG audio may have an ID3v2 header before its first frame.
  let start = 0
  if (bytes.length >= 10 && text(0, 3) === 'ID3') {
    if (bytes.subarray(6, 10).some((value) => value & 128)) throw new Error('Invalid ID3 size')
    start = 10 + (bytes[6]! << 21) + (bytes[7]! << 14) + (bytes[8]! << 7) + bytes[9]!
    if (bytes[3] === 4 && bytes[5]! & 16) start += 10
    if (start > bytes.length) throw new Error('Truncated ID3 tag')
  }
  for (let at = start; at < Math.min(bytes.length - 3, start + 4096); at++) {
    if (bytes[at] !== 255 || (bytes[at + 1]! & 224) !== 224) continue
    const version = (bytes[at + 1]! >> 3) & 3,
      layer = (bytes[at + 1]! >> 1) & 3,
      bitrate = bytes[at + 2]! >> 4,
      index = (bytes[at + 2]! >> 2) & 3
    if (version === 1 || layer === 0 || bitrate === 0 || bitrate === 15 || index === 3) continue
    return [44100, 48000, 32000][index]! / (version === 3 ? 1 : version === 2 ? 2 : 4)
  }
}
