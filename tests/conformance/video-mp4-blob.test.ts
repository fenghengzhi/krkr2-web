import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readVideoTimeline, readVideoTimelineBlob } from '../../src/formats/video/mp4.ts'
import { selectMp4Tracks, selectMp4TracksBlob, type Mp4BlobSource, type Mp4Patch } from '../../src/formats/video/mp4-audio.ts'
import { mp4MetadataByteLimit } from '../../src/formats/video/mp4-source.ts'

interface Box { kind: string; start: number; body: number; end: number }
const tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result: Box[] = []
  for (let at = start; at < end;) {
    const small = view.getUint32(at), header = small === 1 ? 16 : 8,
      length = small === 1 ? Number(view.getBigUint64(at + 8)) : small || end - at
    assert(length >= header && length <= end - at)
    result.push({ kind: tag(bytes, at + 4), start: at, body: at + header, end: at + length })
    at += length
  }
  return result
}
function header(kind: string, length: number, extended = false) {
  const bytes = new Uint8Array(extended ? 16 : 8), view = new DataView(bytes.buffer)
  view.setUint32(0, extended ? 1 : length)
  if (extended) view.setBigUint64(8, BigInt(length))
  bytes.set([...kind].map((character) => character.charCodeAt(0)), 4)
  return bytes
}
function tracked(blob: Blob, top: Box[]) {
  const reads: Array<[number, number]> = [], skipped = top.filter((box) => ['mdat', 'free', 'skip', 'wide'].includes(box.kind)),
    source: Mp4BlobSource = { size: blob.size, slice(start = 0, end = blob.size) {
      assert(start >= 0 && end <= blob.size && end >= start)
      for (const box of skipped)
        assert(!(start < box.end && end > box.body), `Read payload of ${box.kind}: ${start}..${end}`)
      return { async arrayBuffer() { reads.push([start, end]); return blob.slice(start, end).arrayBuffer() } }
    } }
  return { source, reads }
}
function compose(blob: Blob, patches: Mp4Patch[]) {
  const parts: BlobPart[] = []
  let at = 0
  for (const patch of patches) {
    assert(Number.isSafeInteger(patch.offset) && patch.offset >= at)
    assert(patch.bytes.length > 0 && patch.bytes.length <= blob.size - patch.offset)
    parts.push(blob.slice(at, patch.offset), patch.bytes)
    at = patch.offset + patch.bytes.length
  }
  parts.push(blob.slice(at))
  return new Blob(parts, { type: 'video/mp4' })
}

for (const name of ['video-multitrack.mp4', 'video-fragmented.mp4', 'video-interleaved.mp4', 'video-separate.mp4'])
  test(`Blob metadata and track patches preserve every byte of ${name}`, async () => {
    const original = new Uint8Array(readFileSync(resolve('out/verification/video-tracks', name))),
      blob = new Blob([original]), top = boxes(original), observed = tracked(blob, top)
    let charged = 0
    const options = { reserveMetadata(bytes: number) { charged += bytes; assert(charged <= mp4MetadataByteLimit) } },
      expected = await readVideoTimeline(original)
    assert.deepEqual(await readVideoTimelineBlob(observed.source, options), expected)
    assert(charged > 0 && observed.reads.length > 1)
    for (const selection of [{ video: 0, audio: 0 }, { video: 1, audio: 1 }, { video: 1 }, { audio: 1 }]) {
      charged = 0
      const actual = await selectMp4TracksBlob(observed.source, selection, options),
        contiguous = await selectMp4Tracks(original, selection)
      assert(actual); assert(contiguous)
      assert.equal(actual.size, original.length)
      assert.deepEqual([actual.audioStreams, actual.videoStreams, actual.selectedAudioTrackId, actual.selectedVideoTrackId],
        [contiguous.audioStreams, contiguous.videoStreams, contiguous.selectedAudioTrackId, contiguous.selectedVideoTrackId])
      for (const patch of actual.patches)
        assert(top.some((box) => !['mdat', 'free', 'skip', 'wide'].includes(box.kind) &&
          patch.offset >= box.start && patch.offset + patch.bytes.length <= box.end))
      const selected = compose(blob, actual.patches)
      assert.equal(selected.size, blob.size)
      assert.deepEqual(new Uint8Array(await selected.arrayBuffer()), contiguous.bytes)
      assert.deepEqual(await readVideoTimelineBlob(selected), await readVideoTimeline(contiguous.bytes))
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), original, 'Source Blob remains immutable')
    }
  })

/** An independent sparse file with real authored MP4 metadata/media bytes and
 * zero padding. Range access is deliberately incapable of bulk payload reads. */
function distant(head: boolean) {
  const original = new Uint8Array(readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url))),
    top = boxes(original), first = top.find((box) => box.kind === 'ftyp')!, movie = top.find((box) => box.kind === 'moov')!,
    media = top.find((box) => box.kind === 'mdat')!,
    ftyp = original.slice(first.start, first.end), moov = original.slice(movie.start, movie.end),
    paddingSize = 96 * 1024 * 1024, mediaSize = 128 * 1024 * 1024,
    moovAt = head ? ftyp.length : ftyp.length + paddingSize + mediaSize,
    padAt = ftyp.length + (head ? moov.length : 0), mdatAt = padAt + paddingSize,
    payloadAt = mdatAt + mediaSize - (media.end - media.body),
    size = ftyp.length + moov.length + paddingSize + mediaSize,
    view = new DataView(moov.buffer)
  const walk = (start: number, end: number) => {
    for (const box of boxes(moov, start, end)) {
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.kind)) walk(box.body, box.end)
      else if (box.kind === 'stco') {
        const count = view.getUint32(box.body + 4)
        for (let i = 0; i < count; i++) {
          const at = box.body + 8 + i * 4
          view.setUint32(at, payloadAt + view.getUint32(at) - media.body)
        }
      } else assert.notEqual(box.kind, 'co64', 'This independent small fixture uses stco')
    }
  }
  walk(0, moov.length)
  const chunks = [{ offset: 0, bytes: ftyp }, { offset: moovAt, bytes: moov },
    { offset: padAt, bytes: header('free', paddingSize, true) },
    { offset: mdatAt, bytes: header('mdat', mediaSize, true) },
    { offset: payloadAt, bytes: original.slice(media.body, media.end) }], reads: Array<[number, number]> = []
  const source: Mp4BlobSource = { size, slice(start = 0, end = size) {
    return { async arrayBuffer() {
      reads.push([start, end])
      const chunk = chunks.find((part) => start >= part.offset && end <= part.offset + part.bytes.length)
      assert(chunk, 'Metadata reader tried to materialize a sparse hole or combined large file')
      assert(start < payloadAt || start >= payloadAt + chunks.at(-1)!.bytes.length, 'Reader touched actual far-end media samples')
      return chunk.bytes.slice(start - chunk.offset, end - chunk.offset).buffer
    } }
  } }
  return { source, reads, chunks, original, moovAt, moov, padAt, mdatAt, payloadAt }
}

for (const head of [true, false]) test(`Blob ${head ? 'head' : 'tail'} moov skips large extended padding and mdat`, async () => {
  const f = distant(head), expected = await readVideoTimeline(f.original)
  let charged = 0
  const options = { reserveMetadata(bytes: number) { charged += bytes } }
  assert.deepEqual(await readVideoTimelineBlob(f.source, options), expected)
  const selected = await selectMp4TracksBlob(f.source, { video: 0 }, options)
  assert(selected)
  assert.equal(selected.size, f.source.size)
  assert.equal(selected.videoStreams, 1); assert.equal(selected.audioStreams, 0)
  assert(selected.patches.every((patch) => patch.offset >= f.moovAt && patch.offset + patch.bytes.length <= f.moovAt + f.moov.length))
  assert(charged < f.moov.length * 3 + 1024)
  assert(f.reads.some(([at]) => at === f.moovAt))
  assert(f.reads.every(([start, end]) => end - start <= f.moov.length))
})

test('Blob metadata rejects malformed extents, true metadata budget and samples outside mdat', async () => {
  assert.equal(await readVideoTimelineBlob(new Blob([new Uint8Array(7)])), undefined)
  assert.equal(await selectMp4TracksBlob(new Blob([new Uint8Array(8)]), { video: 0 }), undefined)
  for (const bytes of [header('moov', 7), header('moov', 100), header('moov', 1),
    header('moov', Number.MAX_SAFE_INTEGER + 1, true)]) {
    await assert.rejects(readVideoTimelineBlob(new Blob([bytes])), /Truncated|safe integer/)
    await assert.rejects(selectMp4TracksBlob(new Blob([bytes]), { video: 0 }), /Truncated|safe integer/)
  }
  let calls = 0
  const tooLarge: Mp4BlobSource = { size: mp4MetadataByteLimit + 1, slice(start = 0, end = 0) {
    calls++
    assert.equal(start, 0); assert.equal(end, 8)
    return { async arrayBuffer() { return header('moov', mp4MetadataByteLimit + 1).buffer } }
  } }
  await assert.rejects(readVideoTimelineBlob(tooLarge), /64 MiB/)
  assert.equal(calls, 1, 'Oversized metadata is rejected before requesting its body')
  const f = distant(true), view = new DataView(f.moov.buffer)
  const corrupt = (start: number, end: number): boolean => {
    for (const box of boxes(f.moov, start, end)) {
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.kind) && corrupt(box.body, box.end)) return true
      if (box.kind === 'stco') { view.setUint32(box.body + 8, f.padAt + 16); return true }
    }
    return false
  }
  assert(corrupt(0, f.moov.length))
  await assert.rejects(selectMp4TracksBlob(f.source, { video: 0 }), /outside media data/)
})

test('Blob cancellation, resource errors and reservation failures retain identity without later reads', async () => {
  const native = new Blob([new Uint8Array(readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)))]),
    cause = new Error('range cancelled'), reads: Array<[number, number]> = []
  let release!: () => void, entered!: () => void, cancelled = false
  const gate = new Promise<void>((resolve) => { release = resolve }), ready = new Promise<void>((resolve) => { entered = resolve }),
    source: Mp4BlobSource = { size: native.size, slice(start = 0, end = native.size) {
      return { async arrayBuffer() { reads.push([start, end]); entered(); await gate; return native.slice(start, end).arrayBuffer() } }
    } }, choice = { video: 0 }, pending = selectMp4TracksBlob(source, choice, {
      checkpoint() { if (cancelled) throw cause },
    }), rejected = assert.rejects(pending, (error) => error === cause)
  try {
    await ready
    choice.video = 100
    cancelled = true; release()
    await rejected
    assert.equal(reads.length, 1)
  } finally { release(); await pending.catch(() => {}) }
  for (const operation of [readVideoTimelineBlob, (source: Mp4BlobSource, options: { reserveMetadata?(bytes: number): void }) =>
    selectMp4TracksBlob(source, { video: 0 }, options)]) {
    const source: Mp4BlobSource = { size: native.size, slice() { throw cause } }
    await assert.rejects(operation(source, {}), (error) => error === cause)
    let reserved = 0
    await assert.rejects(operation({ size: native.size, slice() { assert.fail('Reservation failure must precede IO') } }, {
      reserveMetadata(bytes) { reserved += bytes; throw cause },
    }), (error) => error === cause)
    assert.equal(reserved, 8)
  }
  await assert.rejects(readVideoTimelineBlob({ size: 8, slice() {
    return { async arrayBuffer() { return new ArrayBuffer(7) } }
  } }), /Truncated MP4 Blob range/)
})

test('Blob selection captures choices before IO and preserves unknown-box and malformed-table rejection', async () => {
  const original = new Uint8Array(readFileSync(resolve('out/verification/video-tracks/video-multitrack.mp4'))),
    blob = new Blob([original]), choice = { video: 1, audio: 0 }, expected = await selectMp4Tracks(original, choice)
  assert(expected)
  const pending = selectMp4TracksBlob(blob, choice)
  choice.video = 0; choice.audio = 1
  const selected = await pending
  assert(selected)
  assert.deepEqual(new Uint8Array(await compose(blob, selected.patches).arrayBuffer()), expected.bytes)
  const unknown = new Blob([blob, header('zzzz', 8)])
  assert.deepEqual(await readVideoTimelineBlob(unknown), await readVideoTimeline(original))
  await assert.rejects(selectMp4TracksBlob(unknown, { video: 0 }), /Unsupported MP4 top-level zzzz box/)
  const corrupted = original.slice(), view = new DataView(corrupted.buffer)
  let changed = false
  const walk = (start: number, end: number) => {
    for (const box of boxes(corrupted, start, end)) {
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.kind)) walk(box.body, box.end)
      else if (box.kind === 'stts' && !changed) { view.setUint32(box.body + 8, 1000001); changed = true }
    }
  }
  walk(0, corrupted.length); assert(changed)
  await assert.rejects(readVideoTimelineBlob(new Blob([corrupted])), /sample count budget/)
  await assert.rejects(selectMp4TracksBlob(new Blob([corrupted]), { video: 1, audio: 0 }), /sample budget/)
})
