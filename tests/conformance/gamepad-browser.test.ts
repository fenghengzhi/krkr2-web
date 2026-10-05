import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserGamepad } from '../../src/backends/input/gamepad-browser.ts'
import type { GamepadSample } from '../../src/backends/input/gamepad.ts'
import { gamepadSource } from '../helpers/gamepad-source.ts'

test('browser gamepad samples one current snapshot per 50ms and never replays missed device polls', () => {
  const clock = gamepadSource(), samples: GamepadSample[] = [], errors: unknown[] = []
  clock.pad()
  const driver = new BrowserGamepad((sample) => samples.push(sample), (error) => errors.push(error), clock.source)
  try {
    clock.tick(0)
    assert.equal(clock.reads, 0, 'No device read before an eligible game Window is focused')
    assert.equal(clock.pending, 0)
    driver.setActive(true)
    assert.equal(clock.reads, 1)
    clock.pad([0])
    clock.tick(49)
    assert.equal(clock.reads, 1)
    clock.tick(50)
    assert.equal(clock.reads, 2)
    assert.deepEqual(samples.at(-1)!.keys, [0x1c0])
    assert.deepEqual(samples.at(-1)!.events, [{ type: 'keyDown', key: 0x1c0, repeat: false }])
    clock.tick(10000)
    assert.equal(clock.reads, 3)
    assert(samples.at(-1)!.events.length <= 10)
    assert.equal(clock.pending, 1)
    assert.deepEqual(errors, [])
  } finally { driver.close() }
  assert.equal(clock.pending, 0)
})

test('browser gamepad suspension releases once and cancelled RAF cannot restore held keys', () => {
  const clock = gamepadSource(), samples: GamepadSample[] = []
  clock.pad()
  const driver = new BrowserGamepad((sample) => samples.push(sample), (error) => { throw error }, clock.source)
  try {
    driver.setActive(true)
    clock.pad([1])
    clock.tick(50)
    const stale = clock.captured()
    driver.setSuspended(true)
    assert.deepEqual(samples.at(-1)!.events, [{ type: 'keyUp', key: 0x1c1, repeat: false }])
    assert.equal(clock.pending, 0)
    const count = samples.length
    for (const callback of stale) callback()
    assert.equal(samples.length, count)
    assert.equal(clock.pending, 0)
    driver.setSuspended(false)
    const resumedPending = clock.pending
    for (const callback of stale) callback()
    assert.equal(clock.pending, resumedPending)
    assert.equal(samples.length, count)
    clock.tick(100)
    assert.deepEqual(samples.at(-1)!.keys, [])
    clock.pad()
    clock.tick(150)
    clock.pad([1])
    clock.tick(200)
    assert.deepEqual(samples.at(-1)!.keys, [0x1c1])
  } finally { driver.close() }
})

test('browser gamepad API failure releases keys and stops polling without retrying a throwing source', () => {
  const clock = gamepadSource(), samples: GamepadSample[] = [], errors: unknown[] = [], denied = new Error('device permission denied')
  clock.pad()
  const driver = new BrowserGamepad((sample) => samples.push(sample), (error) => errors.push(error), clock.source)
  try {
    driver.setActive(true)
    clock.pad([0])
    clock.tick(50)
    clock.fail(denied)
    clock.tick(100)
    assert.deepEqual(samples.at(-1)!.keys, [])
    assert.deepEqual(errors, [denied])
    assert.equal(clock.pending, 0)
    const reads = clock.reads
    driver.setActive(false)
    driver.setActive(true)
    driver.setSuspended(true)
    driver.setSuspended(false)
    clock.tick(1000)
    assert.equal(clock.reads, reads)
    assert.equal(clock.pending, 0)
  } finally { driver.close() }
})

test('closing a browser gamepad cancels ownership and ignores a late callback', () => {
  const clock = gamepadSource(), samples: GamepadSample[] = []
  clock.pad()
  const driver = new BrowserGamepad((sample) => samples.push(sample), (error) => { throw error }, clock.source)
  driver.setActive(true)
  clock.pad([0])
  clock.tick(50)
  const stale = clock.captured()
  driver.close()
  const count = samples.length, reads = clock.reads
  for (const callback of stale) callback()
  driver.setActive(true)
  driver.setSuspended(false)
  assert.deepEqual(samples.at(-1)!.keys, [])
  assert.equal(samples.length, count)
  assert.equal(clock.reads, reads)
  assert.equal(clock.pending, 0)
})
