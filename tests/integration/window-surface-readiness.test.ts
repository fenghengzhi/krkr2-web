import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import type {
  FrameLayer,
  Renderer,
  RendererReadiness,
  RendererStatus,
} from '../../src/engine/ports/graphics.ts'
import type { AudioCommand } from '../../src/engine/ports/audio.ts'
import type { VideoCommand } from '../../src/engine/ports/video.ts'
import { headless } from '../helpers/headless.ts'
import { LifetimeAudioBackend } from '../helpers/sound-lifetime-audio.ts'
import { LifetimeVideoBackend } from '../helpers/video-lifetime-backend.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

interface Surface {
  state: 'ready' | 'pending' | 'failed'
  waiters: Set<ReturnType<typeof deferred<void>>>
}

/** Each native Window has an independent, explicitly released readiness gate. */
class GatedRenderer implements Renderer {
  readonly windows = new Map<number, Surface>()
  readonly opened: number[] = []
  readonly closed: number[] = []
  readonly requests: number[] = []
  readonly cancellations: number[] = []
  readonly listeners = new Set<(status: RendererStatus) => void>()
  readonly entered = deferred<number>()
  readonly cancelled = deferred<number>()
  readonly abandoned: ReturnType<typeof deferred<void>>[] = []
  status: RendererStatus = { state: 'ready', generation: 0 }
  disposals = 0

  constructor(private readonly initiallyReady = 0) {}

  get waiters(): number {
    return [...this.windows.values()].reduce((count, surface) => count + surface.waiters.size, 0)
  }

  openWindow(id: number): void {
    assert.ok(!this.windows.has(id), 'Window surface must open once')
    this.opened.push(id)
    this.windows.set(id, {
      state: this.opened.length <= this.initiallyReady ? 'ready' : 'pending',
      waiters: new Set(),
    })
    this.publish()
  }

  waitWindowReady(id: number): RendererReadiness {
    const surface = this.windows.get(id)
    assert.ok(surface, 'Readiness must follow surface registration')
    this.requests.push(id)
    const work = deferred<void>()
    let cancelled = false
    if (surface.state === 'ready') work.resolve()
    else {
      surface.waiters.add(work)
      this.entered.resolve(id)
    }
    return {
      promise: work.promise,
      cancel: () => {
        if (cancelled) return
        cancelled = true
        this.cancellations.push(id)
        if (surface.waiters.delete(work)) {
          this.abandoned.push(work)
          work.reject(new Error(`Window renderer ${id} readiness wait was cancelled`))
        }
        this.cancelled.resolve(id)
      },
    }
  }

  ready(id: number): void {
    const surface = this.windows.get(id)
    if (!surface) return
    surface.state = 'ready'
    this.publish()
    for (const work of surface.waiters) work.resolve()
    surface.waiters.clear()
  }

  fail(id: number): void {
    const surface = this.windows.get(id)
    assert.ok(surface)
    surface.state = 'failed'
    this.publish()
  }

  closeWindow(id: number): void {
    const surface = this.windows.get(id)
    if (!surface) return
    this.closed.push(id)
    this.windows.delete(id)
    for (const work of surface.waiters) work.reject(new Error(`Window renderer ${id} is retired`))
    surface.waiters.clear()
  }

  present(_layers: FrameLayer[], _width: number, _height: number, id = 0): boolean {
    return this.windows.get(id)?.state === 'ready'
  }

  subscribe(listener: (status: RendererStatus) => void): () => void {
    this.listeners.add(listener)
    listener({ ...this.status })
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    const states = [...this.windows.values()].map((surface) => surface.state)
    this.status = {
      generation: this.status.generation + 1,
      ...(states.includes('failed')
        ? { state: 'failed' as const, message: 'controlled surface failure' }
        : states.includes('pending')
          ? { state: 'restoring' as const, pending: true }
          : { state: 'ready' as const }),
    }
    for (const listener of this.listeners) listener({ ...this.status })
  }

  dispose(): void {
    this.disposals++
    for (const id of this.windows.keys()) this.closeWindow(id)
    this.listeners.clear()
  }
}

class ObservedAudio extends LifetimeAudioBackend {
  readonly pauses: boolean[] = []
  override command(command: AudioCommand) {
    if (command.op === 'pauseAll') this.pauses.push(command.paused)
    return super.command(command)
  }
}

class ObservedVideo extends LifetimeVideoBackend {
  readonly pauses: boolean[] = []
  override command(command: VideoCommand) {
    if (command.op === 'pauseAll') this.pauses.push(command.paused)
    return super.command(command)
  }
}

const definitions = String.raw`
var constructors=0,allocations=0,completed=0;
class SurfaceWindow extends Window {
  function SurfaceWindow(){
    super.Window();constructors++;Debug.message("surface-constructor-returned");
  }
}
function constructScene(){
  global.win=new SurfaceWindow();
  allocations++;Debug.message("surface-allocation-started");
  global.layer=new Layer(win,null);layer.setImageSize(1024,1024);
  completed++;Debug.message("surface-scene-completed");
}
function createPriorMedia(){
  global.prior=new Window();prior.visible=true;
  global.voice=new WaveSoundBuffer(null);voice.open("tone.wav");voice.play();
  global.movie=new VideoOverlay(prior);movie.open("movie.mp4");movie.play();
}
`

async function fixture(binary: boolean, initiallyReady = 0) {
  const renderer = new GatedRenderer(initiallyReady),
    audio = new ObservedAudio(),
    video = new ObservedVideo(),
    harness = await headless(
      {
        'startup.tjs': '',
        'surface-scene.tjs': definitions,
        'tone.wav': new Uint8Array([1]),
        'movie.mp4': new Uint8Array([1, 2, 3]),
      },
      { renderer, audio, video },
    )
  const { session } = harness
  try {
    await session.start()
    // Compilation and definitions contain no Window constructions. Thus only
    // constructScene(), including its bytecode constructor, reaches the gate.
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("surface-scene.tjs","savedata/surface-scene.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/surface-scene.cjs")')
    } else await session.evaluate('Scripts.execStorage("surface-scene.tjs")')
    return { ...harness, renderer, audio, video }
  } catch (error) {
    await session.stop()
    throw error
  }
}

function construction(f: Awaited<ReturnType<typeof fixture>>) {
  let completed = false
  const result = f.session.evaluate('constructScene()').then(
    (value) => {
      completed = true
      return value
    },
    (error) => {
      completed = true
      throw error
    },
  )
  return {
    result,
    completed: () => completed,
    entered: Promise.race([
      f.renderer.entered.promise,
      result.then(() => {
        throw new Error('Constructor completed before waiting for its surface')
      }),
    ]),
  }
}

function assertBeforeAllocation(f: Awaited<ReturnType<typeof fixture>>, completed: boolean) {
  assert.equal(completed, false)
  assert.equal(f.session.snapshot().layers, 0)
  assert.equal(f.session.inspectOwnership().layerSources, 0)
  assert.equal(f.session.inspectOwnership().fontSources, 0)
  assert.equal(f.logs.includes('surface-constructor-returned'), false)
  assert.equal(f.logs.includes('surface-allocation-started'), false)
  assert.equal(f.logs.includes('surface-scene-completed'), false)
}

function assertStopped(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.session.snapshot().state, 'stopped')
  assert.equal(f.session.snapshot().handles, 0)
  assert.equal(f.session.snapshot().resources, 0)
  assert.ok(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  assert.equal(f.renderer.windows.size, 0)
  assert.equal(f.renderer.waiters, 0)
  assert.equal(f.renderer.listeners.size, 0)
  assert.equal(f.renderer.disposals, 1)
  assert.deepEqual(
    [...f.renderer.closed].sort((a, b) => a - b),
    [...f.renderer.opened].sort((a, b) => a - b),
  )
  assert.equal(f.audio.voices.size, 0)
  assert.equal(f.audio.listeners.size, 0)
  assert.equal(f.audio.terminalCloses, 1)
  assert.equal(f.video.movies.size, 0)
  assert.equal(f.video.listeners.size, 0)
  assert.equal(f.video.terminalCloses, 1)
}

const hostTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: Window construction waits for its initial surface before returning or allocating a Layer`, async () => {
    const f = await fixture(binary)
    try {
      const running = construction(f),
        id = await running.entered
      assertBeforeAllocation(f, running.completed())
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      assert.equal(f.session.inspectOwnership().closingWindows, 0)
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(f.session.snapshot().graphics.pending, true)
      assert.equal(f.renderer.waiters, 1)
      assert.equal(f.audio.pauses.includes(true), false)
      assert.equal(f.video.pauses.includes(true), false)
      f.renderer.ready(id)
      await running.result
      assert.equal(running.completed(), true)
      assert.equal(await f.session.evaluate('constructors+","+allocations+","+completed'), '1,1,1')
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      assert.equal(f.session.snapshot().layers, 1)
      assert.equal(await f.session.evaluate('layer.imageWidth+","+layer.imageHeight'), '1024,1024')
      assert.deepEqual(f.renderer.requests, [id])
      assert.deepEqual(f.renderer.cancellations, [id])
      assert.equal(f.renderer.waiters, 0)
      f.renderer.ready(id)
      assert.equal(await f.session.evaluate('constructors+","+allocations+","+completed'), '1,1,1')
      assert.equal(f.logs.filter((line) => line === 'surface-scene-completed').length, 1)
    } finally {
      await f.session.stop()
      assertStopped(f)
    }
  })

  test(`${mode}: waiting for a new Window ignores another surface's readiness and leaves its media running`, async () => {
    const f = await fixture(binary, 1)
    try {
      await f.session.evaluate('createPriorMedia()')
      const prior = Number(await f.session.evaluate('prior.__windowId')),
        baseline = f.session.inspectOwnership(),
        voice = f.audio.onlyId(),
        movie = f.video.onlyId(),
        running = construction(f),
        id = await running.entered
      assert.notEqual(id, prior)
      assertBeforeAllocation(f, running.completed())
      assert.equal(f.session.inspectOwnership().windowSources, baseline.windowSources + 1)
      assert.equal(f.session.inspectOwnership().soundSources, baseline.soundSources)
      assert.equal(f.session.inspectOwnership().videoSources, baseline.videoSources)
      f.renderer.ready(prior)
      await hostTurn()
      assertBeforeAllocation(f, running.completed())
      assert.equal(f.renderer.waiters, 1)
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(f.audio.voices.get(voice)?.status, 'play')
      assert.equal(f.video.movies.get(movie)?.status, 'play')
      assert.equal(f.audio.pauses.includes(true), false)
      assert.equal(f.video.pauses.includes(true), false)
      f.renderer.ready(id)
      await running.result
      assert.equal(
        await f.session.evaluate('completed+","+voice.status+","+movie.status'),
        '1,play,play',
      )
      assert.deepEqual(f.renderer.requests, [prior, id])
      assert.deepEqual(f.renderer.cancellations, [prior, id])
    } finally {
      await f.session.stop()
      assertStopped(f)
    }
  })

  test(`${mode}: readiness received during user pause keeps the constructor suspended until resume`, async () => {
    const f = await fixture(binary)
    try {
      const running = construction(f),
        id = await running.entered
      assertBeforeAllocation(f, running.completed())
      f.session.pause()
      f.renderer.ready(id)
      await f.renderer.cancelled.promise
      await hostTurn()
      assertBeforeAllocation(f, running.completed())
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.session.snapshot().userPaused, true)
      assert.equal(f.renderer.waiters, 0)
      assert.deepEqual(f.renderer.cancellations, [id])
      f.session.resume()
      await running.result
      assert.equal(await f.session.evaluate('constructors+","+allocations+","+completed'), '1,1,1')
      assert.equal(f.session.snapshot().state, 'running')
    } finally {
      await f.session.stop()
      assertStopped(f)
    }
  })

  for (const state of ['pending', 'failed'] as const) {
    test(`${mode}: Stop cancels a ${state} surface wait before draining the VM and releases all Window resources`, async () => {
      const f = await fixture(binary)
      try {
        const running = construction(f),
          id = await running.entered
        assertBeforeAllocation(f, running.completed())
        if (state === 'failed') {
          f.renderer.fail(id)
          assert.equal(f.session.snapshot().state, 'paused')
          assert.equal(f.session.snapshot().graphics.state, 'failed')
          assert.equal(f.renderer.waiters, 1)
        }
        const rejected = assert.rejects(running.result, /Execution cancelled/)
        await Promise.all([f.session.stop(), rejected])
        assert.equal(running.completed(), true)
        assert.deepEqual(f.renderer.cancellations, [id])
        assert.equal(f.renderer.abandoned.length, 1)
        assert.equal(f.logs.includes('surface-constructor-returned'), false)
        assert.equal(f.logs.includes('surface-scene-completed'), false)
        assertStopped(f)
        // Repeated completion of this settled fake wait leaves terminal state
        // unchanged; late transferable surface attachment is covered separately.
        for (const work of f.renderer.abandoned) work.resolve()
        f.renderer.ready(id)
        await hostTurn()
        assertStopped(f)
        assert.deepEqual(f.renderer.requests, [id])
      } finally {
        await f.session.stop()
      }
    })
  }
}
