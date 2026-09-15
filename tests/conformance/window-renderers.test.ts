import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  FrameLayer,
  Renderer,
  RendererReadiness,
  RendererStatus,
} from '../../src/engine/ports/graphics.ts'
import { WindowRendererRegistry } from '../../src/backends/render/window-renderers.ts'

class FakeRenderer implements Renderer {
  status: RendererStatus = { state: 'ready', generation: 1 }
  readonly listeners = new Set<(status: RendererStatus) => void>()
  readonly historical: ((status: RendererStatus) => void)[] = []
  readonly frames: { ids: number[]; width: number; height: number; windowId?: number }[] = []
  readonly textures = new Map<number, { revision: number; pixels: Uint8Array }>()
  disposals = 0
  unsubscribes = 0
  retries = 0
  onSubscribe?: () => void
  onUnsubscribe?: () => void
  onPresent?: () => void
  onRetry?: () => void
  onDispose?: () => void

  subscribe(listener: (status: RendererStatus) => void): () => void {
    this.listeners.add(listener)
    this.historical.push(listener)
    listener({ ...this.status })
    this.onSubscribe?.()
    return () => {
      this.unsubscribes++
      this.listeners.delete(listener)
      this.onUnsubscribe?.()
    }
  }
  emit(status: RendererStatus): void {
    this.status = { ...status }
    for (const listener of this.listeners) listener({ ...status })
  }
  present(layers: FrameLayer[], width: number, height: number, windowId?: number): boolean {
    this.frames.push({ ids: layers.map((layer) => layer.id), width, height, windowId })
    // Match the backend's per-frame eviction and revision-based texture uploads.
    const live = new Set(layers.map((layer) => layer.id))
    for (const id of this.textures.keys()) if (!live.has(id)) this.textures.delete(id)
    for (const layer of layers)
      if (this.textures.get(layer.id)?.revision !== layer.revision)
        this.textures.set(layer.id, {
          revision: layer.revision,
          pixels: layer.pixels.data.slice(),
        })
    this.onPresent?.()
    return true
  }
  retry(): void {
    this.retries++
    this.onRetry?.()
  }
  dispose(): void {
    this.disposals++
    this.listeners.clear()
    this.textures.clear()
    this.onDispose?.()
  }
}

function frame(id: number, color: number, revision = 1): FrameLayer {
  const rect = { x: 0, y: 0, width: 1, height: 1 }
  return {
    ...rect,
    id,
    revision,
    opacity: 1,
    clip: { ...rect },
    source: { ...rect },
    type: 1,
    pixels: { width: 1, height: 1, data: new Uint8Array([color, 0, 0, 255]) },
  }
}

function fixture() {
  const renderers = new Map<number, FakeRenderer>()
  const registry = new WindowRendererRegistry((id) => {
    const renderer = new FakeRenderer()
    renderers.set(id, renderer)
    return renderer
  })
  const statuses: RendererStatus[] = []
  registry.subscribe((status) => statuses.push(status))
  return { registry, renderers, statuses }
}

test('readiness follows only its Window and waits through recoverable failures and retries', async () => {
  const { registry, renderers, statuses } = fixture()
  try {
    registry.openWindow(1)
    registry.openWindow(2)
    const a = renderers.get(1)!,
      b = renderers.get(2)!
    a.emit({ state: 'restoring', generation: 0, pending: true })
    b.emit({ state: 'lost', generation: 1 })
    const wait = registry.waitWindowReady(1),
      completed: string[] = []
    void wait.promise.then(
      () => completed.push('A'),
      () => completed.push('rejected'),
    )
    a.emit({ state: 'lost', generation: 1 })
    a.emit({ state: 'failed', generation: 1, message: 'retryable allocation' })
    b.emit({ state: 'ready', generation: 2 })
    await Promise.resolve()
    assert.deepEqual(completed, [])
    await registry.waitWindowReady(2).promise
    assert.equal(statuses.at(-1)?.state, 'failed')
    b.emit({ state: 'failed', generation: 2, message: 'independent B failure' })
    a.onRetry = () => a.emit({ state: 'restoring', generation: 1 })
    registry.retry(1)
    await Promise.resolve()
    assert.deepEqual(completed, [])
    a.emit({ state: 'ready', generation: 2 })
    await wait.promise
    assert.deepEqual(completed, ['A'])
    assert.equal(statuses.at(-1)?.state, 'failed')
    wait.cancel()
    await registry.waitWindowReady(1).promise
  } finally {
    registry.dispose()
  }
})

test('readiness requested inside the factory waits until renderer subscription finishes', async () => {
  const renderer = new FakeRenderer()
  let wait: RendererReadiness | undefined
  const registry = new WindowRendererRegistry((id) => {
    wait = registry.waitWindowReady(id)
    return renderer
  })
  try {
    registry.openWindow(1)
    assert.ok(wait)
    await wait.promise
    assert.equal(renderer.listeners.size, 1)
    wait.cancel()
  } finally {
    registry.dispose()
  }
})

for (const action of ['throw', 'retire'] as const)
  test(`readiness cannot succeed when an opening renderer's subscription ${action}s`, async () => {
    const renderer = new FakeRenderer()
    let wait: RendererReadiness | undefined
    const registry = new WindowRendererRegistry((id) => {
      wait = registry.waitWindowReady(id)
      return renderer
    })
    renderer.onSubscribe = () => {
      if (action === 'throw') throw new Error('subscribe failed')
      registry.closeWindow(1)
    }
    try {
      if (action === 'throw') assert.throws(() => registry.openWindow(1), /subscribe failed/)
      else registry.openWindow(1)
      assert.ok(wait)
      await assert.rejects(wait.promise, action === 'throw' ? /subscribe failed/ : /retired/)
      assert.equal(renderer.disposals, 1)
      wait.cancel()
    } finally {
      registry.dispose()
    }
  })

for (const action of ['close', 'dispose'] as const)
  test(`${action} rejects pending readiness even when GPU cleanup fails`, async () => {
    const { registry, renderers } = fixture()
    registry.openWindow(1)
    const renderer = renderers.get(1)!
    renderer.emit({ state: 'failed', generation: 1 })
    renderer.onDispose = () => {
      throw new Error('GPU cleanup failed')
    }
    const wait = registry.waitWindowReady(1),
      rejected = assert.rejects(wait.promise, action === 'close' ? /retired/ : /disposed/)
    try {
      assert.throws(
        () => (action === 'close' ? registry.closeWindow(1) : registry.dispose()),
        /GPU cleanup failed/,
      )
      await rejected
      assert.equal(renderer.listeners.size, 0)
      assert.equal(renderer.disposals, 1)
      wait.cancel()
    } finally {
      registry.dispose()
    }
  })

test('cancelling one readiness wait rejects only that waiter and permits later independent waiters', async () => {
  const { registry, renderers } = fixture()
  try {
    registry.openWindow(1)
    const renderer = renderers.get(1)!
    renderer.emit({ state: 'restoring', generation: 0, pending: true })
    const cancelled = registry.waitWindowReady(1),
      live = registry.waitWindowReady(1),
      rejected = assert.rejects(cancelled.promise, /readiness wait was cancelled/)
    cancelled.cancel()
    cancelled.cancel()
    await rejected
    assert.equal(registry.getStatus(1)?.pending, true)
    assert.equal(renderer.listeners.size, 1)
    renderer.emit({ state: 'ready', generation: 1 })
    await live.promise
    live.cancel()
    const alreadyReady = registry.waitWindowReady(1)
    alreadyReady.cancel()
    await alreadyReady.promise
    registry.closeWindow(1)
    await live.promise
    assert.equal(renderer.listeners.size, 0)
  } finally {
    registry.dispose()
  }
})

test('readiness rejects unknown and disposed identities without allocating another renderer', async () => {
  const { registry, renderers } = fixture()
  await assert.rejects(registry.waitWindowReady(1).promise, /not registered/)
  registry.openWindow(1)
  registry.closeWindow(1)
  await assert.rejects(registry.waitWindowReady(1).promise, /not registered/)
  registry.dispose()
  await assert.rejects(registry.waitWindowReady(2).promise, /disposed/)
  assert.equal(renderers.size, 1)
})

test('a ready-status observer can retire the Window before pending readiness is resolved', async () => {
  const { registry, renderers } = fixture()
  try {
    registry.openWindow(1)
    const renderer = renderers.get(1)!
    renderer.emit({ state: 'lost', generation: 1 })
    const wait = registry.waitWindowReady(1),
      rejected = assert.rejects(wait.promise, /retired/)
    registry.subscribe(() => {
      if (registry.getStatus(1)?.state === 'ready') registry.closeWindow(1)
    })
    renderer.emit({ state: 'ready', generation: 2 })
    await rejected
    assert.equal(renderer.disposals, 1)
    wait.cancel()
  } finally {
    registry.dispose()
  }
})

test('readiness remains pending when a ready notification immediately discovers another loss', async () => {
  const { registry, renderers } = fixture()
  try {
    registry.openWindow(1)
    const renderer = renderers.get(1)!
    renderer.emit({ state: 'lost', generation: 1 })
    let resolved = false,
      loseAgain = true
    const waiting = registry.waitWindowReady(1)
    void waiting.promise.then(
      () => {
        resolved = true
      },
      () => {},
    )
    registry.subscribe(() => {
      if (loseAgain && registry.getStatus(1)?.state === 'ready') {
        loseAgain = false
        renderer.emit({ state: 'lost', generation: 2 })
      }
    })
    renderer.emit({ state: 'ready', generation: 2 })
    await Promise.resolve()
    assert.equal(resolved, false)
    renderer.emit({ state: 'ready', generation: 3 })
    await waiting.promise
    assert.equal(resolved, true)
    waiting.cancel()
  } finally {
    registry.dispose()
  }
})

test('no-window and stale frames never allocate or select an implicit window renderer', () => {
  const { registry, renderers, statuses } = fixture()
  assert.deepEqual(statuses, [{ state: 'ready', generation: 0 }])
  for (const id of [undefined, 0, -1, NaN, Infinity, 0.5, 999])
    assert.equal(registry.present([], 10, 20, id), false)
  assert.equal(renderers.size, 0)
  for (const id of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => registry.openWindow(id), /positive safe integers/)
  registry.openWindow(1)
  registry.openWindow(1)
  assert.equal(renderers.size, 1)
  assert.equal(registry.present([], 10, 20), false)
  registry.closeWindow(1)
  registry.closeWindow(2)
  for (const id of [1, 2]) {
    assert.equal(registry.present([], 10, 20, id), false)
    assert.throws(() => registry.openWindow(id), /retired/)
  }
  assert.equal(renderers.size, 1)
  registry.dispose()
  assert.throws(() => registry.openWindow(3), /disposed/)
})

test('legacy renderers without lifecycle/status methods keep their three-argument contract', () => {
  const frames: [FrameLayer[], number, number][] = []
  let disposed = 0
  const legacy: Renderer = {
    present(layers, width, height) {
      frames.push([layers, width, height])
    },
    dispose() {
      disposed++
    },
  }
  const registry = new WindowRendererRegistry(() => legacy)
  registry.openWindow(7)
  const layers = [frame(1, 80)]
  assert.equal(registry.present(layers, 100, 200, 7), undefined)
  assert.deepEqual(frames, [[layers, 100, 200]])
  assert.deepEqual(registry.getStatus(7), { state: 'ready', generation: 0 })
  registry.dispose()
  assert.equal(disposed, 1)
})

test('two windows isolate frame sizes, texture revisions, eviction and closing', () => {
  const { registry, renderers } = fixture()
  registry.openWindow(10)
  registry.openWindow(20)
  const a = renderers.get(10)!,
    b = renderers.get(20)!
  assert.equal(registry.present([frame(1, 10), frame(2, 20)], 100, 200, 10), true)
  assert.equal(registry.present([frame(1, 90)], 300, 400, 20), true)
  assert.equal(registry.present([frame(2, 30, 2)], 50, 60, 10), true)
  assert.deepEqual([...a.textures.keys()], [2])
  assert.deepEqual([...a.textures.get(2)!.pixels], [30, 0, 0, 255])
  assert.deepEqual([...b.textures.keys()], [1])
  assert.deepEqual([...b.textures.get(1)!.pixels], [90, 0, 0, 255])
  assert.deepEqual(a.frames, [
    { ids: [1, 2], width: 100, height: 200, windowId: 10 },
    { ids: [2], width: 50, height: 60, windowId: 10 },
  ])
  assert.deepEqual(b.frames, [{ ids: [1], width: 300, height: 400, windowId: 20 }])
  registry.closeWindow(10)
  assert.equal(a.disposals, 1)
  assert.equal(a.unsubscribes, 1)
  assert.equal(b.disposals, 0)
  assert.deepEqual([...b.textures.keys()], [1])
  assert.equal(registry.present([frame(1, 90)], 300, 400, 20), true)
  registry.dispose()
  assert.equal(a.disposals, 1)
  assert.equal(b.disposals, 1)
})

test('aggregate status preserves every unhealthy window and uses independent monotonic revisions', () => {
  const { registry, renderers, statuses } = fixture()
  registry.openWindow(1)
  registry.openWindow(2)
  const a = renderers.get(1)!,
    b = renderers.get(2)!
  a.emit({ state: 'lost', generation: 50 })
  b.emit({ state: 'restoring', generation: 1 })
  assert.equal(statuses.at(-1)!.state, 'lost')
  b.emit({ state: 'ready', generation: 2 })
  assert.equal(statuses.at(-1)!.state, 'lost')
  a.emit({ state: 'failed', generation: 50, message: 'texture allocation' })
  b.emit({ state: 'ready', generation: 3 })
  assert.equal(statuses.at(-1)!.state, 'failed')
  assert.match(statuses.at(-1)!.message!, /Window 1: texture allocation/)
  const count = statuses.length
  b.emit({ generation: 3, state: 'ready' })
  assert.equal(statuses.length, count)
  b.emit({ state: 'restoring', generation: 3 })
  registry.closeWindow(1)
  assert.equal(statuses.at(-1)!.state, 'restoring')
  b.emit({ state: 'ready', generation: 4 })
  assert.equal(statuses.at(-1)!.state, 'ready')
  assert.equal(statuses.at(-1)!.message, undefined)
  for (let i = 1; i < statuses.length; i++)
    assert.equal(statuses[i]!.generation, statuses[i - 1]!.generation + 1)
  registry.dispose()
})

test('a restoring window can present even while another window remains lost', () => {
  const { registry, renderers, statuses } = fixture()
  registry.openWindow(1)
  registry.openWindow(2)
  renderers.get(1)!.emit({ state: 'lost', generation: 1 })
  const b = renderers.get(2)!
  b.emit({ state: 'restoring', generation: 1 })
  b.onPresent = () => b.emit({ state: 'ready', generation: 2 })
  assert.equal(registry.present([], 10, 20, 1), false)
  assert.equal(registry.present([], 30, 40, 2), true)
  assert.equal(registry.getStatus(2)!.state, 'ready')
  assert.equal(statuses.at(-1)!.state, 'lost')
  registry.dispose()
})

test('only initial pending surfaces are exempt from execution blocking in aggregate graphics status', () => {
  const { registry, renderers, statuses } = fixture()
  try {
    registry.openWindow(1)
    registry.openWindow(2)
    registry.openWindow(3)
    const a = renderers.get(1)!,
      b = renderers.get(2)!,
      c = renderers.get(3)!
    b.emit({ state: 'restoring', generation: 0, pending: true })
    assert.equal(statuses.at(-1)!.state, 'restoring')
    assert.equal(statuses.at(-1)!.pending, true)
    c.emit({ state: 'restoring', generation: 0, pending: true })
    assert.equal(statuses.at(-1)!.pending, true)
    for (const state of ['lost', 'failed', 'restoring'] as const) {
      a.emit({ state, generation: 1 })
      assert.equal(statuses.at(-1)!.state, state)
      assert.equal(statuses.at(-1)!.pending, undefined)
      a.emit({ state: 'ready', generation: 2 })
      assert.equal(statuses.at(-1)!.pending, true)
    }
    b.emit({ state: 'failed', generation: 1, pending: true })
    assert.equal(statuses.at(-1)!.state, 'failed')
    assert.equal(statuses.at(-1)!.pending, undefined)
    b.emit({ state: 'ready', generation: 2 })
    c.emit({ state: 'ready', generation: 1 })
    assert.equal(statuses.at(-1)!.state, 'ready')
    assert.equal(statuses.at(-1)!.pending, undefined)
  } finally {
    registry.dispose()
  }
})

test('ending a pending exemption notifies observers even with unchanged state and backend generation', () => {
  const { registry, renderers, statuses } = fixture()
  try {
    registry.openWindow(1)
    const renderer = renderers.get(1)!
    renderer.emit({ state: 'restoring', generation: 0, pending: true })
    const pending = statuses.at(-1)!
    renderer.emit({ state: 'restoring', generation: 0 })
    assert.equal(statuses.at(-1)!.state, 'restoring')
    assert.equal(statuses.at(-1)!.pending, undefined)
    assert.equal(statuses.at(-1)!.generation, pending.generation + 1)
  } finally {
    registry.dispose()
  }
})

test('inspection and subscription snapshots cannot mutate registered renderer status', () => {
  const { registry, renderers, statuses } = fixture()
  registry.openWindow(1)
  renderers.get(1)!.emit({ state: 'lost', generation: 1 })
  registry.getStatus(1)!.state = 'ready'
  registry.getStatuses().get(1)!.generation = 999
  statuses.at(-1)!.state = 'ready'
  assert.deepEqual(registry.getStatus(1), { state: 'lost', generation: 1 })
  let immediate: RendererStatus | undefined
  const unsubscribe = registry.subscribe((status) => {
    immediate = status
  })
  assert.equal(immediate!.state, 'lost')
  unsubscribe()
  registry.closeWindow(1)
  assert.equal(immediate!.state, 'lost')
  assert.equal(registry.getStatus(1), undefined)
  registry.dispose()
})

test('late backend status callbacks cannot revive closed windows or disposed registries', () => {
  const { registry, renderers, statuses } = fixture()
  registry.openWindow(1)
  registry.openWindow(2)
  const a = renderers.get(1)!,
    b = renderers.get(2)!
  a.emit({ state: 'lost', generation: 1 })
  registry.closeWindow(1)
  let count = statuses.length
  a.historical[0]!({ state: 'failed', generation: 2, message: 'late' })
  assert.equal(statuses.length, count)
  assert.equal(statuses.at(-1)!.state, 'ready')
  registry.dispose()
  count = statuses.length
  b.historical[0]!({ state: 'lost', generation: 1 })
  let disposedNotifications = 0
  registry.subscribe(() => {
    disposedNotifications++
  })
  registry.retry()
  registry.closeWindow(2)
  assert.equal(statuses.length, count)
  assert.equal(disposedNotifications, 0)
  assert.equal(b.disposals, 1)
  assert.equal(b.unsubscribes, 1)
})

test('factory failure releases its reserved budget and permanently retires that ID', () => {
  const failure = new Error('factory failed')
  let calls = 0
  const renderer = new FakeRenderer()
  const registry = new WindowRendererRegistry(
    () => {
      if (++calls === 1) throw failure
      return renderer
    },
    { maxWindows: 1 },
  )
  assert.throws(
    () => registry.openWindow(1),
    (error) => error === failure,
  )
  assert.equal(registry.getStatuses().size, 0)
  assert.throws(() => registry.openWindow(1), /retired/)
  registry.openWindow(2)
  assert.equal(calls, 2)
  assert.equal(registry.present([], 10, 20, 2), true)
  registry.dispose()
})

test('subscription failure disposes the returned renderer and ignores its retained callback', () => {
  const renderer = new FakeRenderer(),
    failure = new Error('subscription failed')
  renderer.onSubscribe = () => {
    throw failure
  }
  const registry = new WindowRendererRegistry(() => renderer)
  const statuses: RendererStatus[] = []
  registry.subscribe((status) => statuses.push(status))
  assert.throws(
    () => registry.openWindow(1),
    (error) => error === failure,
  )
  assert.equal(renderer.disposals, 1)
  assert.equal(renderer.listeners.size, 0)
  assert.equal(registry.getStatuses().size, 0)
  renderer.historical[0]!({ state: 'lost', generation: 1 })
  assert.deepEqual(statuses, [{ state: 'ready', generation: 0 }])
  registry.dispose()
  assert.equal(renderer.disposals, 1)
})

test('window budgets reserve capacity during factories without consuming rejected IDs', () => {
  for (const maxWindows of [0, -1, 0.5, NaN, Infinity])
    assert.throws(
      () => new WindowRendererRegistry(() => new FakeRenderer(), { maxWindows }),
      /budget/,
    )
  const created: number[] = []
  const registry = new WindowRendererRegistry(
    (id) => {
      created.push(id)
      if (id === 1) assert.throws(() => registry.openWindow(2), /budget/)
      return new FakeRenderer()
    },
    { maxWindows: 1 },
  )
  registry.openWindow(1)
  registry.openWindow(1)
  assert.throws(() => registry.openWindow(2), /budget/)
  registry.closeWindow(1)
  registry.openWindow(2)
  assert.deepEqual(created, [1, 2])
  registry.dispose()
})

test('a renderer instance cannot be shared between windows or reused after disposal', () => {
  const renderer = new FakeRenderer()
  const registry = new WindowRendererRegistry(() => renderer)
  registry.openWindow(1)
  assert.throws(() => registry.openWindow(2), /fresh renderer/)
  assert.equal(renderer.disposals, 0)
  assert.equal(registry.present([], 10, 20, 1), true)
  registry.closeWindow(1)
  assert.throws(() => registry.openWindow(3), /fresh renderer/)
  assert.equal(renderer.disposals, 1)
  registry.dispose()
})

for (const action of ['close', 'dispose'] as const) {
  test(`a factory that reenters ${action} cannot install its returned renderer`, () => {
    const renderer = new FakeRenderer()
    const registry = new WindowRendererRegistry((id) => {
      if (action === 'close') registry.closeWindow(id)
      else registry.dispose()
      return renderer
    })
    registry.openWindow(1)
    assert.equal(renderer.disposals, 1)
    assert.equal(renderer.historical.length, 0)
    assert.equal(registry.getStatuses().size, 0)
    assert.equal(registry.present([], 10, 20, 1), false)
    registry.dispose()
    assert.equal(renderer.disposals, 1)
  })

  test(`a subscription that reenters ${action} still releases its returned unsubscribe`, () => {
    const renderer = new FakeRenderer()
    const registry = new WindowRendererRegistry(() => renderer)
    renderer.onSubscribe = () => {
      if (action === 'close') registry.closeWindow(1)
      else registry.dispose()
    }
    registry.openWindow(1)
    assert.equal(renderer.disposals, 1)
    assert.equal(renderer.unsubscribes, 1)
    assert.equal(registry.getStatuses().size, 0)
    registry.dispose()
    assert.equal(renderer.disposals, 1)
  })
}

test('a throwing observer is reported without rolling back construction or starving later observers', () => {
  const renderer = new FakeRenderer(),
    failure = new Error('observer failed')
  const errors: unknown[] = []
  const registry = new WindowRendererRegistry(() => renderer, {
    onObserverError(error) {
      errors.push(error)
      throw new Error('diagnostic failed')
    },
  })
  const unsubscribe = registry.subscribe((status) => {
    if (status.generation > 0) throw failure
  })
  const received: RendererStatus[] = []
  registry.subscribe((status) => received.push(status))
  registry.openWindow(1)
  assert.deepEqual(errors, [failure])
  assert.equal(received.length, 2)
  assert.equal(renderer.disposals, 0)
  assert.equal(registry.getStatus(1)!.state, 'ready')
  assert.equal(registry.present([], 10, 20, 1), true)
  renderer.emit({ state: 'lost', generation: 1 })
  assert.deepEqual(errors, [failure, failure])
  assert.equal(received.at(-1)!.state, 'lost')
  unsubscribe()
  registry.closeWindow(1)
  assert.equal(renderer.disposals, 1)
  registry.dispose()
})

test('observer errors during successful draw and retry never become backend failures', () => {
  const renderer = new FakeRenderer()
  renderer.status = { state: 'restoring', generation: 0 }
  const errors: unknown[] = []
  const registry = new WindowRendererRegistry(() => renderer, {
    onObserverError: (error) => errors.push(error),
  })
  registry.openWindow(1)
  let throwInObserver = false
  registry.subscribe(() => {
    if (throwInObserver) throw new Error('observer failed')
  })
  throwInObserver = true
  renderer.onPresent = () => renderer.emit({ state: 'ready', generation: 1 })
  assert.equal(registry.present([], 10, 20, 1), true)
  assert.equal(registry.getStatus(1)!.state, 'ready')
  renderer.emit({ state: 'lost', generation: 1 })
  renderer.onRetry = () => renderer.emit({ state: 'restoring', generation: 1 })
  registry.retry()
  assert.equal(registry.getStatus(1)!.state, 'restoring')
  assert.equal(errors.length, 3)
  registry.dispose()
})

test('unsubscribe failure still disposes a closed renderer and preserves other windows', () => {
  const { registry, renderers, statuses } = fixture()
  registry.openWindow(1)
  registry.openWindow(2)
  const a = renderers.get(1)!,
    b = renderers.get(2)!,
    failure = new Error('unsubscribe failed')
  a.emit({ state: 'lost', generation: 1 })
  a.onUnsubscribe = () => {
    throw failure
  }
  assert.throws(
    () => registry.closeWindow(1),
    (error) => error === failure,
  )
  assert.equal(a.disposals, 1)
  assert.equal(a.unsubscribes, 1)
  assert.equal(b.disposals, 0)
  assert.equal(statuses.at(-1)!.state, 'ready')
  assert.equal(registry.present([], 10, 20, 2), true)
  registry.closeWindow(1)
  registry.dispose()
})

test('dispose cleans all windows once even if multiple resource cleanups throw', () => {
  const { registry, renderers } = fixture()
  registry.openWindow(1)
  registry.openWindow(2)
  const a = renderers.get(1)!,
    b = renderers.get(2)!
  a.onUnsubscribe = () => {
    throw new Error('unsubscribe failed')
  }
  a.onDispose = () => {
    throw new Error('first dispose failed')
  }
  b.onDispose = () => {
    throw new Error('second dispose failed')
  }
  assert.throws(() => registry.dispose(), AggregateError)
  assert.equal(registry.getStatuses().size, 0)
  assert.equal(a.unsubscribes, 1)
  assert.equal(b.unsubscribes, 1)
  assert.equal(a.disposals, 1)
  assert.equal(b.disposals, 1)
  registry.dispose()
  assert.equal(a.disposals, 1)
  assert.equal(b.disposals, 1)
})

test('a frame that closes its own window is never acknowledged as presented', () => {
  const { registry, renderers } = fixture()
  registry.openWindow(1)
  renderers.get(1)!.onPresent = () => registry.closeWindow(1)
  assert.equal(registry.present([frame(1, 90)], 10, 20, 1), false)
  assert.equal(renderers.get(1)!.disposals, 1)
  registry.dispose()
})

test('a loss published before present returns keeps that window frame dirty', () => {
  const { registry, renderers } = fixture()
  registry.openWindow(1)
  const renderer = renderers.get(1)!
  renderer.onPresent = () => renderer.emit({ state: 'lost', generation: 1 })
  assert.equal(registry.present([frame(1, 90)], 10, 20, 1), false)
  assert.equal(registry.getStatus(1)!.state, 'lost')
  registry.dispose()
})

test('a throwing presentation marks its own window failed and retains the other window', () => {
  const { registry, renderers, statuses } = fixture()
  registry.openWindow(1)
  registry.openWindow(2)
  renderers.get(1)!.onPresent = () => {
    throw new Error('draw failed')
  }
  assert.equal(registry.present([], 10, 20, 1), false)
  assert.equal(registry.getStatus(1)!.state, 'failed')
  assert.match(statuses.at(-1)!.message!, /Window 1: draw failed/)
  assert.equal(registry.present([], 30, 40, 2), true)
  assert.equal(registry.getStatus(2)!.state, 'ready')
  registry.dispose()
})

test('retry selects unhealthy windows and skips any retired by an earlier retry callback', () => {
  const { registry, renderers } = fixture()
  for (const id of [1, 2, 3]) registry.openWindow(id)
  const a = renderers.get(1)!,
    b = renderers.get(2)!,
    c = renderers.get(3)!
  a.emit({ state: 'lost', generation: 1 })
  b.emit({ state: 'failed', generation: 1 })
  registry.retry(0)
  registry.retry(2)
  assert.equal(a.retries, 0)
  assert.equal(b.retries, 1)
  a.onRetry = () => registry.closeWindow(2)
  registry.retry()
  assert.equal(a.retries, 1)
  assert.equal(b.retries, 1)
  assert.equal(c.retries, 0)
  registry.dispose()
})

test('retry failure is reported without skipping another window recovery', () => {
  const { registry, renderers } = fixture()
  registry.openWindow(1)
  registry.openWindow(2)
  const a = renderers.get(1)!,
    b = renderers.get(2)!,
    failure = new Error('retry failed')
  a.emit({ state: 'lost', generation: 1 })
  b.emit({ state: 'lost', generation: 1 })
  a.onRetry = () => {
    throw failure
  }
  b.onRetry = () => b.emit({ state: 'restoring', generation: 1 })
  assert.throws(
    () => registry.retry(),
    (error) => error === failure,
  )
  assert.equal(a.retries, 1)
  assert.equal(b.retries, 1)
  assert.equal(registry.getStatus(1)!.state, 'failed')
  assert.equal(registry.getStatus(2)!.state, 'restoring')
  registry.dispose()
})

test('reentrant status publication cannot deliver a stale fault after recovery', () => {
  const { registry, renderers } = fixture()
  registry.openWindow(1)
  registry.subscribe((status) => {
    if (status.state === 'lost') registry.closeWindow(1)
  })
  const statuses: RendererStatus[] = []
  registry.subscribe((status) => statuses.push(status))
  renderers.get(1)!.emit({ state: 'lost', generation: 1 })
  assert.deepEqual(
    statuses.map((status) => status.state),
    ['ready', 'ready'],
  )
  registry.dispose()
})
