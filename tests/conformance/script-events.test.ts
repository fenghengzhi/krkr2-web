import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ScriptEvents,
  type EventClock,
  type ScriptEventPost,
} from '../../src/engine/scheduler/events.ts'
import type {
  HostContext,
  HostObjectLifetime,
  ScriptObject,
  ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'

// Model independent external references, weak observations and event leases.
// A native lifecycle notification can happen as soon as the last lease goes.
class Lifetime implements HostContext, HostObjectLifetime {
  readonly external = new Set<number>()
  readonly alive = new Set<number>()
  readonly leases = new Map<number, number>()
  readonly observers = new Map<number, { owner: number; invalidated(): void }>()
  onObserve?: (owner: ScriptObject) => void
  private nextOwner = 1
  private nextLease = 1000
  private nextObserver = 1

  owner(): ScriptObject {
    const id = this.nextOwner++
    this.external.add(id)
    this.alive.add(id)
    return { type: 'object', id, runtime: 1 }
  }
  drop(owner: ScriptObject): void {
    this.external.delete(owner.id)
    this.collect(owner.id)
  }
  private collect(owner: number): void {
    if (this.external.has(owner) || [...this.leases.values()].includes(owner)) return
    this.alive.delete(owner)
    for (const [id, entry] of [...this.observers]) {
      if (entry.owner !== owner) continue
      this.observers.delete(id)
      entry.invalidated()
    }
  }
  observe(owner: ScriptObject, invalidated: () => void): ScriptWeakObject {
    const id = this.nextObserver++
    this.observers.set(id, { owner: owner.id, invalidated })
    this.onObserve?.(owner)
    return { type: 'weak-object', id, runtime: 1 }
  }
  upgrade(weak: ScriptWeakObject): ScriptObject | undefined {
    const entry = this.observers.get(weak.id)
    if (!entry || !this.alive.has(entry.owner)) return
    const id = this.nextLease++
    this.leases.set(id, entry.owner)
    return { type: 'object', id, runtime: 1 }
  }
  unobserve(weak: ScriptWeakObject): void {
    this.observers.delete(weak.id)
  }
  retain(): ScriptObject {
    throw new Error('Event registration must not retain its owner')
  }
  release(object: ScriptObject): void {
    const owner = this.leases.get(object.id)
    assert.notEqual(owner, undefined, 'Lease released twice or foreign handle released')
    this.leases.delete(object.id)
    this.collect(owner!)
  }
  snapshot(): ReturnType<HostContext['snapshot']> {
    throw new Error('Scheduler must not snapshot script objects')
  }
}

class Clock implements EventClock {
  time = 0
  readonly tasks = new Set<{ at: number; run(): void }>()
  now = () => this.time
  schedule = (run: () => void, delay: number) => {
    const task = { at: this.time + delay, run }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  advance(ms: number): void {
    this.time += ms
    for (const task of [...this.tasks])
      if (task.at <= this.time && this.tasks.delete(task)) task.run()
  }
}

interface Job {
  event: ScriptEventPost
  resolve(): void
  reject(error: unknown): void
}
class Queue {
  jobs: Job[] = []
  disabled = false
  failure?: 'throw' | 'reject'
  dispatch = (event: ScriptEventPost): Promise<void> => {
    if (this.failure === 'throw') throw new Error('dispatch failed synchronously')
    if (this.failure === 'reject') return Promise.reject(new Error('dispatch failed'))
    if (this.disabled && event.discardable) {
      event.onTaken()
      return Promise.resolve()
    }
    if (event.replace) this.cancel(event.source)
    return new Promise<void>((resolve, reject) => {
      this.jobs.push({ event, resolve, reject })
    })
  }
  cancel = (source: object): void => {
    const removed = this.jobs.filter((job) => job.event.source === source)
    this.jobs = this.jobs.filter((job) => job.event.source !== source)
    for (const job of removed) {
      job.event.onTaken()
      job.resolve()
    }
  }
  take(): Job {
    const job = this.jobs.shift()!
    assert.ok(job)
    job.event.onTaken()
    return job
  }
}

function setup() {
  const objects = new Lifetime(),
    clock = new Clock(),
    queue = new Queue(),
    errors: unknown[] = []
  const events = new ScriptEvents(
    clock,
    objects,
    queue.dispatch,
    (error) => errors.push(error),
    queue.cancel,
  )
  return { events, objects, clock, queue, errors }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test('weak timer registration allows implicit destruction and rejects a late cancelled wake', () => {
  const { events, objects, clock, queue } = setup(),
    owner = objects.owner()
  const id = events.create('timer', owner)
  events.set(id, 'interval', 10)
  events.set(id, 'enabled', 1)
  const stale = [...clock.tasks][0]!
  assert.equal(objects.leases.size, 0)
  assert.equal(events.count, 1)
  objects.drop(owner)
  assert.equal(events.count, 0)
  assert.equal(objects.observers.size, 0)
  assert.equal(clock.tasks.size, 0)
  clock.time = 100
  stale.run()
  assert.equal(queue.jobs.length, 0)
  assert.equal(clock.tasks.size, 0)
  assert.throws(() => events.get(id), /invalidated/)
})

test('a trigger lease outlives its external owner through both queuing and suspended delivery', async () => {
  const { events, objects, queue } = setup(),
    owner = objects.owner()
  const id = events.create('trigger', owner)
  events.trigger(id)
  objects.drop(owner)
  assert.equal(objects.alive.size, 1)
  assert.equal(events.get(id).pending, 1)
  const job = queue.take()
  assert.equal(job.event.member, 'onFire')
  assert.equal(events.get(id).pending, 0)
  assert.equal(objects.leases.size, 1)
  assert.equal(job.event.valid(), true)
  await settle()
  assert.equal(objects.alive.size, 1)
  job.resolve()
  await settle()
  assert.equal(objects.leases.size, 0)
  assert.equal(objects.alive.size, 0)
  assert.equal(events.count, 0)
})

test('timer capacity excludes a running callback while pause discards only queued leases', async () => {
  const { events, objects, clock, queue } = setup(),
    owner = objects.owner()
  const id = events.create('timer', owner)
  events.set(id, 'interval', 10)
  events.set(id, 'capacity', 1)
  events.set(id, 'enabled', 1)
  clock.advance(20)
  assert.equal(queue.jobs.length, 1)
  const active = queue.take()
  assert.equal(active.event.member, 'onTimer')
  clock.advance(20)
  assert.equal(queue.jobs.length, 1)
  assert.equal(objects.leases.size, 2)
  events.pause(true)
  await settle()
  assert.equal(queue.jobs.length, 0)
  assert.equal(objects.leases.size, 1)
  active.resolve()
  await settle()
  assert.equal(objects.leases.size, 0)
  events.resume()
  assert.equal(clock.tasks.size, 1)
  objects.drop(owner)
  assert.equal(clock.tasks.size, 0)
})

test('cached replacement and cancellation release every queued trigger lease', async () => {
  const { events, objects, queue } = setup(),
    owner = objects.owner()
  const id = events.create('trigger', owner)
  events.trigger(id)
  const previous = queue.jobs[0]!.event
  events.trigger(id)
  await settle()
  assert.equal(previous.valid(), false)
  assert.equal(queue.jobs.length, 1)
  assert.equal(objects.leases.size, 1)
  events.set(id, 'cached', 0)
  await settle()
  events.trigger(id)
  events.trigger(id)
  assert.equal(queue.jobs.length, 2)
  events.cancel(id)
  await settle()
  assert.equal(events.get(id).pending, 0)
  assert.equal(objects.leases.size, 0)
  objects.drop(owner)
  assert.equal(events.count, 0)
})

for (const failure of ['throw', 'reject'] as const)
  test(`dispatch ${failure} releases the event lease and restores pending capacity`, async () => {
    const { events, objects, queue, errors } = setup(),
      owner = objects.owner()
    const id = events.create('trigger', owner)
    queue.failure = failure
    events.trigger(id)
    await settle()
    assert.equal(errors.length, 1)
    assert.equal(objects.leases.size, 0)
    assert.equal(events.get(id).pending, 0)
    objects.drop(owner)
    assert.equal(events.count, 0)
  })

test('disabled timer delivery drops its lease without leaking pending capacity', async () => {
  const { events, objects, clock, queue, errors } = setup(),
    owner = objects.owner()
  const id = events.create('timer', owner)
  events.set(id, 'interval', 10)
  events.set(id, 'enabled', 1)
  queue.disabled = true
  clock.advance(10)
  await settle()
  assert.equal(queue.jobs.length, 0)
  assert.equal(objects.leases.size, 0)
  assert.equal(events.get(id).pending, 0)
  assert.deepEqual(errors, [])
  objects.drop(owner)
})

test('a failed weak upgrade removes the stale source and cancels its prior jobs', async () => {
  const { events, objects, queue } = setup(),
    owner = objects.owner()
  const id = events.create('trigger', owner)
  events.set(id, 'cached', 0)
  events.trigger(id)
  // Simulate an already revoked token before its host invalidation is processed.
  objects.observers.clear()
  events.trigger(id)
  await settle()
  assert.equal(events.count, 0)
  assert.equal(queue.jobs.length, 0)
  assert.equal(objects.leases.size, 0)
  objects.drop(owner)
})

test('creation rolls back its observation if invalidation occurs before source registration', () => {
  const { events, objects } = setup(),
    owner = objects.owner()
  objects.onObserve = (object) => objects.drop(object)
  assert.throws(() => events.create('trigger', owner), /invalidated/)
  assert.equal(events.count, 0)
  assert.equal(objects.observers.size, 0)
  assert.equal(objects.leases.size, 0)
})

test('service disposal cancels queued jobs but preserves a running lease until rejection', async () => {
  const { events, objects, queue, errors } = setup(),
    owner = objects.owner()
  const id = events.create('trigger', owner)
  events.set(id, 'cached', 0)
  events.trigger(id)
  const active = queue.take()
  events.trigger(id)
  objects.drop(owner)
  events.dispose()
  events.dispose()
  await settle()
  assert.equal(events.count, 0)
  assert.equal(objects.observers.size, 0)
  assert.equal(queue.jobs.length, 0)
  assert.equal(objects.leases.size, 1)
  assert.equal(active.event.valid(), false)
  active.reject(new Error('cancelled'))
  await settle()
  assert.equal(objects.leases.size, 0)
  assert.equal(objects.alive.size, 0)
  assert.equal(errors.length, 1)
})
