import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateRawSync, crc32 } from 'node:zlib'
import { readZip } from '../../src/formats/zip/archive.ts'
import { cp437 } from '../../src/formats/zip/names.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { inflateRaw } from '../../src/backends/files/blob-source.ts'
import {
  centralRecords,
  openZip,
  zipCodecs,
  zipFixture,
  zipReference,
} from '../helpers/zip-fixtures.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('independent Python ZIP corpus preserves contents, CRC, UTF-8/CP437, descriptors and ZIP64 variants', async () => {
  let entries = 0
  for (const fixture of zipReference.cases) {
    const bytes = zipFixture(fixture.file)
    assert.equal(hash(bytes), fixture.sha256, fixture.file)
    const files = await openZip(bytes)
    assert.equal(files.length, fixture.entries.length, fixture.file)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!,
        expected = fixture.entries[i]!
      assert.equal(file.name, expected.name)
      assert.equal(file.size, expected.size)
      assert.equal(file.zip.crc32, expected.crc32)
      assert.equal(file.zip.method, expected.method)
      assert.equal(hash(await file.read()), expected.sha256, fixture.file + ':' + expected.name)
      entries++
    }
  }
  assert.equal(entries, 90)
  assert.equal(cp437(Uint8Array.of(0x80, 0x82, 0xe0, 0xff)), 'Çéα ')
})

test('ZIP mounting reads central metadata and a bounded tail; inflation and local headers stay lazy', async () => {
  const bytes = zipFixture('0-stream0-local640-zip640.zip'),
    reads: [number, number][] = [],
    inflated: string[] = []
  const files = await readZip(
    {
      size: bytes.length,
      read: async (offset, length) => {
        reads.push([offset, length])
        return bytes.subarray(offset, offset + length)
      },
    },
    {
      ...zipCodecs,
      inflate: async (data, size) => {
        inflated.push(String(size))
        return inflateRaw(data, size)
      },
    },
  )
  assert.deepEqual(inflated, [])
  assert.ok(reads.every(([at]) => at > 1000))
  assert.ok(reads.reduce((sum, [, n]) => sum + n, 0) < bytes.length)
  const a = files.find((f) => f.name === 'startup.tjs')!,
    first = await a.read()
  first[0] = 0
  assert.notEqual((await a.read())[0], 0)
  assert.ok(reads.some(([at]) => at < 1000))
  let calls = 0
  const compressed = await openZip(zipFixture(), {
    ...zipCodecs,
    inflate: async (data, size) => {
      calls++
      return inflateRaw(data, size)
    },
  })
  assert.equal(calls, 0)
  await compressed[0]!.read()
  assert.equal(calls, 1)
})

test('ZIP ignores fake end signatures in a long comment and validates central framing', async () => {
  const bytes = zipFixture('comment.zip')
  Buffer.from('504b0506000000000000000000000000000000000000', 'hex').copy(bytes, bytes.length - 22)
  assert.equal((await openZip(bytes)).length, 6)
  await assert.rejects(openZip(bytes.subarray(0, bytes.length - 1)), /end of central/)
  const invalid = zipFixture(),
    { central, end } = centralRecords(invalid)
  invalid.writeUInt32LE(0, central)
  await assert.rejects(openZip(invalid), /central header/)
  const count = zipFixture()
  count.writeUInt16LE(1, end + 8)
  count.writeUInt16LE(1, end + 10)
  await assert.rejects(openZip(count), /Extra ZIP central/)
  await assert.rejects(
    readZip({ size: 100, read: async () => new Uint8Array(1) }, zipCodecs),
    /Short ZIP/,
  )
})

test('a ZIP64-looking sequence inside a central member comment is not a locator', async () => {
  const bytes = zipFixture(),
    { end, records } = centralRecords(bytes),
    comment = Buffer.alloc(20)
  comment.writeUInt32LE(0x07064b50)
  const result = Buffer.concat([bytes.subarray(0, end), comment, bytes.subarray(end)])
  result.writeUInt16LE(20, records.at(-1)!.at + 32)
  result.writeUInt32LE(bytes.readUInt32LE(end + 12) + 20, end + 20 + 12)
  const files = await openZip(result),
    expected = zipReference.cases.find((f) => f.file === '8-stream0-local640-zip640.zip')!
  assert.equal(files.length, expected.entries.length)
  for (let i = 0; i < files.length; i++)
    assert.equal(hash(await files[i]!.read()), expected.entries[i]!.sha256)
})

test('ZIP member CRC, local metadata, overlapping ranges and data descriptors are checked before returning bytes', async () => {
  for (const kind of ['crc', 'name', 'flags', 'size', 'overlap', 'descriptor']) {
    const bytes = zipFixture(
        kind === 'descriptor' ? '0-stream1-local640-zip640.zip' : '0-stream0-local640-zip640.zip',
      ),
      record = centralRecords(bytes).records.find((r) => r.name === 'startup.tjs')!
    if (kind === 'crc') bytes[record.data] ^= 1
    if (kind === 'name') bytes[record.local + 30] ^= 1
    if (kind === 'flags') bytes[record.local + 6] ^= 1
    if (kind === 'size') bytes.writeUInt32LE(1, record.local + 22)
    if (kind === 'overlap') {
      const size = bytes.readUInt32LE(record.at + 24) + 100
      bytes.writeUInt32LE(size, record.at + 20)
      bytes.writeUInt32LE(size, record.at + 24)
    }
    if (kind === 'descriptor') bytes[record.data + bytes.readUInt32LE(record.at + 20) + 4] ^= 1
    const files = await openZip(bytes),
      target = files.find((f) => f.name === 'startup.tjs')!
    await assert.rejects(target.read(), /ZIP.*(mismatch|range)/, kind)
  }
  const bad = await openZip(zipFixture(), { ...zipCodecs, inflate: async () => Uint8Array.of(1) })
  await assert.rejects(bad[0]!.read(), /decompressed size mismatch/)
})

test('unsupported encrypted, compressed or symlink members remain identifiable and fail only on access', async () => {
  for (const kind of ['encrypted', 'method', 'symlink', 'patched']) {
    const bytes = zipFixture(),
      record = centralRecords(bytes).records.find((r) => r.name === 'empty.bin')!
    if (kind === 'encrypted') bytes.writeUInt16LE(1, record.at + 8)
    if (kind === 'method') bytes.writeUInt16LE(12, record.at + 10)
    if (kind === 'symlink') bytes.writeUInt32LE((0xa1ff << 16) >>> 0, record.at + 38)
    if (kind === 'patched') bytes.writeUInt16LE(32, record.at + 8)
    const files = await openZip(bytes)
    assert.equal(files.length, 6)
    await files[0]!.read()
    await assert.rejects(
      files.find((f) => f.name === 'empty.bin')!.read(),
      /not supported|Unsupported/,
      kind,
    )
  }
})

test('ZIP paths, split volumes, unsafe ZIP64 integers and allocation budgets are rejected', async () => {
  const paths = ['../x.bin', '/root.bin', 'c:/xx.bin', 'a>x.bin\0\0']
  for (const path of paths) {
    const bytes = zipFixture(),
      record = centralRecords(bytes).records.find((r) => r.name === 'empty.bin')!
    Buffer.from(path.padEnd(9, 'x')).copy(bytes, record.at + 46)
    await assert.rejects(openZip(bytes), /path|delimiter|root/, path)
  }
  const split = zipFixture()
  split.writeUInt16LE(1, split.length - 22 + 4)
  await assert.rejects(openZip(split), /Split/)
  const large = zipFixture('8-stream0-local640-zip641.zip'),
    record = Number(large.readBigUInt64LE(large.length - 42 + 8))
  large.writeBigUInt64LE(100001n, record + 24)
  large.writeBigUInt64LE(100001n, record + 32)
  large.writeUInt16LE(0xffff, large.length - 22 + 8)
  large.writeUInt16LE(0xffff, large.length - 22 + 10)
  await assert.rejects(openZip(large), /budget/)
  large.writeBigUInt64LE(2n ** 53n, record + 32)
  await assert.rejects(openZip(large), /safe browser range/)
  const member = zipFixture(),
    central = centralRecords(member).records.find((r) => r.name === 'empty.bin')!
  member.writeUInt32LE(64 * 1024 * 1024 + 1, central.at + 24)
  const files = await openZip(member)
  await assert.rejects(files.find((f) => f.name === 'empty.bin')!.read(), /budget/)
})

test('raw Web decompression enforces size, stream validity and cooperative cancellation', async () => {
  const data = deflateRawSync(Buffer.alloc(1024 * 1024, 7))
  assert.equal((await inflateRaw(data, 1024 * 1024)).length, 1024 * 1024)
  await assert.rejects(inflateRaw(data, 2), /exceeds declared/)
  await assert.rejects(inflateRaw(data, 1024 * 1024 + 1), /size mismatch/)
  await assert.rejects(inflateRaw(data.subarray(0, data.length - 1), 1024 * 1024))
  await assert.rejects(
    inflateRaw(data, 1024 * 1024, async () => {
      throw new Error('Cancelled')
    }),
    /Cancelled/,
  )
  let stop = false,
    checks = 0
  const files = await openZip(zipFixture('0-stream0-local640-zip640.zip'), {
    ...zipCodecs,
    checkpoint: async () => {
      if (stop && ++checks > 10) throw new Error('Cancelled')
    },
  })
  stop = true
  await assert.rejects(files.find((f) => f.name === 'repeated.bin')!.read(), /Cancelled/)
})

test('Unicode path extras use name CRC/version, strict UTF-8 and duplicate-field validation', async () => {
  function withExtra(
    version: number,
    validCRC = true,
    duplicate = false,
    utf8 = Buffer.from('絵/背景.txt'),
  ) {
    const bytes = zipFixture(),
      { end, records } = centralRecords(bytes),
      record = records.find((r) => r.name === 'empty.bin')!,
      nameLength = bytes.readUInt16LE(record.at + 28),
      extraLength = bytes.readUInt16LE(record.at + 30)
    const field = Buffer.alloc(9 + utf8.length)
    field.writeUInt16LE(0x7075)
    field.writeUInt16LE(5 + utf8.length, 2)
    field[4] = version
    field.writeUInt32LE((crc32(Buffer.from('empty.bin')) + (validCRC ? 0 : 1)) >>> 0, 5)
    utf8.copy(field, 9)
    const extra = duplicate ? Buffer.concat([field, field]) : field,
      at = record.at + 46 + nameLength,
      result = Buffer.concat([bytes.subarray(0, at), extra, bytes.subarray(at)])
    result.writeUInt16LE(extraLength + extra.length, record.at + 30)
    result.writeUInt32LE(bytes.readUInt32LE(end + 12) + extra.length, end + extra.length + 12)
    return result
  }
  const good = await openZip(withExtra(1))
  assert.equal((await good.find((f) => f.name === '絵/背景.txt')!.read()).length, 0)
  for (const bytes of [withExtra(0), withExtra(1, false)])
    assert.ok((await openZip(bytes)).some((f) => f.name === 'empty.bin'))
  await assert.rejects(openZip(withExtra(1, true, true)), /Duplicate ZIP extra/)
  await assert.rejects(openZip(withExtra(1, true, false, Buffer.from([0xc0]))), /encoded data|UTF/)
})

test('unsigned data descriptors work with classic and local-ZIP64 streaming members', async () => {
  for (const name of ['8-stream1-local640-zip640.zip', '8-stream1-local641-zip640.zip']) {
    const bytes = zipFixture(name),
      { end, central, records } = centralRecords(bytes),
      removed = records.map((r) => r.data + bytes.readUInt32LE(r.at + 20)).sort((a, b) => a - b)
    const parts: Buffer[] = []
    let cursor = 0
    for (const at of removed) {
      assert.equal(bytes.readUInt32LE(at), 0x08074b50)
      parts.push(bytes.subarray(cursor, at))
      cursor = at + 4
    }
    parts.push(bytes.subarray(cursor))
    const result = Buffer.concat(parts),
      shift = (at: number) => at - 4 * removed.filter((n) => n < at).length
    for (const record of records) result.writeUInt32LE(shift(record.local), shift(record.at) + 42)
    result.writeUInt32LE(shift(central), shift(end) + 16)
    const files = await openZip(result),
      expected = zipReference.cases.find((c) => c.file === name)!
    for (let i = 0; i < files.length; i++)
      assert.equal(hash(await files[i]!.read()), expected.entries[i]!.sha256)
  }
})

test('a classic ZIP can contain exactly 65,535 entries without a ZIP64 locator', async () => {
  const local = Buffer.alloc(31)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(1, 26)
  local[30] = 120
  const record = Buffer.alloc(47)
  record.writeUInt32LE(0x02014b50)
  record.writeUInt16LE(20, 4)
  record.writeUInt16LE(20, 6)
  record.writeUInt16LE(1, 28)
  record[46] = 120
  const index = Buffer.alloc(record.length * 65535)
  for (let at = 0; at < index.length; at += record.length) record.copy(index, at)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(65535, 8)
  end.writeUInt16LE(65535, 10)
  end.writeUInt32LE(index.length, 12)
  end.writeUInt32LE(local.length, 16)
  const files = await openZip(Buffer.concat([local, index, end]))
  assert.equal(files.length, 65535)
  assert.equal((await files[65534]!.read()).length, 0)
})

test('ZIP64 offsets above 4 GiB use bounded reads from a sparse ByteSource', async () => {
  const bytes = zipFixture('8-stream0-local640-zip641.zip'),
    base = 2 ** 32 + 4096,
    end = bytes.length - 22,
    locator = end - 20,
    record = Number(bytes.readBigUInt64LE(locator + 8)),
    central = Number(bytes.readBigUInt64LE(record + 48)),
    count = Number(bytes.readBigUInt64LE(record + 32))
  let at = central
  for (let i = 0; i < count; i++) {
    const nameLength = bytes.readUInt16LE(at + 28),
      extraLength = bytes.readUInt16LE(at + 30),
      commentLength = bytes.readUInt16LE(at + 32)
    let extra = at + 46 + nameLength
    while (extra < at + 46 + nameLength + extraLength) {
      const id = bytes.readUInt16LE(extra),
        length = bytes.readUInt16LE(extra + 2)
      if (id === 1) {
        let field = extra + 4
        if (bytes.readUInt32LE(at + 24) === 0xffffffff) field += 8
        if (bytes.readUInt32LE(at + 20) === 0xffffffff) field += 8
        if (bytes.readUInt32LE(at + 42) === 0xffffffff)
          bytes.writeBigUInt64LE(bytes.readBigUInt64LE(field) + BigInt(base), field)
      }
      extra += 4 + length
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  bytes.writeBigUInt64LE(BigInt(base + central), record + 48)
  bytes.writeBigUInt64LE(BigInt(base + record), locator + 8)
  bytes.writeUInt32LE(0xffffffff, end + 16)
  const reads: [number, number][] = [],
    firstHeader = bytes.subarray(0, 37)
  const files = await readZip(
    {
      size: base + bytes.length,
      read: async (offset, length) => {
        reads.push([offset, length])
        assert.ok(length <= 65557)
        const out = new Uint8Array(length)
        // Directory record remains at offset zero; all file records live after the sparse gap.
        for (const [start, data] of [
          [0, firstHeader],
          [base, bytes],
        ] as const) {
          const from = Math.max(offset, start),
            to = Math.min(offset + length, start + data.length)
          if (to > from) out.set(data.subarray(from - start, to - start), from - offset)
        }
        return out
      },
    },
    zipCodecs,
  )
  const expected = zipReference.cases.find((c) => c.file === '8-stream0-local640-zip641.zip')!
  for (let i = 0; i < files.length; i++)
    assert.equal(hash(await files[i]!.read()), expected.entries[i]!.sha256)
  assert.ok(reads.some(([offset]) => offset > 2 ** 32))
  assert.ok(reads.reduce((sum, [, length]) => sum + length, 0) < 100000)
})

test('pausing during central-directory enumeration waits, and cancellation discards the unfinished index', async () => {
  const control = new ExecutionControl()
  let signal = () => {},
    checks = 0,
    settled = false
  const entered = new Promise<void>((resolve) => {
    signal = resolve
  })
  const indexing = openZip(zipFixture(), {
    ...zipCodecs,
    checkpoint: async () => {
      // The first six checkpoints bracket tail, locator and central-directory reads.
      // The tenth is reached while enumerating the fourth of seven central records.
      if (++checks === 10) {
        control.pause()
        signal()
      }
      await control.wait()
      control.check()
    },
  }).finally(() => {
    settled = true
  })
  await entered
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false)
  control.cancel()
  await assert.rejects(indexing, /Execution cancelled/)
  assert.equal(checks, 10)
})
