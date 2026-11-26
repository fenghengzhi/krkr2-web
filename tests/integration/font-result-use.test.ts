import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { headless } from '../helpers/headless.ts'

const directory = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as WasmManifest,
  assets = manifest.variants.asyncify!,
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file))),
  { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory }

test('older kernels without either optional Font metric export retain the existing script wrapper and shut down normally', { timeout: 60000 }, async () => {
  assert.equal(manifest.capabilities?.nativeFontMetrics, 1)
  for (const omitted of ['_krkr_font_metrics_version', '_krkr_value_set_font_metric_method'] as const) {
    let calls = 0
    const { session } = await headless({ 'startup.tjs': String.raw`
var w=new Window(),a=new Layer(w,null),font=a.font;font.height=24;
font.getTextWidth("A");var oldHeight=font.getTextHeight("");
var usedWidth=font.getTextWidth("A");
` }, {
      createRuntime: (handler, control, options) => TjsWasmRuntime.create(async (config) => {
        const module = await factory(config)
        assert(Reflect.deleteProperty(module, omitted))
        return module
      }, handler, { ...options, control, wasmBinary }),
      graphics: {
        decode: async () => { throw new Error('Unexpected image decode') },
        text: () => { throw new Error('Unexpected text draw') },
        hasFont: () => true,
        measure(text, font) { calls++; return { width: text.length * 7, height: font.height, ascent: 0 } },
      },
    })
    const failures: unknown[] = []
    try {
      await session.start()
      assert.equal(await session.evaluate('oldHeight+"|"+usedWidth'), '24|7', omitted)
      assert(calls > 0, 'The explicitly selected legacy wrapper still performs measurements')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Legacy Font capability or cleanup failed', { cause: failures[0] })
  }
})
