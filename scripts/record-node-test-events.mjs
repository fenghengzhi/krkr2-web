// A third hosted reporter; spec/TAP remain the human and declaration-order logs.
// Node v24.19.0 forwards enqueue/dequeue/complete before its per-file TAP buffer:
// https://github.com/nodejs/node/blob/v24.19.0/lib/internal/test_runner/runner.js#L124-L127
// https://github.com/nodejs/node/blob/v24.19.0/lib/internal/test_runner/runner.js#L325-L336
import { appendFileSync, mkdirSync, writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { types } from 'node:util'

const retainedEvents = new Set([
  'test:enqueue', 'test:dequeue', 'test:complete', 'test:diagnostic',
  'test:plan', 'test:summary', 'test:interrupted', 'test:stderr',
])

// Error fields are often non-enumerable. Keep causes and assertion values,
// and explicitly mark values JSON cannot represent rather than silently lose them.
function serialize(value, ancestors = new Set()) {
  if (value === undefined) return { $type: 'undefined' }
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $type: 'number', value: String(value) }
  if (typeof value === 'symbol' || typeof value === 'function') return { $type: typeof value, value: String(value) }
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) return { $type: 'circular' }
  if (ancestors.size >= 64) return { $type: 'depth-limit', limit: 64 }
  const next = new Set(ancestors).add(value)
  if (Array.isArray(value)) return value.map((item) => serialize(item, next))
  if (types.isMap(value)) return { $type: 'Map', entries: [...value].map((entry) => serialize(entry, next)) }
  if (types.isSet(value)) return { $type: 'Set', values: [...value].map((item) => serialize(item, next)) }
  const result = Object.create(null)
  if (types.isNativeError(value)) {
    result.name = value.name
    result.message = value.message
    result.stack = value.stack
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    result[key] = 'value' in descriptor
      ? serialize(descriptor.value, next)
      : { $type: 'accessor-not-evaluated' }
  }
  return result
}

export default async function* recordNodeTestEvents(source) {
  const directory = resolve('out/ci')
  const destination = resolve(directory, 'node-execution-events.jsonl')
  const errorDestination = resolve(directory, 'node-execution-events-error.json')
  let recording = true
  let sequence = 0
  let written = 0
  const eventCounts = Object.create(null)
  const record = (event, data) => {
    sequence++
    if (!recording) return
    try {
      mkdirSync(directory, { recursive: true })
      appendFileSync(destination, JSON.stringify({
        event, sequence, at: new Date().toISOString(), pid: process.pid,
        data: serialize(data),
      }) + '\n')
      written++
    } catch (error) {
      recording = false
      const gap = {
        event: 'reporter:gap', at: new Date().toISOString(), destination,
        sequence, written, message: String(error), complete: false,
      }
      // A broken diagnostic sink must not replace the test runner's error or
      // prevent the other reporters from receiving their original events.
      try { writeSync(2, `[node-execution-events] INCOMPLETE: ${JSON.stringify(gap)}\n`) } catch {}
      try { writeFileSync(errorDestination, JSON.stringify(gap, null, 2) + '\n') } catch {}
    }
  }
  record('reporter:started', {
    node: process.version, runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT, commit: process.env.GITHUB_SHA,
    retainedEvents: [...retainedEvents],
  })
  let sourceEnded = false
  try {
    for await (const { type, data } of source) {
      eventCounts[type] = (eventCounts[type] ?? 0) + 1
      if (retainedEvents.has(type)) record(type, data)
    }
    sourceEnded = true
  } finally {
    // This is reporter completion, never a passing test verdict. A killed job
    // can have no finish line; individual complete events can include file
    // aggregates and must not simply be counted as additional passing cases.
    record('reporter:finished', { sourceEnded, eventCounts, writtenBeforeFinish: written })
  }
}
