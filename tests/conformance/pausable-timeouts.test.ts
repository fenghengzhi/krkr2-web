import test from 'node:test'
import assert from 'node:assert/strict'
import { PausableTimeouts } from '../../src/backends/shared/pausable-timeouts.ts'

function clock() {
  let now = 0
  const pending = new Set<{ at: number; callback(): void }>()
  return {
    pending,
    source: {
      now: () => now,
      schedule(callback: () => void, delay: number) {
        const job = { at: now + delay, callback }
        pending.add(job)
        return () => {
          pending.delete(job)
        }
      },
    },
    advance(delay: number) {
      now += delay
      for (const job of [...pending]) {
        if (job.at <= now) {
          pending.delete(job)
          job.callback()
        }
      }
    },
  }
}

test('transport deadlines preserve only the unspent budget across a long suspension', () => {
  const time = clock(),
    timers = new PausableTimeouts(time.source)
  let expired = 0
  timers.start(20, () => expired++)
  time.advance(7)
  timers.setPaused(true)
  time.advance(21050)
  assert.equal(expired, 0)
  timers.setPaused(false)
  time.advance(12)
  assert.equal(expired, 0)
  time.advance(1)
  assert.equal(expired, 1)
  time.advance(100)
  assert.equal(expired, 1)
})

test('requests created during suspension receive their full budget and can be cancelled', () => {
  const time = clock(),
    timers = new PausableTimeouts(time.source)
  let expired = 0
  timers.setPaused(true)
  const cancel = timers.start(20, () => expired++)
  time.advance(21050)
  cancel()
  timers.start(15, () => expired++)
  assert.equal(time.pending.size, 0)
  timers.setPaused(false)
  time.advance(14)
  assert.equal(expired, 0)
  time.advance(1)
  assert.equal(expired, 1)
})

test('already queued timer callbacks cannot expire a resumed or completed request', () => {
  const time = clock(),
    timers = new PausableTimeouts(time.source)
  let expired = 0
  const cancel = timers.start(20, () => expired++)
  const stale = [...time.pending][0]!.callback
  timers.setPaused(true)
  timers.setPaused(false)
  stale()
  assert.equal(expired, 0)
  cancel()
  time.advance(20)
  stale()
  assert.equal(expired, 0)
  assert.equal(time.pending.size, 0)
})
