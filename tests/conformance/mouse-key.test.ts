import test from 'node:test'
import assert from 'node:assert/strict'
import { MouseKeyState, MouseKeyTicker, type MouseKeyAction } from '../../src/engine/input/mouse-key.ts'

const keys = (...values: number[]) => new Set(values)
const move = (dx: number, dy: number): MouseKeyAction[] => [{ type: 'move', dx, dy }]

test('mouse keys consume direction down only, use a delayed 50 ms cadence and preserve native acceleration', () => {
  const state = new MouseKeyState()
  assert.deepEqual(state.configure(true, 1000), [])
  assert.deepEqual(state.key(true, 39, 1010, keys(39), true), { consumed: true, actions: move(1, 0) })
  assert.deepEqual(state.tick(1110, keys(39)), [])
  assert.deepEqual(state.tick(1154, keys(39)), [])
  assert.deepEqual(state.tick(1155, keys(39)), move(2, 0))
  assert.deepEqual(state.key(false, 39, 1156, keys(), true), { consumed: false, actions: [] })
  assert.deepEqual(state.tick(1205, keys()), [])
  assert.deepEqual(state.key(true, 37, 1210, keys(37), true), { consumed: true, actions: move(-1, 0) })
  assert.equal(state.text(' '), true)
  assert.equal(state.text('\r'), true)
  assert.equal(state.text('\u001b'), true)
  assert.equal(state.text('x'), false)
  assert.equal(state.key(true, 65, 1211, keys(65), true).consumed, false)
})

test('mouse keys preserve sequential opposed directions, Shift speed and negative odd arithmetic shift', () => {
  const state = new MouseKeyState()
  state.configure(true, 1000)
  assert.deepEqual(state.key(true, 37, 1010, keys(37, 16), true).actions, move(-20, 0))
  // Native sets left=-40 then right=+40; left subtracts 2 and right is
  // already above the unshifted maximum, so opposing directions yield +19.
  assert.deepEqual(state.tick(1160, keys(37, 39, 16)), move(19, 0))
  assert.deepEqual(state.tick(1210, keys(37)), move(-1, 0))
  // Horizontal deceleration -2 -> -1 uses arithmetic >> 1, retaining -1.
  assert.deepEqual(state.tick(1260, keys(38)), move(-1, -1))
  assert.deepEqual(state.tick(1310, keys(38)), move(0, -2))
  for (let i = 0; i < 25; i++) state.tick(1360 + 50 * i, keys(38))
  assert.deepEqual(state.tick(2610, keys(38)), move(0, -15))
})

test('mouse button keys repeat downs, click before left up and consume outside keys without clearing obligations', () => {
  const state = new MouseKeyState()
  state.configure(true, 1000)
  const down: MouseKeyAction[] = [{ type: 'down', button: 0, position: 'current' }]
  assert.deepEqual(state.key(true, 13, 1001, keys(13), true).actions, down)
  assert.deepEqual(state.key(true, 13, 1002, keys(13), true).actions, down)
  assert.deepEqual(state.key(false, 32, 1003, keys(), true).actions, [
    { type: 'click', button: 0, position: 'down' }, { type: 'up', button: 0, position: 'current' },
  ])
  assert.deepEqual(state.key(false, 13, 1004, keys(), true).actions, [
    { type: 'click', button: 0, position: 'down' }, { type: 'up', button: 0, position: 'current' },
  ], 'A left release does not require an earlier down')
  state.key(true, 27, 1005, keys(27), true)
  assert.deepEqual(state.key(false, 27, 1006, keys(), false), { consumed: true, actions: [] })
  assert.deepEqual(state.configure(false, 1007), [{ type: 'up', button: 1, position: 'move' }])
  assert.deepEqual(state.configure(false, 1008), [])
  assert.equal(state.text(' '), false)
})

test('PAD directions and first two buttons share the native mouse-key conversion without changing held keys', () => {
  const state = new MouseKeyState(), held = keys(0x1b7, 0x1c0)
  state.configure(true, 1000)
  assert.deepEqual(state.key(true, 0x1b7, 1001, held, true).actions, move(1, 0))
  assert.deepEqual(state.key(true, 0x1c0, 1002, held, true).actions, [{ type: 'down', button: 0, position: 'current' }])
  assert.deepEqual(state.key(true, 0x1c1, 1003, held, true).actions, [{ type: 'down', button: 1, position: 'current' }])
  assert.equal(state.key(true, 0x1c2, 1004, held, true).consumed, false)
  assert.deepEqual([...held], [0x1b7, 0x1c0])
  assert.deepEqual(state.configure(false, 1005), [
    { type: 'up', button: 0, position: 'move' }, { type: 'up', button: 1, position: 'move' },
  ])
})

test('reassigning true resets button flags and delay but not acceleration; a retired lifetime resets all state', () => {
  const state = new MouseKeyState()
  state.configure(true, 1000)
  state.key(true, 39, 1001, keys(39), true)
  state.key(true, 13, 1002, keys(13), true)
  state.configure(true, 1003)
  assert.deepEqual(state.tick(1047, keys(39)), [])
  assert.deepEqual(state.tick(1048, keys(39)), move(2, 0))
  assert.deepEqual(state.configure(false, 1049), [])
  state.reset()
  state.configure(true, 1100)
  assert.deepEqual(state.key(true, 39, 1101, keys(39), true).actions, move(1, 0))
})

test('mouse-key clock never replays missed ticks or allows cancelled callbacks to revive a surface', () => {
  let now = 1000, next = 1
  const pending = new Map<number, () => void>(), ticks: number[] = []
  const ticker = new MouseKeyTicker({
    now: () => now,
    request: (callback) => { const id = next++; pending.set(id, callback); return id },
    cancel: (id) => { pending.delete(id) },
  }, (time) => ticks.push(time))
  const frame = (time: number) => {
    now = time
    const callbacks = [...pending.values()]
    pending.clear()
    for (const callback of callbacks) callback()
  }
  ticker.setActive(true)
  frame(1049)
  assert.equal(ticks.length, 0)
  frame(1050)
  frame(5000)
  assert.deepEqual(ticks, [1050, 5000])
  const stale = [...pending.values()]
  ticker.setActive(false)
  assert.equal(pending.size, 0)
  ticker.setActive(true)
  for (const callback of stale) callback()
  assert.equal(pending.size, 1)
  assert.deepEqual(ticks, [1050, 5000])
  ticker.close()
  for (const callback of stale) callback()
  frame(10000)
  assert.equal(pending.size, 0)
  assert.deepEqual(ticks, [1050, 5000])
})
