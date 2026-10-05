import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { selectMp4AudioTrack } from '../../src/formats/video/mp4-audio.ts'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'

interface RawBox { kind: string; start: number; body: number; end: number }
interface Sample { offset: number; size: number; dts: number; cts: number; duration: number; data: string }
const text = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fixture = (name: string) => new Uint8Array(readFileSync(resolve('out/verification/video-tracks', name)))
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): RawBox[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result: RawBox[] = []
  for (let at = start; at < end;) {
    const short = view.getUint32(at), header = short === 1 ? 16 : 8,
      size = short === 1 ? Number(view.getBigUint64(at + 8)) : short || end - at
    assert(size >= header && size <= end - at)
    result.push({ kind: text(bytes, at + 4), start: at, body: at + header, end: at + size })
    at += size
  }
  return result
}
const inside = (bytes: Uint8Array, box: RawBox) => boxes(bytes, box.body, box.end)
function required(items: RawBox[], kind: string): RawBox {
  const found = items.filter((box) => box.kind === kind)
  assert.equal(found.length, 1, kind)
  return found[0]!
}
function tracks(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return inside(bytes, required(boxes(bytes), 'moov')).filter((box) => box.kind === 'trak').map((box) => {
    const contents = inside(bytes, box), header = required(contents, 'tkhd'), version = bytes[header.body]!,
      media = inside(bytes, required(contents, 'mdia')), handler = required(media, 'hdlr')
    return { box, header, media, id: view.getUint32(header.body + (version ? 20 : 12)),
      kind: text(bytes, handler.body + 8), alternate: header.body + (version ? 46 : 34) }
  })
}
function type(bytes: Uint8Array, box: RawBox, kind: string): void {
  bytes.set([...kind].map((character) => character.charCodeAt(0)), box.start + 4)
}
function append(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let at = 0
  for (const part of parts) { bytes.set(part, at); at += part.length }
  return bytes
}
function box(kind: string, body: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(body.length + 8)
  new DataView(bytes.buffer).setUint32(0, bytes.length)
  bytes.set([...kind].map((character) => character.charCodeAt(0)), 4)
  bytes.set(body, 8)
  return bytes
}
/** Independent test reader, cross-checked against the hosted ffprobe packet
 * inventory. MP4Box 2.4.1 offsets are never used for fragmented samples. */
function fragmentSamples(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), movie = required(boxes(bytes), 'moov'),
    extension = inside(bytes, movie).find((box) => box.kind === 'mvex'), result = new Map<number, Sample[]>(),
    runs: Array<{ id: number; run: RawBox; base: number; offset: number; end: number; previous?: number; explicit: boolean; index: number }> = [],
    defaults = new Map<number, { duration: number; size: number }>()
  if (extension) for (const entry of inside(bytes, extension).filter((box) => box.kind === 'trex'))
    defaults.set(view.getUint32(entry.body + 4), { duration: view.getUint32(entry.body + 12), size: view.getUint32(entry.body + 16) })
  for (const moof of boxes(bytes).filter((box) => box.kind === 'moof'))
    for (const traf of inside(bytes, moof).filter((box) => box.kind === 'traf')) {
      const items = inside(bytes, traf), tfhd = required(items, 'tfhd'), tfdt = required(items, 'tfdt'),
        flags = view.getUint32(tfhd.body) & 0xffffff, id = view.getUint32(tfhd.body + 4), standard = defaults.get(id)!
      assert(standard)
      let at = tfhd.body + 8, base = moof.start, duration = standard.duration, size = standard.size,
        time = bytes[tfdt.body] ? Number(view.getBigUint64(tfdt.body + 4)) : view.getUint32(tfdt.body + 4), previous: number | undefined
      if (flags & 1) { base = Number(view.getBigUint64(at)); at += 8 }
      if (flags & 2) at += 4
      if (flags & 8) { duration = view.getUint32(at); at += 4 }
      if (flags & 16) { size = view.getUint32(at); at += 4 }
      const track = result.get(id) ?? []
      result.set(id, track)
      let runIndex = 0
      for (const run of items.filter((box) => box.kind === 'trun')) {
        const flags = view.getUint32(run.body) & 0xffffff, count = view.getUint32(run.body + 4), explicit = !!(flags & 1)
        let field = run.body + 8, position = previous ?? base
        if (explicit) { position = base + view.getInt32(field); field += 4 }
        if (flags & 4) field += 4
        const offset = position
        for (let i = 0; i < count; i++) {
          const sampleDuration = flags & 0x100 ? view.getUint32(field) : duration
          if (flags & 0x100) field += 4
          const sampleSize = flags & 0x200 ? view.getUint32(field) : size
          if (flags & 0x200) field += 4
          if (flags & 0x400) field += 4
          const composition = flags & 0x800 ? (bytes[run.body] ? view.getInt32(field) : view.getUint32(field)) : 0
          if (flags & 0x800) field += 4
          assert(position >= 0 && sampleSize <= bytes.length - position)
          track.push({ offset: position, size: sampleSize, dts: time, cts: time + composition, duration: sampleDuration,
            data: hash(bytes.subarray(position, position + sampleSize)) })
          position += sampleSize; time += sampleDuration
        }
        assert.equal(field, run.end)
        runs.push({ id, run, base, offset, end: position, previous, explicit, index: runIndex++ })
        previous = position
      }
    }
  return { tracks: result, runs }
}
async function samples(bytes: Uint8Array) {
  const { createFile, MP4BoxBuffer } = await import('mp4box'), file = createFile(false)
  file.onError = (message) => { throw new Error(String(message)) }
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(Uint8Array.from(bytes).buffer, 0)); file.flush()
  const info = file.getInfo(), fragmented = fragmentSamples(bytes), result = new Map<number, Sample[]>()
  for (const track of [...info.videoTracks, ...info.audioTracks]) {
    const all = file.getTrackSamplesInfo(track.id), fragments = fragmented.tracks.get(track.id) ?? [],
      regular = all.slice(0, all.length - fragments.length).map((sample) => ({
        offset: sample.offset, size: sample.size, dts: sample.dts, cts: sample.cts, duration: sample.duration,
        data: hash(bytes.subarray(sample.offset, sample.offset + sample.size)),
      }))
    assert(all.length >= fragments.length)
    result.set(track.id, [...regular, ...fragments])
  }
  return { audio: info.audioTracks.map((track) => track.id), video: info.videoTracks.map((track) => track.id),
    tracks: result }
}
function packetReference(name: string, source: Uint8Array) {
  const report = JSON.parse(readFileSync(resolve('out/verification/video-tracks', name + '.packets.json'), 'utf8')) as {
    schema: number; file: string; sha256: string;
    streams: Array<{ index: number; id: string }>;
    packets: Array<{ stream_index: number; pos: string; size: string; data_hash: string }>;
  }
  assert.equal(report.schema, 1); assert.equal(report.file, name); assert.equal(report.sha256, hash(source))
  const ids = new Map(report.streams.map((stream) => [stream.index, Number(stream.id)])),
    result = new Map<number, Array<{ offset: number; size: number; data: string }>>()
  for (const packet of report.packets) {
    const id = ids.get(packet.stream_index)
    assert(id !== undefined && Number.isSafeInteger(id))
    assert.match(packet.data_hash, /^SHA256:[0-9a-f]{64}$/i)
    assert(Number.isSafeInteger(Number(packet.pos)) && Number(packet.pos) >= 0)
    assert(Number.isSafeInteger(Number(packet.size)) && Number(packet.size) > 0)
    assert(Number(packet.size) <= source.length - Number(packet.pos))
    const samples = result.get(id) ?? []
    samples.push({ offset: Number(packet.pos), size: Number(packet.size), data: packet.data_hash.slice(7).toLowerCase() })
    result.set(id, samples)
  }
  return result
}
function randomAccess(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result: Array<{
    box: RawBox; id: number; offset: number; offsetAt: number; offsetWidth: number; ordinal: number; ordinalAt: number; ordinalWidth: number
  }> = []
  for (const mfra of boxes(bytes).filter((box) => box.kind === 'mfra'))
    for (const entry of inside(bytes, mfra).filter((box) => box.kind === 'tfra')) {
      const width = bytes[entry.body] ? 8 : 4, bits = view.getUint32(entry.body + 8),
        widths = [(bits >>> 4 & 3) + 1, (bits >>> 2 & 3) + 1, (bits & 3) + 1], count = view.getUint32(entry.body + 12)
      let at = entry.body + 16
      for (let i = 0; i < count; i++) {
        const offsetAt = at + width, offset = width === 8 ? Number(view.getBigUint64(offsetAt)) : view.getUint32(offsetAt)
        at += width * 2
        const ordinalAt = at
        let ordinal = 0
        for (let j = 0; j < widths[0]!; j++) ordinal = ordinal * 256 + bytes[at++]!
        at += widths[1]! + widths[2]!
        result.push({ box: entry, id: view.getUint32(entry.body + 4), offset, offsetAt, offsetWidth: width,
          ordinal, ordinalAt, ordinalWidth: widths[0]! })
      }
    }
  return result
}

for (const name of ['multitrack.mp4', 'fragmented.mp4', 'separate-fragments.mp4', 'interleaved.mp4']) for (const index of [0, 1])
  test(`${name}: selecting audio ${index} preserves the actual video and chosen audio samples`, async () => {
    const source = fixture(name), originals = tracks(source), audio = originals.filter((track) => track.kind === 'soun'),
      video = originals.filter((track) => track.kind === 'vide'), selected = audio[index]!, sourceHash = hash(source),
      wrapped = new Uint8Array(source.length + 29)
    assert.equal(audio.length, 2); assert.equal(video.length, 1)
    wrapped.set(source, 13)
    const window = wrapped.subarray(13, source.length + 13), selecting = selectMp4AudioTrack(window, index)
    window.fill(0) // The asynchronous import must not expose caller mutation.
    const chosen = await selecting
    assert(chosen)
    assert.deepEqual({ audio: chosen.audioStreams, video: chosen.videoStreams, id: chosen.selectedTrackId },
      { audio: 2, video: 1, id: selected.id })
    assert.equal(hash(source), sourceHash)
    assert.equal(chosen.bytes.length, source.length)
    const before = await samples(source), after = await samples(chosen.bytes), independent = packetReference(name, source)
    for (const [id, packets] of before.tracks)
      assert.deepEqual(packets.map(({ offset, size, data }) => ({ offset, size, data })), independent.get(id),
        `Every original track ${id} packet extent/hash must match the hosted ffprobe inventory`)
    assert.equal(before.audio.length, 2)
    assert.deepEqual(after.audio, [selected.id])
    assert.deepEqual(after.video, before.video)
    assert(before.tracks.get(selected.id)!.length > 100, 'Fixture must carry real AAC sample data')
    assert(before.tracks.get(video[0]!.id)!.length > 10, 'Fixture must carry real H.264 video samples')
    assert.deepEqual(after.tracks.get(selected.id), before.tracks.get(selected.id))
    for (const id of before.video) assert.deepEqual(after.tracks.get(id), before.tracks.get(id))
    assert.notDeepEqual(before.tracks.get(audio[0]!.id)!.map((sample) => sample.data),
      before.tracks.get(audio[1]!.id)!.map((sample) => sample.data), '440 Hz and 880 Hz are distinct encoded tracks')
    const expectedTimeline = await readVideoTimeline(source), timeline = await readVideoTimeline(chosen.bytes)
    assert(expectedTimeline); assert(timeline)
    assert.equal(timeline.audioStreams, 1); assert.equal(timeline.videoStreams, 1)
    assert.deepEqual(timeline.times, expectedTimeline.times)
    assert.equal(timeline.duration, expectedTimeline.duration)
    for (const track of video)
      assert.deepEqual(chosen.bytes.subarray(track.box.start, track.box.end), source.subarray(track.box.start, track.box.end))
    for (const data of boxes(source).filter((box) => box.kind === 'mdat'))
      assert.deepEqual(chosen.bytes.subarray(data.start, data.end), source.subarray(data.start, data.end))
    assert.equal(text(chosen.bytes, audio[1 - index]!.box.start + 4), 'free')
    const chosenHeader = tracks(chosen.bytes).find((track) => track.id === selected.id)!
    assert.equal(chosen.bytes[chosenHeader.header.body + 3]! & 3, 3)
    assert.equal(new DataView(chosen.bytes.buffer).getUint16(chosenHeader.alternate), 0)
    if (name !== 'multitrack.mp4') {
      const oldIndex = randomAccess(source), newIndex = randomAccess(chosen.bytes)
      assert(oldIndex.length > 0); assert(newIndex.length > 0)
      for (const entry of newIndex) {
        const old = oldIndex.find((item) => item.id === entry.id && item.offset === entry.offset)!
        assert(old)
        const fragment: RawBox = boxes(source).find((box) => box.start === old.offset)!
        const oldTracks: RawBox[] = inside(source, fragment).filter((box) => box.kind === 'traf')
        const kept: RawBox[] = oldTracks.filter((box) => text(chosen.bytes, box.start + 4) === 'traf')
        assert.equal(entry.ordinal, kept.indexOf(oldTracks[old.ordinal - 1]!) + 1)
        assert.equal(entry.offset, old.offset)
      }
      assert(!newIndex.some((entry) => entry.id === audio[1 - index]!.id))
    }
    if (name === 'separate-fragments.mp4') {
      let removedFragments = 0
      for (const fragment of boxes(source).filter((box) => box.kind === 'moof')) {
        const trafs = inside(source, fragment).filter((box) => box.kind === 'traf')
        assert.equal(trafs.length, 1, 'The hosted fixture must use independent per-track fragments')
        const header = required(inside(source, trafs[0]!), 'tfhd'), id = new DataView(source.buffer).getUint32(header.body + 4)
        const removed = id === audio[1 - index]!.id
        assert.equal(text(chosen.bytes, fragment.start + 4), removed ? 'free' : 'moof')
        if (removed) removedFragments++
      }
      assert(removedFragments > 0, 'The whole-moof path must actually be exercised')
    }
    if (name === 'interleaved.mp4') {
      const inspected = fragmentSamples(source)
      assert(inspected.runs.some((run) => run.index > 0), 'The fixture must contain multiple trun boxes in one traf')
      assert(inspected.runs.some((run) => run.index > 0 && run.explicit && run.offset !== run.previous),
        'The fixture must exercise a non-contiguous later explicit offset')
    }
  })

test('a disabled non-default audio track becomes the sole enabled in-movie choice', async () => {
  const bytes = fixture('multitrack.mp4'), audio = tracks(bytes).filter((track) => track.kind === 'soun'), selected = audio[1]!, view = new DataView(bytes.buffer)
  bytes[selected.header.body + 3] = 0
  view.setUint16(selected.alternate, 19)
  const chosen = await selectMp4AudioTrack(bytes, 1)
  assert(chosen)
  assert.equal(chosen.bytes[selected.header.body + 3]! & 3, 3)
  assert.equal(new DataView(chosen.bytes.buffer).getUint16(selected.alternate), 0)
  assert.equal(bytes[selected.header.body + 3], 0)
  assert.equal(view.getUint16(selected.alternate), 19)
})

test('audio indices are validated and only non-MP4 returns undefined', async () => {
  const bytes = fixture('multitrack.mp4')
  for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(selectMp4AudioTrack(bytes, index), /index/)
  await assert.rejects(selectMp4AudioTrack(bytes, 2), /outside/)
  assert.equal(await selectMp4AudioTrack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0), undefined)
  await assert.rejects(selectMp4AudioTrack(box('ftyp'), 0), /moov|Truncated/)
})

test('truncated, oversized and over-budget MP4 boxes reject without mutating the caller', async () => {
  const source = fixture('multitrack.mp4'), before = hash(source)
  await assert.rejects(selectMp4AudioTrack(source.subarray(0, source.length - 1), 0), /Truncated/)
  const extended = source.slice(), view = new DataView(extended.buffer)
  view.setUint32(0, 1); view.setBigUint64(8, 0xffffffffffffffffn)
  await assert.rejects(selectMp4AudioTrack(extended, 0), /safe integer/)
  const many = new Uint8Array(100001 * 8), manyView = new DataView(many.buffer)
  for (let at = 0; at < many.length; at += 8) { manyView.setUint32(at, 8); many.set([102, 114, 101, 101], at + 4) }
  await assert.rejects(selectMp4AudioTrack(many, 0), /box budget/)
  assert.equal(hash(source), before)
})

test('duplicate IDs, unknown handlers, external data and encrypted sample entries are explicit errors', async () => {
  const original = fixture('multitrack.mp4')
  const duplicate = original.slice(), duplicateTracks = tracks(duplicate), duplicateView = new DataView(duplicate.buffer)
  duplicateView.setUint32(duplicateTracks[1]!.header.body + 12, duplicateTracks[0]!.id)
  await assert.rejects(selectMp4AudioTrack(duplicate, 0), /unique/)
  const handlerBytes = original.slice(), audio = tracks(handlerBytes).find((track) => track.kind === 'soun')!, handler = required(audio.media, 'hdlr')
  handlerBytes.set([116, 101, 120, 116], handler.body + 8)
  await assert.rejects(selectMp4AudioTrack(handlerBytes, 0), /handler/)
  const external = original.slice(), externalTrack = tracks(external).find((track) => track.kind === 'soun')!,
    minf = inside(external, required(externalTrack.media, 'minf')),
    dref = required(inside(external, required(minf, 'dinf')), 'dref'), reference = boxes(external, dref.body + 8, dref.end)[0]!
  external[reference.body + 3] = 0
  await assert.rejects(selectMp4AudioTrack(external, 0), /External/)
  const encrypted = original.slice(), encryptedTrack = tracks(encrypted).find((track) => track.kind === 'soun')!,
    encryptedMinf = inside(encrypted, required(encryptedTrack.media, 'minf')),
    stsd = required(inside(encrypted, required(encryptedMinf, 'stbl')), 'stsd')
  type(encrypted, boxes(encrypted, stsd.body + 8, stsd.end)[0]!, 'enca')
  await assert.rejects(selectMp4AudioTrack(encrypted, 0), /encrypted/)
  await assert.rejects(selectMp4AudioTrack(append(original, box('uuid', new Uint8Array(16))), 0), /Unsupported/)
})

test('fragment inheritance, missing explicit run offsets and invalid random-access ordinals reject', async () => {
  const original = fixture('fragmented.mp4'), inherited = original.slice(),
    moof = boxes(inherited).find((box) => box.kind === 'moof')!, trafs = inside(inherited, moof).filter((box) => box.kind === 'traf')
  assert.equal(trafs.length, 3)
  const tfhd = required(inside(inherited, trafs[2]!), 'tfhd'), view = new DataView(inherited.buffer)
  view.setUint32(tfhd.body, view.getUint32(tfhd.body) & ~0x020000)
  await assert.rejects(selectMp4AudioTrack(inherited, 1), /Inherited/)
  const missing = original.slice(), trun = inside(missing, trafs[0]!).find((box) => box.kind === 'trun')!, missingView = new DataView(missing.buffer)
  missingView.setUint32(trun.body, missingView.getUint32(trun.body) & ~1)
  await assert.rejects(selectMp4AudioTrack(missing, 1), /explicit data offset/)
  const invalidIndex = original.slice(), entry = randomAccess(invalidIndex)[0]!
  invalidIndex.fill(0, entry.ordinalAt, entry.ordinalAt + entry.ordinalWidth)
  await assert.rejects(selectMp4AudioTrack(invalidIndex, 1), /random access entry/)
})

test('later explicit trun offsets cannot bypass validation through MP4Box inferred contiguous addresses', async () => {
  const original = fixture('fragmented.mp4'), moof = boxes(original).find((box) => box.kind === 'moof')!,
    audio = tracks(original).filter((track) => track.kind === 'soun')[0]!, view = new DataView(original.buffer),
    traf = inside(original, moof).filter((box) => box.kind === 'traf').find((box) =>
      view.getUint32(required(inside(original, box), 'tfhd').body + 4) === audio.id)!,
    originalRun = inside(original, traf).find((box) => box.kind === 'trun')!, flags = view.getUint32(originalRun.body) & 0xffffff
  const tfhd = required(inside(original, traf), 'tfhd')
  assert(view.getUint32(tfhd.body) & 0x020000)
  assert.equal(view.getUint32(tfhd.body) & 1, 0)
  assert(flags & 1); assert(flags & 0x200)
  assert(view.getUint32(originalRun.body + 4) >= 3)
  const stride = [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length * 4,
    sizeAt = originalRun.body + 8 + 4 + (flags & 4 ? 4 : 0) + (flags & 0x100 ? 4 : 0),
    sizes = [0, 1, 2].map((index) => view.getUint32(sizeAt + index * stride)),
    firstOffset = view.getInt32(originalRun.body + 8), thirdOffset = firstOffset + sizes[0]! + sizes[1]!
  // Literal fields are read independently of MP4Box's known later-run bug.
  assert(moof.start + thirdOffset + sizes[2]! <= original.length)
  const run = (offset: number, size: number) => {
    const body = new Uint8Array(16), fields = new DataView(body.buffer)
    fields.setUint32(0, 0x201); fields.setUint32(4, 1)
    fields.setInt32(8, offset); fields.setUint32(12, size)
    return box('trun', body)
  }
  for (const offset of [thirdOffset, 0x7fffffff]) {
    const first = run(firstOffset, sizes[0]!), second = run(offset, sizes[2]!),
      spare = originalRun.end - originalRun.start - first.length - second.length
    assert(spare >= 8)
    const source = original.slice()
    source.set(append(first, second, box('free', new Uint8Array(spare - 8))), originalRun.start)
    if (offset === thirdOffset) {
      const chosen = await selectMp4AudioTrack(source, 0)
      assert(chosen)
      const kept = fragmentSamples(chosen.bytes).tracks.get(audio.id)!
      assert.deepEqual(kept.slice(0, 2).map(({ offset, size, data }) => ({ offset, size, data })), [
        { offset: moof.start + firstOffset, size: sizes[0]!,
          data: hash(original.subarray(moof.start + firstOffset, moof.start + firstOffset + sizes[0]!)) },
        { offset: moof.start + thirdOffset, size: sizes[2]!,
          data: hash(original.subarray(moof.start + thirdOffset, moof.start + thirdOffset + sizes[2]!)) },
      ])
      assert.equal(chosen.bytes.length, source.length)
      assert.deepEqual(chosen.bytes.subarray(originalRun.start, originalRun.end), source.subarray(originalRun.start, originalRun.end))
    } else {
      // Validate even the audio being removed: otherwise a broken parser's
      // invented contiguous address could hide the actual out-of-file offset.
      await assert.rejects(selectMp4AudioTrack(source, 1), /run offset is outside/)
    }
  }
})

/** A small real-AAC fragment with literal addresses: packet A twice, seven
 * sentinel bytes, then packet B. No production parser computes expectations.
 * The explicit-base variant places mdat before moof so both run offsets are
 * negative; the other variant uses the moof start as its base. */
function addressedFragment(override: boolean, negative: boolean) {
  const original = fixture('fragmented.mp4'), audio = tracks(original).find((track) => track.kind === 'soun')!,
    packets = packetReference('fragmented.mp4', original).get(audio.id)!,
    first = packets[0]!, second = packets[1]!,
    a = original.slice(first.offset, first.offset + first.size), b = original.slice(second.offset, second.offset + second.size),
    originalTop = boxes(original), ftyp = required(originalTop, 'ftyp'), moov = required(originalTop, 'moov'),
    prefix = append(original.subarray(ftyp.start, ftyp.end), original.subarray(moov.start, moov.end)),
    prefixView = new DataView(prefix.buffer),
    defaults = required(inside(prefix, required(boxes(prefix), 'moov')), 'mvex'),
    trex = inside(prefix, defaults).find((box) => box.kind === 'trex' && prefixView.getUint32(box.body + 4) === audio.id)!
  assert.equal(hash(a), first.data); assert.equal(hash(b), second.data)
  assert(a.length > 0 && b.length > 0)
  // Deliberately wrong trex defaults in the override variant prove precedence.
  prefixView.setUint32(trex.body + 12, override ? 7 : 1024)
  prefixView.setUint32(trex.body + 16, override ? 1 : a.length)
  const duration = override ? 2048 : 1024, media = box('mdat', append(a, a, new Uint8Array(7).fill(0x5a), b)),
    header = new Uint8Array(8 + (negative ? 8 : 0) + (override ? 8 : 0)), headerView = new DataView(header.buffer),
    clock = new Uint8Array(12), clockView = new DataView(clock.buffer), sequence = new Uint8Array(8),
    firstRun = new Uint8Array(12), firstView = new DataView(firstRun.buffer),
    nextRun = new Uint8Array(12), nextView = new DataView(nextRun.buffer),
    lastRun = new Uint8Array(24), lastView = new DataView(lastRun.buffer)
  headerView.setUint32(0, (negative ? 1 : 0x020000) | (override ? 0x18 : 0))
  headerView.setUint32(4, audio.id)
  if (override) {
    headerView.setUint32(negative ? 16 : 8, duration)
    headerView.setUint32(negative ? 20 : 12, a.length)
  }
  clockView.setUint32(0, 0x01000000); clockView.setBigUint64(4, 4096n)
  new DataView(sequence.buffer).setUint32(4, 1)
  firstView.setUint32(0, 1); firstView.setUint32(4, 1)
  nextView.setUint32(0, 0x800); nextView.setUint32(4, 1); nextView.setUint32(8, 0x80000000)
  lastView.setUint32(0, 0x01000b01); lastView.setUint32(4, 1)
  lastView.setUint32(12, 512); lastView.setUint32(16, b.length); lastView.setInt32(20, -32)
  const fragment = () => box('moof', append(box('mfhd', sequence), box('traf', append(box('tfhd', header), box('tfdt', clock),
    box('trun', firstRun), box('trun', nextRun), box('trun', lastRun)))))
  const fragmentLength = fragment().length, mediaStart = prefix.length + (negative ? 0 : fragmentLength),
    firstAddress = mediaStart + 8, lastAddress = firstAddress + a.length * 2 + 7,
    base = negative ? mediaStart + media.length : prefix.length
  if (negative) headerView.setBigUint64(8, BigInt(base))
  firstView.setInt32(8, firstAddress - base); lastView.setInt32(8, lastAddress - base)
  const bytes = negative ? append(prefix, media, fragment()) : append(prefix, fragment(), media)
  const expected: Sample[] = [
    { offset: firstAddress, size: a.length, dts: 4096, cts: 4096, duration, data: first.data },
    { offset: firstAddress + a.length, size: a.length, dts: 4096 + duration,
      cts: 4096 + duration + 2147483648, duration, data: first.data },
    { offset: lastAddress, size: b.length, dts: 4096 + duration * 2,
      cts: 4096 + duration * 2 - 32, duration: 512, data: second.data },
  ]
  return { bytes, id: audio.id, expected }
}

for (const override of [false, true]) for (const negative of [false, true])
  test(`fragment addresses: ${override ? 'tfhd override' : 'trex default'}, ${negative ? 'negative explicit base' : 'moof base'}`, async () => {
    const { bytes, id, expected } = addressedFragment(override, negative), before = hash(bytes), chosen = await selectMp4AudioTrack(bytes, 0)
    assert(chosen)
    assert.equal(chosen.selectedTrackId, id)
    assert.deepEqual(fragmentSamples(bytes).tracks.get(id), expected)
    assert.deepEqual(fragmentSamples(chosen.bytes).tracks.get(id), expected)
    assert.equal(hash(bytes), before)
    assert.equal(chosen.bytes.length, bytes.length)
    const media = required(boxes(bytes), 'mdat')
    assert.deepEqual(chosen.bytes.subarray(media.start, media.end), bytes.subarray(media.start, media.end))
    const runs = fragmentSamples(chosen.bytes).runs
    assert.equal(runs.length, 3)
    assert.equal(runs[1]!.explicit, false)
    assert.equal(runs[1]!.offset, expected[1]!.offset)
    assert.notEqual(runs[2]!.offset, runs[2]!.previous)
  })

test('fragment ranges and default sample extents reject without trusting inferred parser offsets', async () => {
  const { bytes } = addressedFragment(true, true),
    moof = required(boxes(bytes), 'moof'), traf = required(inside(bytes, moof), 'traf'),
    items = inside(bytes, traf), runs = items.filter((box) => box.kind === 'trun'), tfhd = required(items, 'tfhd')
  for (const offset of [-0x80000000, 0x7fffffff]) {
    const invalid = bytes.slice()
    new DataView(invalid.buffer).setInt32(runs[2]!.body + 8, offset)
    await assert.rejects(selectMp4AudioTrack(invalid, 0), /run offset is outside/)
  }
  const crossing = bytes.slice(), data = required(boxes(crossing), 'mdat'), crossingView = new DataView(crossing.buffer),
    base = Number(crossingView.getBigUint64(tfhd.body + 8))
  // A valid in-file address that crosses the end of mdat must still reject.
  crossingView.setInt32(runs[2]!.body + 8, data.end - 1 - base)
  await assert.rejects(selectMp4AudioTrack(crossing, 0), /outside media data/)
  const wrongDefault = bytes.slice()
  new DataView(wrongDefault.buffer).setUint32(tfhd.body + 20, bytes.length)
  await assert.rejects(selectMp4AudioTrack(wrongDefault, 0), /outside media data/)
})

test('fragment decode/composition timestamp sums must remain safe integers', async () => {
  const { bytes } = addressedFragment(false, false), moof = required(boxes(bytes), 'moof'),
    traf = required(inside(bytes, moof), 'traf'), tfdt = required(inside(bytes, traf), 'tfdt')
  for (const time of [BigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER) - 1000000n]) {
    const unsafe = bytes.slice()
    new DataView(unsafe.buffer).setBigUint64(tfdt.body + 4, time)
    // The second value has safe decode ends, but the unsigned version-0
    // composition offset on run two exceeds the safe timestamp range.
    await assert.rejects(selectMp4AudioTrack(unsafe, 0), /Invalid MP4 sample extent or timestamp/)
  }
})

/** Add a genuine byte-range sidx to the fragmented fixture. Only the insertion
 * itself relocates bytes, so repair its original absolute tfra offsets here;
 * the selector must then preserve this new source's offsets without remuxing. */
function indexedFragment(source: Uint8Array, referenceId: number): Uint8Array {
  const originalTop = boxes(source), ftyp = required(originalTop, 'ftyp'), first = originalTop.find((box) => box.kind === 'moof')!,
    last = originalTop.filter((box) => box.kind === 'mdat').at(-1)!, body = new Uint8Array(36), view = new DataView(body.buffer)
  view.setUint32(4, referenceId); view.setUint32(8, 1000)
  view.setUint32(16, first.start - ftyp.end)
  view.setUint16(22, 1); view.setUint32(24, last.end - first.start); view.setUint32(28, 6000)
  const index = box('sidx', body), bytes = append(source.subarray(0, ftyp.end), index, source.subarray(ftyp.end)), output = new DataView(bytes.buffer)
  for (const entry of randomAccess(source)) {
    const at = entry.offsetAt + index.length, offset = entry.offset + index.length
    if (entry.offsetWidth === 8) output.setBigUint64(at, BigInt(offset))
    else output.setUint32(at, offset)
  }
  return bytes
}

test('retained sidx byte ranges stay exact while an unselected track index becomes free', async () => {
  const original = fixture('fragmented.mp4'), audio = tracks(original).filter((track) => track.kind === 'soun')
  for (const reference of [0, 1]) {
    const indexed = indexedFragment(original, audio[reference]!.id), sidx = required(boxes(indexed), 'sidx'), chosen = await selectMp4AudioTrack(indexed, 1)
    assert(chosen)
    assert.equal(chosen.bytes.length, indexed.length)
    assert.equal(text(chosen.bytes, sidx.start + 4), reference === 1 ? 'sidx' : 'free')
    assert.deepEqual(chosen.bytes.subarray(sidx.body, sidx.end), indexed.subarray(sidx.body, sidx.end))
    const before = await samples(indexed), after = await samples(chosen.bytes)
    assert.deepEqual(after.tracks.get(audio[1]!.id), before.tracks.get(audio[1]!.id))
    for (const id of before.video) assert.deepEqual(after.tracks.get(id), before.tracks.get(id))
  }
  const hierarchy = indexedFragment(original, audio[1]!.id), sidx = required(boxes(hierarchy), 'sidx'), view = new DataView(hierarchy.buffer)
  view.setUint32(sidx.body + 24, view.getUint32(sidx.body + 24) | 0x80000000)
  await assert.rejects(selectMp4AudioTrack(hierarchy, 1), /hierarchical/)
})

test('injected task yields admit cancellation before publishing any selected bytes', { timeout: 15000 }, async () => {
  const source = fixture('fragmented.mp4'), before = hash(source)
  let enter!: () => void, release!: () => void, cancelled = false, checkpoints = 0
  const entered = new Promise<void>((resolve) => { enter = resolve }),
    gate = new Promise<void>((resolve) => { release = resolve })
  const selecting = selectMp4AudioTrack(source, 1, {
    checkpoint() { checkpoints++; if (cancelled) throw new Error('Selection cancelled at owner boundary') },
    async yieldControl() { enter(); await gate },
  })
  try {
    await Promise.race([entered, selecting.then(() => { throw new Error('Selection completed before the task yield') })])
    cancelled = true
    release()
    await assert.rejects(selecting, /cancelled at owner boundary/)
    assert(checkpoints >= 2)
    assert.equal(hash(source), before)
    assert.equal(tracks(source).filter((track) => track.kind === 'soun').length, 2)
  } finally { release(); await selecting.catch(() => {}) }
})
