import test from 'node:test'
import assert from 'node:assert/strict'
import {
  InputController,
  type InputCall,
  type InputOperation,
} from '../../src/engine/input/controller.ts'
import { InputService } from '../../src/engine/input/service.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import type { InputPacket } from '../../src/engine/ports/input.ts'
import {
  scriptRecord,
  type HostContext,
  type ScriptList,
  type ScriptObject,
  type ScriptRecord,
} from '../../src/engine/script/runtime.ts'

function fixture(withLayer = false) {
  const layers = new LayerTree(),
    window = new WindowState(),
    controller = new InputController(layers, () => window)
  window.visible = true
  let child = 0
  if (withLayer) {
    window.zoomNumer = 1
    window.zoomDenom = 2
    const root = layers.create(0)
    child = layers.create(root)
    Object.assign(layers.get(child), {
      left: 10,
      top: 6,
      visible: true,
      focusable: true,
      hitThreshold: 0,
    })
  }
  return { layers, window, controller, child }
}

function drain(operation: InputOperation): InputCall[] {
  const calls: InputCall[] = []
  let next = operation.next()
  while (!next.done) {
    if (next.value.kind !== 'ownership' && next.value.kind !== 'invoke') calls.push(next.value)
    next = operation.next()
  }
  return calls
}

// WindowIntf.cpp 320–381 and 466–476 take tjs_int x/y for these six
// callbacks. The browser's fractional canvas conversion must not leak a real
// TJS value into their arguments, including negative positions during capture.
test('all Window legacy mouse coordinates truncate toward zero at the callback boundary', () => {
  for (const [x, y, expectedX, expectedY] of [
    [15.8125, 20.999, 15, 20],
    [-15.8125, -20.999, -15, -20],
    [-0.8125, 0.75, 0, 0],
  ]) {
    const { controller } = fixture(),
      common = { x: x!, y: y!, button: 2, shift: 16, clicks: 0 },
      packets: InputPacket[] = [
        { type: 'move', ...common },
        { type: 'down', ...common },
        { type: 'up', ...common, shift: 0, clicks: 1 },
        { type: 'up', ...common, shift: 0, clicks: 2 },
        { type: 'wheel', x: x!, y: y!, shift: 3, delta: -120 },
      ],
      calls = packets
        .flatMap((packet) => drain(controller.packet(packet)))
        .filter((call) => call.target === 0)
    assert.deepEqual(
      calls.map((call) => [call.method, call.args]),
      [
        ['onMouseMove', [expectedX, expectedY, 16]],
        ['onMouseDown', [expectedX, expectedY, 2, 16]],
        ['onClick', [expectedX, expectedY]],
        ['onMouseUp', [expectedX, expectedY, 2, 0]],
        ['onDoubleClick', [expectedX, expectedY]],
        ['onMouseUp', [expectedX, expectedY, 2, 0]],
        ['onMouseWheel', [3, -120, expectedX, expectedY]],
      ],
    )
    assert.deepEqual(controller.point, { x, y }, 'physical point keeps its fractional coordinates')
    assert.deepEqual(packets[0], { type: 'move', ...common }, 'the packet itself is not quantized')
  }
})

test('Window argument conversion does not round before zoom, Layer hit tests or capture transforms', () => {
  const { controller, child } = fixture(true),
    down: InputPacket = { type: 'down', x: 10.875, y: 8.875, button: 0, shift: 8, clicks: 0 },
    calls = drain(controller.packet(down))
  assert.deepEqual(
    calls.find((call) => call.target === 0 && call.method === 'onMouseDown')?.args,
    [10, 8, 0, 8],
  )
  assert.deepEqual(
    calls.find((call) => call.target === child && call.method === 'onMouseDown')?.args,
    [11, 11, 0, 8],
  )
  assert.equal(controller.capture, child)
  const moved = drain(controller.packet({ ...down, type: 'move', x: -0.75, y: -1.25 }))
  assert.deepEqual(
    moved.find((call) => call.target === 0 && call.method === 'onMouseMove')?.args,
    [0, -1, 8],
  )
  assert.deepEqual(
    moved.find((call) => call.target === child && call.method === 'onMouseMove')?.args,
    [-12, -9, 8],
  )
  assert.deepEqual(controller.point, { x: -0.75, y: -1.25 })
  const clicked = drain(controller.packet({ ...down, type: 'up', shift: 0, clicks: 1 }))
  assert.deepEqual(
    clicked.find((call) => call.target === 0 && call.method === 'onClick')?.args,
    [10, 8],
  )
  assert.deepEqual(
    clicked.find((call) => call.target === child && call.method === 'onClick')?.args,
    [11, 11],
  )
  controller.focused = child
  const wheel = drain(
    controller.packet({ type: 'wheel', x: 10.875, y: 8.875, shift: 0, delta: 120 }),
  )
  assert.deepEqual(wheel.find((call) => call.target === 0)?.args, [0, 120, 10, 8])
  assert.deepEqual(wheel.find((call) => call.target === child)?.args, [0, 120, 21, 17])
  assert.deepEqual(controller.point, { x: 10.875, y: 8.875 })
})

test('Window and Layer touch coordinates and contact sizes remain real-valued', () => {
  const { controller, child } = fixture(true)
  for (const type of ['touchDown', 'touchMove', 'touchUp'] as const) {
    const calls = drain(
      controller.packet({ type, x: 10.875, y: 8.875, width: 1.25, height: 2.75, id: 7 }),
    )
    assert.deepEqual(calls.find((call) => call.target === 0)?.args, [10.875, 8.875, 1.25, 2.75, 7])
    assert.deepEqual(
      calls.find((call) => call.target === child && call.method !== 'onHitTest')?.args,
      [11.75, 11.75, 2.5, 5.5, 7],
    )
  }
})

test('queued InputService packets expose integer Window mouse variants while retaining touch real variants', () => {
  const { controller } = fixture(),
    object = (id: number): ScriptObject => ({ type: 'object', id, runtime: 1 }),
    context: HostContext = {
      retain: (value) => value,
      release: () => {},
      snapshot: () => scriptRecord({}),
    },
    service = new InputService(
      controller,
      context,
      () => undefined,
      () => object(3),
    )
  service.host('Input.bind', [object(1), object(2)], context)
  const consume = (packet: InputPacket) => {
    const reply = service.packet(packet)
    assert.equal(reply.kind, 'invoke')
    if (reply.kind !== 'invoke') throw new Error('Missing input pump')
    const result = service.host('Input.resume', [reply.args[0]], context)
    assert.equal(result.kind, 'value')
    if (result.kind !== 'value') throw new Error('Missing input callback')
    const record = (result.value as ScriptRecord).entries
    assert.equal(record.window, 1n)
    const end = service.host('Input.resume', [reply.args[0]], context)
    assert.equal(end.kind, 'value')
    if (end.kind !== 'value') throw new Error('Input pump did not complete')
    assert.equal((end.value as ScriptRecord).entries.done, 1n)
    return (record.args as ScriptList).items
  }
  assert.deepEqual(consume({ type: 'wheel', x: -1.875, y: 15.8125, shift: 3, delta: -120 }), [
    3n,
    -120n,
    -1n,
    15n,
  ])
  assert.deepEqual(
    consume({ type: 'touchMove', x: -1.875, y: 15.8125, width: 1.25, height: 2.75, id: 7 }),
    [-1.875, 15.8125, 1.25, 2.75, 7n],
  )
})
