// Loaded by the hosted Node test command, including its file subprocesses.
// A job cancellation can lose buffered TAP; retain which files actually began
// and which processes exited without changing test order or timeout budgets.
import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const directory = resolve('out/ci/node-processes')
mkdirSync(directory, { recursive: true })
const destination = resolve(directory, `${process.pid}.jsonl`)
const record = (event, extra = {}) => appendFileSync(destination, JSON.stringify({
  event, at: new Date().toISOString(), pid: process.pid, ppid: process.ppid,
  file: process.argv[1] ?? null, ...extra,
}) + '\n')
record('started')
process.on('exit', (code) => record('exit', { code }))
