import { wave } from './audio.ts'

/** A 72 MiB PCM16 WAVE with 144 MiB decoded Float32 data. Generate only the
 * requested encoded ranges so the hosted test does not need a giant fixture. */
export function longWave() {
  const dataBytes = 72 * 1024 * 1024, size = dataBytes + 44, rate = 48000,
    samples = dataBytes / 2, header = Buffer.from(wave([], rate))
  header.writeUInt32LE(size - 8, 4)
  header.writeUInt32LE(dataBytes, 40)
  return { size, rate, samples, read(offset: number, length: number) {
    const bytes = Buffer.alloc(length)
    for (let index = 0; index < length; index++) {
      const at = offset + index
      if (at < 44) bytes[index] = header[at]!
      else {
        const sample = Math.round(Math.sin(Math.floor((at - 44) / 2) * Math.PI * 2 / 96) * 12000)
        bytes[index] = (at - 44) % 2 ? (sample >> 8) & 255 : sample & 255
      }
    }
    return bytes
  } }
}

const u16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes }
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes }
const chunk = (tag: string, data: Buffer) => Buffer.concat([Buffer.from(tag), u64(data.length), data])

/** Raw XP3 entries preserve true range access; payload verification is covered
 * separately by stored-ZIP CRC and archive tests. No compressed fallback here. */
export function longAudioArchive(startup: string, sli: string) {
  const audio = longWave(), script = Buffer.from(startup), labels = Buffer.from(sli),
    entries = [
      { name: 'startup.tjs', size: script.length, read: (at: number, length: number) => script.subarray(at, at + length) },
      { name: 'long.wav.sli', size: labels.length, read: (at: number, length: number) => labels.subarray(at, at + length) },
      { name: 'long.wav', ...audio },
    ]
  let next = 19
  const ranges = entries.map((entry) => { const result = { ...entry, offset: next }; next += entry.size; return result })
  const index = Buffer.concat(ranges.map((entry) => chunk('File', Buffer.concat([
    chunk('info', Buffer.concat([u32(0), u64(entry.size), u64(entry.size), u16(entry.name.length), Buffer.from(entry.name, 'utf16le')])),
    chunk('segm', Buffer.concat([u32(0), u64(entry.offset), u64(entry.size), u64(entry.size)])),
  ]))))
  const header = Buffer.concat([Buffer.from([88, 80, 51, 13, 10, 32, 10, 26, 139, 103, 1]), u64(next)]),
    tail = Buffer.concat([Buffer.from([0]), u64(index.length), index]),
    pieces = [
      { offset: 0, size: header.length, read: (at: number, length: number) => header.subarray(at, at + length) },
      ...ranges,
      { offset: next, size: tail.length, read: (at: number, length: number) => tail.subarray(at, at + length) },
    ]
  return { size: next + tail.length, audio, audioOffset: ranges[2]!.offset,
    read(offset: number, length: number) {
      const bytes = Buffer.alloc(length)
      for (const piece of pieces) {
        const start = Math.max(offset, piece.offset), end = Math.min(offset + length, piece.offset + piece.size)
        if (end > start) piece.read(start - piece.offset, end - start).copy(bytes, start - offset)
      }
      return bytes
    },
  }
}
