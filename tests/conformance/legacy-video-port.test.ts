import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PortVideoBackend } from '../../src/backends/video/port-backend.ts'
import { legacyVideoFormat, needsQuickTimeConversion, type LegacyVideoFormat } from '../../src/backends/video/legacy/format.ts'
import { checkLegacyInputSize } from '../../src/backends/video/legacy/module.ts'
import { defaultVideoSettings, type VideoCommand } from '../../src/engine/ports/video.ts'
import { ExecutionCancelled } from '../../src/engine/scheduler/control.ts'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'
import type { VideoRequest } from '../../src/protocol/video.ts'

type Open = Extract<VideoCommand, { op: 'open' }>
type Converter = (bytes: Blob | Uint8Array, format: LegacyVideoFormat, signal: AbortSignal) => Promise<Blob>
const open = (name: string, bytes: Open['bytes'], epoch = 1): Open =>
  ({ op: 'open', id: 3, epoch, name, bytes, settings: defaultVideoSettings() })
const mp4File = async () => Uint8Array.from(await readFile(new URL('../fixtures/video/colors-sound.mp4', import.meta.url)))

function transport(convert: Converter) {
  const channel = new MessageChannel(), opens: Open[] = []
  channel.port2.onmessage = ({ data }: MessageEvent<VideoRequest>) => {
    if (data.command.op === 'open') opens.push(data.command)
    channel.port2.postMessage({ type: 'reply', serial: data.serial, result: { events: [] } })
  }
  const port = new PortVideoBackend(channel.port1, undefined, undefined, undefined, convert)
  return { port, opens, async close() { try { await port.close() } finally { channel.port2.close() } } }
}

test('legacy movie conversion retains the game name and sends owned MP4 bytes and their actual video timeline', async () => {
  const encoded = await mp4File(), timeline = await readVideoTimeline(encoded)
  assert(timeline); assert(timeline.times.length > 1); assert.equal(timeline.audioStreams, 1)
  const routes = [['op.MPG?mode=1', 'mpeg'], ['opening.mpeg', 'mpeg'], ['disc.xp3>cut.MPV', 'mpegvideo'],
    ['ending.m1v', 'mpegvideo'], ['video/opening.AVI', 'avi'], ['opening.WMV?width=96', 'asf'],
    ['data.xp3>video/intro.asf', 'asf'], ['movie.wma', 'asf']] as const
  const seen: LegacyVideoFormat[] = [], input = Uint8Array.of(0, 0, 1, 0xba, 3, 4)
  const f = transport(async (data, format, signal) => {
    signal.throwIfAborted()
    assert.deepEqual(data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer()), input)
    seen.push(format)
    return new Blob([encoded])
  })
  try {
    for (const [index, [name]] of routes.entries()) {
      const bytes = index % 2 ? input : { blob: new Blob([input]), buffered: false }
      await f.port.command(open(name, bytes, index + 1))
      const outgoing = f.opens.at(-1)!
      assert.equal(outgoing.name, name); assert.deepEqual(outgoing.timeline, timeline)
      assert(!(outgoing.bytes instanceof Uint8Array)); assert(outgoing.bytes.blob instanceof Blob)
      assert.equal(outgoing.bytes.buffered, true); assert.equal(outgoing.bytes.blob.type, 'video/mp4')
      assert.deepEqual(new Uint8Array(await outgoing.bytes.blob.arrayBuffer()), encoded)
    }
    assert.deepEqual(seen, routes.map(([, format]) => format))
    for (const name of ['data.avi>clip.mp4', 'clip.mp4?old.mpg', 'clip?old.avi', 'pack.wmv>clip.mp4', 'clip?old.asf', 'sound.wav', 'movie.webm'])
      assert.equal(legacyVideoFormat(name), undefined)
  } finally { await f.close() }
})

test('MP4 and WebM stored under a legacy name retain their bytes and avoid a codec worker', async () => {
  const mp4 = await mp4File(), webm = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3)
  const f = transport(async () => { throw new Error('Unexpected transcoding') })
  try {
    await f.port.command(open('renamed.avi', { blob: new Blob([mp4]), buffered: false }))
    await f.port.command(open('renamed.mpg', webm, 2))
    for (const [index, expected] of [mp4, webm].entries()) {
      const payload = f.opens[index]!.bytes
      assert(!(payload instanceof Uint8Array)); assert(payload.blob instanceof Blob)
      assert.equal(payload.buffered, index !== 0); assert.equal(payload.blob.type, index ? 'video/webm' : 'video/mp4')
      assert.deepEqual(new Uint8Array(await payload.blob.arrayBuffer()), Uint8Array.from(expected))
    }
  } finally { await f.close() }
})

for (const action of ['close', 'cancel', 'replace', 'shutdown'] as const)
  test(`a ${action} during legacy conversion aborts its worker and retires the old movie`, async () => {
    let started!: () => void, signal: AbortSignal | undefined
    const ready = new Promise<void>((resolve) => { started = resolve })
    const f = transport((_bytes, _format, control) => new Promise<Blob>((_resolve, reject) => {
      signal = control; control.addEventListener('abort', () => reject(control.reason), { once: true }); started()
    }))
    try {
      const failed = assert.rejects(f.port.command(open('old.mpg', Uint8Array.of(1))), /closed|superseded/)
      await ready
      if (action === 'replace') await f.port.command(open('new.mp4', await mp4File(), 2))
      else if (action === 'close') await f.port.command({ op: 'close', id: 3, epoch: 2 })
      else if (action === 'cancel') await f.port.command({ op: 'cancel' })
      else await f.port.close()
      await failed; assert.equal(signal?.aborted, true)
      assert.deepEqual(f.opens.map((item) => item.name), action === 'replace' ? ['new.mp4'] : [])
    } finally { await f.close() }
  })

test('a failed conversion leaves the next movie usable and never presents malformed output', async () => {
  const mp4 = await mp4File()
  let attempts = 0
  const f = transport(async () => ++attempts === 1 ? new Blob([Uint8Array.of(7, 8)]) : new Blob([mp4]))
  try {
    await assert.rejects(f.port.command(open('bad.avi', Uint8Array.of(17))), /no MP4 video timeline/)
    assert.equal(f.opens.length, 0)
    await f.port.command(open('good.avi', Uint8Array.of(21), 2))
    assert.equal(f.opens[0]?.timeline?.audioStreams, 1)
  } finally { await f.close() }
})

test('closing a queued AVI leaves the active movie alone and never starts a decoder for the closed one', async () => {
  const mp4 = await mp4File(), started: LegacyVideoFormat[] = []
  let enter!: () => void, resume!: () => void
  const active = new Promise<void>((resolve) => { enter = resolve })
  const gate = new Promise<void>((resolve) => { resume = resolve })
  const f = transport(async (_input, format, signal) => {
    started.push(format); enter(); await gate; signal.throwIfAborted()
    return new Blob([mp4])
  })
  try {
    const playing = f.port.command(open('opening.mpg', Uint8Array.of(1)))
    await active
    const queued = f.port.command({ ...open('other.avi', Uint8Array.of(2)), id: 4 })
    const retired = assert.rejects(queued, /closed|superseded/)
    await f.port.command({ op: 'close', id: 4, epoch: 2 }); await retired
    resume(); await playing
    assert.deepEqual(started, ['mpeg'])
    assert.deepEqual(f.opens.map(({ name }) => name), ['opening.mpg'])
  } finally { resume(); await f.close() }
})

test('borrowed legacy sources and converted output have independent size checks', async () => {
  const block = new Blob([new Uint8Array(1024 * 1024)])
  const large = new Blob(Array<Blob>(129).fill(block))
  let conversions = 0
  const small = new Blob([await mp4File()]), f = transport(async (input) => {
    conversions++
    return input instanceof Blob && input.size === large.size ? small : large
  })
  try {
    await assert.rejects(f.port.command(open('buffered.avi', { blob: large, buffered: true })), /input exceeds 128 MiB/)
    assert.equal(conversions, 0)
    await f.port.command(open('large.avi', { blob: large, buffered: false }))
    assert.equal(conversions, 1); assert.equal(f.opens.length, 1)
    await assert.rejects(f.port.command(open('large-output.mpg', Uint8Array.of(1), 2)), /Converted movie data exceeds/)
    assert.equal(conversions, 2); assert.equal(f.opens.length, 1)
    assert.doesNotThrow(() => checkLegacyInputSize(2 * 1024 ** 3, true))
    assert.throws(() => checkLegacyInputSize(2 * 1024 ** 3 + 1, true), /2 GiB/)
    assert.throws(() => checkLegacyInputSize(large.size, false), /128 MiB/)
  } finally { await f.close() }
})

test('cancelling the game source abandons the open and retains only the actual in-flight reader lease', async () => {
  const listeners = new Set<() => void>()
  let begin!: () => void, finish!: () => void, busySignal: AbortSignal | undefined
  const started = new Promise<void>((resolve) => { begin = resolve })
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const f = transport(async (_data, _format, signal) => {
    busySignal = signal; begin(); await gate
    return new Blob([Uint8Array.of(17)])
  })
  try {
    const source = await f.port.prepareSource({ name: 'opening.avi', size: 3, read: async () => Uint8Array.of(1, 2, 3) }, {
      check() {}, async checkpoint() {}, onCancel(callback) {
        listeners.add(callback); return () => { listeners.delete(callback) }
      },
    })
    const cancelled = assert.rejects(f.port.command(open('opening.avi', source.bytes)), ExecutionCancelled)
    await started
    for (const callback of listeners) callback()
    await cancelled
    source.release()
    assert.equal(busySignal?.aborted, true)
    assert.equal(f.port.inspectSources().bufferedBytes, 3)
    finish()
    await f.port.command({ op: 'close', id: 3, epoch: 2 })
    assert.deepEqual(f.port.inspectSources(), { preparations: 0, bufferedBytes: 0, metadataBytes: 0 })
    assert.deepEqual(f.opens, [])
  } finally { finish(); await f.close() }
})

test('QuickTime and MPEG-4 Part 2 use their actual track descriptions even when the file was renamed', async () => {
  const encoded = await mp4File(), seen: LegacyVideoFormat[] = []
  const f = transport(async (input, format) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer())
    assert(bytes.length > 32)
    seen.push(format)
    return new Blob([encoded])
  })
  try {
    for (const [file, alias, codec] of [['legacy-animation.mov', 'Opening.avi', 'rle '], ['legacy-part2.mp4', 'Ending.mp4', 'mp4v']] as const) {
      const bytes = Uint8Array.from(await readFile(new URL('../../out/verification/video-tracks/' + file, import.meta.url)))
      let descriptions: string[] = []
      await readVideoTimeline(bytes, { acceptTracks(tracks) {
        descriptions = tracks.filter((track) => track.handler === 'vide').flatMap((track) => track.entries)
        return false
      } })
      assert.deepEqual(descriptions, [codec])
      await f.port.command(open(alias, { blob: new Blob([bytes]), buffered: false }))
      const result = f.opens.at(-1)!
      assert.equal(result.name, alias)
      assert(!(result.bytes instanceof Uint8Array))
      assert.deepEqual(new Uint8Array(await result.bytes.blob.arrayBuffer()), encoded)
      assert.equal(result.timeline?.videoStreams, 1)
    }
    // A codec spelling inside a padding box never changes a native H.264 open.
    const padding = Uint8Array.of(0, 0, 0, 12, 102, 114, 101, 101, 109, 112, 52, 118)
    const native = new Blob([encoded, padding], { type: 'video/mp4' })
    await f.port.command(open('native.mov', { blob: native, buffered: false }))
    const last = f.opens.at(-1)!; assert(!(last.bytes instanceof Uint8Array))
    assert.equal(last.bytes.buffered, false); assert.equal(last.bytes.blob.size, native.size)
    assert.deepEqual(seen, ['mov', 'mov'])
  } finally { await f.close() }
})

test('QuickTime conversion preserves native and mixed-codec tracks outside the converter’s supported set', () => {
  const track = (handler: string, ...entries: string[]) => ({ handler, entries })
  assert(needsQuickTimeConversion([track('vide', 'avc1', 'mp4v'), track('soun', 'mp4a'), track('text', 'text')]))
  assert(needsQuickTimeConversion([track('vide', 'avc3'), track('vide', 'rle '), track('soun', 'twos')]))
  for (const tracks of [
    [track('vide', 'avc1'), track('soun', 'mp4a')], [track('vide', 'av01', 'rle ')],
    [track('vide', 'mp4v'), track('soun', 'Opus')], [track('vide', 'mp4v'), track('soun', 'enca')],
    [track('vide', 'encv')], [track('meta', 'mp4v')], Array.from({ length: 17 }, () => track('vide', 'mp4v')),
  ]) assert.equal(needsQuickTimeConversion(tracks), false)
})

test('QuickTime conversion failure retains the original bytes for native playback and releases the temporary reservation', async () => {
  const bytes = Uint8Array.from(await readFile(new URL('../../out/verification/video-tracks/legacy-part2.mp4', import.meta.url)))
  let attempts = 0
  const f = transport(async () => { attempts++; throw new Error('Converter unavailable') })
  try {
    await f.port.command(open('old.mp4', bytes))
    assert.equal(attempts, 1)
    assert(f.opens[0]?.bytes instanceof Uint8Array); assert.deepEqual(f.opens[0].bytes, bytes)
    assert.equal(f.port.inspectSources().bufferedBytes, 0)
  } finally { await f.close() }
})

test('closing a QuickTime cutscene during conversion retires the request without reopening the original movie', async () => {
  const bytes = Uint8Array.from(await readFile(new URL('../../out/verification/video-tracks/legacy-animation.mov', import.meta.url)))
  let started!: () => void
  const converting = new Promise<void>((resolve) => { started = resolve })
  const f = transport((_input, format, signal) => new Promise<Blob>((_resolve, reject) => {
    assert.equal(format, 'mov')
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started()
  }))
  try {
    const pending = assert.rejects(f.port.command(open('animation.mov', { blob: new Blob([bytes]), buffered: true })), /closed|superseded/)
    await converting
    await f.port.command({ op: 'close', id: 3, epoch: 2 })
    await pending
    assert.equal(f.opens.length, 0)
    assert.deepEqual(f.port.inspectSources(), { preparations: 0, bufferedBytes: 0, metadataBytes: 0 })
  } finally { await f.close() }
})
