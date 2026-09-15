import test from 'node:test'
import assert from 'node:assert/strict'
import { InputController, type InputOperation } from '../../src/engine/input/controller.ts'
import { InputControllers } from '../../src/engine/input/controllers.ts'
import { InputService } from '../../src/engine/input/service.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import {
  scriptRecord,
  type HostContext,
  type HostReply,
  type ScriptRecord,
  type ScriptObject,
  type ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'

function fixture() {
  const layers = new LayerTree(),
    wa = new WindowState(),
    wb = new WindowState()
  wa.visible = wb.visible = true
  const a = layers.create(0, 101),
    b = layers.create(0, 202)
  layers.get(a).focusable = layers.get(b).focusable = true
  let active = 101
  const controllers = new InputControllers(layers, () => active),
    ca = controllers.create(101, wa),
    cb = controllers.create(202, wb),
    retained: ScriptObject[] = [],
    context: HostContext = {
      retain: (object) => {
        retained.push(object)
        return object
      },
      release: () => {},
      snapshot: () => scriptRecord({}),
    },
    weak = (id: number): ScriptWeakObject => ({ type: 'weak-object', id, runtime: 1 }),
    layer = (id: number) => (layers.has(id) ? weak(1000 + id) : undefined),
    service = new InputService(controllers, context, layer, (id) => (id ? weak(id) : undefined)),
    object = (id: number): ScriptObject => ({ type: 'object', id, runtime: 1 })
  service.host('Input.bind', [object(1), object(2)], context)
  const owners = new Map<string, unknown>()
  const next = (reply: HostReply, unwind = false): ScriptRecord['entries'] => {
    assert.equal(reply.kind, 'invoke')
    if (reply.kind !== 'invoke') throw new Error('Expected an Input operation')
    const result = service.host(unwind ? 'Input.unwind' : 'Input.resume', [reply.args[0]], context)
    assert.equal(result.kind, 'value')
    if (result.kind !== 'value') throw new Error('Expected an Input step')
    const record = result.value as ScriptRecord
    assert.equal(record.type, 'dictionary')
    if (record.entries.ownership === 1n) {
      const key = String(record.entries.key)
      if (record.entries.target) owners.set(key, record.entries.target)
      else owners.delete(key)
    }
    return record.entries
  }
  const drain = (reply: HostReply) => {
    const events: ScriptRecord['entries'][] = []
    if (reply.kind === 'value') return events
    for (let n = 0; n < 500; n++) {
      const step = next(reply)
      if (step.done === 1n) return events
      if (step.ownership === 0n) events.push(step)
    }
    throw new Error('Input operation did not finish')
  }
  const host = (name: string, args: Parameters<InputService['host']>[1]) =>
    service.host(name, args, context)
  return {
    layers,
    a,
    b,
    ca,
    cb,
    controllers,
    service,
    retained,
    owners,
    next,
    drain,
    host,
    active: (id: number) => {
      active = id
    },
  }
}

test('Window input managers keep focus, modal, capture and role ownership independent', () => {
  const f = fixture()
  f.drain(f.host('Input.focus', [BigInt(f.a), 1n, 101n]))
  f.drain(f.host('Input.focus', [BigInt(f.b), 1n, 202n]))
  f.drain(f.host('Input.mode', [BigInt(f.a), 1n]))
  f.drain(f.host('Input.mode', [BigInt(f.b), 1n]))
  for (const windowId of [101, 202])
    f.drain(
      f.service.packet({ type: 'down', windowId, x: 1, y: 1, shift: 8, button: 0, clicks: 0 }),
    )
  assert.deepEqual([f.ca.focused, f.ca.modal, f.ca.capture], [f.a, [f.a], f.a])
  assert.deepEqual([f.cb.focused, f.cb.modal, f.cb.capture], [f.b, [f.b], f.b])
  for (const id of [f.a, f.b])
    for (const role of ['focus', `modal:${id}`, 'capture'])
      assert.equal(f.owners.has(`${id}:${role}`), true, `manager ${id} owns ${role}`)
  // Only the shared pump and its Dictionary are retained by the host service.
  assert.equal(f.retained.length, 2)
})

test('Window registration releases capture everywhere while preserving focus and modal slots', () => {
  const f = fixture()
  for (const id of [f.a, f.b]) f.drain(f.host('Input.mode', [BigInt(id), 1n]))
  for (const windowId of [101, 202])
    f.drain(
      f.service.packet({ type: 'down', windowId, x: 1, y: 1, shift: 8, button: 0, clicks: 0 }),
    )
  f.controllers.releaseCaptures()
  f.drain(f.host('Input.synchronize', []))
  assert.deepEqual([f.ca.focused, f.ca.modal, f.ca.capture], [f.a, [f.a], 0])
  assert.deepEqual([f.cb.focused, f.cb.modal, f.cb.capture], [f.b, [f.b], 0])
  assert.equal(f.owners.has(`${f.a}:capture`), false)
  assert.equal(f.owners.has(`${f.b}:capture`), false)
  assert.equal(f.owners.has(`${f.a}:focus`), true)
  assert.equal(f.owners.has(`${f.b}:focus`), true)
})

test('retiring Window A drains its owners without releasing Window B roles or keys', () => {
  const f = fixture()
  for (const id of [f.a, f.b]) f.drain(f.host('Input.mode', [BigInt(id), 1n]))
  f.cb.observe({ type: 'keyDown', key: 65, shift: 0 })
  f.active(202)
  f.controllers.remove(101)
  assert.equal(f.controllers.get(101), undefined)
  assert.equal(f.controllers.ownershipPending, true)
  f.drain(f.host('Input.synchronize', []))
  assert.equal(f.controllers.ownershipPending, false)
  assert.equal(
    [...f.owners.keys()].some((key) => key.startsWith(`${f.a}:`)),
    false,
  )
  assert.equal(f.owners.has(`${f.b}:focus`), true)
  assert.equal(f.owners.has(`${f.b}:modal:${f.b}`), true)
  assert.deepEqual([f.cb.focused, f.cb.modal, [...f.cb.keys]], [f.b, [f.b], [65]])
  assert.deepEqual(f.service.packet({ type: 'text', windowId: 101, text: 'late' }), {
    kind: 'value',
    value: undefined,
  })
  assert.notEqual(f.controllers.forLayer(f.a), f.cb)
  assert.throws(() => f.host('Input.focus', [0n, 1n, 101n]), /not registered/)
})

test('a suspended Window callback resolves subsequent target zero events to its captured source', () => {
  const f = fixture(),
    operation = f.service.packet({ type: 'text', windowId: 101, text: 'ab' })
  const first = f.next(operation)
  assert.equal((first.target as ScriptWeakObject).id, 101)
  f.active(202)
  const second = f.next(operation)
  assert.equal(second.method, 'onKeyPress')
  assert.equal((second.target as ScriptWeakObject).id, 101)
  assert.equal(f.next(operation).done, 1n)
  assert.equal(f.retained.length, 2)
})

test('retiring the source Window invalidates its suspended packet without rebinding a replacement', () => {
  const f = fixture(),
    operation = f.service.packet({ type: 'text', windowId: 101, text: 'ab' })
  assert.equal((f.next(operation).target as ScriptWeakObject).id, 101)
  f.controllers.remove(101)
  f.active(202)
  const replacement = f.controllers.create(101, new WindowState())
  assert.notEqual(replacement, f.ca)
  assert.deepEqual(f.drain(operation), [])
  assert.equal(f.next(f.service.packet({ type: 'activate', windowId: 202 })).method, 'onActivate')
})

test('Layer input uses its manager Window and explicit Window focus queries ignore active changes', () => {
  const f = fixture()
  f.active(202)
  f.drain(f.host('Input.focus', [BigInt(f.a), 1n]))
  assert.equal(f.ca.focused, f.a)
  assert.equal(f.cb.focused, 0)
  const focused = f.host('Input.get', [0n, 'focusedLayer', 101n])
  assert.equal(focused.kind, 'value')
  if (focused.kind === 'value') assert.equal((focused.value as ScriptWeakObject).id, 1000 + f.a)
  f.drain(f.host('Input.focus', [BigInt(f.b), 1n, 101n]))
  assert.equal(f.ca.focused, f.a, 'another Window cannot become this Window focusedLayer')
  f.drain(f.host('Input.focus', [0n, 1n, 101n]))
  assert.equal(f.ca.focused, 0)
})

test('keyState treats its first argument as a key code even when it collides with a Layer id', () => {
  const f = fixture()
  f.active(202)
  f.cb.observe({ type: 'keyDown', key: f.a, shift: 0 })
  assert.deepEqual(f.host('Input.get', [BigInt(f.a), 'keyState']), { kind: 'value', value: 1n })
  f.controllers.resetTransient()
  assert.deepEqual(f.host('Input.get', [BigInt(f.a), 'keyState']), { kind: 'value', value: 0n })
})

test('detaching an inactive Window primary uses its manager and keeps the active Window focused', () => {
  const f = fixture()
  for (const id of [f.a, f.b]) f.drain(f.host('Input.focus', [BigInt(id), 1n]))
  f.active(202)
  const events = f.drain(f.service.detach(f.a, () => f.layers.destroy(f.a), true))
  assert.equal(
    events.some((event) => event.method === 'onBlur'),
    true,
  )
  assert.equal(f.ca.focused, 0)
  assert.equal(f.cb.focused, f.b)
  assert.equal(f.owners.has(`${f.a}:focus`), false)
  assert.equal(f.owners.has(`${f.b}:focus`), true)
})

test('focusNext uses its Layer manager even when another Window is active', () => {
  const f = fixture(),
    next = f.layers.create(f.a)
  f.layers.get(next).visible = f.layers.get(next).focusable = true
  f.drain(f.host('Input.focus', [BigInt(f.a), 1n]))
  f.active(202)
  f.drain(f.host('Input.moveFocus', [1n, BigInt(f.a)]))
  assert.equal(f.ca.focused, next)
  assert.equal(f.cb.focused, 0)
})

test('epoch invalidation suppresses stale callbacks while preserving cooperative cleanup invokes', () => {
  const f = fixture(),
    callback: ScriptObject = { type: 'object', id: 70, runtime: 1 }
  function* work(): InputOperation {
    try {
      yield { target: 0, method: 'onActivate', args: [] }
      yield { target: 0, method: 'onDeactivate', args: [] }
    } finally {
      yield { kind: 'invoke', callback, args: [], unwind: true }
    }
    return undefined
  }
  const operation = f.service.start(work(), f.ca, 'packet')
  assert.equal(f.next(operation).method, 'onActivate')
  f.ca.clear()
  const cleanup = f.next(operation)
  assert.equal(cleanup.direct, 1n)
  assert.equal(cleanup.target, callback)
  assert.equal(f.next(operation).done, 1n)
})

test('generic rendering generators keep callbacks when input transient state resets', () => {
  const f = fixture()
  function* paint(): InputOperation {
    yield { target: f.a, method: 'onPaint', args: [] }
    yield { target: f.a, method: 'onPaint', args: [] }
    return undefined
  }
  const operation = f.service.start(paint(), f.ca)
  assert.equal(f.next(operation).method, 'onPaint')
  f.ca.resetTransient()
  assert.equal(f.next(operation).method, 'onPaint')
  assert.equal(f.next(operation).done, 1n)
})

test('removal during before-focus cannot restart modal or hover ownership on a retired manager', () => {
  const f = fixture(),
    operation = f.host('Input.mode', [BigInt(f.a), 1n])
  assert.equal(f.next(operation).method, 'onBeforeFocus')
  f.controllers.remove(101)
  f.active(202)
  assert.deepEqual(f.drain(operation), [])
  assert.deepEqual([f.ca.focused, f.ca.modal, f.ca.hover, f.ca.capture], [0, [], 0, 0])
  assert.equal(f.ca.ownershipPending, false)
  assert.equal(f.controllers.ownershipPending, false)
  assert.equal(f.owners.size, 0)
})

test('reset before the first resume cancels queued packet and focus state changes', () => {
  const f = fixture(),
    packet = f.service.packet({
      type: 'down',
      windowId: 101,
      x: 1,
      y: 1,
      shift: 8,
      button: 0,
      clicks: 0,
    }),
    focus = f.host('Input.focus', [BigInt(f.a), 1n])
  f.ca.resetTransient()
  assert.deepEqual(f.drain(packet), [])
  assert.deepEqual(f.drain(focus), [])
  assert.deepEqual([f.ca.focused, f.ca.hover, f.ca.capture], [0, 0, 0])
  assert.equal(f.owners.size, 0)
})

for (const interruptedCallback of ['onBlur', 'onFocus'])
  test(`transient reset during ${interruptedCallback} preserves committed focus ownership`, () => {
    const f = fixture(),
      child = f.layers.create(f.a)
    f.layers.get(child).visible = f.layers.get(child).focusable = true
    f.drain(f.host('Input.focus', [BigInt(f.a), 1n]))
    const operation = f.host('Input.focus', [BigInt(child), 1n])
    assert.equal(f.next(operation).method, 'onBeforeFocus')
    assert.equal(f.next(operation).method, 'onBlur')
    if (interruptedCallback === 'onFocus') assert.equal(f.next(operation).method, 'onFocus')
    assert.equal(f.ca.focused, child, 'focus commits before blur/focus notifications')
    f.ca.resetTransient()
    assert.deepEqual(f.drain(operation), [])
    assert.equal(f.ca.focused, child)
    assert.equal((f.owners.get(`${f.a}:focus`) as ScriptWeakObject).id, 1000 + child)
    f.drain(f.host('Input.focus', [BigInt(f.a), 1n]))
    assert.equal((f.owners.get(`${f.a}:focus`) as ScriptWeakObject).id, 1000 + f.a)
  })

for (const interruptAt of ['ownership', 'search'])
  test(`transient reset during modal removal at ${interruptAt} completes its manager transaction`, () => {
    const f = fixture()
    f.drain(f.host('Input.mode', [BigInt(f.a), 1n]))
    assert.equal(f.owners.has(`${f.a}:modal:${f.a}`), true)
    const operation = f.host('Input.mode', [BigInt(f.a), 0n]),
      drop = f.next(operation)
    assert.equal(drop.ownership, 1n)
    assert.equal(drop.key, `${f.a}:modal:${f.a}`)
    assert.equal(drop.target, null)
    if (interruptAt === 'search') assert.equal(f.next(operation).method, 'onSearchNextFocusable')
    f.ca.resetTransient()
    f.drain(operation)
    assert.deepEqual(f.ca.modal, [])
    assert.equal(f.owners.has(`${f.a}:modal:${f.a}`), false)
    assert.equal((f.owners.get(`${f.a}:focus`) as ScriptWeakObject).id, 1000 + f.a)
  })

test('a structural change finishes its action but cannot reacquire hover after Window removal', () => {
  const f = fixture()
  f.ca.point = { x: 1, y: 1 }
  let changed = 0
  const operation = f.service.change(() => changed++, f.ca)
  let reachedEnter = false
  for (let n = 0; n < 20; n++) {
    const step = f.next(operation)
    assert.notEqual(step.done, 1n)
    if (step.method === 'onMouseEnter') {
      reachedEnter = true
      break
    }
  }
  assert.equal(reachedEnter, true)
  f.controllers.remove(101)
  f.active(202)
  assert.deepEqual(f.drain(operation), [])
  assert.equal(changed, 1)
  assert.deepEqual([f.ca.focused, f.ca.modal, f.ca.hover, f.ca.capture], [0, [], 0, 0])
  assert.equal(f.ca.ownershipPending, false)
  assert.equal(f.owners.size, 0)
})

test('pre-Window and legacy single-controller adapters expose independent safe input state', () => {
  const layers = new LayerTree(),
    controllers = new InputControllers(layers, () => 999)
  assert.equal(controllers.active.root(), 0)
  assert.equal(controllers.active.sourceWindowId, 0)
  assert.deepEqual(controllers.values(), [])
  const window = new WindowState(),
    controller = new InputController(
      layers,
      () => window,
      () => 101,
    ),
    legacy = InputControllers.single(controller)
  assert.equal(legacy.active, controller)
  assert.equal(legacy.forLayer(777), controller)
})
