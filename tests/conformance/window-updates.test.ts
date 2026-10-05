import test from 'node:test'
import assert from 'node:assert/strict'
import { WindowUpdates } from '../../src/engine/scene/window-updates.ts'

test('window invalidation keeps first-post order and counts delivered entries in the native two-entry limit', () => {
  const queue = new WindowUpdates()
  queue.post(2); queue.post(1); queue.post(2)
  assert.equal(queue.begin(), true)
  assert.equal(queue.next(), 2)
  queue.post(2); queue.post(2); queue.post(1); queue.post(1)
  assert.equal(queue.begin(), false)
  assert.deepEqual([queue.next(), queue.next(), queue.next(), queue.next()], [1, 2, 1, undefined])
  queue.finish()
  queue.post(2); queue.post(2)
  assert.equal(queue.begin(), true)
  assert.deepEqual([queue.next(), queue.next()], [2, undefined])
  queue.finish()
})

test('retirement during a window-update round removes future entries without moving its current iterator', () => {
  const queue = new WindowUpdates()
  queue.post(1); queue.post(2); queue.post(3)
  queue.begin(); assert.equal(queue.next(), 1)
  queue.post(1); queue.remove(1); queue.remove(2)
  assert.deepEqual([queue.next(), queue.next()], [3, undefined])
  // Exception/Stop cleanup ends the round, including its duplicate counters.
  queue.finish(); queue.post(3)
  assert.equal(queue.begin(), true); assert.equal(queue.next(), 3)
  queue.finish()
})
