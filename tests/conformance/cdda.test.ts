import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCue, cueTrackParts } from '../../src/formats/audio/cue.ts'
import { openCddaPcmSource } from '../../src/formats/audio/cdda-source.ts'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { CddaDiscs, openCddaSelection } from '../../src/engine/storage/cdda.ts'
import { AudioResourceSources } from '../../src/engine/storage/audio-sources.ts'
import { copyCddaDiscs } from '../../src/engine/ports/cdda.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import type { ByteSource, Resource } from '../../src/engine/ports/storage.ts'
import { wave } from '../helpers/audio.ts'

const encode = (text: string) => new TextEncoder().encode(text)
function raw(sectors: number, little = true): Uint8Array {
  const bytes = new Uint8Array(sectors * 2352), view = new DataView(bytes.buffer)
  for (let frame = 0; frame < sectors * 588; frame++) {
    const sector = Math.floor(frame / 588)
    view.setInt16(frame * 4, [8192, -16384, 4096, -4096][sector % 4]!, little)
    view.setInt16(frame * 4 + 2, [4096, -8192, 2048, -2048][sector % 4]!, little)
  }
  return bytes
}
const source = (bytes: Uint8Array): ByteSource => ({ size: bytes.length, async read(offset, length) { return bytes.slice(offset, offset + length) } })
const sheet = (text: string) => parseCue(encode(text))

test('CUE preserves original track numbers and file-relative INDEX 01 boundaries in CD frames', () => {
  const value = sheet('REM ignored text\nfile "disc image.bin" BINARY\nTRACK 01 MODE1/2352\nINDEX 01 00:00:00\n' +
    'TRACK 02 AUDIO\nINDEX 00 00:01:00\nINDEX 01 00:01:02\nTRACK 03 AUDIO\nINDEX 01 00:02:00\n')
  assert.equal(value.files[0]!.name, 'disc image.bin')
  assert.equal(cueTrackParts(value, 1), undefined)
  assert.equal(cueTrackParts(value, 99), undefined)
  assert.deepEqual(cueTrackParts(value, 2), [{ kind: 'file', file: 0, startFrame: 77, endFrame: 150 }])
  assert.deepEqual(cueTrackParts(value, 3), [{ kind: 'file', file: 0, startFrame: 150 }])
})

test('CUE cross-file intervals retain generated gaps and the next file-backed pre-gap', () => {
  const value = sheet('FILE a.wav WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nPOSTGAP 00:00:01\n' +
    'FILE b.wav WAVE\nTRACK 02 AUDIO\nPREGAP 00:00:02\nINDEX 00 00:00:00\nINDEX 01 00:00:01')
  assert.deepEqual(cueTrackParts(value, 1), [
    { kind: 'file', file: 0, startFrame: 0 }, { kind: 'silence', frames: 1 },
    { kind: 'silence', frames: 2 }, { kind: 'file', file: 1, startFrame: 0, endFrame: 1 },
  ])
  assert.deepEqual(cueTrackParts(value, 2), [{ kind: 'file', file: 1, startFrame: 1 }])
})

test('CUE rejects invalid coordinates and explicitly separates unsupported physical processing', () => {
  for (const text of ['FILE a WAVE\nTRACK 01 AUDIO', 'FILE a WAVE\nTRACK 01 AUDIO\nINDEX 01 00:60:00',
    'FILE a WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:75', 'FILE a WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nINDEX 00 00:00:00',
    'FILE a WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 01 AUDIO\nINDEX 01 00:01:00'])
    assert.throws(() => sheet(text), /Invalid CUE/)
  assert.throws(() => cueTrackParts(sheet('FILE a BINARY\nTRACK 01 MODE1/2048\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:01:00'), 2), /non-2352/)
  assert.throws(() => cueTrackParts(sheet('FILE a WAVE\nTRACK 01 AUDIO\nFLAGS PRE\nINDEX 01 00:00:00'), 1), /pre-emphasis/)
  assert.throws(() => parseCue(new Uint8Array(1024 * 1024 + 1)), /budget/)
})

test('raw little/big-endian CD sectors decode exact stereo samples and expose only selected frames', async () => {
  for (const little of [true, false]) {
    const bytes = raw(4, little), reads: [number, number][] = [],
      decoder = await openCddaPcmSource({ size: bytes.length, async read(offset, length) {
        reads.push([offset, length]); return bytes.slice(offset, offset + length)
      } }, { parts: [{ kind: 'file', offset: 0, size: bytes.length, encoding: little ? 's16le' : 's16be', startFrame: 1, endFrame: 3 }] }, {}, openPortablePcmSource)
    try {
      assert.equal(decoder.info.sampleCount, 1176); assert.equal(decoder.info.sampleRate, 44100)
      const planes = await decoder.read(0, 1176)
      assert.deepEqual([...planes[0]!], [...Array(588).fill(-0.5), ...Array(588).fill(0.125)])
      assert.deepEqual([...planes[1]!], [...Array(588).fill(-0.25), ...Array(588).fill(0.0625)])
      assert(reads.every(([offset, length]) => offset >= 2352 && offset + length <= 3 * 2352))
      assert.deepEqual((await decoder.read(1175, 20)).map((plane) => [...plane]), [[0.125], [0.0625]])
      await assert.rejects(decoder.read(1177, 1), /outside/)
    } finally { await decoder.close() }
    await assert.rejects(decoder.read(0, 1), /closed/)
  }
})

test('WAVE and generated silence compose a private track timeline without source loop metadata', async () => {
  const a = wave(Array<number>(588 * 2).fill(0.25), 44100, 2), b = wave(Array<number>(1176 * 2).fill(-0.5), 44100, 2),
    joined = new Uint8Array(a.length + b.length)
  joined.set(a); joined.set(b, a.length)
  const decoder = await openCddaPcmSource(source(joined), { parts: [
    { kind: 'file', offset: 0, size: a.length, encoding: 'encoded', startFrame: 0 },
    { kind: 'silence', frames: 2 },
    { kind: 'file', offset: a.length, size: b.length, encoding: 'encoded', startFrame: 0, endFrame: 1 },
  ] }, {}, openPortablePcmSource)
  try {
    assert.equal(decoder.info.sampleCount, 2352)
    assert.deepEqual(decoder.info.loops, { links: [], labels: [] })
    const data = await decoder.read(0, 2352)
    for (const plane of data) assert.deepEqual([...plane], [...Array(588).fill(0.25), ...Array(1176).fill(0), ...Array(588).fill(-0.5)])
    assert.deepEqual((await decoder.read(580, 16)).map((plane) => [...plane]),
      [Array(8).fill(0.25).concat(Array(8).fill(0)), Array(8).fill(0.25).concat(Array(8).fill(0))])
  } finally { await decoder.close() }
})

test('CDDA metadata cancellation owns late decoders and preserves initial failure plus cleanup error', async () => {
  const bytes = raw(1), failure = new Error('decoder failed'), cleanup = new Error('close failed'), abort = new AbortController()
  let closeCount = 0
  const fake = { info: { sampleRate: 44100, channels: 2, bits: 16, sampleCount: 588, loops: { links: [], labels: [] } },
    async read() { throw new Error('Unexpected samples') }, async close() { closeCount++; throw cleanup } }
  await assert.rejects(openCddaPcmSource(source(bytes), { parts: [
    { kind: 'file', offset: 0, size: bytes.length, encoding: 'encoded', startFrame: 0 },
  ] }, { checkpoint() { throw failure } }, async () => fake), (error: unknown) => {
    assert(error instanceof AggregateError); assert.equal(error.cause, failure); assert.deepEqual(error.errors, [failure, cleanup]); return true
  })
  assert.equal(closeCount, 1)
  let release!: () => void, entered!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve }), gate = new Promise<void>((resolve) => { entered = resolve })
  const operation = openCddaPcmSource(source(bytes), { parts: [
    { kind: 'file', offset: 0, size: bytes.length, encoding: 'encoded', startFrame: 0 },
  ] }, { signal: abort.signal }, async () => { entered(); await hold; return { ...fake, async close() { closeCount++ } } })
  const rejected = assert.rejects(operation, /closed/)
  try { await gate; abort.abort(); release(); await rejected; assert.equal(closeCount, 2) }
  finally { release(); await operation.catch(() => {}) }
})

test('closing a CDDA track cancels its real child PCM read without waiting for the borrowed provider', { timeout: 10000 }, async () => {
  const bytes = wave(Array<number>(1176).fill(0.25), 44100, 2)
  let armed = false, release!: () => void, entered!: () => void, timer: ReturnType<typeof setTimeout> | undefined
  const hold = new Promise<void>((resolve) => { release = resolve }), gate = new Promise<void>((resolve) => { entered = resolve })
  const decoder = await openCddaPcmSource({ size: bytes.length, async read(offset, length) {
    if (armed && offset >= 44) { entered(); await hold }
    return bytes.slice(offset, offset + length)
  } }, { parts: [{ kind: 'file', offset: 0, size: bytes.length, encoding: 'encoded', startFrame: 0 }] }, {}, openPortablePcmSource)
  armed = true
  const reading = decoder.read(0, 588).then((value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }))
  try {
    await gate
    const closing = decoder.close()
    await Promise.race([closing, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Parent close waited for its child read instead of cancelling it')), 1000)
    })])
    clearTimeout(timer)
    const outcome = await reading
    assert.equal(outcome.status, 'rejected')
    if (outcome.status === 'rejected') assert.match(String(outcome.reason), /closed/)
    assert.equal(decoder.close(), closing, 'retirement remains idempotent')
  } finally { clearTimeout(timer); release(); await reading; await decoder.close() }
})

function resolver(files: Record<string, Uint8Array>, cues: string[], discs?: Parameters<typeof copyCddaDiscs>[0]) {
  const resources = new Map(Object.entries(files).map(([name, bytes]) => [name, {
    name, size: bytes.length, source: source(bytes), async read() { return bytes.slice() },
  } satisfies Resource]))
  return new CddaDiscs({ currentDirectory: '', exists: async (name) => resources.has(name),
    exact: async (name) => resources.get(name), cues: async () => cues,
    read: (resource) => resource.read(), checkpoint: async () => {} }, discs)
}
test('virtual CDDA preserves direct files, binds explicit drives and resolves CUE-relative archive paths', async () => {
  const cue = encode('FILE "../audio/raw.bin" BINARY\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:00:01'),
    files = { 'game.xp3>disc/disc.cue': cue, 'game.xp3>audio/raw.bin': raw(2), '2.wav': wave([0.25], 44100) },
    discs = resolver(files, ['game.xp3>disc/disc.cue'])
  assert.equal(await discs.prepare('2.wav'), undefined)
  const selected = await discs.prepare('d:2tail')
  assert.equal(selected!.track, 2); assert.equal(selected!.drive, 'D')
  const sources = new AudioResourceSources(async () => {}), lease = await openCddaSelection(selected!, sources, () => true)
  const decoder = await openCddaPcmSource(lease.source, lease.cdda, {}, openPortablePcmSource)
  try { assert.deepEqual((await decoder.read(0, 3)).map((plane) => [...plane]), [[-0.5, -0.5, -0.5], [-0.25, -0.25, -0.25]]) }
  finally { await decoder.close(); lease.release(); sources.dispose() }
  assert.deepEqual(sources.inspect(), { bufferedBytes: 0, leases: 0 })
  assert.equal((await discs.prepare('99'))!.parts, undefined, 'absent tracks remain an open-time selection')
  await assert.rejects(discs.prepare('E:1'), (error: unknown) => error instanceof TvpError && error.tvpMessage.id === 'TVPInvalidCDDADrive')
  const explicit = resolver(files, ['other.cue', 'game.xp3>disc/disc.cue'], [{ drive: 'F', cue: 'game.xp3>disc/disc.cue' }])
  assert.equal((await explicit.prepare('1'))!.drive, 'F')
})

test('disc ambiguity, path escape, missing media and mutable startup bindings cannot silently select another file', async () => {
  await assert.rejects(resolver({}, []).prepare('1'), (error: unknown) => error instanceof TvpError && error.tvpMessage.id === 'TVPCDDADriveNotFound')
  await assert.rejects(resolver({}, ['a.cue', 'b.cue']).prepare('1'), /Multiple imported CUE/)
  for (const name of ['../../outside.bin', 'C:\\outside.bin', '/outside.bin']) {
    const cue = encode(`FILE "${name}" BINARY\nTRACK 01 AUDIO\nINDEX 01 00:00:00`)
    await assert.rejects(resolver({ 'a.cue': cue }, ['a.cue']).prepare('1'), /escapes|relative/)
  }
  const bindings = [{ drive: 'd', cue: 'a.cue' }], copied = copyCddaDiscs(bindings)!
  bindings[0]!.drive = 'E'; assert.deepEqual(copied, [{ drive: 'D', cue: 'a.cue' }]); assert(Object.isFrozen(copied[0]))
  assert.throws(() => copyCddaDiscs([{ drive: 'D', cue: 'a' }, { drive: 'd', cue: 'b' }]), /Duplicate/)
  assert.throws(() => copyCddaDiscs([{ drive: 'DD', cue: 'a' }]), /Invalid/)
})
