import test from 'node:test'
import assert from 'node:assert/strict'
import type { FrameLayer, Renderer, RendererStatus } from '../../src/engine/ports/graphics.ts'
import { WindowGpuPool } from '../../src/backends/render/webgl2/window-pool.ts'

type Bitmap = ImageBitmap & { frame: number; consumed: boolean; closes: number }
const frame = (id: number): FrameLayer[] => [{ id, revision: id, x: 0, y: 0, width: 1, height: 1,
  pixels: { width: 1, height: 1, data: Uint8Array.of(id, 0, 0, 255) }, opacity: 1,
  clip: { x: 0, y: 0, width: 1, height: 1 }, source: { x: 0, y: 0, width: 1, height: 1 }, type: 1 }]

function fixture() {
  const listeners = new Set<(status: RendererStatus) => void>(), bitmaps: Bitmap[] = []
  let status: RendererStatus = { state: 'restoring', generation: 0 }, latest = 0, disposed = 0, retries = 0,
    failCapture = false, failRetry = false, onDraw: (() => void) | undefined, disposalError: Error | undefined
  const emit = (state: RendererStatus['state']) => {
    status = { state, generation: status.generation + 1 }
    for (const listener of [...listeners]) listener({ ...status })
  }
  const renderer: Renderer = {
    subscribe(listener) { listeners.add(listener); listener({ ...status }); return () => { listeners.delete(listener) } },
    present(layers) {
      if (status.state === 'lost' || status.state === 'failed') return false
      latest = layers[0]?.id ?? 0
      onDraw?.()
      if (status.state === 'restoring') emit('ready')
      return true
    },
    retry() { retries++; emit(failRetry ? 'failed' : 'restoring') },
    dispose() { disposed++; if (disposalError) throw disposalError },
  }
  const scratch = {
    transferToImageBitmap() {
      if (failCapture) throw new Error('capture refused')
      const bitmap = { frame: latest, consumed: false, closes: 0,
        close() { this.closes++ } } as Bitmap
      bitmaps.push(bitmap)
      return bitmap
    },
  } as unknown as OffscreenCanvas
  const pool = new WindowGpuPool(scratch, renderer)
  function output(kind: 'bitmap' | '2d' = 'bitmap') {
    const state = { width: 0, height: 0, frames: [] as number[], fail: false, disposed: false },
      statuses: RendererStatus[] = [],
      context = {
        transferFromImageBitmap(bitmap: Bitmap) {
          if (state.fail) throw new Error('output refused')
          state.frames.push(bitmap.frame)
          bitmap.consumed = true
        },
        drawImage(bitmap: Bitmap) {
          if (state.fail) throw new Error('output refused')
          state.frames.push(bitmap.frame)
        },
      },
      canvas = {
        get width() { return state.width },
        set width(value) { state.width = value; if (!value) state.disposed = true },
        get height() { return state.height },
        set height(value) { state.height = value },
        getContext(type: string) { return type === (kind === 'bitmap' ? 'bitmaprenderer' : '2d') ? context : null },
      } as unknown as OffscreenCanvas,
      adapter = pool.attach(canvas)
    adapter.subscribe!((status) => statuses.push(status))
    return { adapter, state, statuses }
  }
  return { pool, output, emit, bitmaps, disposed: () => disposed,
    retries: () => retries, retryFailure: (value: boolean) => { failRetry = value },
    captureFailure: (value: boolean) => { failCapture = value },
    onDraw: (value: (() => void) | undefined) => { onDraw = value },
    disposalFailure: (value: Error) => { disposalError = value },
    listeners: () => listeners.size }
}

test('one shared GPU commits eight independent Window outputs and retiring one preserves survivors', () => {
  const f = fixture(), outputs = Array.from({ length: 8 }, () => f.output())
  try {
    for (let i = 0; i < outputs.length; i++)
      assert.equal(outputs[i]!.adapter.present(frame(i + 1), 20 + i, 30 + i), true)
    assert.deepEqual(outputs.map((output) => output.state.frames), [[1], [2], [3], [4], [5], [6], [7], [8]])
    assert.deepEqual(outputs.map((output) => [output.state.width, output.state.height]),
      Array.from({ length: 8 }, (_, i) => [20 + i, 30 + i]))
    assert(f.bitmaps.every((bitmap) => bitmap.consumed && bitmap.closes === 0))
    outputs[2]!.adapter.dispose()
    assert.equal(f.disposed(), 0)
    const replacement = f.output()
    assert.equal(replacement.adapter.present(frame(9), 99, 55), true)
    assert.equal(outputs[2]!.adapter.present(frame(10), 1, 1), false)
    assert.deepEqual(outputs[3]!.state.frames, [4], 'Another output retains its committed bitmap')
    assert.equal(outputs[3]!.adapter.present(frame(11), 23, 33), true)
    assert.deepEqual(replacement.state.frames, [9])
  } finally { f.pool.dispose() }
  assert.equal(f.disposed(), 1)
  assert.equal(f.listeners(), 0)
  assert(outputs.every((output) => output.state.disposed))
})

test('shared loss invalidates every output and scratch readiness never acknowledges an uncommitted Window', () => {
  const f = fixture(), outputs = [f.output(), f.output(), f.output()]
  try {
    outputs.forEach((output, i) => output.adapter.present(frame(i + 1), 10, 10))
    f.emit('lost')
    assert(outputs.every((output) => output.statuses.at(-1)!.state === 'lost'))
    assert.equal(outputs[0]!.adapter.present(frame(99), 10, 10), false)
    f.emit('restoring')
    f.onDraw(() => assert(outputs.every((output) => output.statuses.at(-1)!.state === 'restoring')))
    assert.equal(outputs[0]!.adapter.present(frame(4), 10, 10), true)
    f.onDraw(undefined)
    assert.deepEqual(outputs.map((output) => output.statuses.at(-1)!.state), ['ready', 'restoring', 'restoring'])
    assert.deepEqual(outputs[1]!.state.frames, [2])
    assert.equal(outputs[1]!.adapter.present(frame(5), 10, 10), true)
    assert.equal(outputs[2]!.adapter.present(frame(6), 10, 10), true)
    assert(outputs.every((output) => output.statuses.at(-1)!.state === 'ready'))
    assert.deepEqual(outputs.map((output) => output.state.frames), [[1, 4], [2, 5], [3, 6]])
  } finally { f.pool.dispose() }
})

test('restoration subscribers can synchronously replay each surviving output without crossing frames', () => {
  const f = fixture(), outputs = [f.output(), f.output(), f.output()]
  let replay = false
  try {
    outputs.forEach((output, i) => {
      output.adapter.present(frame(i + 1), 10 + i, 20 + i)
      output.adapter.subscribe!((status) => {
        if (replay && status.state === 'restoring') output.adapter.present(frame(i + 1), 10 + i, 20 + i)
      })
    })
    f.emit('lost')
    outputs[1]!.adapter.dispose()
    replay = true
    f.emit('restoring')
    assert.deepEqual(outputs.map((output) => output.state.frames), [[1, 1], [2], [3, 3]])
    assert.equal(outputs[0]!.statuses.at(-1)!.state, 'ready')
    assert.equal(outputs[2]!.statuses.at(-1)!.state, 'ready')
  } finally { f.pool.dispose() }
})

test('2D fallback closes borrowed bitmaps on success and failure, and retry commits before ready', () => {
  const f = fixture(), output = f.output('2d'), other = f.output()
  try {
    assert.equal(output.adapter.present(frame(1), 10, 12), true)
    assert.equal(f.bitmaps[0]!.closes, 1)
    output.state.fail = true
    assert.equal(output.adapter.present(frame(2), 10, 12), false)
    assert.equal(f.bitmaps[1]!.closes, 1)
    assert.equal(output.statuses.at(-1)!.state, 'failed')
    assert.deepEqual(output.state.frames, [1])
    assert.equal(other.adapter.present(frame(3), 15, 16), true)
    output.state.fail = false
    output.adapter.retry!()
    assert.equal(output.statuses.at(-1)!.state, 'restoring')
    assert.equal(output.adapter.present(frame(4), 10, 12), true)
    assert.deepEqual(output.state.frames, [1, 4])
    assert.equal(output.statuses.at(-1)!.state, 'ready')
  } finally { f.pool.dispose() }
})

test('capture and bitmap-output failures stay retryable without losing another Window or leaking images', () => {
  const f = fixture(), first = f.output(), second = f.output()
  try {
    first.adapter.present(frame(1), 10, 10)
    second.adapter.present(frame(2), 20, 20)
    f.captureFailure(true)
    assert.equal(first.adapter.present(frame(3), 10, 10), false)
    assert.equal(first.statuses.at(-1)!.state, 'failed')
    assert.equal(second.statuses.at(-1)!.state, 'ready')
    f.captureFailure(false)
    first.adapter.retry!()
    first.state.fail = true
    assert.equal(first.adapter.present(frame(4), 10, 10), false)
    assert.equal(f.bitmaps.at(-1)!.closes, 1)
    assert.equal(f.bitmaps.at(-1)!.consumed, false)
    first.state.fail = false
    first.adapter.retry!()
    assert.equal(first.adapter.present(frame(5), 10, 10), true)
    assert.deepEqual(first.state.frames, [1, 5])
    assert.deepEqual(second.state.frames, [2])
  } finally { f.pool.dispose() }
})

test('retirement during readiness prevents a successful return and late GPU notifications cannot resurrect outputs', () => {
  const f = fixture(), output = f.output()
  output.adapter.subscribe!((status) => { if (status.state === 'ready') output.adapter.dispose() })
  assert.equal(output.adapter.present(frame(1), 10, 10), false)
  const notices = output.statuses.length
  f.pool.dispose()
  f.emit('restoring')
  assert.equal(output.statuses.length, notices)
  assert.equal(f.listeners(), 0)
  assert.equal(f.disposed(), 1)
  assert.throws(() => f.pool.attach({} as OffscreenCanvas), /disposed/)
  assert.equal(output.adapter.present(frame(2), 10, 10), false)
})

test('pool cleanup remains final and idempotent when the underlying GPU cleanup fails', () => {
  const f = fixture(), output = f.output(), failure = new Error('GPU cleanup refused')
  f.disposalFailure(failure)
  assert.throws(() => f.pool.dispose(), (error) => error === failure)
  assert.equal(output.state.disposed, true)
  assert.equal(f.listeners(), 0)
  assert.equal(f.disposed(), 1)
  f.pool.dispose()
  assert.equal(f.disposed(), 1)
})

test('one registry retry turn rebuilds a failed shared GPU once, and restoring outputs do not rebuild it again', async () => {
  const f = fixture(), first = f.output(), second = f.output()
  try {
    f.emit('failed')
    f.retryFailure(true)
    first.adapter.retry!()
    second.adapter.retry!()
    assert.equal(f.retries(), 1, 'A failed rebuild is not retried once per Window')
    await Promise.resolve()
    f.retryFailure(false)
    first.adapter.retry!()
    second.adapter.retry!()
    assert.equal(f.retries(), 2, 'Restoring is waiting for a frame, not another program allocation')
    assert.equal(first.adapter.present(frame(1), 10, 10), true)
    assert.equal(second.adapter.present(frame(2), 20, 20), true)
    assert.equal(f.retries(), 2)
  } finally { f.pool.dispose() }
})
