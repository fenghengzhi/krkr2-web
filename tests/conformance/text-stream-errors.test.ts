import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, deflateRawSync } from 'node:zlib'
import { readText, writeText } from '../../src/backends/files/text-codecs.ts'
import { inflateRaw } from '../../src/backends/files/blob-source.ts'
import { decodeTextStream, encodeTextStream, type TextCodecs } from '../../src/formats/text/stream.ts'
import { parseTextWriterMode } from '../../src/formats/text/mode.ts'
import { TextStreamError } from '../../src/formats/text/errors.ts'
import { CompressionError } from '../../src/formats/binary/compression-error.ts'
import { mapTextStreamError } from '../../src/engine/system/text-stream-error.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { ExecutionCancelled } from '../../src/engine/scheduler/control.ts'

function envelope(body: Uint8Array, length: bigint, packed = BigInt(body.length)): Uint8Array {
  const result = new Uint8Array(21 + body.length), view = new DataView(result.buffer)
  result.set([0xfe, 0xfe, 2, 0xff, 0xfe])
  view.setBigUint64(5, packed, true); view.setBigUint64(13, length, true)
  result.set(body, 21)
  return result
}
function codec(overrides: Partial<TextCodecs> = {}): TextCodecs {
  return {
    narrow: () => { throw new Error('Unexpected narrow conversion') },
    utf8: () => { throw new Error('Unexpected UTF-8 encoding') },
    inflate: async () => { throw new Error('Unexpected inflate') },
    deflate: async () => { throw new Error('Unexpected deflate') },
    ...overrides,
  }
}
function mapped(error: unknown, kind: TextStreamError['kind'], id: string, args: string[]): boolean {
  assert(error instanceof TextStreamError); assert.equal(error.kind, kind)
  const result = mapTextStreamError(error, 'archive.xp3>requested%1.txt')
  assert(result instanceof TvpError)
  assert.deepEqual(result.tvpMessage, { id, args })
  assert.equal(result.cause, error)
  return true
}

test('text writer unsupported modes carry a fixed native argument and precede offset validation', { timeout: 30000 }, async () => {
  for (const mode of ['c0', 'c3', 'c9o67108865', 'c01', 'bc0']) {
    const check = (error: unknown) => mapped(error, 'unsupported-mode', 'TVPUnsupportedModeString', ['unsupported cipher mode'])
    assert.throws(() => parseTextWriterMode(mode), check)
    await assert.rejects(writeText('unchanged', mode), check)
  }
  assert.equal(parseTextWriterMode('c0z').encoding, 'compressed')
  assert.equal(parseTextWriterMode('c0utf8').encoding, 'utf8')
})

test('cipher type and original BOM errors map only their original requested storage name', { timeout: 30000 }, async () => {
  for (const bytes of [
    [0xfe, 0xfe, 3, 0xff, 0xfe],
    [0xfe, 0xfe, 1, 0, 0],
    [0xfe, 0xfe, 0, 0xfe, 0xff],
    [0xfe, 0xfe, 2, 0xff, 0],
    [0xfe, 0xfe, 1],
  ]) await assert.rejects(readText(Uint8Array.from(bytes)), (error) =>
    mapped(error, 'unsupported-cipher', 'TVPUnsupportedCipherMode', ['archive.xp3>requested%1.txt']))
})

test('native uint32 envelope failures remain separate from smaller Web budgets and binary short reads', { timeout: 30000 }, async () => {
  for (const [packed, length] of [[0x100000000n, 0n], [0n, 0x100000000n], [0xffffffffffffffffn, 2n]] as const)
    await assert.rejects(readText(envelope(new Uint8Array(), length, packed)), (error) =>
      mapped(error, 'unsupported-cipher', 'TVPUnsupportedCipherMode', ['archive.xp3>requested%1.txt']))
  for (const bytes of [envelope(new Uint8Array(), 67108865n), envelope(new Uint8Array(), 2n, 4n),
    Uint8Array.from([0xfe, 0xfe, 2, 0xff, 0xfe])]) {
    await assert.rejects(readText(bytes), (error) => {
      assert(!(error instanceof TextStreamError)); assert.equal(mapTextStreamError(error, 'ignored'), error)
      return true
    })
  }
})

test('real zlib checksum corruption and exact-size mismatches produce the native cipher category', { timeout: 30000 }, async () => {
  const content = Buffer.from('A日\r\n', 'utf16le'), packed = deflateSync(content), damaged = Uint8Array.from(packed)
  damaged[damaged.length - 1]! ^= 1
  for (const bytes of [envelope(damaged, BigInt(content.length)), envelope(packed, BigInt(content.length - 2)),
    envelope(packed, BigInt(content.length + 2)), envelope(Uint8Array.from([1, 2, 3]), 2n)])
    await assert.rejects(readText(bytes), (error) =>
      mapped(error, 'unsupported-cipher', 'TVPUnsupportedCipherMode', ['archive.xp3>requested%1.txt']))
  // The declared compressed extent owns the zlib stream; trailing file bytes
  // are not silently added to its input.
  assert.equal(await readText(Buffer.concat([envelope(packed, BigInt(content.length)), Buffer.from([0xa5, 0x5a])])), 'A日\r\n')
})

test('unbranded codec failures and cancellations preserve identity instead of matching English messages', { timeout: 30000 }, async () => {
  const input = envelope(new Uint8Array(), 2n)
  for (const error of [new ExecutionCancelled(), new Error('Decoded text stream exceeds budget'),
    new Error('Unsupported text writer encoding 0'), new RangeError('allocation failed'), 'opaque failure']) {
    await assert.rejects(decodeTextStream(input, codec({ inflate: async () => { throw error } })), (actual) => {
      assert.equal(actual, error); assert.equal(mapTextStreamError(actual, 'ignored'), error); return true
    })
    await assert.rejects(encodeTextStream('A', codec({ deflate: async () => { throw error } }), 'z'), (actual) => {
      assert.equal(actual, error); assert.equal(mapTextStreamError(actual, 'ignored'), error); return true
    })
  }
})

test('only deflate processing errors use the parameterless native compression holder', { timeout: 30000 }, async () => {
  const cause = new Error('controlled codec failure'), compressed = new CompressionError('deflate', 'codec failure', { cause })
  await assert.rejects(encodeTextStream('日本語', codec({ deflate: async () => { throw compressed } }), 'c2'), (error) => {
    mapped(error, 'compression-failed', 'TVPCompressionFailed', [])
    assert.equal((error as TextStreamError).cause, compressed)
    return true
  })
  const wrongPhase = new CompressionError('inflate', 'different codec phase')
  await assert.rejects(encodeTextStream('A', codec({ deflate: async () => { throw wrongPhase } }), 'z'), (error) => error === wrongPhase)
})

test('a decompression checkpoint failure escapes the codec reader classification unchanged', { timeout: 30000 }, async () => {
  const cancelled = new ExecutionCancelled(), packed = deflateRawSync(Buffer.from('raw'))
  await assert.rejects(inflateRaw(packed, 3, async () => { throw cancelled }), (error) => error === cancelled)
  await assert.rejects(inflateRaw(packed, 2), (error) => error instanceof CompressionError && error.operation === 'inflate')
})

test('codec output disagreement is a cipher failure while unchanged legacy c0/c1 bytes still decode', { timeout: 30000 }, async () => {
  await assert.rejects(decodeTextStream(envelope(new Uint8Array(), 4n), codec({ inflate: async () => new Uint8Array(2) })), (error) =>
    mapped(error, 'unsupported-cipher', 'TVPUnsupportedCipherMode', ['archive.xp3>requested%1.txt']))
  assert.equal(await readText(Uint8Array.from([0xfe, 0xfe, 0, 0xff, 0xfe, 0x40, 0x40, 0xe4, 0x81])), 'A日')
  assert.equal(await readText(Uint8Array.from([0xfe, 0xfe, 1, 0xff, 0xfe, 0x82, 0])), 'A')
})
