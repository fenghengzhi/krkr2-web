import assert from 'node:assert/strict'
import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { largeVideoGame } from './large-video-game.ts'

/** Use the original genisoimage primary descriptor, path tables and root.
 * Replace the one scene record with ISO level 3 multi-extent movie records.
 * A sector of unrelated bytes separates the two sections inside the mdat. */
export async function largeVideoDisc(directory: string, startup: string, raw = false) {
  const { paths, size, mediaStart } = await largeVideoGame(directory, false, startup)
  const sector = 2048, base = await readFile('out/verification/disc-volumes/plain.iso')
  const pvd = base.subarray(16 * sector, 17 * sector)
  assert.equal(pvd.toString('ascii', 1, 6), 'CD001')
  assert.equal(pvd.readUInt16LE(128), sector)
  const rootStart = pvd.readUInt32LE(158) * sector, root = base.subarray(rootStart, rootStart + sector)
  let record = 0
  while (root[record] && root.toString('ascii', record + 33, record + 33 + root[record + 32]!) !== 'SCENE.TXT;1')
    record += root[record]!
  const length = root[record]!
  assert(length >= 44 && record + length * 2 <= sector && root[record + length] === 0)
  const split = (Math.floor(mediaStart / sector) + 1) * sector
  assert(split > mediaStart && split < size)
  const start = base.length, gap = start + split
  assert.equal(start % sector, 0)
  const both = (buf: Buffer, at: number, value: number) => {
    buf.writeUInt32LE(value, at); buf.writeUInt32BE(value, at + 4)
  }
  both(pvd, 80, Math.ceil((start + size) / sector) + 1)
  root.set(root.slice(record, record + length), record + length)
  for (const [index, at, bytes] of [[0, start, split], [1, gap + sector, size - split]] as const) {
    const section = root.subarray(record + index * length, record + (index + 1) * length)
    assert.equal(section[32], 11)
    section.write('MOVIE.MP4;1', 33, 'ascii'); section[25] = index === 0 ? 128 : 0
    both(section, 2, at / sector); both(section, 10, bytes)
  }
  const path = join(directory, 'Game.iso'), movie = await open(paths[1]!, 'r')
  try {
    const iso = await open(path, 'wx')
    try {
      await iso.truncate(pvd.readUInt32LE(80) * sector)
      const put = async (buffer: Buffer, at: number) =>
        assert.equal((await iso.write(buffer, 0, buffer.length, at)).bytesWritten, buffer.length)
      // The source helper creates a sparse hole between the mdat header and
      // the first packet. Preserve it while splitting the actual packet data.
      const prefix = Buffer.alloc(sector), tail = Buffer.alloc(size - mediaStart)
      assert.equal((await movie.read(prefix, 0, prefix.length, 0)).bytesRead, prefix.length)
      assert.equal((await movie.read(tail, 0, tail.length, mediaStart)).bytesRead, tail.length)
      await put(base, 0); await put(prefix, start); await put(Buffer.alloc(sector, 0xa5), gap)
      await put(tail.subarray(0, split - mediaStart), start + mediaStart)
      await put(tail.subarray(split - mediaStart), gap + sector)
    } finally { await iso.close() }
  } finally { await movie.close() }
  if (!raw) return { paths: [paths[0]!, path], size, mediaStart }
  const bin = join(directory, 'Game.bin'), cue = join(directory, 'Game.cue')
  const cooked = await open(path, 'r')
  try {
    const dest = await open(bin, 'wx')
    try {
      const input = Buffer.alloc(256 * sector), output = Buffer.alloc(256 * 2352)
      for (let at = 0; at < pvd.readUInt32LE(80); at += 256) {
        const sectors = Math.min(256, pvd.readUInt32LE(80) - at), count = sectors * sector
        assert.equal((await cooked.read(input, 0, count, at * sector)).bytesRead, count)
        for (let n = 0; n < sectors; n++) {
          const frame = output.subarray(n * 2352, (n + 1) * 2352)
          frame.fill(255, 1, 11); frame[15] = 1
          input.copy(frame, 16, n * sector, (n + 1) * sector)
        }
        assert.equal((await dest.write(output, 0, sectors * 2352, at * 2352)).bytesWritten, sectors * 2352)
      }
    } finally { await dest.close() }
  } finally { await cooked.close() }
  await writeFile(cue, 'FILE "Game.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n')
  return { paths: [paths[0]!, cue, bin], size, mediaStart }
}
