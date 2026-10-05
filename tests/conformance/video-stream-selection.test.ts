import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readVideoTimeline, selectVideoTimeline } from '../../src/formats/video/mp4.ts'
import { selectMp4Tracks, selectMp4AudioTrack } from '../../src/formats/video/mp4-audio.ts'

interface Box { kind: string; start: number; body: number; end: number }
interface Packet { stream_index: number; pos: string; size: string; pts: number; duration: number; data_hash: string }
interface Stream { index: number; id: string; codec_type: string; width?: number; height?: number; time_base: string }
const names = ['video-multitrack.mp4', 'video-fragmented.mp4', 'video-interleaved.mp4', 'video-separate.mp4'],
  directory = resolve('out/verification/video-tracks'),
  fixture = (name: string) => new Uint8Array(readFileSync(resolve(directory, name))),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  text = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result: Box[] = []
  for (let at = start; at < end;) {
    const short = data.getUint32(at), header = short === 1 ? 16 : 8,
      length = short === 1 ? Number(data.getBigUint64(at + 8)) : short || end - at
    assert(length >= header && length <= end - at)
    result.push({ kind: text(bytes, at + 4), start: at, body: at + header, end: at + length })
    at += length
  }
  return result
}
const inside = (bytes: Uint8Array, box: Box) => boxes(bytes, box.body, box.end)
function one(items: Box[], kind: string): Box {
  const selected = items.filter((box) => box.kind === kind)
  assert.equal(selected.length, 1, kind)
  return selected[0]!
}
function tracks(bytes: Uint8Array) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return inside(bytes, one(boxes(bytes), 'moov')).filter((box) => box.kind === 'trak').map((box) => {
    const items = inside(bytes, box), header = one(items, 'tkhd'), version = bytes[header.body],
      media = one(items, 'mdia'), mediaItems = inside(bytes, media), handler = one(mediaItems, 'hdlr')
    return { box, header, media, mediaItems, id: data.getUint32(header.body + (version ? 20 : 12)),
      kind: text(bytes, handler.body + 8), alternate: header.body + (version ? 46 : 34) }
  })
}
function report(name: string, bytes: Uint8Array) {
  const result = JSON.parse(readFileSync(resolve(directory, name + '.packets.json'), 'utf8')) as {
    schema: number; file: string; sha256: string; streams: Stream[]; packets: Packet[]
  }
  assert.equal(result.schema, 1); assert.equal(result.file, name); assert.equal(result.sha256, hash(bytes))
  assert(result.packets.length > 100)
  return result
}
function trackOfFragment(bytes: Uint8Array, traf: Box): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(one(inside(bytes, traf), 'tfhd').body + 4)
}
function randomAccess(bytes: Uint8Array) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), rows: Array<{ id: number; offset: number; ordinal: number }> = []
  for (const mfra of boxes(bytes).filter((box) => box.kind === 'mfra'))
    for (const tfra of inside(bytes, mfra).filter((box) => box.kind === 'tfra')) {
      const width = bytes[tfra.body] ? 8 : 4, flags = data.getUint32(tfra.body + 8),
        fields = [(flags >>> 4 & 3) + 1, (flags >>> 2 & 3) + 1, (flags & 3) + 1],
        count = data.getUint32(tfra.body + 12), id = data.getUint32(tfra.body + 4)
      let at = tfra.body + 16
      for (let index = 0; index < count; index++) {
        const offset = width === 8 ? Number(data.getBigUint64(at + width)) : data.getUint32(at + width)
        at += width * 2
        let ordinal = 0
        for (let byte = 0; byte < fields[0]!; byte++) ordinal = ordinal * 256 + bytes[at++]!
        at += fields[1]! + fields[2]!
        rows.push({ id, offset, ordinal })
      }
      assert.equal(at, tfra.end)
    }
  return rows
}

for (const name of names) for (const video of [0, 1]) for (const audio of [0, 1])
  test(`${name}: selected video ${video} and audio ${audio} retain exact original samples and addressing`, { timeout: 60000 }, async () => {
    const source = fixture(name), original = tracks(source), videos = original.filter((track) => track.kind === 'vide'),
      audios = original.filter((track) => track.kind === 'soun'), expected = [videos[video]!.id, audios[audio]!.id],
      reference = report(name, source), beforeHash = hash(source), chosen = await selectMp4Tracks(source, { video, audio })
    assert.equal(videos.length, 2); assert.equal(audios.length, 2); assert(chosen)
    assert.deepEqual({ video: chosen.videoStreams, audio: chosen.audioStreams,
      videoId: chosen.selectedVideoTrackId, audioId: chosen.selectedAudioTrackId },
    { video: 2, audio: 2, videoId: expected[0], audioId: expected[1] })
    assert.equal(chosen.bytes.length, source.length); assert.equal(hash(source), beforeHash)
    const kept = tracks(chosen.bytes)
    assert.deepEqual(kept.map((track) => track.id), expected)
    for (const track of original) {
      const selected = expected.includes(track.id)
      assert.equal(text(chosen.bytes, track.box.start + 4), selected ? 'trak' : 'free')
      if (selected) {
        // All sample tables, edit/media headers and codec bytes remain where
        // they were; only tkhd enable/alternate metadata may change.
        assert.deepEqual(chosen.bytes.subarray(track.media.start, track.media.end), source.subarray(track.media.start, track.media.end))
        const view: DataView = new DataView(chosen.bytes.buffer)
        assert.equal(chosen.bytes[track.header.body + 3]! & 3, 3)
        assert.equal(view.getUint16(track.alternate), 0)
      }
    }
    for (const media of boxes(source).filter((box) => box.kind === 'mdat'))
      assert.deepEqual(chosen.bytes.subarray(media.start, media.end), source.subarray(media.start, media.end))
    const sourceIds = new Map(reference.streams.map((stream) => [stream.index, Number(stream.id)]))
    const counts = new Map<number, number>()
    for (const packet of reference.packets) {
      const id = sourceIds.get(packet.stream_index)!
      if (!expected.includes(id)) continue
      const offset = Number(packet.pos), length = Number(packet.size)
      assert(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length > 0 && length <= source.length - offset)
      assert.match(packet.data_hash, /^SHA256:[0-9a-f]{64}$/i)
      assert.equal(hash(chosen.bytes.subarray(offset, offset + length)), packet.data_hash.slice(7).toLowerCase())
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    assert.equal(counts.get(expected[0]!), video ? 60 : 72)
    assert(counts.get(expected[1]!)! > 100)
    for (const moof of boxes(source).filter((box) => box.kind === 'moof')) {
      const trafs = inside(source, moof).filter((box) => box.kind === 'traf'), retained = trafs.filter((traf) => expected.includes(trackOfFragment(source, traf)))
      assert.equal(text(chosen.bytes, moof.start + 4), retained.length ? 'moof' : 'free')
      for (const traf of retained) assert.deepEqual(chosen.bytes.subarray(traf.start, traf.end), source.subarray(traf.start, traf.end))
      if (retained.length) for (const traf of trafs.filter((traf) => !retained.includes(traf)))
        assert.equal(text(chosen.bytes, traf.start + 4), 'free')
    }
    const selectedMoofs = new Map(boxes(chosen.bytes).filter((box) => box.kind === 'moof')
      .map((moof) => [moof.start, inside(chosen.bytes, moof).filter((box) => box.kind === 'traf')]))
    for (const entry of randomAccess(chosen.bytes)) {
      assert(expected.includes(entry.id))
      const traf = selectedMoofs.get(entry.offset)?.[entry.ordinal - 1]
      assert(traf); assert.equal(trackOfFragment(chosen.bytes, traf), entry.id)
    }
    const timeline = await readVideoTimeline(chosen.bytes)
    assert(timeline); assert.equal(timeline.videoStreams, 1); assert.equal(timeline.audioStreams, 1)
    assert.equal(timeline.videoTracks?.[0]?.id, expected[0])
    assert.equal(timeline.times.length, video ? 60 : 72)
  })

for (const name of names) test(`${name}: complete video catalog retains independent dimensions, cadence and presentation timestamps`, async () => {
  const source = fixture(name), reference = report(name, source), timeline = await readVideoTimeline(source)
  assert(timeline); assert.equal(timeline.videoStreams, 2); assert.equal(timeline.audioStreams, 2)
  assert.equal(timeline.selectedVideoStream, 0)
  const videos = reference.streams.filter((stream) => stream.codec_type === 'video')
  for (const index of [0, 1]) {
    const selected = selectVideoTimeline(timeline, index), track = selected.videoTracks![index]!, referenceTrack = videos[index]!,
      [numerator, denominator] = referenceTrack.time_base.split('/').map(Number),
      times = reference.packets.filter((packet) => packet.stream_index === referenceTrack.index)
        .map((packet) => Number(packet.pts) * numerator! * 1000 / denominator!).sort((a, b) => a - b)
    assert.deepEqual([track.width, track.height], index ? [80, 60] : [64, 48])
    assert.equal(track.frameDuration, index ? 100 : 1000 / 12)
    assert.equal(track.times.length, index ? 60 : 72)
    assert.equal(track.id, Number(referenceTrack.id))
    assert.equal(selected.selectedVideoStream, index)
    assert.equal(selected.videoTracks, timeline.videoTracks)
    assert.equal(selected.times, track.times)
    assert.equal(selected.times.length, times.length)
    selected.times.forEach((time, frame) => assert(Math.abs(time - times[frame]!) < 1e-9, `${index}:${frame}`))
    assert.equal(selectVideoTimeline(selected, 1 - index).times, timeline.videoTracks![1 - index]!.times)
  }
  assert.equal(timeline.selectedVideoStream, 0, 'Choosing a view never mutates the original active view')
})

for (const name of names) test(`${name}: selecting one category preserves every other category and the audio compatibility entry point`, async () => {
  const source = fixture(name), original = tracks(source),
    videoOnly = await selectMp4Tracks(source, { video: 1 }), audioOnly = await selectMp4AudioTrack(source, 1)
  assert(videoOnly); assert(audioOnly)
  assert.equal(videoOnly.selectedAudioTrackId, undefined)
  assert.deepEqual(tracks(videoOnly.bytes).filter((track) => track.kind === 'soun').map((track) => track.id),
    original.filter((track) => track.kind === 'soun').map((track) => track.id))
  assert.deepEqual(tracks(audioOnly.bytes).filter((track) => track.kind === 'vide').map((track) => track.id),
    original.filter((track) => track.kind === 'vide').map((track) => track.id))
  for (const track of original) {
    const output: Uint8Array = track.kind === 'soun' ? videoOnly.bytes : audioOnly.bytes
    assert.deepEqual(output.subarray(track.box.start, track.box.end), source.subarray(track.box.start, track.box.end))
  }
})

test('track choice and bytes are snapshotted before asynchronous checkpoints, and abort never edits the original', async () => {
  const original = fixture(names[0]!), input = original.slice(), choices = { video: 1, audio: 0 },
    pending = selectMp4Tracks(input, choices)
  input.fill(0); choices.video = 0; choices.audio = 1
  const chosen = await pending
  assert(chosen)
  const originalTracks = tracks(original)
  assert.equal(chosen.selectedVideoTrackId, originalTracks.filter((track) => track.kind === 'vide')[1]!.id)
  assert.equal(chosen.selectedAudioTrackId, originalTracks.filter((track) => track.kind === 'soun')[0]!.id)
  let checks = 0
  const before = hash(original)
  await assert.rejects(selectMp4Tracks(original, { video: 1, audio: 1 }, { checkpoint() {
    if (++checks === 5) throw new Error('selection canceled')
  } }), /selection canceled/)
  assert.equal(checks, 5); assert.equal(hash(original), before)
})
test('invalid track choices reject without modifying input or silently falling back to the first video', async () => {
  const source = fixture(names[0]!), before = hash(source), timeline = await readVideoTimeline(source)
  assert(timeline)
  for (const index of [-1, 0.5, 2, NaN, Infinity]) {
    await assert.rejects(selectMp4Tracks(source, { video: index }), /video index/)
    await assert.rejects(selectMp4Tracks(source, { audio: index }), /audio index/)
    assert.throws(() => selectVideoTimeline(timeline, index), /outside/)
  }
  assert.equal(hash(source), before)
  assert.throws(() => selectVideoTimeline({ ...timeline, videoTracks: undefined }, 1), /catalog/)
  const first = timeline.videoTracks![0]!, second = timeline.videoTracks![1]!
  for (const videoTracks of [
    [first], [first, { ...second, id: first.id }], [first, { ...second, width: 0 }],
    [first, { ...second, frameDuration: NaN }], [first, { ...second, times: [20, 10] }],
    [first, { ...second, times: [second.duration + 1] }],
  ]) assert.throws(() => selectVideoTimeline({ ...timeline, videoTracks }, 1), /catalog/)
  assert.throws(() => selectVideoTimeline({ ...timeline,
    videoTracks: [first, { ...second, times: new Array<number>(1_000_001) }] }, 1), /budget/)
  const many = Array.from({ length: 257 }, (_, index) => ({ ...first, id: index + 1 }))
  assert.throws(() => selectVideoTimeline({ ...timeline, videoStreams: many.length, videoTracks: many }, 0), /budget/)
})
test('a real video without audio remains selectable, and metadata owns its input across the parser import', async () => {
  const original = new Uint8Array(readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url))),
    input = original.slice(), pending = readVideoTimeline(input)
  input.fill(0)
  const timeline = await pending, selected = await selectMp4Tracks(original, { video: 0 })
  assert(timeline); assert(selected)
  assert.equal(timeline.times.length, 18)
  assert.equal(selected.audioStreams, 0); assert.equal(selected.videoStreams, 1)
  assert.equal(selected.selectedAudioTrackId, undefined)
  assert.deepEqual(selectVideoTimeline({ ...timeline, videoTracks: undefined }, 0).times, timeline.times)
  assert.equal(await selectMp4Tracks(new Uint8Array([1, 2, 3]), { video: 0 }), undefined)
})
test('a malformed selected or discarded video timing table still fails the strict container validation', async () => {
  const original = fixture(names[0]!)
  for (const video of [0, 1]) {
    const bytes = original.slice(), track = tracks(bytes).filter((track) => track.kind === 'vide')[video]!,
      mdhd = one(track.mediaItems, 'mdhd'), data = new DataView(bytes.buffer)
    data.setUint32(mdhd.body + (bytes[mdhd.body] ? 20 : 12), 0)
    await assert.rejects(selectMp4Tracks(bytes, { video: 1, audio: 0 }), /timescale/)
  }
  const bytes = original.slice(), track = tracks(bytes).find((track) => track.kind === 'vide')!,
    minf = one(track.mediaItems, 'minf'), stbl = one(inside(bytes, minf), 'stbl'), stts = one(inside(bytes, stbl), 'stts')
  new DataView(bytes.buffer).setUint32(stts.body + 8, 1_000_001)
  await assert.rejects(readVideoTimeline(bytes), /sample count budget/)
  await assert.rejects(selectMp4Tracks(bytes, { video: 1, audio: 0 }), /sample budget/)
})
