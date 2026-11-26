import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { selectMp4Tracks, selectMp4TracksBlob } from '../../src/formats/video/mp4-audio.ts'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'

interface Box { kind: string; start: number; body: number; end: number }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result: Box[] = []
  for (let at = start; at < end;) {
    const size = view.getUint32(at), header = size === 1 ? 16 : 8,
      length = size === 1 ? Number(view.getBigUint64(at + 8)) : size || end - at
    assert(length >= header && length <= end - at)
    result.push({ kind: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), start: at, body: at + header, end: at + length })
    at += length
  }
  return result
}
function headers(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    child = (box: Box) => boxes(bytes, box.body, box.end),
    one = (items: Box[], kind: string) => { const result = items.filter((box) => box.kind === kind); assert.equal(result.length, 1); return result[0]! },
    movie = one(boxes(bytes), 'moov'), contents = child(movie), mvhd = one(contents, 'mvhd'),
    field = (box: Box, track = false) => {
      const version = bytes[box.body], at = box.body + (track ? (version ? 28 : 20) : (version ? 24 : 16))
      return { at, width: version ? 8 : 4, value: version ? view.getBigUint64(at) : BigInt(view.getUint32(at)) }
    },
    tracks = contents.filter((box) => box.kind === 'trak').map((box) => {
      const tkhd = one(child(box), 'tkhd'), mdia = one(child(box), 'mdia'), mdhd = one(child(mdia), 'mdhd')
      return { box, tkhd, mdhd, id: view.getUint32(tkhd.body + (bytes[tkhd.body] ? 20 : 12)),
        scale: view.getUint32(mdhd.body + (bytes[mdhd.body] ? 20 : 12)), media: field(mdhd), track: field(tkhd, true) }
    })
  return { movie, contents, mvhd, duration: field(mvhd), scale: view.getUint32(mvhd.body + (bytes[mvhd.body] ? 20 : 12)), tracks }
}
const fixture = (name: string) => Uint8Array.from(readFileSync(`out/verification/video-tracks/${name}.mp4`))
interface PacketReport {
  sha256: string
  streams: Array<{ id: string; index: number; time_base: string }>
  packets: Array<{ stream_index: number; pts: number; dts: number; duration: number; pos: string; size: string; data_hash: string }>
}

for (const name of ['fragmented', 'separate-fragments', 'interleaved'])
  test(`finite ${name} selected media publishes complete durations without changing any FFmpeg packet or PTS`, async () => {
    const source = fixture(name), original = headers(source), sourceHash = hash(source),
      report = JSON.parse(readFileSync(`out/verification/video-tracks/${name}.mp4.packets.json`, 'utf8')) as PacketReport,
      timeline = await readVideoTimeline(source)
    assert.equal(report.sha256, sourceHash)
    assert.equal(original.duration.value, 0n)
    assert(original.tracks.every((track) => track.media.value === 0n && track.track.value === 0n))
    for (const audio of [0, 1]) {
      const result = await selectMp4Tracks(source, { video: 0, audio }, { completeFragmentDurations: true }),
        unchangedHeaders = await selectMp4Tracks(source, { video: 0, audio })
      assert(result); assert(unchangedHeaders)
      const actual = headers(result.bytes)
      let movieEnd = 0n
      for (const track of actual.tracks) {
        const stream = report.streams.find((stream) => Number(stream.id) === track.id)!
        assert(stream)
        assert.equal(stream.time_base, `1/${track.scale}`)
        const packets = report.packets.filter((packet) => packet.stream_index === stream.index)
        assert(packets.length > 50)
        let end = 0n
        for (const packet of packets) {
          assert(Number.isSafeInteger(packet.pts) && Number.isSafeInteger(packet.duration))
          const packetEnd = BigInt(packet.pts) + BigInt(packet.duration)
          if (packetEnd > end) end = packetEnd
          const at = Number(packet.pos), length = Number(packet.size)
          assert.equal(hash(result.bytes.subarray(at, at + length)), packet.data_hash.slice(7).toLowerCase(),
            'The independent ffprobe packet bytes, including delayed audio, remain at their original offsets')
        }
        assert.equal(track.media.value, end)
        const movieTicks = (end * BigInt(actual.scale) + BigInt(track.scale) - 1n) / BigInt(track.scale)
        assert.equal(track.track.value, movieTicks)
        if (movieTicks > movieEnd) movieEnd = movieTicks
      }
      assert.equal(actual.duration.value, movieEnd)
      assert(actual.duration.value > BigInt(actual.scale) * 6n)
      for (const box of boxes(source).filter((box) => ['moof', 'mdat'].includes(box.kind))) {
        assert.deepEqual(result.bytes.subarray(box.start, box.end),
          (box.kind === 'mdat' ? source : unchangedHeaders.bytes).subarray(box.start, box.end),
          'Every retained fragment timestamp, sample duration and payload byte is unchanged by header completion')
      }
      const after = await readVideoTimeline(result.bytes)
      assert.deepEqual(after?.times, timeline?.times); assert.equal(after?.duration, timeline?.duration)
      const blob = new Blob([source]), reads: Array<[number, number]> = [],
        media = boxes(source).filter((box) => box.kind === 'mdat'),
        selectedBlob = await selectMp4TracksBlob({ size: blob.size, slice(start = 0, end = blob.size) {
          assert(!media.some((box) => start < box.end && end > box.body), 'No mdat payload read is needed to complete duration')
          return { async arrayBuffer() { reads.push([start, end]); return blob.slice(start, end).arrayBuffer() } }
        } }, { video: 0, audio }, { completeFragmentDurations: true })
      assert(selectedBlob); assert(reads.length > 1)
      const parts: BlobPart[] = []
      let offset = 0
      for (const patch of selectedBlob.patches) { parts.push(blob.slice(offset, patch.offset), patch.bytes); offset = patch.offset + patch.bytes.length }
      parts.push(blob.slice(offset))
      assert.deepEqual(new Uint8Array(await new Blob(parts).arrayBuffer()), result.bytes)
    }
    assert.equal(hash(source), sourceHash)
  })

/** Reuse space from the removed audio track inside moov. Media, moof and
 * absolute random-access offsets never move; only authored metadata changes. */
function edited(source: Uint8Array, openEnded: boolean) {
  const bytes = Uint8Array.from(source), h = headers(bytes), view = new DataView(bytes.buffer), track = h.tracks[0]!,
    padding = h.contents.find((box) => box.kind === 'free')!
  assert(padding); assert(padding.end - padding.start > 64)
  const edit = new Uint8Array(48), ed = new DataView(edit.buffer)
  ed.setUint32(0, 48); edit.set([101, 100, 116, 115], 4) // edts
  ed.setUint32(8, 40); edit.set([101, 108, 115, 116], 12) // elst
  ed.setUint32(20, 2)
  ed.setUint32(24, h.scale / 2); ed.setInt32(28, -1); ed.setUint32(32, 0x10000)
  ed.setUint32(36, openEnded ? 0 : h.scale * 3); ed.setInt32(40, 0); ed.setUint32(44, 0x10000)
  const replacement = new Uint8Array(track.box.end - track.box.start + edit.length)
  replacement.set(bytes.subarray(track.box.start, track.box.end)); replacement.set(edit, track.box.end - track.box.start)
  new DataView(replacement.buffer).setUint32(0, replacement.length)
  const free = new Uint8Array(padding.end - padding.start - edit.length)
  new DataView(free.buffer).setUint32(0, free.length); free.set([102, 114, 101, 101], 4)
  let at = h.movie.body
  for (const box of h.contents) {
    const data = box === track.box ? replacement : box === padding ? free : source.subarray(box.start, box.end)
    bytes.set(data, at); at += data.length
  }
  assert.equal(at, h.movie.end)
  // Author an audio tail which is longer than the edited video, using the
  // independently parsed original track. Its declared duration must survive.
  const updated = headers(bytes), audio = updated.tracks[1]!
  view.setUint32(audio.track.at, updated.scale * 7)
  return bytes
}

test('duration completion preserves declared lengths, edit-list empty time, long audio and uncertain metadata', async () => {
  const selected = await selectMp4Tracks(fixture('fragmented'), { video: 0, audio: 0 })
  assert(selected)
  const source = edited(selected.bytes, false), before = headers(source),
    result = await selectMp4Tracks(source, { video: 0, audio: 0 }, { completeFragmentDurations: true })
  assert(result)
  const after = headers(result.bytes)
  assert.equal(after.tracks[0]!.track.value, BigInt(after.scale * 3.5), 'Initial half-second empty edit plus three-second clip')
  assert.equal(after.tracks[1]!.track.value, BigInt(after.scale * 7), 'An existing audio duration is never rewritten')
  assert.equal(after.duration.value, BigInt(after.scale * 7), 'Movie duration includes the retained audio tail')
  assert.equal(before.duration.value, 0n)
  const oversized = Uint8Array.from(selected.bytes), header = headers(oversized)
  new DataView(oversized.buffer).setUint32(header.mvhd.body + 12, 0xffffffff) // movie ticks cannot fit the original 32-bit fields
  for (const uncertain of [edited(selected.bytes, true), oversized]) {
    const legacy = await selectMp4Tracks(uncertain, { video: 0, audio: 0 }),
      repaired = await selectMp4Tracks(uncertain, { video: 0, audio: 0 }, { completeFragmentDurations: true })
    assert.deepEqual(repaired?.bytes, legacy?.bytes, 'Uncertain/open-ended/overflowing metadata keeps the original duration fields')
  }
})
