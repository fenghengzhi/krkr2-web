import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { BlobSource, inflate, decodeScript } from '../../src/backends/files/blob-source.ts'
import { readXp3, adler32 } from '../../src/formats/xp3/archive.ts'
import { StorageResolver, normalizePath } from '../../src/engine/storage/resolver.ts'

function u64(value: number) {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(BigInt(value))
  return bytes
}
function u32(value: number) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}
function chunk(tag: string, bytes: Buffer) {
  return Buffer.concat([Buffer.from(tag), u64(bytes.length), bytes])
}
function archive(compressed: boolean, encrypted = false) {
  const content = Buffer.from('var answer = 42;')
  const stored = compressed ? deflateSync(content) : content
  const name = Buffer.from('startup.tjs', 'utf16le'),
    length = Buffer.alloc(2)
  length.writeUInt16LE(name.length / 2)
  const file = chunk(
    'File',
    Buffer.concat([
      chunk(
        'info',
        Buffer.concat([
          u32(encrypted ? 0x80000000 : 0),
          u64(content.length),
          u64(stored.length),
          length,
          name,
        ]),
      ),
      chunk(
        'segm',
        Buffer.concat([u32(Number(compressed)), u64(19), u64(content.length), u64(stored.length)]),
      ),
      chunk('adlr', u32(adler32(content))),
    ]),
  )
  const index = compressed ? deflateSync(file) : file
  const bytes = Buffer.concat([
    Buffer.from([88, 80, 51, 13, 10, 32, 10, 26, 139, 103, 1]),
    u64(19 + stored.length),
    stored,
    Buffer.from([Number(compressed)]),
    u64(index.length),
    ...(compressed ? [u64(file.length)] : []),
    index,
  ])
  return { bytes, content }
}

for (const compressed of [false, true])
  test(`XP3 ${compressed ? 'zlib' : 'raw'} index and segments read lazily`, async () => {
    const { bytes, content } = archive(compressed)
    const source = new BlobSource(new Blob([bytes]))
    const reads: [number, number][] = []
    const files = await readXp3(
      {
        size: source.size,
        read: async (offset, length) => {
          reads.push([offset, length])
          return source.read(offset, length)
        },
      },
      inflate,
    )
    assert.equal(files[0]?.name, 'startup.tjs')
    assert.equal(
      reads.some(([offset]) => offset === 19),
      false,
    )
    assert.deepEqual(Buffer.from(await files[0]!.read()), content)
    assert.ok(reads.some(([offset]) => offset === 19))
  })

test('XP3 protection is metadata; truncation and optional integrity checks are enforced', async () => {
  const protectedFile = archive(false, true)
  const protectedResources = await readXp3(new BlobSource(new Blob([protectedFile.bytes])), inflate)
  assert.equal(protectedResources[0]!.xp3.protected, true)
  assert.deepEqual(Buffer.from(await protectedResources[0]!.read()), protectedFile.content)
  await assert.rejects(
    readXp3(new BlobSource(new Blob([protectedFile.bytes.subarray(0, 15)])), inflate),
    /outside valid range/,
  )
  const corrupt = archive(false)
  corrupt.bytes[19] ^= 1
  const files = await readXp3(new BlobSource(new Blob([corrupt.bytes])), inflate, {
    verifyAdler32: true,
  })
  await assert.rejects(files[0]!.read(), /checksum mismatch/)
})

test('decompression enforces both declared output size and limits', async () => {
  const compressed = deflateSync(Buffer.alloc(1000))
  await assert.rejects(inflate(compressed, 10), /exceeds declared/)
  await assert.rejects(inflate(compressed, 1001), /size mismatch/)
})

test('mount order, case collisions and game-root boundaries are explicit', async () => {
  const storage = new StorageResolver()
  const resource = (name: string, value: number) => ({
    name,
    size: 1,
    read: async () => new Uint8Array([value]),
  })
  storage.mount([resource('data/scene.tjs', 1)])
  storage.mount([resource('data/scene.tjs', 2)])
  storage.addAutoPath('data/')
  assert.deepEqual(await storage.resolve('SCENE.TJS').read(), new Uint8Array([2]))
  storage.mount([resource('data/Scene.tjs', 3)])
  assert.throws(() => storage.resolve('SCENE.TJS'), /Ambiguous/)
  assert.equal(storage.exists('missing.tjs'), false)
  for (const path of ['../game.tjs', '/root.tjs', 'file:///secret', 'a/../../escape'])
    assert.throws(() => normalizePath(path))
  assert.equal(normalizePath('data\\folder/../scene.tjs'), 'data/scene.tjs')
})

test('script input detects UTF-8, UTF-16 and bytecode without mojibake', () => {
  assert.equal(decodeScript(new TextEncoder().encode('"你好😀"')), '"你好😀"')
  assert.equal(
    decodeScript(Buffer.concat([Buffer.from([255, 254]), Buffer.from('"日文"', 'utf16le')])),
    '"日文"',
  )
  const bytecode = new Uint8Array([84, 74, 83, 50, 0])
  assert.equal(decodeScript(bytecode), bytecode)
  assert.throws(() => decodeScript(new Uint8Array([254, 254, 0])), /not yet supported/)
})

test('archive-qualified auto paths use the last registered directory and preserve explicit placement', async () => {
  const storage = new StorageResolver()
  const resource = (name: string, value: number) => ({
    name,
    size: 1,
    read: async () => new Uint8Array([value]),
  })
  storage.mount([resource('base.xp3>scenario/first.ks', 1), resource('patch.xp3>first.ks', 2)])
  storage.addAutoPath('base.xp3>scenario/')
  storage.addAutoPath('patch.xp3>')
  assert.deepEqual(await storage.resolve('first.ks').read(), new Uint8Array([2]))
  assert.deepEqual(await storage.resolve('base.xp3>scenario/first.ks').read(), new Uint8Array([1]))
  storage.removeAutoPath('patch.xp3>')
  assert.deepEqual(await storage.resolve('somewhere/first.ks').read(), new Uint8Array([1]))
  assert.throws(() => storage.resolve('base.xp3>../escape.tjs'), /escapes/)
})
