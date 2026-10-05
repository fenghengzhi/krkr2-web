import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { GamepadState, type GamepadKeyEvent, type GamepadSnapshot } from '../../src/backends/input/gamepad.ts'

const test = (name: string, run: () => void) => nodeTest(name, { timeout: 60000 }, run)
const left = 0x1b5, right = 0x1b7, up = 0x1b6, down = 0x1b8, button1 = 0x1c0
const press = (key: number, repeat = false): GamepadKeyEvent => ({ type: 'keyDown', key, repeat })
const release = (key: number): GamepadKeyEvent => ({ type: 'keyUp', key, repeat: false })
function pad(index = 0, held: number[] = [], axes: number[] = [0, 0], mapping = 'standard'): GamepadSnapshot {
  return { index, id: `pad-${index}`, connected: true, mapping, axes,
    buttons: Array.from({ length: 18 }, (_, index) => ({ pressed: held.includes(index), value: held.includes(index) ? 1 : 0 })) }
}
function ready(value = pad()): GamepadState {
  const state = new GamepadState()
  assert.deepEqual(state.sample([value], 0, true).keys, [])
  return state
}

test('gamepad initial admission requires each initially held key to be released first', () => {
  const state = new GamepadState()
  let sample = state.sample([pad(0, [0], [-1, 0])], 0, true)
  assert.deepEqual(sample.rawKeys, [left, button1])
  assert.deepEqual(sample.keys, [])
  assert.deepEqual(sample.events, [])
  assert.deepEqual(state.sample([pad(0, [0])], 50, true).keys, [])
  sample = state.sample([pad(0, [0], [-1, 0])], 100, true)
  assert.deepEqual(sample.keys, [left])
  assert.deepEqual(sample.events, [press(left)])
  assert.deepEqual(state.sample([pad(0, [], [-1, 0])], 150, true).keys, [left])
  sample = state.sample([pad(0, [0], [-1, 0])], 200, true)
  assert.deepEqual(sample.keys, [left, button1])
  assert.deepEqual(sample.events, [press(button1)])
})

test('gamepad emits fourteen native keys in bit order and never emits VK_PADANY', () => {
  const state = ready(), all = Array.from({ length: 18 }, (_, index) => index),
    expected = [0x1b5, 0x1b7, 0x1b6, 0x1b8, 0x1c0, 0x1c1, 0x1c2, 0x1c3, 0x1c4,
      0x1c5, 0x1c6, 0x1c7, 0x1c8, 0x1c9], sample = state.sample([pad(0, all)], 50, true)
  assert.deepEqual(sample.keys, expected)
  assert.deepEqual(sample.rawKeys, expected)
  assert.deepEqual(sample.events, expected.map((key) => press(key)))
  assert(!sample.keys.includes(0x1df))
  assert.deepEqual(state.sample([pad()], 100, true).events, expected.map(release))
})

test('gamepad nonstandard mapping uses only the exposed first two axes and ten buttons', () => {
  const state = ready(pad(0, [], [0, 0], '')),
    sample = state.sample([pad(0, [0, 9, 10, 11, 12, 13, 14, 15], [0, 0, -1, 1], '')], 50, true)
  assert.deepEqual(sample.keys, [button1, button1 + 9])
  assert.deepEqual(sample.events, [press(button1), press(button1 + 9)])
  assert.deepEqual(state.sample([pad(0, [], [-1, 1], '')], 100, true).keys, [left, down])
})

test('gamepad standard D-pad and first stick contribute independently to direction keys', () => {
  const state = ready(), sample = state.sample([pad(0, [13, 15], [-1, -1])], 50, true)
  assert.deepEqual(sample.keys, [left, right, up, down])
  assert.deepEqual(sample.events, [press(left), press(right), press(up), press(down)])
})

test('gamepad normalized axes preserve the native asymmetric integer threshold boundaries', () => {
  // Native constants are +31128 and -31129. Quarter-unit offsets keep these
  // cases independent of a floating-point divide/multiply exact tie.
  for (const [value, expected] of [
    [(31128 - 0.25) / 32767, []], [(31128 + 0.25) / 32767, [right]],
    [-(31129 - 0.25) / 32768, []], [-(31129 + 0.25) / 32768, [left]],
    [0.949981, [right]], [-0.949981, []], [0.95, [right]], [-0.95, [left]],
  ] as const) {
    const state = ready()
    assert.deepEqual(state.sample([pad(0, [], [value, 0])], 50, true).keys, expected, `axis=${value}`)
  }
})

test('gamepad invalid axes stay neutral and finite out-of-range axes clamp to the endpoints', () => {
  for (const value of [NaN, Infinity, -Infinity])
    assert.deepEqual(ready().sample([pad(0, [], [value, value])], 50, true).keys, [])
  assert.deepEqual(ready().sample([pad(0, [], [])], 50, true).keys, [])
  assert.deepEqual(ready().sample([pad(0, [], [-2, 2])], 50, true).keys, [left, down])
})

test('gamepad uses the UA pressed flag rather than inventing an analog button threshold', () => {
  const state = ready(), value = { ...pad(), buttons: [
    { pressed: false, value: 1 }, { pressed: true, value: 0 }, { pressed: false, value: NaN },
  ] }
  assert.deepEqual(state.sample([value], 50, true).keys, [button1 + 1])
})

test('gamepad chooses the lowest available index and retains it when a lower index later appears', () => {
  const state = ready(pad(2))
  let sample = state.sample([pad(3, [2]), pad(0, [0]), pad(2, [1])], 50, true)
  assert.deepEqual(sample.selected, { index: 2, id: 'pad-2' })
  assert.deepEqual(sample.keys, [button1 + 1])
  sample = state.sample([pad(3), pad(0, [0])], 100, true)
  assert.deepEqual(sample.selected, { index: 0, id: 'pad-0' })
  assert.deepEqual(sample.rawKeys, [button1])
  assert.deepEqual(sample.keys, [])
  assert.deepEqual(sample.events, [release(button1 + 1)])
  state.sample([pad(0)], 150, true)
  assert.deepEqual(state.sample([pad(0, [0])], 200, true).events, [press(button1)])
  const unordered = new GamepadState().sample([pad(4), null, pad(1), undefined, pad(3)], 0, true)
  assert.deepEqual(unordered.selected, { index: 1, id: 'pad-1' })
})

test('gamepad skips disconnected and invalid device indices', () => {
  const state = new GamepadState(), sample = state.sample([
    { ...pad(0), connected: false }, pad(-1), pad(NaN), pad(1.5), pad(2),
  ], 0, true)
  assert.deepEqual(sample.selected, { index: 2, id: 'pad-2' })
})

test('gamepad device identity or mapping replacement releases old keys and requires neutral', () => {
  const state = ready()
  state.sample([pad(0, [0])], 50, true)
  const replacement = (held: number[] = [], mapping = 'standard') => ({ ...pad(0, held, [0, 0], mapping), id: 'replacement' })
  assert.deepEqual(state.sample([replacement([0])], 100, true).events, [release(button1)])
  state.sample([replacement()], 150, true)
  assert.deepEqual(state.sample([replacement([0])], 200, true).events, [press(button1)])
  assert.deepEqual(state.sample([replacement([0], '')], 250, true).events, [release(button1)])
  assert.deepEqual(state.sample([replacement([0], '')], 300, true).keys, [])
})

test('gamepad disconnect releases once and reconnect cannot inherit held admission', () => {
  const state = ready()
  state.sample([pad(0, [0])], 50, true)
  const gone = state.sample([null], 100, true)
  assert.deepEqual(gone.keys, [])
  assert.deepEqual(gone.rawKeys, [])
  assert.equal(gone.selected, null)
  assert.deepEqual(gone.events, [release(button1)])
  assert.deepEqual(state.sample([], 150, true).events, [])
  assert.deepEqual(state.sample([pad(0, [0])], 200, true).keys, [])
  state.sample([pad()], 250, true)
  assert.deepEqual(state.sample([pad(0, [0])], 300, true).events, [press(button1)])
})

test('gamepad inactive samples publish no admitted keys while preserving separate raw observation', () => {
  const state = ready()
  state.sample([pad(0, [1], [-1, 0])], 50, true)
  let sample = state.sample([pad(0, [1], [-1, 0])], 100, false)
  assert.deepEqual(sample.rawKeys, [left, button1 + 1])
  assert.deepEqual(sample.keys, [])
  assert.deepEqual(sample.events, [release(left), release(button1 + 1)])
  assert.deepEqual(state.sample([pad(0, [1], [-1, 0])], 150, true).keys, [])
  state.sample([pad(0, [], [-1, 0])], 200, true)
  sample = state.sample([pad(0, [1], [-1, 0])], 250, true)
  assert.deepEqual(sample.keys, [button1 + 1])
  assert.deepEqual(sample.events, [press(button1 + 1)])
})

test('gamepad suspension releases immediately and restarts admission and repeat timing', () => {
  const state = ready()
  state.sample([pad(0, [0])], 10, true)
  assert.deepEqual(state.suspend(100).events, [release(button1)])
  assert.deepEqual(state.suspend(100).events, [])
  assert.deepEqual(state.sample([pad(0, [0])], 1000, true).events, [])
  state.sample([pad()], 1050, true)
  assert.deepEqual(state.sample([pad(0, [0])], 1100, true).events, [press(button1)])
  assert.deepEqual(state.sample([pad(0, [0])], 1600, true).events, [])
  assert.deepEqual(state.sample([pad(0, [0])], 1630, true).events, [press(button1, true)])
})

test('gamepad first repeat occurs after delay plus interval, not at the delay boundary', () => {
  const state = ready()
  state.sample([pad(0, [0])], 10, true)
  for (const now of [509, 510, 539]) assert.deepEqual(state.sample([pad(0, [0])], now, true).events, [])
  assert.deepEqual(state.sample([pad(0, [0])], 540, true).events, [press(button1, true)])
  assert.deepEqual(state.sample([pad(0, [0])], 570, true).events, [press(button1, true)])
  assert.deepEqual(state.sample([pad(0, [0])], 570, true).events, [])
})

test('gamepad catches up at most ten repeats per group and discards older excess', () => {
  const state = ready()
  state.sample([pad(0, [0], [-1, -1])], 10, true)
  const result = state.sample([pad(0, [0], [-1, -1])], 3510, true)
  assert.deepEqual(result.events, [
    ...Array.from({ length: 10 }, () => [press(left, true), press(up, true)]).flat(),
    ...Array.from({ length: 10 }, () => press(button1, true)),
  ])
  assert.deepEqual(state.sample([pad(0, [0], [-1, -1])], 3510, true).events, [])
  assert.deepEqual(state.sample([pad(0, [0], [-1, -1])], 3540, true).events,
    [press(left, true), press(up, true), press(button1, true)])
})

test('gamepad cross-group direction changes retain the repeat clock and dispatch ups before downs and repeats', () => {
  const state = ready()
  state.sample([pad(0, [], [-1, 0])], 10, true)
  assert.deepEqual(state.sample([pad(0, [], [-1, -1])], 300, true).events, [press(up)])
  assert.deepEqual(state.sample([pad(0, [], [-1, -1])], 540, true).events, [press(left, true), press(up, true)])
  assert.deepEqual(state.sample([pad(0, [], [1, -1])], 570, true).events,
    [release(left), press(right), press(right, true), press(up, true)])
  assert.deepEqual(state.sample([pad()], 580, true).events, [release(right), release(up)])
  state.sample([pad(0, [], [1, 0])], 590, true)
  assert.deepEqual(state.sample([pad(0, [], [1, 0])], 1090, true).events, [])
  assert.deepEqual(state.sample([pad(0, [], [1, 0])], 1120, true).events, [press(right, true)])
})

test('gamepad trigger repeats select the lowest newly pressed button and any release stops that group', () => {
  const state = ready()
  assert.deepEqual(state.sample([pad(0, [2, 0, 1])], 10, true).events,
    [press(button1), press(button1 + 1), press(button1 + 2)])
  assert.deepEqual(state.sample([pad(0, [0, 1, 2])], 540, true).events, [press(button1, true)])
  assert.deepEqual(state.sample([pad(0, [0, 1])], 550, true).events, [release(button1 + 2)])
  assert.deepEqual(state.sample([pad(0, [0, 1])], 2000, true).events, [])
  assert.deepEqual(state.sample([pad(0, [0, 1, 3])], 2010, true).events, [press(button1 + 3)])
  assert.deepEqual(state.sample([pad(0, [0, 1, 3])], 2540, true).events, [press(button1 + 3, true)])
})

test('gamepad a new trigger press takes precedence over a simultaneous trigger release', () => {
  const state = ready()
  state.sample([pad(0, [0])], 10, true)
  assert.deepEqual(state.sample([pad(0, [1])], 400, true).events, [release(button1), press(button1 + 1)])
  assert.deepEqual(state.sample([pad(0, [1])], 900, true).events, [])
  assert.deepEqual(state.sample([pad(0, [1])], 930, true).events, [press(button1 + 1, true)])
})

test('gamepad cross and trigger groups have independent repeat start times', () => {
  const state = ready()
  state.sample([pad(0, [], [-1, 0])], 10, true)
  state.sample([pad(0, [0], [-1, 0])], 300, true)
  assert.deepEqual(state.sample([pad(0, [0], [-1, 0])], 540, true).events, [press(left, true)])
  assert.deepEqual(state.sample([pad(0, [0], [-1, 0])], 810, true).events,
    Array.from({ length: 9 }, () => press(left, true)))
  assert.deepEqual(state.sample([pad(0, [0], [-1, 0])], 830, true).events, [press(button1, true)])
  assert.deepEqual(state.sample([pad(0, [0], [-1, 0])], 840, true).events, [press(left, true)])
})

test('gamepad repeat options support disabling without disabling ordinary key transitions', () => {
  for (const [delay, interval] of [[-1, 30], [500, 0], [500, -1]]) {
    const state = ready()
    state.setRepeat(delay!, interval!)
    assert.deepEqual(state.sample([pad(0, [0])], 10, true).events, [press(button1)])
    assert.deepEqual(state.sample([pad(0, [0])], 10000, true).events, [])
    assert.deepEqual(state.sample([pad()], 10050, true).events, [release(button1)])
  }
})

test('gamepad live repeat option changes remain bounded when the new count decreases', () => {
  const state = ready()
  state.setRepeat(0, 10)
  state.sample([pad(0, [0])], 10, true)
  assert.deepEqual(state.sample([pad(0, [0])], 110, true).events,
    Array.from({ length: 10 }, () => press(button1, true)))
  state.setRepeat(0, 100)
  assert.deepEqual(state.sample([pad(0, [0])], 120, true).events, [])
  assert.deepEqual(state.sample([pad(0, [0])], 210, true).events, [press(button1, true)])
  state.setRepeat(0, 1)
  assert.equal(state.sample([pad(0, [0])], 220, true).events.length, 10)
})

test('gamepad fractional clocks truncate to milliseconds and backwards clocks still allow releases', () => {
  const state = ready()
  state.sample([pad(0, [0])], 10.9, true)
  assert.deepEqual(state.sample([pad(0, [0])], 539.99, true).events, [])
  assert.deepEqual(state.sample([pad(0, [0])], 540.9, true).events, [press(button1, true)])
  assert.deepEqual(state.sample([pad(0, [0])], 100, true).events, [])
  assert.deepEqual(state.sample([pad()], 101, true).events, [release(button1)])
})

test('gamepad samples own their arrays and device identity while input snapshots can change in place', () => {
  const state = ready(), buttons = [{ pressed: true, value: 1 }], value = { ...pad(), buttons },
    first = state.sample([value], 10, true)
  first.keys.length = first.rawKeys.length = first.events.length = 0
  first.selected!.id = 'mutated-output'
  assert.deepEqual(state.sample([value], 20, true).keys, [button1])
  assert.deepEqual(state.sample([value], 30, true).events, [])
  buttons[0]!.pressed = false
  assert.deepEqual(state.sample([value], 40, true).events, [release(button1)])
})

test('gamepad rejects invalid time and repeat options before changing admitted input or configuration', () => {
  const state = ready()
  state.setRepeat(0, 20)
  state.sample([pad(0, [0])], 10, true)
  for (const now of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => state.sample([], now, true), /sample time/)
  for (const [delay, interval] of [[1.5, 30], [0, NaN], [0, Infinity], [0x80000000, 1], [0, -0x80000001]])
    assert.throws(() => state.setRepeat(delay!, interval!), /32-bit integers/)
  assert.deepEqual(state.sample([pad(0, [0])], 30, true).events, [press(button1, true)])
})

test('gamepad reset retires identity and admission while preserving configured repeat settings', () => {
  const state = ready()
  state.setRepeat(20, 10)
  state.sample([pad(0, [0])], 10, true)
  state.reset()
  assert.deepEqual(state.sample([pad(0, [0])], 100, true).keys, [])
  state.sample([pad()], 110, true)
  assert.deepEqual(state.sample([pad(0, [0])], 120, true).events, [press(button1)])
  assert.deepEqual(state.sample([pad(0, [0])], 150, true).events, [press(button1, true)])
})
