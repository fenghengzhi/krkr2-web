import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EngineSession } from '../../src/engine/session.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { decodeScript, inflateImage, deflateImage } from '../../src/backends/files/blob-source.ts'
import { readText, writeText } from '../../src/backends/files/text-codecs.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

test('real TJS bootstrap drives layer pixels, callback coordinates and session lifecycle', async () => {
  const logs: string[] = []
  let firstPixel: number[] = []
  let rendererDisposed = false
  const session = new EngineSession({
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    inflateImage,
    deflateImage,
    createRuntime: (handler, control) =>
      TjsWasmRuntime.create(factory, handler, { control, wasmBinary }),
    graphics: {
      decode: async () => {
        throw new Error('No images in this case')
      },
      text: () => {
        throw new Error('No text in this case')
      },
    },
    renderer: {
      present: (layers) => {
        // Window visibility may present before its first Layer is created.
        firstPixel = layers[0] ? Array.from(layers[0].pixels.data.subarray(0, 4)) : []
      },
      dispose: () => {
        rendererDisposed = true
      },
    },
    decodeScript,
    readText,
    writeText,
    now: () => 123,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
    event: (event) => {
      if (event.type === 'log') logs.push(event.text)
    },
  })
  await session.initialize()
  const source =
    'var window = new Window(); window.setInnerSize(8, 8); window.visible=true; var layer = new Layer(window, null); layer.setSize(8, 8); layer.fillRect(0, 0, 8, 8, 0xffff0000); var clicks = 0; layer.onClick = function(x, y) { clicks++; layer.fillRect(0, 0, 8, 8, 0xff00ff00); Debug.message(x + "," + y); };'
  session.mount([
    {
      name: 'startup.tjs',
      size: source.length,
      read: async () => new TextEncoder().encode(source),
    },
  ])
  await session.start()
  assert.deepEqual(firstPixel, [255, 0, 0, 255])
  await session.click(2, 3)
  assert.deepEqual(firstPixel, [0, 255, 0, 255])
  assert.equal(logs.at(-1), '2,3')
  session.pause()
  await session.click(1, 1)
  session.resume()
  assert.equal(await session.evaluate('clicks'), '1')
  await session.stop()
  await session.stop()
  assert.equal(session.snapshot().state, 'stopped')
  assert.equal(session.snapshot().handles, 0)
  assert.equal(rendererDisposed, true)
})
