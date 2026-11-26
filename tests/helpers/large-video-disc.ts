import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { largeVideoGame } from './large-video-game.ts'

/** Use the original genisoimage primary descriptor, path tables and root.
 * Replace the one scene record with ISO level 3 multi-extent movie records.
 * A sector of unrelated bytes separates the two sections inside the mdat. */
export async function largeVideoDisc(directory: string, startup: string) {
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
  return { paths: [paths[0]!, path], size, mediaStart }
}
