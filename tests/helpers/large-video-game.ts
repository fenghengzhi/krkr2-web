import assert from 'node:assert/strict'
import { open, readFile, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { xp3Signature } from './xp3-fixtures.ts'

interface Box { type: string; start: number; end: number }
function boxes(bytes: Buffer, start: number, end: number): Box[] {
  const result: Box[] = []
  for (let at = start; at < end;) {
    const size = bytes.readUInt32BE(at)
    assert(size >= 8 && size <= end - at)
    result.push({ type: bytes.toString('ascii', at + 4, at + 8), start: at, end: at + size })
    at += size
  }
  return result
}
const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes }
const chunk = (tag: string, body: Buffer) => Buffer.concat([Buffer.from(tag), u64(body.length), body])
function xp3Entry(name: string, segments: { size: number; offset: number }[]) {
  const size = segments.reduce((total, segment) => total + segment.size, 0)
  const length = Buffer.alloc(2)
  length.writeUInt16LE(name.length)
  return chunk('File', Buffer.concat([
    chunk('info', Buffer.concat([Buffer.alloc(4), u64(size), u64(size), length, Buffer.from(name, 'utf16le')])),
    chunk('segm', Buffer.concat(segments.map((segment) =>
      Buffer.concat([Buffer.alloc(4), u64(segment.offset), u64(segment.size), u64(segment.size)])))),
  ]))
}

/** Write the tail first, then another game file, then the beginning. Logical
 * index order must be observed even when a borrow crosses the intervening file. */
export async function writeSegmentedMovieXp3(path: string, moviePath: string, name: string, size: number,
  split: number, startup: string) {
  assert(Number.isSafeInteger(split) && split > 0 && split < size)
  const script = Buffer.from(startup), tailAt = 19, scriptAt = tailAt + size - split,
    headAt = scriptAt + script.length, indexAt = headAt + split,
    index = Buffer.concat([xp3Entry('startup.tjs', [{ size: script.length, offset: scriptAt }]),
      xp3Entry(name, [{ size: split, offset: headAt }, { size: size - split, offset: tailAt }])])
  async function* bytes() {
    yield Buffer.concat([xp3Signature, u64(indexAt)])
    yield* createReadStream(moviePath, { start: split })
    yield script
    yield* createReadStream(moviePath, { end: split - 1 })
    yield Buffer.concat([Buffer.alloc(1), u64(index.length), index])
  }
  await pipeline(bytes(), createWriteStream(path, { flags: 'wx' }))
}

/** A sparse hole inside mdat places both the authored FFmpeg H.264/AAC packets
 * and the tail moov beyond the caller's chosen boundary. Only the absolute
 * chunk offsets change. The app's MP4 parser and selector are not used here. */
export async function largeVideoGame(directory: string, archive: boolean, startup: string, padding = 144 * 1024 * 1024) {
  const small = await readFile('out/verification/video-tracks/video-multitrack.mp4'),
    top = boxes(small, 0, small.length)
  const one = (kind: string) => {
    const matching = top.filter((box) => box.type === kind)
    assert.equal(matching.length, 1)
    return matching[0]!
  }
  const ftyp = one('ftyp'), mdat = one('mdat'), moov = one('moov'),
    brand = small.subarray(ftyp.start, ftyp.end), movie = Buffer.from(small.subarray(moov.start, moov.end)),
    packets = small.subarray(mdat.start + 8, mdat.end),
    mediaStart = brand.length + 16 + padding, size = mediaStart + packets.length + movie.length
  let relocated = 0
  const relocate = (start: number, end: number) => {
    for (const box of boxes(movie, start, end)) {
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.type)) relocate(box.start + 8, box.end)
      if (box.type === 'co64') throw new Error('Unexpected 64-bit table in small authored FFmpeg fixture')
      if (box.type !== 'stco') continue
      const count = movie.readUInt32BE(box.start + 12)
      assert.equal(box.start + 16 + count * 4, box.end)
      for (let i = 0; i < count; i++) {
        const at = box.start + 16 + i * 4, original = movie.readUInt32BE(at)
        assert(original >= mdat.start + 8 && original < mdat.end)
        movie.writeUInt32BE(mediaStart + original - mdat.start - 8, at)
        relocated++
      }
    }
  }
  relocate(0, movie.length)
  assert(relocated >= 4)
  const header = Buffer.alloc(16)
  header.writeUInt32BE(1)
  header.write('mdat', 4)
  header.writeBigUInt64BE(BigInt(16 + padding + packets.length), 8)
  const script = Buffer.from(startup), offset = archive ? 19 + script.length : 0,
    path = join(directory, archive ? 'data.xp3' : 'cutscene.mp4'), file = await open(path, 'w')
  try {
    if (archive) {
      const index = Buffer.concat([xp3Entry('startup.tjs', [{ size: script.length, offset: 19 }]),
        xp3Entry('cutscene.mp4', [{ size, offset }])])
      const prefix = Buffer.concat([xp3Signature, u64(offset + size), script]),
        tail = Buffer.concat([Buffer.alloc(1), u64(index.length), index])
      assert.equal((await file.write(prefix, 0, prefix.length, 0)).bytesWritten, prefix.length)
      assert.equal((await file.write(tail, 0, tail.length, offset + size)).bytesWritten, tail.length)
    }
    const prefix = Buffer.concat([brand, header]), tail = Buffer.concat([packets, movie])
    assert.equal((await file.write(prefix, 0, prefix.length, offset)).bytesWritten, prefix.length)
    assert.equal((await file.write(tail, 0, tail.length, offset + mediaStart)).bytesWritten, tail.length)
  } finally { await file.close() }
  if (archive) return { paths: [path], size, mediaStart }
  const entry = join(directory, 'startup.tjs')
  await writeFile(entry, script)
  return { paths: [entry, path], size, mediaStart }
}
