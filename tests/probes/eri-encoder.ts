import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const encoder = {
  url: 'https://raw.githubusercontent.com/uyjulian/erinalib/829244b10337bf70cd91c19174becce4e7dfd690/samples/bin/ericvt.exe',
  bytes: 176128, sha256: 'a24baae35e560e0cb781130a2e8c8ebf77dbaa5e4d98b067e078b17c838882ec',
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface Recipe {
  id: string; width: number; height: number; degree: number; speed: number; independent: boolean
  huffman?: 'default' | 'enhanced'; rebuildPattern?: boolean; indexed?: boolean; sampling?: '4:4:4' | '4:2:2' | '4:1:1'
}
export const indexedEncoderRecipe: Recipe = { id: 'encoder-huffman-indexed', width: 27, height: 12, degree: 0,
  speed: 1, independent: false, huffman: 'default', indexed: true }
export const encoderRecipes: Recipe[] = [
  { id: 'encoder-standard', width: 13, height: 11, degree: 3, speed: 0, independent: false },
  { id: 'encoder-independent', width: 19, height: 17, degree: 3, speed: 2, independent: true },
  { id: 'encoder-degree4', width: 21, height: 9, degree: 4, speed: 3, independent: false },
  { id: 'encoder-huffman-default', width: 13, height: 11, degree: 4, speed: 1, independent: false, huffman: 'default' },
  { id: 'encoder-huffman-table', width: 29, height: 17, degree: 3, speed: 0, independent: false, huffman: 'enhanced' },
  { id: 'encoder-huffman-inline', width: 19, height: 17, degree: 3, speed: 2, independent: true, huffman: 'enhanced' },
  { id: 'encoder-huffman-rebuild', width: 96, height: 96, degree: 3, speed: 3, independent: false,
    huffman: 'enhanced', rebuildPattern: true },
  indexedEncoderRecipe,
]

export const dctEncoderRecipes: Recipe[] = [
  { id: 'encoder-dct-444', width: 19, height: 18, degree: 3, speed: 1, independent: false, sampling: '4:4:4' },
  { id: 'encoder-dct-422', width: 33, height: 23, degree: 4, speed: 1, independent: false, sampling: '4:2:2' },
  { id: 'encoder-dct-411', width: 39, height: 35, degree: 5, speed: 1, independent: false, sampling: '4:1:1' },
]

function paletteIndex(x: number, y: number, width: number) {
  if (x < 5 || x >= width - 4) return y % 3 === 0 ? 173 : 23
  return (x * 11 + y * 41) & 255
}
const paletteColor = (index: number) => [index, (index * 37 + 5) & 255, (255 - index) & 255, 255]

// Author the top-down image before choosing a file representation. Every pixel
// can be compared after encoding by ericvt and loading by two different engines.
export function encoderPixels({ width, height, rebuildPattern, indexed }: Recipe) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4
    if (indexed) {
      rgba.set(paletteColor(paletteIndex(x, y, width)), at)
    } else if (rebuildPattern && y < 88) {
      // -p3 emits horizontal and vertical differences without a color or order
      // transform. Each of these 88 rows contains 96 differences per channel,
      // mainly +1 with +2/+3/+4 interspersed. Context 1 exceeds weight 0x4000.
      const ramp = x + 1 + Math.floor((x + 1) / 8) + 2 * Math.floor((x + 1) / 11)
      const sample = (ramp * (y + 1)) & 255
      rgba.set([sample, sample, sample, 255], at)
    } else {
      rgba.set([(x * 17 + y * 13 + 7) & 255, (x * 3 + y * 29 + 40) & 255,
        ((x ^ y) * 19 + 23) & 255, 255], at)
    }
  }
  return rgba
}

function bitmap({ width, height, indexed }: Recipe, rgba: Uint8Array) {
  const components = indexed ? 1 : 3, stride = (width * components + 3) & ~3, pixels = 54 + (indexed ? 1024 : 0)
  const bmp = Buffer.alloc(pixels + stride * height)
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(pixels, 10)
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22)
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(components * 8, 28); bmp.writeUInt32LE(stride * height, 34)
  if (indexed) for (let i = 0; i < 256; i++) {
    const [r, g, b] = paletteColor(i)
    bmp.set([b!, g!, r!, 0], 54 + i * 4)
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const src = (y * width + x) * 4, dest = pixels + (height - y - 1) * stride + x * components
    if (indexed) bmp[dest] = paletteIndex(x, y, width)
    else { bmp[dest] = rgba[src + 2]!; bmp[dest + 1] = rgba[src + 1]!; bmp[dest + 2] = rgba[src]! }
  }
  return bmp
}

// Only inspect the records in these known authoring-tool outputs. A zero exit
// status is also returned for usage errors by the 1.02 command-line sample.
function checkOutput(bytes: Buffer, recipe: Recipe) {
  assert(bytes.length >= 64 && bytes.length <= 65536)
  assert.equal(bytes.subarray(0, 8).toString('hex'), '456e7469731a0000')
  function member(name: string, start: number, end: number) {
    for (let at = start; at + 16 <= end;) {
      const size = bytes.readBigUInt64LE(at + 8), data = at + 16
      const next = size === 0xffffffffffffffffn ? end : data + Number(size)
      assert(next <= end)
      if (bytes.toString('ascii', at, at + 8) === name) return { data, next }
      at = next
    }
    throw new Error('Missing encoder record ' + name)
  }
  const header = member('Header  ', 64, bytes.length), info = member('ImageInf', header.data, header.next)
  const stream = member('Stream  ', header.next, bytes.length), frame = member('ImageFrm', stream.data, stream.next)
  assert(info.next - info.data >= 68)
  assert(frame.next - frame.data > 4, recipe.id + ' ImageFrm contains only ' + (frame.next - frame.data) + ' bytes')
  // The lossy parameter file selects the author's enhanced DCT mode.
  const huffman = !!(recipe.sampling || recipe.huffman)
  const fields = [0, 4, 8, 12, 16, 20, 24, 52].map((offset) => bytes.readUInt32LE(info.data + offset))
  assert.deepEqual(fields, [huffman ? 0x20200 : 0x20100, recipe.sampling ? 1 : 0x03020000,
    huffman ? 0xfffffffc : 0xffffffff, recipe.indexed ? 0x01000001 : 1,
    recipe.width, -recipe.height >>> 0, recipe.indexed ? 8 : 24, recipe.degree])
  const frameHeader = [...bytes.subarray(frame.data, frame.data + 4)]
  if (recipe.sampling) {
    const samplingCode = { '4:4:4': 0x40404, '4:2:2': 0x40202, '4:1:1': 0x40101 }[recipe.sampling]
    assert.equal(bytes.readUInt32LE(info.data + 32), samplingCode)
    assert.deepEqual(frameHeader, [9, 0, 1, 8])
    return { imageInfo: fields, samplingCode, frameHeader }
  }
  assert.deepEqual(frameHeader, recipe.indexed ? [2, 0, 0, 0] : [recipe.huffman ? 8 : 1, 0, recipe.independent ? 0 : 1, recipe.huffman ? 8 : 0])
  return { imageInfo: fields, frameHeader }
}

export async function prepareEncodedImages(output: string, recipes: readonly Recipe[]) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, 'Windows')
  const artifacts = resolve(output, 'encoder'), temp = mkdtempSync(resolve(process.env.RUNNER_TEMP!, 'ericvt-'))
  const files: Record<string, Uint8Array> = {}, failures: Record<string, string> = {}, snapshots: Record<string, unknown>[] = []
  mkdirSync(artifacts, { recursive: true })
  try {
    const response = await fetch(encoder.url, { signal: AbortSignal.timeout(30000) })
    assert(response.ok, 'ERINA encoder download returned HTTP ' + response.status)
    const binary = new Uint8Array(await response.arrayBuffer())
    assert.equal(binary.length, encoder.bytes); assert.equal(digest(binary), encoder.sha256)
    const exe = resolve(temp, 'ericvt.exe')
    writeFileSync(exe, binary)
    for (const recipe of recipes) {
      const processResult: Record<string, unknown> = { recipe }
      snapshots.push(processResult)
      try {
        const dir = resolve(artifacts, recipe.id), rgba = encoderPixels(recipe), bmp = bitmap(recipe, rgba)
        mkdirSync(dir)
        writeFileSync(resolve(dir, 'input.bmp'), bmp)
        if (recipe.sampling) {
          const parameters = ['[parameter]', 'sampling_flag=' + recipe.sampling, 'blocking_degree=' + recipe.degree,
            'y_dc_scale=1.0', 'c_dc_scale=0.75', 'y_low_scale=0.75', 'c_low_scale=0.5',
            'y_high_scale=0.5', 'c_high_scale=0.25', ''].join('\r\n')
          writeFileSync(resolve(dir, 'dct.ini'), parameters, 'ascii')
        }
        const options = recipe.sampling ? ['-l=dct.ini']
          : recipe.huffman === 'default' ? ['-e'] : [recipe.huffman ? '-x' : '-s',
          '-b' + recipe.degree, '-p' + recipe.speed, ...(recipe.independent ? ['-i'] : [])]
        const args = [...options, 'input.bmp', 'output.eri']
        const run = spawnSync(exe, args, { cwd: dir, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true })
        writeFileSync(resolve(dir, 'stdout.log'), run.stdout ?? '')
        writeFileSync(resolve(dir, 'stderr.log'), run.stderr ?? '')
        Object.assign(processResult, { args, status: run.status, signal: run.signal, error: run.error?.message,
          bitmapSha256: digest(bmp), rgbaSha256: digest(rgba) })
        if (run.error) throw run.error
        assert.equal(run.status, 0)
        const bytes = readFileSync(resolve(dir, 'output.eri'))
        Object.assign(processResult, { outputBytes: bytes.length, outputSha256: digest(bytes) })
        Object.assign(processResult, checkOutput(bytes, recipe))
        files[recipe.id + '.eri'] = bytes
      } catch (error) {
        failures[recipe.id + '.eri'] = String(error)
        processResult.failure = String(error)
      }
    }
    return { files, failures }
  } finally {
    writeFileSync(resolve(artifacts, 'provenance.json'), JSON.stringify({ encoder, snapshots }, null, 2) + '\n')
    rmSync(temp, { recursive: true, force: true })
  }
}
