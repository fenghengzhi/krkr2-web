import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserWindowSurfaces } from '../../src/player/window-surfaces.ts'
import { WorkerWindowSurfaces } from '../../src/workers/window-surfaces.ts'
import type { FrameLayer, Renderer, RendererStatus } from '../../src/engine/ports/graphics.ts'
import type {
  WindowSurfaceIdentity,
  WindowSurfaceReply,
  WindowSurfaceRequest,
} from '../../src/protocol/surfaces.ts'

type SurfaceMessage = WindowSurfaceRequest | WindowSurfaceReply

class FakePort {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()
  readonly posted: { message: SurfaceMessage; transfer?: Transferable[] }[] = []
  started = 0
  closed = 0
  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    assert.equal(type, 'message')
    this.listeners.add(listener)
  }
  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    assert.equal(type, 'message')
    this.listeners.delete(listener)
  }
  start(): void {
    this.started++
  }
  close(): void {
    this.closed++
  }
  postMessage(message: SurfaceMessage, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer })
  }
  receive(data: unknown): void {
    for (const listener of [...this.listeners]) listener({ data } as MessageEvent<unknown>)
  }
  get port(): MessagePort {
    return this as unknown as MessagePort
  }
}

function canvas() {
  const offscreen = {} as OffscreenCanvas
  const state = { transfers: 0, error: undefined as Error | undefined }
  return {
    offscreen,
    state,
    element: {
      transferControlToOffscreen() {
        state.transfers++
        if (state.error) throw state.error
        return offscreen
      },
    } as HTMLCanvasElement,
  }
}

const identity = (windowId = 1, surfaceEpoch = 1, generation = 7): WindowSurfaceIdentity => ({
  generation,
  windowId,
  surfaceEpoch,
})
const request = (windowId = 1, surfaceEpoch = 1, generation = 7): WindowSurfaceRequest => ({
  type: 'request',
  ...identity(windowId, surfaceEpoch, generation),
})
const attach = (windowId = 1, surfaceEpoch = 1, generation = 7): WindowSurfaceReply => ({
  type: 'attach',
  ...identity(windowId, surfaceEpoch, generation),
  canvas: {} as OffscreenCanvas,
})

class FakeRenderer implements Renderer {
  readonly frames: { layers: FrameLayer[]; width: number; height: number; windowId?: number }[] = []
  readonly listeners = new Set<(status: RendererStatus) => void>()
  status: RendererStatus = { state: 'restoring', generation: 0 }
  disposals = 0
  retries = 0
  autoReady = true
  present(layers: FrameLayer[], width: number, height: number, windowId?: number): boolean {
    this.frames.push({ layers, width, height, windowId })
    if (this.autoReady && this.status.state === 'restoring') this.publish('ready')
    return this.status.state === 'ready'
  }
  subscribe(listener: (status: RendererStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => {
      this.listeners.delete(listener)
    }
  }
  publish(state: RendererStatus['state'], message?: string): void {
    this.status = { state, generation: this.status.generation + 1, ...(message ? { message } : {}) }
    for (const listener of [...this.listeners]) listener(this.status)
  }
  retry(): void {
    this.retries++
    this.publish('restoring')
  }
  dispose(): void {
    this.disposals++
    this.listeners.clear()
  }
}

test('surface host transfers once and ignores old generations, duplicate requests and retired epochs', () => {
  const port = new FakePort(),
    first = canvas(),
    second = canvas(),
    attached: number[][] = [],
    cleanup: string[] = []
  const surfaces = new BrowserWindowSurfaces(
    port.port,
    7,
    {
      attach(id, epoch) {
        attached.push([id, epoch])
        return epoch === 1 ? first.element : second.element
      },
      detach(id, epoch) {
        cleanup.push(`dom:${id}:${epoch}`)
      },
    },
    { onDetach: (_canvas, id) => cleanup.push(`input:${id.windowId}:${id.surfaceEpoch}`) },
  )
  try {
    port.receive(request(1, 1, 6))
    port.receive({ ...request(), windowId: NaN })
    assert.equal(port.posted.length, 0)
    port.receive(request())
    port.receive(request())
    assert.equal(first.state.transfers, 1)
    assert.deepEqual(port.posted, [
      {
        message: { type: 'attach', ...identity(), canvas: first.offscreen },
        transfer: [first.offscreen],
      },
    ])
    assert.deepEqual(surfaces.get(1), { canvas: first.element, identity: identity() })
    port.receive({ type: 'detach', ...identity(1, 2) })
    port.receive(request(1, 1))
    port.receive(request(1, 2))
    assert.deepEqual(cleanup, ['input:1:1', 'dom:1:1'])
    assert.equal(surfaces.get(1), undefined)
    port.receive(request(1, 3))
    port.receive({ type: 'detach', ...identity(1, 1) })
    assert.deepEqual(attached, [
      [1, 1],
      [1, 3],
    ])
    assert.deepEqual(surfaces.get(1)?.identity, identity(1, 3))
  } finally {
    surfaces.dispose()
  }
  assert.equal(port.started, 1)
  assert.equal(port.closed, 1)
  assert.equal(port.listeners.size, 0)
  assert.deepEqual(cleanup, ['input:1:1', 'dom:1:1', 'input:1:3', 'dom:1:3'])
})

test('surface host reports setup failures and refuses a reused canvas on a fresh epoch', () => {
  const port = new FakePort(),
    surface = canvas(),
    cleanup: number[] = []
  const surfaces = new BrowserWindowSurfaces(port.port, 7, {
    attach: () => surface.element,
    detach: (_id, epoch) => cleanup.push(epoch),
  })
  try {
    port.receive(request())
    port.receive(request(1, 2))
    assert.equal(surface.state.transfers, 1)
    assert.equal(port.posted[1]!.message.type, 'failed')
    assert.match(
      (port.posted[1]!.message as Extract<WindowSurfaceReply, { type: 'failed' }>).message,
      /more than once/,
    )
    assert.deepEqual(cleanup, [1, 2])
    assert.equal(surfaces.get(1), undefined)
  } finally {
    surfaces.dispose()
  }
})

for (const failure of ['missing', 'transfer', 'input'] as const)
  test(`surface ${failure} setup failure cleans the DOM and reports its exact identity`, () => {
    const port = new FakePort(),
      surface = canvas(),
      cleanup: string[] = []
    if (failure === 'transfer') surface.state.error = new Error('No offscreen support')
    const surfaces = new BrowserWindowSurfaces(
      port.port,
      7,
      {
        attach: () => (failure === 'missing' ? undefined : surface.element),
        detach: () => cleanup.push('dom'),
      },
      {
        onAttach() {
          if (failure === 'input') throw new Error('Input setup failed')
        },
        onDetach: () => cleanup.push('input'),
      },
    )
    try {
      port.receive(request())
      assert.equal(surfaces.get(1), undefined)
      assert.deepEqual(cleanup, failure === 'missing' ? ['dom'] : ['input', 'dom'])
      const reply = port.posted[0]!.message
      assert.equal(reply.type, 'failed')
      assert.deepEqual([reply.generation, reply.windowId, reply.surfaceEpoch], [7, 1, 1])
    } finally {
      surfaces.dispose()
    }
  })

test('surface disposal releases other windows and closes its port after an input cleanup error', () => {
  const port = new FakePort(),
    removed: number[] = []
  const surfaces = new BrowserWindowSurfaces(
    port.port,
    7,
    { attach: () => canvas().element, detach: (id) => removed.push(id) },
    {
      onDetach: (_canvas, id) => {
        if (id.windowId === 1) throw new Error('cleanup failed')
      },
    },
  )
  port.receive(request())
  port.receive(request(2))
  assert.throws(() => surfaces.dispose(), /cleanup failed/)
  assert.deepEqual(removed, [1, 2])
  assert.equal(port.closed, 1)
  assert.equal(port.listeners.size, 0)
  port.receive(request(3))
  assert.equal(port.posted.length, 2)
  surfaces.dispose()
  assert.equal(port.closed, 1)
})

test('disposal from the page attachment callback removes the DOM before any canvas transfer', () => {
  const port = new FakePort(),
    surface = canvas(),
    cleanup: string[] = []
  const surfaces = new BrowserWindowSurfaces(
    port.port,
    7,
    { attach: () => surface.element, detach: () => cleanup.push('dom') },
    {
      onAttach: () => surfaces.dispose(),
      onDetach: () => cleanup.push('input'),
    },
  )
  port.receive(request())
  assert.deepEqual(cleanup, ['input', 'dom'])
  assert.equal(surface.state.transfers, 0)
  assert.equal(port.posted.length, 0)
  assert.equal(surfaces.get(1), undefined)
})

for (const nested of ['request', 'same-epoch-detach', 'newer-detach'] as const)
  test(`a nested ${nested} during page cleanup supersedes the outer attachment operation`, () => {
    const port = new FakePort(),
      attached: number[] = [],
      detached: number[] = []
    const surfaces = new BrowserWindowSurfaces(
      port.port,
      7,
      {
        attach(_id, epoch) {
          attached.push(epoch)
          return canvas().element
        },
        detach: (_id, epoch) => detached.push(epoch),
      },
      {
        onDetach(_canvas, id) {
          if (id.surfaceEpoch !== 1) return
          port.receive(
            nested === 'request'
              ? request(1, 3)
              : {
                  type: 'detach',
                  ...identity(1, nested === 'same-epoch-detach' ? 2 : 3),
                },
          )
        },
      },
    )
    try {
      port.receive(request())
      port.receive(request(1, 2))
      assert.deepEqual(attached, nested === 'request' ? [1, 3] : [1])
      assert.deepEqual(detached, [1])
      assert.equal(surfaces.get(1)?.identity.surfaceEpoch, nested === 'request' ? 3 : undefined)
      assert.deepEqual(
        port.posted.map(({ message }) => message.surfaceEpoch),
        nested === 'request' ? [1, 3] : [1],
      )
    } finally {
      surfaces.dispose()
    }
  })

test('worker surfaces buffer the latest frame and reject stale, duplicate and closed attachments', () => {
  const port = new FakePort(),
    backends: FakeRenderer[] = [],
    worker = new WorkerWindowSurfaces(port.port, 7, {
      createRenderer() {
        const backend = new FakeRenderer()
        backends.push(backend)
        return backend
      },
    })
  try {
    worker.openWindow(1)
    assert.equal(worker.getStatus(1)?.state, 'restoring')
    assert.equal(worker.present([], 20, 30, 1), false)
    assert.equal(worker.present([], 40, 50, 1), false)
    port.receive(attach(1, 1, 6))
    port.receive(attach(1, 2))
    port.receive(attach(2))
    assert.equal(backends.length, 0)
    port.receive(attach())
    assert.equal(worker.getStatus(1)?.state, 'ready')
    assert.ok(backends[0]!.frames.length > 0)
    assert.ok(
      backends[0]!.frames.every(
        (frame) => frame.width === 40 && frame.height === 50 && frame.windowId === 1,
      ),
    )
    port.receive(attach())
    assert.equal(backends.length, 1)
    worker.closeWindow(1)
    port.receive(attach())
    assert.equal(backends[0]!.disposals, 1)
    assert.equal(worker.present([], 1, 1, 1), false)
    assert.throws(() => worker.openWindow(1), /retired/)
    worker.openWindow(2)
    worker.closeWindow(2)
    port.receive(attach(2))
    assert.equal(backends.length, 1)
    assert.deepEqual(
      port.posted.map(({ message }) => [message.type, message.windowId, message.surfaceEpoch]),
      [
        ['request', 1, 1],
        ['detach', 1, 1],
        ['request', 2, 1],
        ['detach', 2, 1],
      ],
    )
  } finally {
    worker.dispose()
  }
  assert.equal(port.closed, 1)
  assert.equal(port.listeners.size, 0)
})

test('surface attachment bootstraps an awaiting VM without requiring a frame from its serial queue', () => {
  const port = new FakePort(),
    backend = new FakeRenderer(),
    statuses: string[] = [],
    worker = new WorkerWindowSurfaces(port.port, 7, { createRenderer: () => backend })
  worker.subscribe((status) => statuses.push(status.state))
  try {
    worker.openWindow(1)
    port.receive(attach())
    assert.equal(statuses.at(-1), 'ready')
    assert.deepEqual(backend.frames[0], { layers: [], width: 1, height: 1, windowId: 1 })
    assert.ok(statuses.includes('restoring'))
  } finally {
    worker.dispose()
  }
})

test('opening another pending surface never reports a blocking graphics state before its first frame', () => {
  const port = new FakePort(),
    backends = new Map<number, FakeRenderer>(),
    statuses: RendererStatus[] = []
  const worker = new WorkerWindowSurfaces(port.port, 7, {
    createRenderer(_canvas, id) {
      const renderer = new FakeRenderer()
      backends.set(id.windowId, renderer)
      return renderer
    },
  })
  worker.subscribe((status) => statuses.push(status))
  try {
    worker.openWindow(1)
    port.receive(attach())
    const before = statuses.length
    worker.openWindow(2)
    assert.equal(worker.getStatus(2)?.state, 'restoring')
    assert.equal(worker.getStatus(2)?.pending, true)
    assert.equal(worker.present([], 20, 30, 2), false)
    port.receive(attach(2))
    assert.equal(worker.getStatus(2)?.state, 'ready')
    assert.equal(worker.getStatus(2)?.pending, undefined)
    assert.ok(statuses.slice(before).some((status) => status.pending))
    assert.ok(
      statuses
        .slice(before)
        .every(
          (status) =>
            status.state === 'ready' || (status.state === 'restoring' && status.pending === true),
        ),
    )
    backends.get(2)!.publish('lost')
    assert.equal(statuses.at(-1)?.state, 'lost')
    assert.equal(statuses.at(-1)?.pending, undefined)
    const recovery = statuses.length
    backends.get(2)!.publish('restoring')
    assert.equal(statuses.at(-1)?.state, 'ready')
    assert.ok(
      statuses
        .slice(recovery)
        .some((status) => status.state === 'restoring' && status.pending !== true),
    )
  } finally {
    worker.dispose()
  }
})

test('an initial GPU loss revokes the pending exemption before any frame succeeds', () => {
  const port = new FakePort(),
    backend = new FakeRenderer(),
    worker = new WorkerWindowSurfaces(port.port, 7, { createRenderer: () => backend })
  backend.autoReady = false
  try {
    worker.openWindow(1)
    port.receive(attach())
    assert.equal(worker.getStatus(1)?.pending, true)
    backend.publish('lost')
    assert.equal(worker.getStatus(1)?.pending, undefined)
    backend.publish('restoring')
    assert.equal(worker.getStatus(1)?.state, 'restoring')
    assert.equal(worker.getStatus(1)?.pending, undefined)
    backend.autoReady = true
    worker.present([], 3, 4, 1)
    assert.equal(worker.getStatus(1)?.state, 'ready')
  } finally {
    worker.dispose()
  }
})

for (const result of [true, undefined] as const)
  test(`a successful ${String(result)} present ends pending even before the backend reports ready`, () => {
    const port = new FakePort(),
      statuses: RendererStatus[] = []
    let emit: ((status: RendererStatus) => void) | undefined
    const worker = new WorkerWindowSurfaces(port.port, 7, {
      createRenderer: () => ({
        present: () => result,
        subscribe(listener) {
          emit = listener
          listener({ state: 'restoring', generation: 0 })
          return () => {
            emit = undefined
          }
        },
        dispose() {},
      }),
    })
    worker.subscribe((status) => statuses.push(status))
    try {
      worker.openWindow(1)
      assert.equal(statuses.at(-1)?.pending, true)
      port.receive(attach())
      assert.equal(statuses.at(-1)?.state, 'restoring')
      assert.equal(statuses.at(-1)?.pending, undefined)
      assert.equal(worker.getStatus(1)?.pending, undefined)
      emit!({ state: 'restoring', generation: 1 })
      assert.equal(worker.getStatus(1)?.pending, undefined)
      emit!({ state: 'ready', generation: 2 })
      assert.equal(statuses.at(-1)?.state, 'ready')
    } finally {
      worker.dispose()
    }
  })

for (const failure of ['host', 'factory'] as const)
  test(`worker retries a ${failure} failure with a new epoch and never adopts the old canvas`, () => {
    const port = new FakePort(),
      backend = new FakeRenderer()
    let factories = 0
    const worker = new WorkerWindowSurfaces(port.port, 7, {
      createRenderer() {
        factories++
        if (failure === 'factory' && factories === 1) throw new Error('GPU creation failed')
        return backend
      },
    })
    try {
      worker.openWindow(1)
      port.receive(
        failure === 'host' ? { type: 'failed', ...identity(), message: 'DOM failed' } : attach(),
      )
      assert.equal(worker.getStatus(1)?.state, 'failed')
      assert.equal(worker.getStatus(1)?.pending, undefined)
      worker.retry(1)
      assert.equal(worker.getStatus(1)?.state, 'restoring')
      assert.equal(worker.getStatus(1)?.pending, undefined)
      assert.deepEqual(
        port.posted.map(({ message }) => [message.type, message.surfaceEpoch]),
        [
          ['request', 1],
          ['detach', 1],
          ['request', 2],
        ],
      )
      const before = factories
      port.receive(attach())
      port.receive({ type: 'failed', ...identity(), message: 'Late failure' })
      assert.equal(factories, before)
      port.receive(attach(1, 2))
      assert.equal(worker.getStatus(1)?.state, 'ready')
      assert.equal(factories, before + 1)
      worker.closeWindow(1)
      worker.retry(1)
      port.receive(attach(1, 2))
      assert.equal(factories, before + 1)
      assert.equal(backend.disposals, 1)
    } finally {
      worker.dispose()
    }
  })

test('context recovery keeps the same surface and one ready Window cannot clear another failure', () => {
  const port = new FakePort(),
    backends = new Map<number, FakeRenderer>(),
    statuses: RendererStatus[] = []
  const worker = new WorkerWindowSurfaces(port.port, 7, {
    createRenderer(_canvas, identity) {
      const backend = new FakeRenderer()
      backends.set(identity.windowId, backend)
      return backend
    },
  })
  worker.subscribe((status) => statuses.push(status))
  try {
    worker.openWindow(1)
    port.receive(attach())
    worker.openWindow(2)
    port.receive(attach(2))
    backends.get(1)!.publish('failed', 'broken A')
    backends.get(2)!.publish('lost')
    backends.get(2)!.publish('restoring')
    assert.equal(worker.getStatus(2)?.state, 'ready')
    assert.equal(statuses.at(-1)?.state, 'failed')
    assert.match(statuses.at(-1)?.message ?? '', /Window 1: broken A/)
    assert.equal(worker.present([], 2, 3, 2), true)
    worker.retry(1)
    assert.equal(backends.get(1)!.retries, 1)
    assert.equal(statuses.at(-1)?.state, 'ready')
    assert.deepEqual(
      port.posted.map(({ message }) => message.type),
      ['request', 'request'],
    )
  } finally {
    worker.dispose()
  }
  assert.deepEqual(
    [...backends.values()].map((backend) => backend.disposals),
    [1, 1],
  )
})

test('disposing during renderer construction releases the new backend and ignores further port replies', () => {
  const port = new FakePort(),
    backend = new FakeRenderer()
  const worker = new WorkerWindowSurfaces(port.port, 7, {
    createRenderer() {
      worker.closeWindow(1)
      return backend
    },
  })
  worker.openWindow(1)
  port.receive(attach())
  assert.equal(backend.disposals, 1)
  assert.equal(backend.frames.length, 0)
  assert.equal(worker.getStatus(1), undefined)
  worker.dispose()
  port.receive(attach())
  assert.equal(backend.disposals, 1)
})

test('a renderer without status subscriptions can retry a failed frame on its existing surface', () => {
  const port = new FakePort(),
    frames: number[][] = []
  let recovered = false,
    disposed = 0
  const worker = new WorkerWindowSurfaces(port.port, 7, {
    createRenderer: () => ({
      present(_layers, width, height) {
        frames.push([width, height])
        if (!recovered) throw new Error('Temporary draw failure')
        return true
      },
      retry: () => {
        recovered = true
      },
      dispose: () => {
        disposed++
      },
    }),
  })
  try {
    worker.openWindow(1)
    worker.present([], 30, 40, 1)
    port.receive(attach())
    assert.equal(worker.getStatus(1)?.state, 'failed')
    worker.retry(1)
    assert.equal(worker.getStatus(1)?.state, 'ready')
    assert.deepEqual(frames, [
      [30, 40],
      [30, 40],
    ])
    assert.equal(port.posted.length, 1)
  } finally {
    worker.dispose()
  }
  assert.equal(disposed, 1)
})

test('worker disposal retains both backend cleanup errors while retiring all surfaces and closing the port', () => {
  const port = new FakePort(),
    disposed: number[] = []
  const worker = new WorkerWindowSurfaces(port.port, 7, {
    createRenderer(_canvas, id) {
      return {
        present: () => true,
        subscribe(listener) {
          listener({ state: 'ready', generation: 1 })
          return () => {
            if (id.windowId === 1) throw new Error('unsubscribe failure')
          }
        },
        dispose() {
          disposed.push(id.windowId)
          if (id.windowId === 1) throw new Error('GPU cleanup failure')
        },
      }
    },
  })
  worker.openWindow(1)
  port.receive(attach())
  worker.openWindow(2)
  port.receive(attach(2))
  assert.throws(
    () => worker.dispose(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(
        error.errors.map((item: Error) => item.message),
        ['unsubscribe failure', 'GPU cleanup failure'],
      )
      return true
    },
  )
  assert.deepEqual(disposed, [1, 2])
  assert.deepEqual(
    port.posted.map(({ message }) => [message.type, message.windowId]),
    [
      ['request', 1],
      ['request', 2],
      ['detach', 1],
      ['detach', 2],
    ],
  )
  assert.equal(port.closed, 1)
  assert.equal(port.listeners.size, 0)
  port.receive(attach(3))
  assert.equal(worker.getStatuses().size, 0)
})
