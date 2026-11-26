import assert from 'node:assert/strict'
import test from 'node:test'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { openCddaPcmSource } from '../../src/formats/audio/cdda-source.ts'
import { aiffReference } from '../helpers/cdda-aiff.ts'
import { deferred } from '../helpers/http-server.ts'

const source = (bytes: Buffer) => ({ size: bytes.length, async read(at: number, count: number) { return bytes.subarray(at, at + count) } })
const open = (bytes: Buffer) => openPortablePcmSource(source(bytes), { cddaFile: true })
function chunk(tag: string, payload: Buffer) {
  const bytes = Buffer.alloc(8 + payload.length + (payload.length & 1))
  bytes.write(tag, 0); bytes.writeUInt32BE(payload.length, 4); payload.copy(bytes, 8)
  return bytes
}
function form(chunks: Buffer[], type = 'AIFF') {
  const header = Buffer.alloc(12); header.write('FORM'); header.write(type, 8)
  header.writeUInt32BE(4 + chunks.reduce((sum, part) => sum + part.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}
function comm(bits: number, frames: number, codec?: string) {
  const bytes = Buffer.alloc(codec ? 24 : 18)
  bytes.writeUInt16BE(1); bytes.writeUInt32BE(frames, 2); bytes.writeUInt16BE(bits, 6)
  Buffer.from('400eac44000000000000', 'hex').copy(bytes, 8) // extended 44100
  if (codec) bytes.write(codec, 18)
  return chunk('COMM', bytes)
}
function sound(samples: Buffer, offset = 0) {
  const header = Buffer.alloc(8); header.writeUInt32BE(offset)
  return chunk('SSND', Buffer.concat([header, Buffer.alloc(offset, 0x6d), samples]))
}
test('AIFF sound data can precede its description, with an odd chunk, sound offset and left-justified signed samples', async () => {
  for (const [bits, hex, values] of [
    [1, '80ff0000', [-1, -1, 0]], [8, '807f00ff', [-1, 127 / 128, 0]],
    [12, '800f7fff000f1234', [-1, 2047 / 2048, 0]],
    [20, '80000f7fffff00000fabcdef', [-1, 524287 / 524288, 0]],
    [32, '800000007fffffff00000000', [-1, Math.fround(2147483647 / 2147483648), 0]],
  ] as const) {
    const bytes = form([chunk('ANNO', Buffer.from('odd')), sound(Buffer.from(hex, 'hex'), 3), comm(bits, 3)])
    assert.equal(await openPortablePcmSource(source(bytes)), undefined, 'an ordinary WAVE reader keeps its format selection')
    const reader = await open(bytes); assert(reader)
    try { assert.deepEqual([...(await reader.read(0, 16))[0]!], [...values]); assert.equal(reader.info.bits, bits) }
    finally { await reader.close() }
  }
})

test('AIFF-C validates frame and chunk boundaries, compression, sample rates and finite float output', async () => {
  await assert.rejects(open(form([comm(16, 3), sound(Buffer.alloc(4))])), /frames exceed/)
  const short = sound(Buffer.alloc(2)); short.writeUInt32BE(20, 8)
  await assert.rejects(open(form([comm(16, 1), short])), /SSND offset/)
  await assert.rejects(open(form([comm(16, 1), comm(16, 1), sound(Buffer.alloc(2))])), /COMM/)
  await assert.rejects(open(form([comm(16, 1), sound(Buffer.alloc(2)), sound(Buffer.alloc(2))])), /SSND/)
  const fractional = comm(16, 1); fractional[fractional.length - 1] = 1
  await assert.rejects(open(form([fractional, sound(Buffer.alloc(2))])), /sample rate/)
  await assert.rejects(open(form([comm(16, 1, 'ABCD'), sound(Buffer.alloc(2))], 'AIFC')), /encoding: ABCD/)
  const badName = comm(16, 1, 'NONE'); badName[30] = 8
  await assert.rejects(open(form([badName, sound(Buffer.alloc(2))], 'AIFC')), /compression name/)
  await assert.rejects(open(form([comm(16, 1, 'NONE'), chunk('FVER', Buffer.alloc(4)), sound(Buffer.alloc(2))], 'AIFC')), /version/)
  await assert.rejects(open(form([comm(16, 1), sound(Buffer.alloc(2))]).subarray(0, -1)), /Truncated/)
  const reader = await open(form([comm(32, 1, 'fl32'), sound(Buffer.from('7f800000', 'hex'))], 'AIFC'))
  assert(reader)
  try { await assert.rejects(reader.read(0, 1), /finite PCM/) } finally { await reader.close() }
})

test('explicit AIFF-C integer tags retain signedness, packing and byte order', async () => {
  for (const [codec, bits, hex, divisor] of [
    ['raw ', 8, '0081', 128], ['twos', 16, '80000001', 32768], ['sowt', 16, '00800100', 32768],
    ['in24', 24, '800000000001', 8388608], ['in32', 32, '8000000000000001', 2147483648],
  ] as const) {
    const reader = await open(form([comm(bits, 2, codec), sound(Buffer.from(hex, 'hex'))], 'AIFC'))
    assert(reader)
    try { assert.deepEqual([...(await reader.read(0, 2))[0]!], [-1, 1 / divisor]) } finally { await reader.close() }
  }
})

test('CDDA decodes every FFmpeg-authored AIFF frame and both channels exactly, including little-endian and floating-point AIFF-C', async () => {
  const { raw, files, record } = aiffReference()
  for (const { name } of record.variants) {
    const bytes = files.get(name)!, reader = await openCddaPcmSource(source(bytes), {
      parts: [{ kind: 'file', offset: 0, size: bytes.length, encoding: 'encoded', startFrame: 0 }],
    }, {}, openPortablePcmSource)
    try {
      assert.equal(reader.info.sampleRate, record.rate); assert.equal(reader.info.sampleCount, record.frames)
      assert.equal(reader.info.channels, 2)
      for (let start = 0; start < record.frames; start += 32003) {
        const planes = await reader.read(start, 32003)
        assert.equal(planes[0]!.length, Math.min(32003, record.frames - start))
        for (const [c, plane] of planes.entries()) for (let n = 0; n < plane.length; n++) {
          const expected = raw.readInt16LE((start + n) * 4 + c * 2) / 32768
          if (plane[n] !== expected) assert.fail(`${name}: frame ${start + n}, channel ${c} differs`)
        }
      }
    } finally { await reader.close() }
  }
})

test('seeking into a 128 MiB AIFF disc reads only headers and the requested sample window', async () => {
  const frames = 64 * 1024 * 1024, payload = frames * 2, header = form([comm(16, frames), sound(Buffer.alloc(0))])
  header.writeUInt32BE(header.length + payload - 8, 4); header.writeUInt32BE(payload + 8, header.length - 12)
  const reads: Array<[number, number]> = [], reader = await openPortablePcmSource({
    size: header.length + payload,
    async read(at, count) {
      reads.push([at, count])
      if (at < header.length) return header.subarray(at, at + count)
      const bytes = Buffer.alloc(count)
      for (let i = 0; i < count; i += 2) bytes.writeInt16BE(((at - header.length + i) / 2) % 32768, i)
      return bytes
    },
  }, { cddaFile: true })
  assert(reader)
  try {
    assert(reads.every(([at, count]) => at + count <= header.length))
    reads.length = 0
    assert.deepEqual([...(await reader.read(frames - 3, 8))[0]!], [32765, 32766, 32767].map((v) => v / 32768))
    assert.deepEqual(reads, [[header.length + payload - 6, 6]])
  } finally { await reader.close() }
})

test('closing a CD track cancels a held AIFF sample range and leaves the imported file available', { timeout: 15000 }, async () => {
  const bytes = form([comm(16, 2), sound(Buffer.from('4000c000', 'hex'))])
  const held = deferred<Uint8Array>(), entered = deferred()
  let hold = true
  const borrowed = { size: bytes.length, async read(at: number, count: number) {
    if (hold && at === bytes.length - 4) { entered.resolve(); return held.promise }
    return bytes.subarray(at, at + count)
  } }, track = { parts: [{ kind: 'file', offset: 0, size: bytes.length, encoding: 'encoded', startFrame: 0 }] } as const
  const reader = await openCddaPcmSource(borrowed, track, {}, openPortablePcmSource)
  const stopped = assert.rejects(reader.read(0, 2), /closed/)
  await entered.promise
  await reader.close()
  await stopped
  hold = false; held.resolve(bytes.subarray(-4))
  const reopened = await openCddaPcmSource(borrowed, track, {}, openPortablePcmSource)
  try { assert.deepEqual([...(await reopened.read(0, 2))[0]!], [.5, -.5]) } finally { await reopened.close() }
})
