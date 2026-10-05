import nodeTest, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { GeometryChannel, type GeometryPresentation } from '../../src/player/geometry-channel.ts'
import { PortWindowGeometry } from '../../src/backends/window/port-geometry.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import { HeadlessWindowGeometry } from '../../src/engine/scene/window-geometry.ts'
import type { WindowGeometry, WindowGeometryRequest, WindowGeometryScroll } from '../../src/engine/ports/window-geometry.ts'

const test = (name: string, run: (context: TestContext) => Promise<void>) => nodeTest(name, { timeout: 30000 }, run)
const request = (id = 1): WindowGeometryRequest => ({ requestId: id, revision: id, windowId: 7,
  operation: 'create', view: new WindowState().view(), menus: {}, primary: { width: 800, height: 600 },
  innerRequest: { width: 800, height: 600 }, resetScroll: false })
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Geometry channel did not settle')), 10000)
  })]) } finally { clearTimeout(timer) }
}
async function measured(value: WindowGeometryRequest, epoch = 3): Promise<WindowGeometry> {
  const headless = new HeadlessWindowGeometry()
  try { return { ...await headless.measure(value), platform: 'dom', surfaceEpoch: epoch } }
  finally { headless.dispose() }
}
function fixture(context: TestContext, host: GeometryPresentation) {
  const ports = new MessageChannel(), errors: unknown[] = [],
    presentation = new GeometryChannel(ports.port1, 11, host, (error) => errors.push(error)),
    backend = new PortWindowGeometry(ports.port2, 11)
  context.after(() => { presentation.close(); backend.dispose(); assert.deepEqual(errors, []) })
  return { presentation, backend }
}

test('geometry real ports await measurement and preserve the surface and scroll identity', async (context) => {
  const entered = gate<void>(), result = gate<WindowGeometry>()
  let scroll!: (value: WindowGeometryScroll) => void
  const f = fixture(context, { get: () => ({ surfaceEpoch: 3 }),
    measureGeometry: async () => { entered.resolve(); return result.promise },
    subscribeGeometryScroll: (listener) => { scroll = listener; return () => {} } }),
    observation = gate<WindowGeometryScroll>(), pending = f.backend.measure(request())
  f.backend.subscribe(observation.resolve)
  await bounded(entered.promise)
  let completed = false
  void pending.then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  result.resolve(await measured(request()))
  const geometry = await bounded(pending)
  assert.equal(geometry.surfaceEpoch, 3)
  assert.equal(geometry.platform, 'dom')
  scroll({ windowId: 7, surfaceEpoch: 3, baseRevision: 1, sequence: 1, x: 0, y: 0 })
  assert.deepEqual(await bounded(observation.promise), { windowId: 7, surfaceEpoch: 3,
    baseRevision: 1, sequence: 1, x: 0, y: 0 })
})

test('geometry missing presentation and invalid measured rectangles settle as errors', async (context) => {
  const absent = fixture(context, { get: () => ({ surfaceEpoch: 3 }) })
  await assert.rejects(bounded(absent.backend.measure(request())), /presentation is unavailable/)
  const invalid = fixture(context, { get: () => ({ surfaceEpoch: 3 }),
    measureGeometry: async (value) => { const g = await measured(value); g.viewport.width = 9000; return g } })
  await assert.rejects(bounded(invalid.backend.measure(request())), /Invalid Window geometry/)
})

test('geometry detach aborts pending work and a late old result cannot satisfy a replacement surface', async (context) => {
  const entered = gate<void>(), late = gate<WindowGeometry>()
  let epoch = 3, oldSignal: AbortSignal | undefined
  const f = fixture(context, { get: () => ({ surfaceEpoch: epoch }),
    measureGeometry: async (value, current, signal) => {
      if (value.requestId === 1) { oldSignal = signal; entered.resolve(); return late.promise }
      return measured(value, current)
    } }), pending = f.backend.measure(request()), rejected = assert.rejects(pending, /surface retired/)
  await bounded(entered.promise)
  f.presentation.detach(7)
  epoch = 4
  assert.equal(oldSignal?.aborted, true)
  await bounded(rejected)
  late.resolve(await measured(request()))
  const replacement = await bounded(f.backend.measure(request(2)))
  assert.equal(replacement.surfaceEpoch, 4)
})

test('geometry Stop suspension aborts presentation without resuming TJS ahead of backend disposal', async (context) => {
  const entered = gate<void>(), late = gate<WindowGeometry>()
  let signal: AbortSignal | undefined
  const f = fixture(context, { get: () => ({ surfaceEpoch: 3 }),
    measureGeometry: async (_value, _epoch, current) => { signal = current; entered.resolve(); return late.promise } }),
    pending = f.backend.measure(request()), rejected = assert.rejects(pending, /host closed/)
  let settled = false
  void rejected.then(() => { settled = true })
  await bounded(entered.promise)
  f.presentation.suspend()
  assert.equal(signal?.aborted, true)
  late.resolve(await measured(request()))
  await Promise.resolve(); await Promise.resolve()
  assert.equal(settled, false)
  f.backend.dispose()
  await bounded(rejected)
})

test('geometry worker retirement rejects its request and cancels only that Window presentation', async (context) => {
  const entered = gate<void>(), late = gate<WindowGeometry>(), aborted = gate<void>()
  const f = fixture(context, { get: () => ({ surfaceEpoch: 3 }),
    measureGeometry: async (value, epoch, signal) => {
      if (value.windowId !== 7) return measured(value, epoch)
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      entered.resolve(); return late.promise
    } }), pending = f.backend.measure(request()), rejected = assert.rejects(pending, /retired/)
  await bounded(entered.promise)
  f.backend.retire(7)
  await bounded(rejected); await bounded(aborted.promise)
  late.resolve(await measured(request()))
  assert.equal((await bounded(f.backend.measure({ ...request(2), windowId: 8 }))).surfaceEpoch, 3)
})
