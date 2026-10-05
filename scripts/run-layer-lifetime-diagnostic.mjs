// A fixed default/Liftoff experiment, never a retry-until-green test runner.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Layer lifetime diagnosis requires a GitHub-hosted runner')
if (process.version !== 'v24.19.0') throw new Error('The crash comparison requires exact Node v24.19.0')
const mode = process.argv[2]
if (!['default', 'liftoff-only'].includes(mode)) throw new Error('Expected default or liftoff-only')
const directory = resolve('out/ci/layer-lifetime-diagnostic', mode), records = []
mkdirSync(directory, { recursive: true })
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const manifest = JSON.parse(readFileSync('.generated/wasm/manifest.json', 'utf8'))
const assets = manifest.variants.asyncify
const provenance = { mode, node: process.version, versions: process.versions, commit: process.env.GITHUB_SHA,
  nodeOptions: process.env.NODE_OPTIONS ?? '',
  runId: process.env.GITHUB_RUN_ID, nodeHash: hash(process.execPath), build: JSON.parse(readFileSync('out/ci/build-info.json', 'utf8')),
  wasmHash: hash(resolve('.generated/wasm', assets.wasm.file)), moduleHash: hash(resolve('.generated/wasm', assets.mjs.file)),
  expectedRepetitions: 3, expectedDefinitionsPerRepetition: 20,
  claim: 'Bounded runtime diagnostic; clean observations do not resolve the historical heap corruption' }
if (provenance.build.commit !== provenance.commit) throw new Error('Runtime diagnosis build provenance differs from the checkout')
const save = () => writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ ...provenance, records }, null, 2) + '\n')
save()
for (let repetition = 1; repetition <= 3; repetition++) {
  const prefix = resolve(directory, String(repetition)), journal = prefix + '-journal'
  const args = [...(mode === 'liftoff-only' ? ['--liftoff-only'] : []), '--import', 'tsx', '--import',
    './scripts/record-node-test-process.mjs', '--test', '--test-reporter=tap', 'tests/integration/layer-lifetime.test.ts']
  const startedAt = new Date().toISOString()
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(),
    env: { ...process.env, KRKR_LAYER_LIFETIME_JOURNAL: journal }, encoding: 'utf8',
    timeout: 300000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(prefix + '.tap', result.stdout ?? '')
  writeFileSync(prefix + '.stderr.log', result.stderr ?? '')
  let events = [], journalError
  try {
    events = readdirSync(journal).filter((file) => file.endsWith('.jsonl')).flatMap((file) =>
      readFileSync(resolve(journal, file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
  } catch (error) { journalError = String(error) }
  const started = events.filter((event) => event.event === 'definition:start').map((event) => event.name),
    passed = events.filter((event) => event.event === 'definition:pass').map((event) => event.name),
    failed = events.filter((event) => event.event === 'definition:fail'),
    processes = events.filter((event) => event.event === 'process:start'),
    modeConfirmed = processes.length > 0 && processes.every((event) => event.node === 'v24.19.0' &&
      Array.isArray(event.execArgv) && event.execArgv.includes('--liftoff-only') === (mode === 'liftoff-only')),
    complete = started.length === 20 && new Set(started).size === 20 && passed.length === 20 &&
      new Set(passed).size === 20 && started.every((name) => passed.includes(name)) && failed.length === 0
  const tap = result.stdout ?? '', stderr = result.stderr ?? ''
  records.push({ repetition, startedAt, finishedAt: new Date().toISOString(), args,
    status: result.status, signal: result.signal, error: result.error ? String(result.error) : null,
    started, passed, failed, processes, modeConfirmed, journalError: journalError ?? null,
    observedClean: result.status === 0 && !result.error && complete && modeConfirmed &&
      /^# tests 20\s*$/m.test(tap) && /^# pass 20\s*$/m.test(tap) && /^# fail 0\s*$/m.test(tap) &&
      !tap.includes('LIFETIME_JOURNAL_INCOMPLETE') && !stderr.includes('LIFETIME_JOURNAL_INCOMPLETE') })
  save()
}
if (records.some((record) => !record.observedClean)) process.exitCode = 1
