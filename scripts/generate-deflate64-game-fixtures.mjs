import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Deflate64 authoring and verification require GitHub-hosted Actions')

const { customEntryDistribution } = await import('../tests/helpers/custom-entry-distribution.ts')
const directory = resolve('out/verification/deflate64-games'), sha = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  manifest = { version: 1, status: 'generating', commit: process.env.GITHUB_SHA, tool: '', commands: [], games: [], dictionary: null }
mkdirSync(directory, { recursive: true })
const save = () => writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
function command(binary, args, name, cwd = directory, allowMissing = false) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(resolve(directory, name + '.stdout.log'), result.stdout ?? '')
  writeFileSync(resolve(directory, name + '.stderr.log'), result.stderr ?? '')
  manifest.commands.push({ binary, args, cwd, stdout: name + '.stdout.log', stderr: name + '.stderr.log',
    status: result.status, signal: result.signal, error: result.error?.message })
  save()
  if (allowMissing && result.error?.code === 'ENOENT') return false
  if (result.error || result.status !== 0) throw new Error('Hosted 7-Zip command failed: ' + name, { cause: result.error })
  return true
}
function entries(bytes) {
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--)
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
    throw new Error('Expected one independently authored classic ZIP disk')
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16), rows = []
  if (count === 0xffff || start + size !== end) throw new Error('Unexpected shared ZIP directory bounds')
  let at = start
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('Expected central header')
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), nameSize = bytes.readUInt16LE(at + 28),
      extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), next = at + 46 + nameSize + extra + comment,
      name = bytes.subarray(at + 46, at + 46 + nameSize).toString('utf8'), local = bytes.readUInt32LE(at + 42)
    if (next > end || flags & 1 || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 ||
        bytes.readUInt16LE(local + 8) !== method || ![0, 9].includes(method)) throw new Error('Unexpected shared ZIP method/header')
    rows.push({ name, method, crc32: bytes.readUInt32LE(at + 16), packed: bytes.readUInt32LE(at + 20), bytes: bytes.readUInt32LE(at + 24) })
    at = next
  }
  if (at !== end || !rows.some((row) => row.method === 9)) throw new Error('Actual Deflate64 member is absent')
  return rows.filter((row) => !row.name.endsWith('/'))
}
function pack(id, work, files) {
  const archive = resolve(directory, id + '.zip'), list = resolve(directory, id + '-files.txt')
  writeFileSync(list, files.map((file) => file.name).join('\n') + '\n')
  command(manifest.tool, ['a', '-bd', '-y', '-tzip', '-mm=Deflate64', '-mx=9', '-scsUTF-8', archive, '@' + list], id + '-encode', work)
  command(manifest.tool, ['t', '-bd', '-y', archive], id + '-test')
  command(manifest.tool, ['l', '-slt', archive], id + '-inventory')
  const bytes = readFileSync(archive), rows = entries(bytes), decoded = resolve(directory, 'roundtrip', id)
  mkdirSync(decoded, { recursive: true })
  command(manifest.tool, ['x', '-bd', '-y', '-o' + decoded, archive], id + '-decode')
  if (rows.length !== files.length || rows.some((row) => !files.some((file) => file.name === row.name)))
    throw new Error('Shared archive file inventory changed')
  for (const file of files) {
    const actual = readFileSync(resolve(decoded, file.name)), row = rows.find((row) => row.name === file.name)
    if (actual.length !== file.bytes || sha(actual) !== file.sha256 || row.bytes !== file.bytes)
      throw new Error('Independent 7-Zip readback differs: ' + file.name)
  }
  return { id, file: id + '.zip', bytes: bytes.length, sha256: sha(bytes), methods: [...new Set(rows.map((row) => row.method))], entries: rows, inputs: files }
}
try {
  for (const tool of ['7zz', '7z']) if (command(tool, ['i'], 'version-' + tool, directory, true)) { manifest.tool = tool; break }
  if (!manifest.tool) throw new Error('The hosted build needs the distro 7zip package')
  for (const binary of [false, true]) {
    const id = binary ? 'bytecode' : 'source', fixture = await customEntryDistribution(binary), base = resolve(directory, id + '-method8.zip'),
      work = resolve(directory, 'authored', id)
    writeFileSync(base, fixture.bytes); mkdirSync(work, { recursive: true })
    command(manifest.tool, ['x', '-bd', '-y', '-o' + work, base], id + '-extract-author')
    for (const file of fixture.evidence.files) {
      const actual = readFileSync(resolve(work, file.name))
      if (actual.length !== file.bytes || sha(actual) !== file.sha256) throw new Error('Authored game differs after extraction: ' + file.name)
    }
    const encoded = pack(id, work, fixture.evidence.files),
      playedMethod9 = encoded.entries.filter((row) => row.method === 9 &&
        ['Release/data/engine.xp3', 'Release/data/first.ks', 'Release/observer.tjs'].includes(row.name)).map((row) => row.name)
    if (!playedMethod9.length) throw new Error('No actual KAG story/system/observer member uses Deflate64: ' + id)
    manifest.games.push({ ...encoded, playedMethod9, baseZipSha256: sha(fixture.bytes), originalSha256: fixture.evidence.originalSha256 })
    save()
  }
  // A repeated 48 KiB block exceeds Deflate's 32 KiB history while leaving
  // lookahead room in a 64 KiB encoder window. Keep the independent raw source.
  const block = Buffer.alloc(48 * 1024)
  for (let at = 0; at < block.length; at += 32) createHash('sha256').update('krkr-deflate64-window:' + at).digest().copy(block, at)
  const bytes = Buffer.concat([...Array.from({ length: 48 }, () => block), block.subarray(0, 257)]), name = 'multi-window.bin', work = resolve(directory, 'authored', 'multi-window')
  mkdirSync(work, { recursive: true }); writeFileSync(resolve(work, name), bytes); writeFileSync(resolve(directory, name), bytes)
  manifest.dictionary = { ...pack('multi-window', work, [{ name, bytes: bytes.length, sha256: sha(bytes) }]),
    raw: name, rawBytes: bytes.length, rawSha256: sha(bytes), blockBytes: block.length, repeatedBlocks: 48, suffixBytes: 257 }
  if (manifest.dictionary.entries[0].method !== 9 || manifest.dictionary.entries[0].packed >= bytes.length * 0.65)
    throw new Error('The independent long-distance repetition did not produce a compact Deflate64 stream')
  manifest.status = 'complete'
} catch (error) {
  manifest.status = 'failed'; manifest.error = String(error)
  throw error
} finally { save() }
