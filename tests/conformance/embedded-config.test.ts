import assert from 'node:assert/strict'
import test from 'node:test'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { readEmbeddedConfig } from '../../src/engine/system/embedded-config.ts'

const minimum = 512 * 1024, maximum = 5 * 1024 * 1024, page = 64 * 1024
const reader = { decode: async (bytes: Uint8Array) => new TextDecoder('shift_jis').decode(bytes) }
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
// Independent ordinary author-area layout from ConfMainFrameUnit's section 0.
// This is inert data, not a native executable or a product-generated fixture.
const area = (text: string | Uint8Array, capacity?: number) => {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'ascii') : text
  return Buffer.concat([Buffer.from('XOPT_EMBED_AREA_', 'ascii'), u32(capacity ?? bytes.length + 1), bytes, Buffer.from([0])])
}
function source(size: number, zones: { at: number; bytes: Uint8Array }[] = []) {
  const reads: [number, number][] = []
  const resource: Resource = { name: 'Story.exe', size,
    read: async () => { throw new Error('A range-capable executable must never be read whole') },
    source: { size, read: async (offset, length) => {
      assert(offset >= minimum && offset + length <= Math.min(size, maximum))
      assert(length <= page)
      reads.push([offset, length])
      const bytes = Buffer.alloc(length, 0x55)
      for (const zone of zones) {
        const start = Math.max(offset, zone.at), end = Math.min(offset + length, zone.at + zone.bytes.length)
        if (end > start) bytes.set(zone.bytes.subarray(start - zone.at, end - zone.at), start - offset)
      }
      return bytes
    } },
  }
  return { resource, reads }
}

test('embedded options decode only the first ordinary string and reuse exact config-line semantics', async () => {
  const bytes = Buffer.concat([Buffer.from('flag\r\nroute=first\r\nroute=second\r\nname='), Buffer.from([0x82, 0xa0]),
    Buffer.from('\r\nquoted="A" "B"\r\n')]),
    fixture = source(minimum + 4096, [{ at: minimum, bytes: Buffer.concat([
      area(bytes, 258), Buffer.from('later="unterminated'),
    ]) }])
  let calls = 0
  const result = await readEmbeddedConfig(fixture.resource, { decode: async (actual) => {
    calls++; assert.deepEqual(actual, new Uint8Array(bytes)); return reader.decode(actual)
  } })
  assert.deepEqual([...result], [['-flag', 'yes'], ['-route', 'first'], ['-name', 'あ'], ['-quoted', 'AB']])
  assert.equal(calls, 1)
  assert.deepEqual(fixture.reads, [[minimum, 4096]])
})

test('embedded discovery uses the first aligned marker and handles the capacity on the next read page', async () => {
  const chosen = minimum + page - 16, fixture = source(chosen + page + 100, [
    { at: minimum - 16, bytes: area('wrong=before') },
    { at: minimum + 1, bytes: area('wrong=unaligned') },
    { at: chosen, bytes: area('chosen=yes') },
    { at: chosen + 64, bytes: area('wrong=later') },
  ])
  assert.deepEqual([...await readEmbeddedConfig(fixture.resource, reader)], [['-chosen', 'yes']])
  assert.deepEqual(fixture.reads, [[minimum, page], [minimum + page, page]])
  const empty = source(minimum + 1024, [{ at: minimum, bytes: area('') }, { at: minimum + 64, bytes: area('wrong=later') }])
  assert.deepEqual([...await readEmbeddedConfig(empty.resource, reader)], [])
})

test('short placeholders and missing markers are empty without reading outside the original search window', async () => {
  for (const size of [0, 16, minimum - 1, minimum, minimum + 15]) {
    const fixture = source(size)
    assert.deepEqual([...await readEmbeddedConfig(fixture.resource, reader)], [])
    assert.deepEqual(fixture.reads, [])
  }
  const huge = source(2 ** 40, [
    { at: minimum - 32, bytes: area('wrong=before') },
    { at: maximum, bytes: area('wrong=after') },
  ])
  assert.deepEqual([...await readEmbeddedConfig(huge.resource, reader)], [])
  assert.equal(huge.reads.reduce((total, [, length]) => total + length, 0), maximum - minimum)
  assert.equal(huge.reads.length, 72)
})

test('reserved capacity may cross five MiB while the first ordinary string ends inside the native window', async () => {
  const at = maximum - 32, fixture = source(maximum + 4096, [{ at, bytes: area('x=ok', 2048) }])
  assert.deepEqual([...await readEmbeddedConfig(fixture.resource, reader)], [['-x', 'ok']])
  assert.equal(fixture.reads.at(-1)![0] + fixture.reads.at(-1)![1], maximum)
  assert.equal(fixture.reads.reduce((total, [, length]) => total + length, 0), maximum - minimum)
  const lastByte = source(maximum, [{ at, bytes: area('x=123456789', 12) }])
  assert.deepEqual([...await readEmbeddedConfig(lastByte.resource, reader)], [['-x', '123456789']])
})

test('malformed first areas reject truncated fields, invalid capacities and missing bounded terminators', async () => {
  const marker = Buffer.from('XOPT_EMBED_AREA_'), cases = [
    { size: minimum + 18, at: minimum, bytes: Buffer.concat([marker, Buffer.from([1, 0])]), error: 'Truncated embedded configuration capacity' },
    { size: minimum + 1024, at: minimum, bytes: Buffer.concat([marker, u32(0)]), error: 'Embedded configuration capacity is outside the resource' },
    { size: minimum + 1024, at: minimum, bytes: Buffer.concat([marker, u32(1005)]), error: 'Embedded configuration capacity is outside the resource' },
    { size: minimum + 1024, at: minimum, bytes: Buffer.concat([marker, u32(0xffffffff)]), error: 'Embedded configuration capacity is outside the resource' },
    { size: minimum + 1024, at: minimum, bytes: Buffer.concat([marker, u32(3), Buffer.from('x=y\0')]), error: 'Unterminated embedded configuration within the readable area' },
    { size: maximum + 1024, at: maximum - 32, bytes: Buffer.concat([marker, u32(100), Buffer.from('x=1234567890\0')]), error: 'Unterminated embedded configuration within the readable area' },
    { size: maximum + 1024, at: maximum - 16, bytes: area('outside'), error: 'Truncated embedded configuration capacity' },
  ]
  for (const item of cases) {
    const fixture = source(item.size, [{ at: item.at, bytes: item.bytes }])
    await assert.rejects(readEmbeddedConfig(fixture.resource, { decode: async () => assert.fail('Invalid area must not decode') }),
      { name: 'Error', message: item.error })
  }
  const firstBad = source(minimum + 1024, [
    { at: minimum, bytes: Buffer.concat([marker, u32(0)]) }, { at: minimum + 32, bytes: area('later=valid') },
  ])
  await assert.rejects(readEmbeddedConfig(firstBad.resource, reader), { message: 'Embedded configuration capacity is outside the resource' })
})

test('whole-file-only resources skip oversized optional defaults without reading and validate declared source ranges', async () => {
  const bytes = Buffer.alloc(minimum + 1024); bytes.set(area('fallback=yes'), minimum)
  let calls = 0
  const resource: Resource = { name: 'small.exe', size: bytes.length, read: async () => { calls++; return bytes } }
  assert.deepEqual([...await readEmbeddedConfig(resource, reader)], [['-fallback', 'yes']])
  assert.equal(calls, 1)
  calls = 0
  const warnings: string[] = [], large = { ...resource, name: 'Old embedding/combined.exe', size: maximum + 1 }
  assert.deepEqual([...await readEmbeddedConfig(large, {
    decode: async () => assert.fail('Skipped embedded defaults must not decode'), warn: (message) => warnings.push(message),
  })], [])
  assert.deepEqual(warnings, ['Skipping embedded configuration for Old embedding/combined.exe: no range source; whole-file reads above 5 MiB are disabled'])
  assert.equal(calls, 0)
  assert.deepEqual([...await readEmbeddedConfig(large, reader)], [], 'Legacy callers need not install a warning sink')
  assert.equal(calls, 0)
  await assert.rejects(readEmbeddedConfig({ ...resource, source: { size: bytes.length - 1, read: async () => bytes } }, reader),
    { message: 'Resource source size or reader mismatch' })
  await assert.rejects(readEmbeddedConfig({ ...resource, source: { size: bytes.length, read: async () => new Uint8Array(3) } }, reader),
    { message: 'Resource source returned an invalid range' })
  await assert.rejects(readEmbeddedConfig({ ...resource, size: Number.NaN }, reader), { message: 'Resource read outside valid range' })
})

test('cancellation is checked before reading and after an outstanding read or decoder completes', { timeout: 10000 }, async () => {
  const cancelled = new Error('Stop embedded configuration'), fixture = source(minimum + 1024, [{ at: minimum, bytes: area('x=ok') }])
  await assert.rejects(readEmbeddedConfig(fixture.resource, { ...reader, checkpoint: () => { throw cancelled } }), (error) => error === cancelled)
  assert.deepEqual(fixture.reads, [])
  const warnings: string[] = []
  await assert.rejects(readEmbeddedConfig({ ...fixture.resource, source: undefined, size: maximum + 1 }, {
    ...reader, warn: (message) => warnings.push(message), checkpoint: () => { throw cancelled },
  }), (error) => error === cancelled)
  assert.deepEqual(warnings, [], 'Stop precedes optional-layer capability warnings')
  let finish!: (bytes: Uint8Array) => void, entered!: () => void, stopped = false, decoded = false
  const began = new Promise<void>((resolve) => { entered = resolve }), held = new Promise<Uint8Array>((resolve) => { finish = resolve }),
    resource = { ...fixture.resource, source: { size: fixture.resource.size, read: async () => { entered(); return held } } },
    pending = readEmbeddedConfig(resource, { decode: async () => { decoded = true; return 'x=wrong' },
      checkpoint: () => { if (stopped) throw cancelled } })
  const outcome = assert.rejects(pending, (error) => error === cancelled)
  try { await began; stopped = true } finally { finish(new Uint8Array(1024)) }
  await outcome; assert.equal(decoded, false)
  stopped = false
  await assert.rejects(readEmbeddedConfig(fixture.resource, { decode: async (bytes) => { stopped = true; return reader.decode(bytes) },
    checkpoint: () => { if (stopped) throw cancelled } }), (error) => error === cancelled)
})

test('source, decoder and quoted-value errors retain their original cause instead of becoming absent options', async () => {
  const fixture = source(minimum + 1024, [{ at: minimum, bytes: area('x=ok') }]), failure = new Error('Original source failure')
  await assert.rejects(readEmbeddedConfig({ ...fixture.resource, source: {
    size: fixture.resource.size, read: async () => { throw failure },
  } }, reader), (error) => error === failure)
  await assert.rejects(readEmbeddedConfig(fixture.resource, { decode: async () => { throw failure } }), (error) => error === failure)
  const invalid = source(minimum + 1024, [{ at: minimum, bytes: area('x="broken') }])
  await assert.rejects(readEmbeddedConfig(invalid.resource, reader), {
    name: 'Error', message: 'Unterminated quoted engine option on line 1',
  })
})
