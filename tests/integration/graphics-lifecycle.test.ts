import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { Renderer, RendererStatus, FrameLayer } from '../../src/engine/ports/graphics.ts'
import { readText } from '../../src/backends/files/text-codecs.ts'

class Surface implements Renderer {
  status: RendererStatus = { state: 'ready', generation: 1 }
  listener?: (status: RendererStatus) => void
  frames = 0
  last: number[] = []
  disposed = false
  subscribe(listener: (status: RendererStatus) => void) {
    this.listener = listener
    listener(this.status)
    return () => {
      this.listener = undefined
    }
  }
  change(state: RendererStatus['state']) {
    this.status = { state, generation: this.status.generation + (state === 'ready' ? 1 : 0) }
    this.listener?.(this.status)
  }
  present(layers: FrameLayer[]) {
    if (this.status.state === 'lost' || this.status.state === 'failed') return false
    this.frames++
    this.last = [...(layers[0]?.pixels.data ?? [])]
    if (this.status.state === 'restoring') this.change('ready')
    return true
  }
  retry() {
    this.change('restoring')
  }
  dispose() {
    this.disposed = true
  }
}
const scene = `
var window=new Window();window.visible=true;window.setInnerSize(2,1);
var root=new Layer(window,null);root.setSize(2,1);root.fillRect(0,0,2,1,0xffff0000);
var clicks=0;root.onClick=function(){clicks++;};
["checkpoint"].save("savedata/state.txt","utf-8");
`

test('graphics recovery preserves automatic transition phase and its completion callback', async () => {
  const surface = new Surface()
  let now = 0
  const scheduled = new Set<() => void>()
  const { session } = await headless(
    {
      'startup.tjs':
        scene +
        `
var front=new Layer(window,root),back=new Layer(window,root),completed=0;
front.setSize(2,1);back.setSize(2,1);front.visible=true;
front.fillRect(0,0,2,1,0xffff0000);back.fillRect(0,0,2,1,0xff0000ff);
front.onTransitionCompleted=function(){completed++;};front.beginTransition("crossfade",true,back,%[time:100]);
`,
    },
    {
      renderer: surface,
      now: () => now,
      schedule(callback) {
        scheduled.add(callback)
        return () => {
          scheduled.delete(callback)
        }
      },
    },
  )
  const advance = async (value: number) => {
    now = value
    const callback = scheduled.values().next().value
    if (callback) {
      scheduled.delete(callback)
      callback()
      await session.idle()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  try {
    await session.start()
    await advance(40)
    surface.change('lost')
    assert.equal(scheduled.size, 0)
    now = 1040
    surface.change('restoring')
    session.present()
    await advance(1099)
    assert.equal(await session.evaluate('completed'), '0')
    await advance(1100)
    assert.equal(await session.evaluate('completed'), '1')
    assert.equal(await session.evaluate('root.children[0]===back'), '1')
  } finally {
    await session.stop()
  }
})

test('graphics loss holds the VM and input until a complete replacement frame is presented', async () => {
  const surface = new Surface()
  const { session } = await headless({ 'startup.tjs': scene }, { renderer: surface })
  try {
    await session.start()
    const handles = session.snapshot().handles,
      pixels = [...surface.last]
    surface.change('lost')
    assert.equal(session.snapshot().state, 'paused')
    assert.equal(session.snapshot().userPaused, false)
    await session.click(0, 0)
    const frames = surface.frames
    session.present()
    assert.equal(surface.frames, frames)
    surface.change('restoring')
    assert.equal(session.snapshot().state, 'paused')
    session.present()
    assert.equal(session.snapshot().state, 'running')
    assert.equal(session.snapshot().handles, handles)
    assert.deepEqual(surface.last, pixels)
    assert.equal(await session.evaluate('clicks'), '0')
    await session.click(0, 0)
    assert.equal(await session.evaluate('clicks'), '1')
    assert.equal(await readText(session.exportSaves()[0]!.bytes), 'checkpoint\r\n')
  } finally {
    await session.stop()
  }
  assert(surface.disposed)
  assert.equal(surface.listener, undefined)
})

test('user pause intent is independent of loss, retry and repeated restoration', async () => {
  const surface = new Surface()
  const { session } = await headless({ 'startup.tjs': scene }, { renderer: surface })
  try {
    await session.start()
    session.pause()
    surface.change('lost')
    surface.change('restoring')
    session.present()
    assert.equal(session.snapshot().state, 'paused')
    session.resume()
    surface.change('lost')
    session.pause() // The user chooses to stay paused while graphics recovers.
    surface.change('failed')
    assert.equal(session.snapshot().state, 'paused')
    assert.equal(session.control.cancelled, false)
    assert.equal(session.exportSaves().length, 1)
    session.retryGraphics()
    assert.equal(session.snapshot().state, 'paused')
    assert.equal(session.snapshot().graphics.state, 'ready')
    surface.change('lost')
    session.resume() // Removing user pause cannot override a lost surface.
    assert.equal(session.snapshot().state, 'paused')
    surface.change('restoring')
    session.present()
    assert.equal(session.snapshot().state, 'running')
    assert.equal(await session.evaluate('clicks'), '0')
  } finally {
    await session.stop()
  }
})

test('graphics suspension freezes timer deadlines instead of accumulating missed ticks', async () => {
  const surface = new Surface()
  let now = 0
  const scheduled = new Set<{ at: number; callback: () => void }>()
  const { session } = await headless(
    {
      'startup.tjs':
        scene +
        `
var ticks=0;var timer=new Timer(function(){ticks++;},"");timer.interval=100;timer.enabled=true;
`,
    },
    {
      renderer: surface,
      now: () => now,
      schedule(callback, delay) {
        const task = { at: now + delay, callback }
        scheduled.add(task)
        return () => {
          scheduled.delete(task)
        }
      },
    },
  )
  try {
    await session.start()
    now = 40
    surface.change('lost')
    assert.equal(scheduled.size, 0)
    now = 1040
    surface.change('restoring')
    session.present()
    assert.equal(Math.min(...[...scheduled].map((task) => task.at)), 1100)
    now = 1100
    for (const task of [...scheduled])
      if (task.at <= now) {
        scheduled.delete(task)
        task.callback()
      }
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '1')
  } finally {
    await session.stop()
  }
  assert.equal(scheduled.size, 0)
})

test('a loss before startup can recover or stop without replacing the VM', async () => {
  const surface = new Surface()
  surface.change('lost')
  const { session } = await headless({ 'startup.tjs': scene }, { renderer: surface })
  const starting = session.start()
  assert.equal(session.snapshot().state, 'paused')
  const handles = session.snapshot().handles
  surface.change('restoring')
  session.present()
  await starting
  assert.equal(session.snapshot().state, 'running')
  assert(session.snapshot().handles >= handles)
  surface.change('lost')
  await session.stop()
  surface.change('ready')
  assert.equal(session.snapshot().state, 'stopped')
  assert.equal(session.snapshot().handles, 0)
})

test('stop cancels a startup waiting for graphics and detaches late recovery notifications', async () => {
  const surface = new Surface()
  surface.change('lost')
  const { session } = await headless({ 'startup.tjs': scene }, { renderer: surface })
  const starting = session.start()
  const rejected = assert.rejects(starting, /cancelled/)
  await session.stop()
  await rejected
  surface.change('ready')
  assert.equal(session.snapshot().state, 'stopped')
  assert.equal(surface.listener, undefined)
})
