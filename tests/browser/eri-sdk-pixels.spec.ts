import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { eriTruecolorSource } from '../helpers/eri-truecolor-fixtures.ts'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const pictures = ['encoder-dct-444', 'encoder-dct-422', 'encoder-dct-411'] as const
if (process.env.KRKR_DCT_SDK_IMPORT === '1') for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: original DCT pixels from author-encoded pictures reach the game canvas`, async ({ page }, info) => {
    test.setTimeout(120000)
    const root = resolve('out/verification/sdk-dct'), read = (name: string) => readFileSync(resolve(root, name))
    const manifest = JSON.parse(read('inputs.json').toString('utf8')) as { commit: string; corpus: string;
      inputs: { name: string; bytes: number; sha256: string }[]; unavailable: Record<string, string> }
    const processState = JSON.parse(read('sdk-process.json').toString('utf8').replace(/^\ufeff/, ''))
    const comparison = JSON.parse(read('comparison.json').toString('utf8')), raw = read('game/native-events.txt')
    assert.equal(manifest.commit, process.env.GITHUB_SHA); assert.equal(manifest.corpus, 'dct')
    assert.equal(processState.commit, manifest.commit); assert.equal(processState.state, 'observed')
    assert.equal(processState.exitCode, 0); assert.equal(processState.timedOut, false)
    assert.equal(comparison.commit, manifest.commit); assert.equal(comparison.nativeObservationSha256, sha(raw))
    const lines = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
    assert.equal(lines[0], 'start'); assert.equal(lines.at(-1), 'done')
    const provenance = JSON.parse(read('encoder/provenance.json').toString('utf8')) as {
      snapshots: { recipe: { id: string }; status: number; outputSha256?: string; failure?: string }[]
    }
    const inputs = manifest.inputs.filter((input) => pictures.some((id) => id + '.eri' === input.name)).map((input) => {
      const buffer = read('game/' + input.name)
      assert.equal(buffer.length, input.bytes); assert.equal(sha(buffer), input.sha256)
      const encoded = provenance.snapshots.filter((r) => r.recipe.id + '.eri' === input.name)
      assert.equal(encoded.length, 1); assert.equal(encoded[0]!.status, 0); assert.equal(encoded[0]!.failure, undefined)
      assert.equal(encoded[0]!.outputSha256, input.sha256)
      return { name: input.name, mimeType: 'application/octet-stream', buffer }
    })
    const source = eriTruecolorSource + `
    tcMask.visible=false;
    function sdkPicture(name){
      tcImage.loadImages(name);
      var w=tcImage.imageWidth,h=tcImage.imageHeight;
      tcWindow.setInnerSize(w,h);tcRoot.setSize(w,h);tcImage.setSize(w,h);return w+","+h;
    }`
    const game = await launchWindowAttention(page, backend, binary, source, inputs)
    const failures: unknown[] = [], results: unknown[] = []
    try {
      const canvas = game.surface('ERI truecolor').locator('canvas[data-window-id]')
      for (const id of pictures) {
        try {
          assert(!Object.hasOwn(manifest.unavailable, id), manifest.unavailable[id])
          const rows = lines.filter((line) => line.startsWith('case|' + id + '|'))
          assert.equal(rows.length, 1, id)
          const fields = rows[0]!.split('|'); assert.equal(fields[2], 'ok'); assert.equal(fields.length, 6)
          const width = Number(fields[3]), height = Number(fields[4]), rgba = fields[5]!.split(',').map((v) => {
            assert(/^\d+$/.test(v) && Number(v) <= 255); return Number(v)
          })
          assert(width > 0 && height > 0 && width * height * 4 === rgba.length)
          await evaluate(page, `sdkPicture("${id}.eri")`, width + ',' + height)
          await expect.poll(() => canvas.evaluate((node) => {
            const screen = node as HTMLCanvasElement, out = new OffscreenCanvas(screen.width, screen.height)
            const ctx = out.getContext('2d')!
            ctx.drawImage(screen, 0, 0)
            return [screen.width, screen.height, ...ctx.getImageData(0, 0, screen.width, screen.height).data]
          })).toEqual([width, height, ...rgba])
          results.push({ id, matched: true, width, height, rgbaSha256: sha(Uint8Array.from(rgba)) })
        } catch (error) { failures.push(error); results.push({ id, matched: false, error: String(error) }) }
      }
    } finally {
      try { await info.attach('sdk-dct-result', { contentType: 'application/json', body: JSON.stringify({ commit: manifest.commit, results }) }) }
      catch (error) { failures.push(error) }
      try { await game.stop() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Original and displayed DCT observations incomplete or different', { cause: failures[0] })
  })
