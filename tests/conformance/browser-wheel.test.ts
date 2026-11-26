import test from 'node:test'
import assert from 'node:assert/strict'
import { VerticalWheel } from '../../src/backends/input/wheel.ts'

test('vertical DOM wheel units retain direction and fractional movement without zero native messages', () => {
  const wheel = new VerticalWheel()
  assert.deepEqual([-.25, -.25, -.25, -.25].map(value => wheel.sample(value, 0, 480)), [0, 0, 0, 1])
  assert.deepEqual([.25, .25, .25, .25].map(value => wheel.sample(value, 0, 480)), [0, 0, 0, -1])
  assert.deepEqual([-120, 120, -40, 40].map(value => wheel.sample(value, 0, 480)), [120, -120, 40, -40])
  assert.equal(wheel.sample(-3, 1, 480), 120)
  assert.equal(wheel.sample(3, 1, 480), -120)
  assert.equal(wheel.sample(-1, 2, 480), 480)
  assert.equal(wheel.sample(1, 2, 320), -320)
})

test('fractional wheel state does not cross axis, direction, unit or explicit Window boundaries', () => {
  const wheel = new VerticalWheel(), other = new VerticalWheel()
  assert.equal(wheel.sample(-.75, 0, 480), 0)
  assert.equal(other.sample(-.25, 0, 480), 0)
  assert.equal(wheel.sample(.25, 0, 480), 0, 'reversing direction does not combine an earlier gesture')
  assert.equal(wheel.sample(.75, 0, 480), -1)
  assert.equal(wheel.sample(-.75, 0, 480), 0)
  assert.equal(wheel.sample(0, 0, 480), 0, 'horizontal-only input resets the residual')
  assert.equal(wheel.sample(-.75, 0, 480), 0)
  assert.equal(wheel.sample(-1 / 64, 1, 480), 0, 'changing units starts with only the new five-eighths unit')
  assert.equal(wheel.sample(-3 / 256, 1, 480), 1)
  assert.equal(wheel.sample(-.75, 0, 480), 0)
  wheel.clear()
  assert.equal(wheel.sample(-.25, 0, 480), 0)
  assert.equal(wheel.sample(-120, 0, 480), 120, 'ordinary integer wheel input remains exact')
  assert.equal(wheel.sample(120, 0, 480), -120)
})
