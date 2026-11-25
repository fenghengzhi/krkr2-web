import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { headless } from '../helpers/headless.ts'
import { postedInputErrors, postedInputSource } from '../helpers/window-post-input.ts'

const directory = resolve('.generated/wasm'), manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')),
  assets = manifest.variants.asyncify!, wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file))),
  { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory }

async function fixture(binary: boolean, legacy = false) {
  const f = await headless({ 'input.tjs': postedInputSource, 'startup.tjs': binary
    ? 'Scripts.compileStorage("input.tjs","savedata/input.cjs",false,true,false);Scripts.execStorage("savedata/input.cjs");'
    : 'Scripts.execStorage("input.tjs");' }, { createRuntime: (handler, control, options) =>
      TjsWasmRuntime.create(async (config) => {
        const module = await factory(config)
        if (legacy) assert(Reflect.deleteProperty(module, '_krkr_window_input_version'))
        return module
      }, handler, { ...options, control, wasmBinary }) })
  try {
    await f.session.start(); await f.session.idle()
    const a = Number(await f.session.evaluate('postedA.__windowId')), b = Number(await f.session.evaluate('postedB.__windowId'))
    return { ...f, a, b, exec: (source: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(source)})`) }
  } catch (error) {
    try { await f.session.stop() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Posted input setup and cleanup failed', { cause: error }) }
    throw error
  }
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: posted Window events use native argument/error ordering and actual byte character codes`, { timeout: 60000 }, async () => {
    assert.equal(manifest.capabilities?.nativeWindowInput, 1)
    const f = await fixture(binary)
    try {
      await f.session.evaluate('postedHolders()')
      for (const [which, expected] of Object.entries(postedInputErrors))
        assert.equal(await f.session.evaluate(`postedInvalid(${which})`), expected)
      assert.equal(await f.session.evaluate('postedInvalid(6)'), 'ok|key')
      assert.equal(await f.session.evaluate('postedInvalid(7)'), 'ok|')
      await f.session.idle()
      assert.equal(await f.session.evaluate('postedTrace.join("|")'), 'A:T:A|A:D:0:0')
      assert.equal(await f.session.evaluate('postedOrdinary()'), 'key,shift,key,shift')
      await f.session.idle()
      assert.equal(await f.session.evaluate('postedTrace.join("|")'), 'returned|A:D:65:-1|A:U:65:127|A:T:A|B:D:66:0')
      assert.equal(await f.session.evaluate('[System.getKeyState(65),System.getKeyState(66)].join(",")'), '0,0')
      // Web CP932 is per Window and independent of Scripts.textEncoding.
      await f.exec('postedTrace.clear();postedA.postInputEvent("onKeyPress",%[key:0x82]);postedB.postInputEvent("onKeyPress",%[key:66]);Scripts.textEncoding="utf-8";postedA.postInputEvent("onKeyPress",%[key:0]);postedA.postInputEvent("onKeyPress",%[key:0xa0]);')
      await f.session.idle()
      assert.equal(await f.session.evaluate('postedTrace.join("|")'), 'B:T:B|A:T:あ')
      await f.exec('postedTrace.clear();postedA.postInputEvent("onKeyPress",%[key:0x82]);invalidate postedA;')
      await f.session.input({ type: 'text', windowId: f.b, text: '中' })
      assert.equal(await f.session.evaluate('postedTrace.join("|")'), 'B:T:中', 'Physical Unicode remains a distinct input path')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })
  test(`${mode}: posted mouse keys retain explicit Window, asynchronous ordering and real click delivery across event disabling`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('postedB.trapKey=true;System.eventDisabled=true;')
      f.session.pointerState(20, 10, f.a, 1)
      await f.session.evaluate('postedMouse()')
      assert.equal(await f.session.evaluate('postedTrace.join("|")'), 'returned')
      await f.session.evaluate('System.eventDisabled=false'); await f.session.idle()
      assert.equal(await f.session.evaluate('postedTrace.join("|")'), 'returned|A:down:20,10:0:0|A:click:20,10|button:10,5|A:up:20,10:0:0')
      assert.equal(await f.session.evaluate('[System.getKeyState(VK_RETURN),System.getKeyState(VK_LBUTTON)].join(",")'), '0,0')
      await f.exec('postedTrace.clear();System.eventDisabled=true;postedMouse();invalidate postedA;System.eventDisabled=false;')
      await f.session.idle()
      assert.equal(await f.session.evaluate('postedTrace.join("|")'), 'returned')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })
}

test('kernels without the optional Window input export retain their existing posted-input wrapper', { timeout: 60000 }, async () => {
  const f = await fixture(false, true)
  try {
    await f.exec('postedA.postInputEvent("onKeyPress",%[key:"中"]);postedA.useMouseKey=true;postedA.postInputEvent("onKeyDown",%[key:13]);')
    await f.session.idle()
    assert.equal(await f.session.evaluate('postedTrace.join("|")'), 'A:T:中|A:D:13:0')
  } finally { await f.session.stop() }
})
