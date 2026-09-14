import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EngineSession } from '../../src/engine/session.ts'
import { MemorySaveStore, type SaveStore } from '../../src/engine/ports/saves.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { readScript, readText, writeText } from '../../src/backends/files/text-codecs.ts'
import { inflateImage, deflateImage } from '../../src/backends/files/blob-source.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
class Clock {
  now = 0
  tasks = new Set<{ time: number; callback: () => void }>()
  schedule = (callback: () => void, delay: number) => {
    const task = { time: this.now + delay, callback }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  advance(delta: number) {
    this.now += delta
    for (let limit = 0; limit < 10000; limit++) {
      const task = [...this.tasks].find((task) => task.time <= this.now)
      if (!task) return
      this.tasks.delete(task)
      task.callback()
    }
    throw new Error('Clock did not settle')
  }
}
async function create(
  source: string,
  store: SaveStore = new MemorySaveStore(),
  clock = new Clock(),
) {
  const logs: string[] = []
  const session = new EngineSession({
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    inflateImage,
    deflateImage,
    createRuntime: (handler, control) =>
      TjsWasmRuntime.create(factory, handler, { control, wasmBinary }),
    saveStore: store,
    renderer: { present() {}, dispose() {} },
    graphics: {
      decode: async () => {
        throw new Error('Unexpected image')
      },
      text: () => {
        throw new Error('Unexpected text')
      },
    },
    now: () => clock.now,
    schedule: clock.schedule,
    decodeScript: readScript,
    readText,
    writeText,
    event: (event) => {
      if (event.type === 'log') logs.push(event.text)
    },
  })
  await session.initialize()
  session.mount([
    {
      name: 'startup.tjs',
      size: source.length,
      read: async () => new TextEncoder().encode(source),
    },
  ])
  return { session, clock, logs }
}

test('Scripts executes source and expressions in the supplied TJS context', async () => {
  const { session } = await create(
    'var scope = %[value:7]; var result = Scripts.eval("value*6", "context.tjs", 0, scope); Scripts.exec("value=12;", "context.tjs", 8, scope);',
  )
  try {
    await session.start()
    assert.equal(await session.evaluate('result'), '42')
    assert.equal(await session.evaluate('scope.value'), '12')
    assert.equal(
      await session.evaluate('Storages.extractStorageName("data.xp3>folder/image.png")'),
      'image.png',
    )
    assert.equal(
      await session.evaluate('Storages.chopStorageExt("folder/image.png")'),
      'folder/image',
    )
  } finally {
    await session.stop()
  }
})

test('native Array and Dictionary streams persist raw game files and reload in a fresh VM', async () => {
  const store = new MemorySaveStore()
  const first = await create(
    'var lines=["first","日本語","😀"]; lines.save("savedata/lines.txt"); var same=[].load("savedata/lines.txt"); var data=%[counter:9007199254740993, name:"記録"]; (Dictionary.saveStruct incontextof data)("savedata/state.bin", "b");',
    store,
  )
  try {
    await first.session.start()
    assert.equal(await first.session.evaluate('same[1]'), '日本語')
    assert.equal(first.session.snapshot().saveFiles, 2)
    assert.equal(first.session.snapshot().pendingSaves, 0)
  } finally {
    await first.session.stop()
  }
  const second = await create(
    'var loaded = [].load("savedata/lines.txt"); var state = Dictionary.loadStruct("savedata/state.bin");',
    store,
  )
  try {
    await second.session.start()
    assert.equal(await second.session.evaluate('loaded[2]'), '😀')
    assert.equal(await second.session.evaluate('state.counter'), '9007199254740993')
    assert.equal(await second.session.evaluate('state.name'), '記録')
  } finally {
    await second.session.stop()
  }
})

test('failed save commits retain exportable writes and stop can be retried', async () => {
  const memory = new MemorySaveStore()
  let fail = true
  const store: SaveStore = {
    load: () => memory.load(),
    close() {},
    commit: (files) => (fail ? Promise.reject(new Error('quota exhausted')) : memory.commit(files)),
  }
  const { session } = await create('["keep me"].save("savedata/recovery.txt");', store)
  await assert.rejects(session.start(), /quota/)
  assert.equal(session.snapshot().pendingSaves, 2)
  const backup = session.exportSaves()
  assert.deepEqual(backup.map((file) => file.path).sort(), [
    'savedata/krkr.console.log',
    'savedata/recovery.txt',
  ])
  assert.equal(
    await readText(backup.find((file) => file.path.endsWith('recovery.txt'))!.bytes),
    'keep me\r\n',
  )
  assert.match(
    await readText(backup.find((file) => file.path.endsWith('krkr.console.log'))!.bytes),
    /quota exhausted/,
  )
  await assert.rejects(session.stop(), /quota/)
  fail = false
  await session.stop()
  assert.deepEqual(await memory.load(), backup)
})

test('Timer capacity, zero interval, pause/resume and invalidation preserve event ordering', async () => {
  const { session, clock } = await create(
    'var ticks=0; var timer=new Timer(function(){ ticks++; }, ""); timer.interval=10; timer.capacity=2; timer.enabled=true;',
  )
  try {
    await session.start()
    clock.advance(100)
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '2')
    session.pause()
    clock.advance(1000)
    session.resume()
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '2')
    clock.advance(10)
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '3')
    await session.evaluate('timer.interval=0')
    clock.advance(100)
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '3')
    await session.evaluate('(function(){invalidate timer;return 0;})()')
    assert.equal(clock.tasks.size, 0)
  } finally {
    await session.stop()
  }
})

test('AsyncTrigger caching, cancellation and priority modes run after the current script', async () => {
  const source =
    'var order=[]; var normal=new AsyncTrigger(function(){order.add("normal");},""); var idle=new AsyncTrigger(function(){order.add("idle");},""); idle.mode=atmAtIdle; var exclusive=new AsyncTrigger(function(){order.add("exclusive");},""); exclusive.mode=atmExclusive; idle.trigger(); normal.trigger(); normal.trigger(); exclusive.trigger(); order.add("script");'
  const { session } = await create(source)
  try {
    await session.start()
    await session.idle()
    assert.equal(await session.evaluate('order.join(",")'), 'script,exclusive,normal,idle')
    await session.evaluate(
      '(function(){normal.cached=false;normal.trigger();normal.trigger();return 0;})()',
    )
    await session.idle()
    assert.equal(await session.evaluate('order.count'), '6')
    await session.evaluate('(function(){normal.trigger();normal.cancel();return 0;})()')
    await session.idle()
    assert.equal(await session.evaluate('order.count'), '6')
  } finally {
    await session.stop()
  }
})
