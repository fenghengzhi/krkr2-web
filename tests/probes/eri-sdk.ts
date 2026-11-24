import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  eriContractFiles, eriGrayNegative, eriGrayPositive, eriGrayRgba, eriKey1, eriMaskedRgba,
  eriPaletteGray, eriRgbNegative, eriRgbPositive,
} from '../helpers/eri-fixtures.ts'
import { eriTruecolorCases, eriTruecolorFiles, eriTrueGray, eriTrueRgb, eriTrueRgba } from '../helpers/eri-truecolor-fixtures.ts'
import { eriHuffmanCases, eriHuffmanFiles, eriHuffmanPaletteCases } from '../helpers/eri-huffman-fixtures.ts'
import { encoderPixels, encoderRecipes, indexedEncoderRecipe, prepareEncodedImages } from './eri-encoder.ts'
import { noColorKey } from '../../src/engine/graphics/loading.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'

assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const output = resolve('out/verification/native-eri'), game = resolve(output, 'game')
const save = (name: string, data: unknown) => writeFileSync(resolve(output, name), JSON.stringify(data, null, 2) + '\n')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface Case {
  id: string; source: string; mask?: string; index?: number; key?: number; province?: boolean
  width?: number; height?: number; expected?: readonly number[]
}
const reversed = (values: readonly number[], stride: number) => [...values.slice(stride), ...values.slice(0, stride)]
const cases119: Case[] = [
  { id: 'indexed-top-down', source: 'rgb-negative.eri', expected: eriRgbNegative },
  { id: 'indexed-bottom-up', source: 'rgb-positive.eri', expected: eriRgbPositive },
  { id: 'gray-top-down', source: 'gray-negative.eri', expected: eriGrayRgba(eriGrayNegative) },
  { id: 'gray-bottom-up', source: 'gray-positive.eri', expected: eriGrayRgba(eriGrayPositive) },
  { id: 'key-first', source: 'rgb-negative.eri', index: 0, expected: eriRgbNegative.map((v, i) => i === 3 ? 0 : v) },
  { id: 'key-second', source: 'rgb-positive.eri', index: 1, expected: reversed(eriKey1, 12) },
  { id: 'key-absent', source: 'rgb-positive.eri', index: 255, expected: eriRgbPositive },
  { id: 'gray-key', source: 'gray-negative.eri', index: 1, expected: eriGrayRgba(eriGrayNegative) },
  { id: 'gray-mask', source: 'rgb-negative.eri', mask: 'gray-positive.eri', expected: eriMaskedRgba(eriGrayPositive) },
  { id: 'palette-mask', source: 'rgb-negative.eri', mask: 'rgb-positive.eri', expected: eriMaskedRgba(reversed(eriPaletteGray, 3)) },
  { id: 'province', source: 'rgb-negative.eri', province: true },
]
const corpus = process.env.KRKR_ERI_CORPUS ?? 'authored'
assert(corpus === 'authored' || corpus === 'encoder')
const cases: Case[] = corpus === 'encoder' ? encoderRecipes.map((recipe) => ({
  id: recipe.id, source: recipe.id + '.eri', width: recipe.width, height: recipe.height, expected: [...encoderPixels(recipe)],
})) : [...cases119, ...[...eriTruecolorCases, ...eriHuffmanCases, ...eriHuffmanPaletteCases].map(({ name, width, height, rgba }) => ({
  id: name.slice(0, -4), source: name, width, height, expected: rgba,
})), {
  id: 'tc-mask', source: 'tc-rgb-v1-table.eri', mask: 'tc-rgba-v1-independent.eri', width: 3, height: 3,
  expected: eriTrueRgb.map((v, i) => i % 4 === 3 ? eriTrueGray[i >> 2]! : v),
}, {
  id: 'tc-rgb-key', source: 'tc-rgba-v1-independent.eri', width: 3, height: 3, key: 0x0a141e,
  expected: eriTrueRgba.map((v, i) => i % 4 === 3 ? (i === 3 ? 0 : 255) : v),
}, {
  id: 'hc-mask', source: 'hc-rgb-table.eri', mask: 'hc-rgba-inline.eri', width: 3, height: 3,
  expected: eriTrueRgb.map((v, i) => i % 4 === 3 ? eriTrueGray[i >> 2]! : v),
}, {
  id: 'hp-key', source: 'hp-indexed-negative.eri', width: 3, height: 2, index: 1, expected: eriKey1,
}, {
  id: 'hp-mask', source: 'rgb-negative.eri', mask: 'hp-indexed-positive.eri', width: 3, height: 2,
  expected: eriMaskedRgba(reversed(eriPaletteGray, 3)),
}]
const provinceError = 'currently Kirikiri does not support loading palettized ERI image.'
if (corpus === 'encoder') {
  const { id, width, height } = indexedEncoderRecipe, source = id + '.eri'
  const rgba = [...encoderPixels(indexedEncoderRecipe)]
  // This authored palette has red == index. The grayscale companion must
  // consume palette colors, including at indices in the repeated edge runs.
  cases.push({ id: 'encoder-palette-key', source, width, height, index: 23,
    expected: rgba.map((v, i) => i % 4 === 3 && rgba[i - 3] === 23 ? 0 : v) },
  { id: 'encoder-palette-mask', source, mask: source, width, height,
    expected: rgba.map((v, i) => i % 4 === 3 ? (54 * rgba[i - 3]! + 183 * rgba[i - 2]! + 19 * rgba[i - 1]!) >> 8 : v) })
}

async function prepare() {
  mkdirSync(game, { recursive: true })
  const files = corpus === 'encoder' ? await prepareEncodedImages(output)
    : { ...eriContractFiles(), ...eriTruecolorFiles(), ...eriHuffmanFiles() }
  const inputs: { name: string; bytes: number; sha256: string }[] = []
  function copy(from: string, name: string) {
    const bytes = files[from]
    assert(bytes && bytes.length >= 64 && bytes.length <= 65536)
    writeFileSync(resolve(game, name), bytes)
    inputs.push({ name, bytes: bytes.length, sha256: sha(bytes) })
  }
  const calls: string[] = []
  for (const item of cases) {
    copy(item.source, item.id + '.eri')
    if (item.mask) copy(item.mask, item.id + '_m.eri')
    const key = item.index === undefined ? String(item.key ?? 'clNone') : 'clPalIdx+' + item.index
    calls.push(`observe("${item.id}",${key},${!!item.province},${item.width ?? 3},${item.height ?? 2});`)
  }
  const script = readFileSync('tests/fixtures/native-reference/eri-loader.tjs', 'utf8')
  assert.equal(script.split('/* CASES */').length, 2)
  const startup = Buffer.from('\ufeff' + script.replace('/* CASES */', calls.join('\n')), 'utf16le')
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, corpus, sdk: JSON.parse(readFileSync('tests/fixtures/native-reference/sdk.json', 'utf8')),
    cases, inputs, startupSha256: sha(startup) })
}

async function compare() {
  const { ImageLoader } = await import('../../src/engine/storage/images.ts')
  const { decodeSelectedImage } = await import('../../src/engine/graphics/image-decoder.ts')
  const { TvpError } = await import('../../src/engine/system/tvp-error.ts')
  const sdkPath = resolve(output, 'sdk-process.json'), nativePath = resolve(game, 'native-events.txt')
  const sdk = existsSync(sdkPath) ? JSON.parse(readFileSync(sdkPath, 'utf8').replace(/^\ufeff/, '')) : null
  const raw = existsSync(nativePath) ? readFileSync(nativePath) : Buffer.alloc(0)
  const lines = raw.toString(raw[0] === 0xff && raw[1] === 0xfe ? 'utf16le' : 'utf8')
    .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const rows = lines.filter((line) => line.startsWith('case|'))
  const manifest = JSON.parse(readFileSync(resolve(output, 'inputs.json'), 'utf8')) as {
    commit: string; corpus: string; inputs: { name: string; bytes: number; sha256: string }[] }
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  assert.equal(manifest.corpus, corpus)
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
  const results: { id: string; status: 'matched' | 'failed' | 'unreported'; error?: string; sha256?: string }[] = []
  try {
    for (const item of cases) {
      try {
        const found = rows.filter((line) => line.split('|')[1] === item.id)
        if (!found.length) {
          results.push({ id: item.id, status: 'unreported' })
          continue
        }
        assert.equal(found.length, 1)
        const name = item.id + '.eri', width = item.width ?? 3, height = item.height ?? 2
        let rgbaHash: string | undefined
        if (item.province) {
          assert.equal(found[0], 'case|province|error|eri:' + provinceError)
          await assert.rejects(loader.province(name, width, height), (err: unknown) =>
            err instanceof TvpError && err.tvpMessage.id === 'TVPERILoadError' &&
            err.tvpMessage.args.length === 1 && err.tvpMessage.args[0] === provinceError)
        } else {
          const fields = found[0]!.split('|')
          assert.equal(fields[2], 'ok', found[0]); assert.equal(fields.length, 6)
          assert.deepEqual(fields.slice(3, 5), [String(width), String(height)])
          const native = fields[5]!.split(',').map(Number)
          const actual = (await loader.load(name, item.index === undefined ? item.key ?? noColorKey : 0x03000000 + item.index)).image
          save(item.id + '-web.json', { width: actual.width, height: actual.height, rgba: [...actual.data] })
          assert.deepEqual([actual.width, actual.height], [width, height])
          assert.equal(actual.data.length, width * height * 4)
          assert.equal(native.length, actual.data.length)
          assert.equal(item.expected?.length, native.length)
          for (let i = 0; i < native.length; ++i) {
            const label = item.id + ' (' + ((i >> 2) % width) + ',' + Math.floor((i >> 2) / width) + ') ' + 'RGBA'[i % 4]
            assert.equal(native[i], item.expected![i], 'SDK ' + label)
            assert.equal(actual.data[i], native[i], 'Web ' + label)
          }
          rgbaHash = sha(actual.data)
        }
        results.push({ id: item.id, status: 'matched', sha256: rgbaHash })
      } catch (err) { results.push({ id: item.id, status: 'failed', error: String(err) }) }
    }
  } finally { loader.dispose() }
  const complete = sdk?.state === 'observed' && sdk.exitCode === 0 &&
    lines[0] === 'start' && lines.at(-1) === 'done' && rows.length === cases.length &&
    lines.length === cases.length + 2 && results.every((entry) => entry.status === 'matched')
  save('comparison.json', { commit: process.env.GITHUB_SHA, corpus, complete, planned: cases.length, results,
    sdkState: sdk?.state ?? 'unreported', nativeObservationSha256: raw.length ? sha(raw) : null })
  assert(complete, 'Incomplete SDK observations or differences from the selected Web image loader')
}
if (process.argv[2] === 'prepare') await prepare()
else if (process.argv[2] === 'compare') await compare()
else throw new Error('Expected prepare or compare')
