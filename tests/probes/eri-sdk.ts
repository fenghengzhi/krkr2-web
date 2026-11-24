import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eriContractFiles } from '../helpers/eri-fixtures.ts'
import { noColorKey } from '../../src/engine/graphics/loading.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'

assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const output = resolve('out/verification/native-eri'), game = resolve(output, 'game')
const save = (name: string, data: unknown) => writeFileSync(resolve(output, name), JSON.stringify(data, null, 2) + '\n')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface Case { id: string; source: string; mask?: string; index?: number; province?: boolean }
const cases: Case[] = [
  { id: 'indexed-top-down', source: 'rgb-negative.eri' },
  { id: 'indexed-bottom-up', source: 'rgb-positive.eri' },
  { id: 'gray-top-down', source: 'gray-negative.eri' },
  { id: 'gray-bottom-up', source: 'gray-positive.eri' },
  { id: 'key-first', source: 'rgb-negative.eri', index: 0 },
  { id: 'key-second', source: 'rgb-positive.eri', index: 1 },
  { id: 'key-absent', source: 'rgb-positive.eri', index: 255 },
  { id: 'gray-key', source: 'gray-negative.eri', index: 1 },
  { id: 'gray-mask', source: 'rgb-negative.eri', mask: 'gray-positive.eri' },
  { id: 'palette-mask', source: 'rgb-negative.eri', mask: 'rgb-positive.eri' },
  { id: 'province', source: 'rgb-negative.eri', province: true },
]
const provinceError = 'currently Kirikiri does not support loading palettized ERI image.'

function prepare() {
  mkdirSync(game, { recursive: true })
  const files = eriContractFiles(), inputs: { name: string; bytes: number; sha256: string }[] = []
  function copy(from: string, name: string) {
    const bytes = files[from]
    assert(bytes && bytes.length >= 64 && bytes.length <= 4096)
    writeFileSync(resolve(game, name), bytes)
    inputs.push({ name, bytes: bytes.length, sha256: sha(bytes) })
  }
  const calls: string[] = []
  for (const item of cases) {
    copy(item.source, item.id + '.eri')
    if (item.mask) copy(item.mask, item.id + '_m.eri')
    const key = item.index === undefined ? 'clNone' : 'clPalIdx+' + item.index
    calls.push(`observe("${item.id}",${key},${item.province ? 'true' : 'false'});`)
  }
  const script = readFileSync('tests/fixtures/native-reference/eri-loader.tjs', 'utf8')
  assert.equal(script.split('/* CASES */').length, 2)
  const startup = Buffer.from('\ufeff' + script.replace('/* CASES */', calls.join('\n')), 'utf16le')
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, sdk: JSON.parse(readFileSync('tests/fixtures/native-reference/sdk.json', 'utf8')),
    cases, inputs, startupSha256: sha(startup) })
}

async function compare() {
  const { ImageLoader } = await import('../../src/engine/storage/images.ts')
  const { decodeSelectedImage } = await import('../../src/engine/graphics/image-decoder.ts')
  const { TvpError } = await import('../../src/engine/system/tvp-error.ts')
  const raw = readFileSync(resolve(game, 'native-events.txt'))
  const lines = raw.toString(raw[0] === 0xff && raw[1] === 0xfe ? 'utf16le' : 'utf8')
    .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const rows = lines.filter((line) => line.startsWith('case|'))
  const manifest = JSON.parse(readFileSync(resolve(output, 'inputs.json'), 'utf8')) as {
    commit: string; inputs: { name: string; bytes: number; sha256: string }[] }
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  const resources = new Map<string, Resource>()
  for (const input of manifest.inputs) {
    const bytes = readFileSync(resolve(game, input.name))
    assert.equal(bytes.length, input.bytes); assert.equal(sha(bytes), input.sha256)
    resources.set(input.name, { name: input.name, size: bytes.length, async read() { return bytes } })
  }
  async function finish<T>(work: Generator<void, T>) {
    try {
      for (;;) { const step = work.next(); if (step.done) return step.value }
    } finally { work.return(undefined as T) }
  }
  const loader = new ImageLoader((name) => resources.get(name),
    (bytes, selection, progress) => decodeSelectedImage(bytes, selection, {
      finish, async inflate() { throw new Error('Unexpected inflate') }, async host() { throw new Error('Unexpected host decoder') },
    }, progress), finish, { now: () => 0, check() {}, async yield() {} })
  const results: { id: string; status: 'matched' | 'failed'; error?: string }[] = []
  try {
    for (const item of cases) {
      try {
        const found = rows.filter((line) => line.split('|')[1] === item.id)
        assert.equal(found.length, 1)
        const name = item.id + '.eri'
        if (item.province) {
          assert.equal(found[0], 'case|province|error|eri:' + provinceError)
          await assert.rejects(loader.province(name, 3, 2), (err: unknown) =>
            err instanceof TvpError && err.tvpMessage.id === 'TVPERILoadError' &&
            err.tvpMessage.args.length === 1 && err.tvpMessage.args[0] === provinceError)
        } else {
          const fields = found[0]!.split('|')
          assert.equal(fields.length, 6); assert.deepEqual(fields.slice(2, 5), ['ok', '3', '2'])
          const actual = (await loader.load(name, item.index === undefined ? noColorKey : 0x03000000 + item.index)).image
          assert.deepEqual([actual.width, actual.height], [3, 2])
          assert.equal(actual.data.length, 24)
          assert.equal([...actual.data].join(','), fields[5])
        }
        results.push({ id: item.id, status: 'matched' })
      } catch (err) { results.push({ id: item.id, status: 'failed', error: String(err) }) }
    }
  } finally { loader.dispose() }
  const complete = lines[0] === 'start' && lines.at(-1) === 'done' && rows.length === cases.length &&
    lines.length === cases.length + 2 && results.every((entry) => entry.status === 'matched')
  save('comparison.json', { commit: process.env.GITHUB_SHA, complete, planned: cases.length, results,
    nativeObservationSha256: sha(raw) })
  assert(complete, 'Incomplete SDK observations or differences from the selected Web image loader')
}
if (process.argv[2] === 'prepare') prepare()
else if (process.argv[2] === 'compare') await compare()
else throw new Error('Expected prepare or compare')
