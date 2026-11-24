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
export const encoderRecipes = [
  { id: 'encoder-standard', width: 13, height: 11, degree: 3, speed: 0, independent: false },
  { id: 'encoder-independent', width: 19, height: 17, degree: 3, speed: 2, independent: true },
  { id: 'encoder-degree4', width: 21, height: 9, degree: 4, speed: 3, independent: false },
]
type Recipe = typeof encoderRecipes[number]

// Author the top-down image before choosing a file representation. Every pixel
// can be compared after encoding by ericvt and loading by two different engines.
export function encoderPixels({ width, height }: Recipe) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    rgba.set([(x * 17 + y * 13 + 7) & 255, (x * 3 + y * 29 + 40) & 255,
      ((x ^ y) * 19 + 23) & 255, 255], (y * width + x) * 4)
  }
  return rgba
}

function bitmap({ width, height }: Recipe, rgba: Uint8Array) {
  const stride = (width * 3 + 3) & ~3
  const bmp = Buffer.alloc(54 + stride * height)
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22)
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(stride * height, 34)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const src = (y * width + x) * 4, dest = 54 + (height - y - 1) * stride + x * 3
    bmp[dest] = rgba[src + 2]!; bmp[dest + 1] = rgba[src + 1]!; bmp[dest + 2] = rgba[src]!
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
  assert(info.next - info.data >= 68 && frame.next - frame.data > 4)
  const fields = [0, 4, 8, 12, 16, 20, 24, 52].map((offset) => bytes.readUInt32LE(info.data + offset))
  assert.deepEqual(fields, [0x20100, 0x03020000, 0xffffffff, 1, recipe.width, -recipe.height >>> 0, 24, recipe.degree])
  const frameHeader = [...bytes.subarray(frame.data, frame.data + 4)]
  assert.deepEqual(frameHeader, [1, 0, recipe.independent ? 0 : 1, 0])
  return { imageInfo: fields, frameHeader }
}

export async function prepareEncodedImages(output: string): Promise<Record<string, Uint8Array>> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, 'Windows')
  const artifacts = resolve(output, 'encoder'), temp = mkdtempSync(resolve(process.env.RUNNER_TEMP!, 'ericvt-'))
  const files: Record<string, Uint8Array> = {}, snapshots: unknown[] = []
  mkdirSync(artifacts, { recursive: true })
  try {
    const response = await fetch(encoder.url, { signal: AbortSignal.timeout(30000) })
    assert(response.ok, 'ERINA encoder download returned HTTP ' + response.status)
    const binary = new Uint8Array(await response.arrayBuffer())
    assert.equal(binary.length, encoder.bytes); assert.equal(digest(binary), encoder.sha256)
    const exe = resolve(temp, 'ericvt.exe')
    writeFileSync(exe, binary)
    for (const recipe of encoderRecipes) {
      const dir = resolve(artifacts, recipe.id), rgba = encoderPixels(recipe), bmp = bitmap(recipe, rgba)
      mkdirSync(dir)
      writeFileSync(resolve(dir, 'input.bmp'), bmp)
      const args = ['-s', '-b' + recipe.degree, '-p' + recipe.speed,
        ...(recipe.independent ? ['-i'] : []), 'input.bmp', 'output.eri']
      const run = spawnSync(exe, args, { cwd: dir, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true })
      writeFileSync(resolve(dir, 'stdout.log'), run.stdout ?? '')
      writeFileSync(resolve(dir, 'stderr.log'), run.stderr ?? '')
      const processResult = { recipe, args, status: run.status, signal: run.signal, error: run.error?.message,
        bitmapSha256: digest(bmp), rgbaSha256: digest(rgba) }
      snapshots.push(processResult)
      if (run.error) throw run.error
      assert.equal(run.status, 0)
      const bytes = readFileSync(resolve(dir, 'output.eri'))
      Object.assign(processResult, { outputBytes: bytes.length, outputSha256: digest(bytes) })
      Object.assign(processResult, checkOutput(bytes, recipe))
      files[recipe.id + '.eri'] = bytes
    }
    return files
  } finally {
    writeFileSync(resolve(artifacts, 'provenance.json'), JSON.stringify({ encoder, snapshots }, null, 2) + '\n')
    rmSync(temp, { recursive: true, force: true })
  }
}
