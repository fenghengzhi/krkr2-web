import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { selectMp4AudioTrack } from '../../src/formats/video/mp4-audio.ts'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'

interface RawBox { kind: string; start: number; body: number; end: number }
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
function box(kind: string, body = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(body.length + 8)
  new DataView(bytes.buffer).setUint32(0, bytes.length)
  bytes.set([...kind].map((character) => character.charCodeAt(0)), 4)
  bytes.set(body, 8)
  return bytes
}
async function samples(bytes: Uint8Array) {
  const { createFile, MP4BoxBuffer } = await import('mp4box'), file = createFile(false)
  file.onError = (message) => { throw new Error(String(message)) }
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(Uint8Array.from(bytes).buffer, 0)); file.flush()
  const info = file.getInfo()
  return { audio: info.audioTracks.map((track) => track.id), video: info.videoTracks.map((track) => track.id),
    tracks: new Map([...info.videoTracks, ...info.audioTracks].map((track) => [track.id,
      file.getTrackSamplesInfo(track.id).map((sample) => ({
        offset: sample.offset, size: sample.size, dts: sample.dts, cts: sample.cts, duration: sample.duration,
        data: hash(bytes.subarray(sample.offset, sample.offset + sample.size)),
      }))])) }
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

for (const name of ['multitrack.mp4', 'fragmented.mp4', 'separate-fragments.mp4']) for (const index of [0, 1])
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
    const before = await samples(source), after = await samples(chosen.bytes)
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
        const fragment = boxes(source).find((box) => box.start === old.offset)!,
          oldTracks = inside(source, fragment).filter((box) => box.kind === 'traf'),
          kept = oldTracks.filter((box) => text(chosen.bytes, box.start + 4) === 'traf')
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
    await assert.rejects(selectMp4AudioTrack(source, 1), /Unsupported MP4 explicit data offset after the first fragment run/)
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
