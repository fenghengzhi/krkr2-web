import test from 'node:test'
import assert from 'node:assert/strict'
import { SystemMaintenance } from '../../src/engine/system/maintenance.ts'

class Clock {
  value = 0
  tasks = new Set<{ at: number; run(): void }>()
  now = () => this.value
  schedule = (run: () => void, delay: number) => {
    const task = { at: this.value + delay, run }
    this.tasks.add(task)
    return () => { this.tasks.delete(task) }
  }
  at(value: number) {
    this.value = value
    for (const task of [...this.tasks]) if (task.at <= value && this.tasks.delete(task)) task.run()
  }
}
test('native idle maintenance uses a strict four-second WatchTimer interval, not input inactivity', () => {
  const clock = new Clock(), levels: number[] = []
  let continuous = false
  const maintenance = new SystemMaintenance(clock, () => continuous, (level) => { levels.push(level) })
  clock.at(4000); assert.deepEqual(levels, [])
  clock.at(4050); assert.deepEqual(levels, [5])
  continuous = true
  clock.at(12000); assert.deepEqual(levels, [5])
  continuous = false
  clock.at(12050); assert.deepEqual(levels, [5, 5], 'EndContinuous does not reset the last compact timestamp')
  maintenance.close(); assert.equal(clock.tasks.size, 0)
})
test('maintenance uses DWORD subtraction across wrap and preserves the wall clock through host pause', () => {
  const clock = new Clock(), levels: number[] = []
  const maintenance = new SystemMaintenance(clock, () => false, (level) => { levels.push(level) })
  clock.at(0xfffffff0); assert.equal(levels.length, 1)
  clock.at(0x100000010); assert.equal(levels.length, 1)
  maintenance.setPaused(true); assert.equal(clock.tasks.size, 0)
  clock.at(0x100002000); maintenance.setPaused(false)
  clock.at(0x100002032); assert.equal(levels.length, 2)
  maintenance.close(); assert.equal(clock.tasks.size, 0)
})
test('closing maintenance during its callback or a late canceled timer cannot rearm it', () => {
  const clock = new Clock()
  let calls = 0
  const maintenance = new SystemMaintenance(clock, () => false, () => { calls++; maintenance.close() })
  const late = [...clock.tasks][0]!.run
  clock.at(4050); late(); clock.at(9000)
  assert.equal(calls, 1); assert.equal(clock.tasks.size, 0)
  const other = new SystemMaintenance(clock, () => false, () => { calls++ })
  const beforePause = [...clock.tasks][0]!.run
  other.setPaused(true); other.setPaused(false)
  const resumed = [...clock.tasks][0]!
  beforePause()
  assert.equal(clock.tasks.size, 1); assert.equal([...clock.tasks][0], resumed); assert.equal(calls, 1)
  other.close(); resumed.run()
  assert.equal(clock.tasks.size, 0); assert.equal(calls, 1)
})
