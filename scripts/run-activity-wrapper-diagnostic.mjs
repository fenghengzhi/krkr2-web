// Hosted observations of the fixed batch111 SIGTRAP. This is deliberately
// independent of both the main Node command and the older menu SIGABRT probe.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, readSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMainThread } from 'node:worker_threads'

const script = fileURLToPath(import.meta.url)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const hosted = () => {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'linux')
    throw new Error('Activity wrapper diagnosis requires a GitHub-hosted Linux runner')
}

// The same extra --import is used in BOTH arms. It observes without installing
// an uncaughtException handler, changing test definitions, or instrumenting TJS.
// The driver supplies an explicit, non-secret environment; Node may add its own
// NODE_TEST_CONTEXT. All actual child values are retained, not reconstructed.
if (process.env.KRKR_ACTIVITY_WRAPPER_OBSERVER === '1') {
  hosted()
  // Loader/worker threads share a PID and are not additional fresh processes.
  // Do not install extra hooks there if Node propagates the preload list.
  if (isMainThread) {
    const directory = process.env.KRKR_ACTIVITY_WRAPPER_JOURNAL
    if (!directory) throw new Error('Missing wrapper observation directory')
    mkdirSync(directory, { recursive: true })
    const path = resolve(directory, `${process.pid}.jsonl`)
    const record = (event, data = {}) => {
      try { appendFileSync(path, JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid,
        ppid: process.ppid, ...data }) + '\n') }
      catch (error) {
        process.stderr.write(`ACTIVITY_WRAPPER_OBSERVER_INCOMPLETE ${String(error)}\n`)
        process.exitCode = 1
      }
    }
    record('process:start', { argv: process.argv, execArgv: process.execArgv, execPath: process.execPath,
      node: process.version, versions: process.versions, nodeSha256: hash(process.execPath),
      cwd: process.cwd(), environment: { ...process.env }, observerSha256: hash(script), scope: 'process-main-thread' })
    process.on('uncaughtExceptionMonitor', (error, origin) => record('process:uncaught-exception', {
      origin, error: String(error), stack: error instanceof Error ? error.stack : undefined }))
    process.on('exit', (code) => record('process:exit', { code }))
  }
} else {
  await run()
}

async function run() {
  hosted()
  const [mode, fixtureArgument, outputArgument] = process.argv.slice(2)
  if (!['default', 'no-wasm-code-gc'].includes(mode) || !fixtureArgument || !outputArgument)
    throw new Error('Usage: run-activity-wrapper-diagnostic.mjs MODE FIXTURE_DIRECTORY OUTPUT_DIRECTORY')
  const fixture = resolve(fixtureArgument), directory = resolve(outputArgument)
  const reference = JSON.parse(readFileSync(resolve(dirname(script), 'activity-wrapper-reference.json'), 'utf8'))
  const definitions = reference.definitions
  const repetitions = 16, timeoutMs = 60000, graceMs = 5000, outputBudget = 16 * 1024 * 1024
  const roundBudgetMs = 25 * 60 * 1000, minFreeBytes = 4 * 1024 ** 3
  const coreDirectory = resolve(directory, 'cores'), ci = resolve(fixture, 'out/ci')
  mkdirSync(coreDirectory, { recursive: true })
  const summary = {
    schema: 1, mode, reference, fixture, directory,
    diagnosticCommit: process.env.GITHUB_SHA, diagnosticRun: process.env.GITHUB_RUN_ID,
    diagnosticAttempt: process.env.GITHUB_RUN_ATTEMPT, observerSha256: hash(script),
    instrumentation: 'Both arms add this identical passive --import and use an explicit non-secret child environment. The fixed activity file runs alone; this is not the original full-suite schedule/environment.',
    historicalClaim: 'Bounded wrapper/code-GC observations. Clean observations do not establish that the batch111 ThreadIsolation SIGTRAP is fixed, and are unrelated to the older menu malloc/RegisterDestroyHook SIGABRT.',
    limits: { repetitions, definitionsPerRepetition: definitions.length, timeoutMs, graceMs, outputBudget,
      roundBudgetMs, minFreeBytes, corePolicy: 'Preserve every full core; stop future attempts if disk reserve is insufficient.' },
    records: Array.from({ length: repetitions }, (_, index) => ({ repetition: index + 1,
      planned: [...definitions], state: 'not-started', notStarted: 'Preflight or earlier attempts have not finished',
      registered: [], dequeued: [], completed: [], passed: [], failed: [], unreported: [...definitions], observedClean: false })),
    complete: false, observedClean: false,
  }
  const save = () => json(resolve(directory, 'summary.json'), summary)
  let terminateActive
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    summary.interrupted = signal; terminateActive?.('driver-' + signal); save()
  })
  save() // The full 16 × 15 plan exists even when provenance/flag checks fail.

  const environment = {}
  // Do not export GitHub credentials/secrets to crash cores or observations.
  // This explicit environment is a documented diagnostic difference, not a
  // claim about the lost historical process environment.
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'CI',
    'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'GITHUB_WORKSPACE', 'GITHUB_SHA', 'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT', 'GITHUB_REPOSITORY', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP'])
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  summary.childEnvironmentBase = environment
  const ownedGroups = new Map()
  const delay = (ms) => new Promise((done) => setTimeout(done, ms))
  const freeBytes = () => { const fs = statfsSync(directory); return fs.bavail * fs.bsize }
  function groupMembers(group) {
    const members = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      let raw
      try { raw = readFileSync(`/proc/${name}/stat`, 'utf8') }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error }
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
      if (Number(fields[2]) === group) members.push({ pid: Number(name), ppid: Number(fields[1]),
        group: Number(fields[2]), session: Number(fields[3]), state: fields[0], startTicks: fields[19] })
    }
    return members
  }
  function signalGroup(group, signal, record) {
    const start = ownedGroups.get(group), members = groupMembers(group)
    if (!start || members.some((member) => member.session !== group || (member.pid === group && member.startTicks !== start)))
      throw new Error('Refusing to signal an unconfirmed or changed process group')
    record.signals.push({ signal, at: new Date().toISOString(), members })
    if (members.length) try { process.kill(-group, signal) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  async function cleanup(group, record) {
    const initial = groupMembers(group)
    let remaining = initial
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (!remaining.length) break
      signalGroup(group, signal, record)
      const end = performance.now() + graceMs
      do { await delay(50); remaining = groupMembers(group) } while (remaining.length && performance.now() < end)
    }
    return { confirmed: remaining.length === 0, initiallyRemaining: initial, remaining }
  }
  function treeBytes(path) {
    if (!existsSync(path)) return 0
    return readdirSync(path, { withFileTypes: true }).reduce((bytes, item) => {
      const child = resolve(path, item.name)
      return bytes + (item.isDirectory() ? treeBytes(child) : item.isFile() ? statSync(child).size : 0)
    }, 0)
  }
  function boundedText(path, errors) {
    const size = statSync(path).size
    if (size > outputBudget) {
      if (!errors) throw new Error(`Observation exceeds parsing budget: ${path}`)
      errors.push({ path, error: 'Observation exceeds parsing budget; only the bounded prefix is accounted', size })
    }
    const fd = openSync(path, 'r'), buffer = Buffer.alloc(Math.min(size, outputBudget))
    let offset = 0
    try { while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count } }
    finally { closeSync(fd) }
    return buffer.subarray(0, offset).toString('utf8')
  }
  function jsonLines(path, errors) {
    let text
    try { text = boundedText(path, errors) }
    catch (error) { errors.push({ path, error: String(error) }); return [] }
    const records = []
    for (const [index, line] of text.split('\n').entries()) {
      if (!line) continue
      try { records.push(JSON.parse(line)) }
      catch (error) { errors.push({ path, line: index + 1, error: String(error) }) }
    }
    return records
  }
  function journals(path, errors) {
    try { return readdirSync(path).filter((name) => name.endsWith('.jsonl')).sort().flatMap((name) => jsonLines(resolve(path, name), errors)) }
    catch (error) { errors.push({ path, error: String(error) }); return [] }
  }
  const cores = () => readdirSync(coreDirectory).filter((name) => name.startsWith('core.')).sort()

  function account(record, output) {
    record.observationErrors = []
    const events = jsonLines(resolve(output, 'ci/node-execution-events.jsonl'), record.observationErrors)
    record.reporterContiguous = events.every((event, index) => event.sequence === index + 1)
    record.reporterStarted = events[0]?.event === 'reporter:started'
    record.reporterFinished = events.at(-1)?.event === 'reporter:finished' && events.at(-1)?.data?.sourceEnded === true
    record.reportedPlans = events.filter((event) => event.event === 'test:plan')
    record.reportedSummaries = events.filter((event) => event.event === 'test:summary')
    const isDefinition = (event) => typeof event.data?.file === 'string' &&
      event.data.file.endsWith('/tests/integration/activity.test.ts') && definitions.includes(event.data.name)
    record.fileContainers = events.filter((event) => event.data?.name === 'tests/integration/activity.test.ts')
    record.unexpectedDefinitions = events.filter((event) => ['test:enqueue', 'test:dequeue', 'test:complete'].includes(event.event) &&
      !isDefinition(event) && event.data?.name !== 'tests/integration/activity.test.ts')
    const names = (kind) => events.filter((event) => event.event === kind && isDefinition(event)).map((event) => event.data.name)
    record.registered = names('test:enqueue')
    record.dequeued = names('test:dequeue')
    const completed = events.filter((event) => event.event === 'test:complete' && isDefinition(event))
    record.completed = completed.map((event) => event.data.name)
    record.passed = completed.filter((event) => event.data.details?.passed === true).map((event) => event.data.name)
    record.failed = completed.filter((event) => event.data.details?.passed !== true).map((event) => event.data)
    record.unreported = definitions.filter((name) => !record.completed.includes(name))
    record.unregistered = definitions.filter((name) => !record.registered.includes(name))
    record.notDequeued = definitions.filter((name) => !record.dequeued.includes(name))
    record.observations = journals(resolve(output, 'process-observations'), record.observationErrors)
    record.originalProcessJournal = journals(resolve(output, 'ci/node-processes'), record.observationErrors)
    const starts = record.observations.filter((event) => event.event === 'process:start')
    const testStarts = starts.filter((event) => event.argv[1]?.endsWith('/tests/integration/activity.test.ts'))
    record.actualChildProvenanceConfirmed = testStarts.length === 1 && starts.every((event) =>
      event.node === reference.node.version && event.versions.v8 === reference.node.v8 &&
      event.nodeSha256 === reference.node.sha256 && event.execPath === process.execPath && event.cwd === fixture &&
      event.observerSha256 === summary.observerSha256 && !event.environment.NODE_OPTIONS &&
      event.execArgv.includes('--no-wasm-code-gc') === (mode === 'no-wasm-code-gc') &&
      event.execArgv.includes(pathToFileURL(script).href) &&
      record.observations.some((exit) => exit.event === 'process:exit' && exit.pid === event.pid && exit.code === 0))
    record.originalProcessJournalComplete = record.originalProcessJournal.some((event) =>
      event.event === 'started' && event.file?.endsWith('/tests/integration/activity.test.ts')) &&
      record.originalProcessJournal.filter((event) => event.event === 'started').every((start) =>
        record.originalProcessJournal.some((event) => event.event === 'exit' && event.pid === start.pid && event.code === 0))
    const tap = boundedText(resolve(output, 'ci/node.tap'), record.observationErrors)
    const stderr = boundedText(resolve(output, 'stderr.log'), record.observationErrors)
    record.tapComplete = ['tests 15', 'pass 15', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0'].every((line) =>
      new RegExp('^# ' + line + '\\s*$', 'm').test(tap))
    record.crashMarkers = {
      threadIsolationErase: /jit_page_->allocations_\.erase\(addr\) == 1/.test(tap + stderr),
      sigtrap: /SIGTRAP/.test(tap + stderr), sigabrt: /SIGABRT/.test(tap + stderr),
    }
    record.complete = [record.registered, record.dequeued, record.completed, record.passed].every((list) =>
      list.length === definitions.length && new Set(list).size === definitions.length) && record.failed.length === 0 &&
      record.unexpectedDefinitions.length === 0 && record.reporterStarted && record.reporterFinished && record.reporterContiguous &&
      !existsSync(resolve(output, 'ci/node-execution-events-error.json')) &&
      record.observationErrors.length === 0 && !stderr.includes('ACTIVITY_WRAPPER_OBSERVER_INCOMPLETE') &&
      !stderr.includes('[node-execution-events] INCOMPLETE:') &&
      record.observations.every((event) => event.event !== 'process:uncaught-exception') && record.tapComplete &&
      record.actualChildProvenanceConfirmed && record.originalProcessJournalComplete
  }

  async function attempt(record, buildInfo) {
    const output = resolve(directory, `attempt-${String(record.repetition).padStart(2, '0')}`)
    mkdirSync(output)
    // Both old reporters have literal out/ci paths. Retire each directory after
    // its process group exits; never let later repetitions append to its files.
    mkdirSync(ci, { recursive: true }); writeFileSync(resolve(ci, 'build-info.json'), buildInfo)
    const observation = resolve(output, 'process-observations')
    mkdirSync(observation)
    const args = [...(mode === 'no-wasm-code-gc' ? ['--no-wasm-code-gc'] : []),
      '--import', 'tsx', '--import', './scripts/record-node-test-process.mjs',
      '--import', pathToFileURL(script).href, '--test',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=tap', '--test-reporter-destination=out/ci/node.tap',
      '--test-reporter=./scripts/record-node-test-events.mjs', '--test-reporter-destination=stdout',
      'tests/integration/activity.test.ts']
    Object.assign(record, { state: 'started', notStarted: undefined, output, args,
      startedAt: new Date().toISOString(), signals: [], status: null, signal: null, terminationReason: null })
    record.environment = { ...environment, KRKR_ACTIVITY_WRAPPER_OBSERVER: '1', KRKR_ACTIVITY_WRAPPER_JOURNAL: observation }
    save()
    const before = new Set(cores()), stdout = openSync(resolve(output, 'stdout.log'), 'wx'), stderr = openSync(resolve(output, 'stderr.log'), 'wx')
    let child, deadline, escalation, hardDeadline, watch
    try {
      child = spawn(process.execPath, args, { cwd: fixture, env: record.environment, detached: true, stdio: ['ignore', stdout, stderr] })
      record.pid = child.pid ?? null
      const exited = new Promise((done) => {
        child.once('error', (error) => { record.spawnError = String(error); done() })
        child.once('exit', (status, signal) => { record.status = status; record.signal = signal; done() })
      })
      if (child.pid) {
        record.initialGroup = groupMembers(child.pid)
        const leader = record.initialGroup.find((member) => member.pid === child.pid)
        if (!leader || leader.session !== child.pid || record.initialGroup.some((member) => member.session !== child.pid))
          throw new Error('Could not confirm the original detached group leader')
        ownedGroups.set(child.pid, leader.startTicks)
      }
      const terminate = (reason) => {
        if (record.terminationReason || !child.pid) return
        record.terminationReason = reason
        try { signalGroup(child.pid, 'SIGTERM', record) } catch (error) { record.signalError = String(error) }
        escalation = setTimeout(() => { try { signalGroup(child.pid, 'SIGKILL', record) }
          catch (error) { record.signalError = String(error) } }, graceMs)
        save()
      }
      terminateActive = terminate
      if (summary.interrupted) terminate('driver-' + summary.interrupted)
      deadline = setTimeout(() => terminate('attempt-deadline'), timeoutMs)
      watch = setInterval(() => {
        try {
          if (treeBytes(output) + treeBytes(ci) > outputBudget) terminate('output-budget')
          if (freeBytes() < minFreeBytes / 2) terminate('disk-reserve')
        } catch (error) { record.watchError = String(error); terminate('observation-error') }
      }, 250)
      const bounded = new Promise((done) => { hardDeadline = setTimeout(() => {
        record.exitDeadlineExceeded = true; terminate('attempt-deadline'); done()
      }, timeoutMs + 2 * graceMs) })
      await Promise.race([exited, bounded])
    } catch (error) { record.driverError = String(error) }
    finally {
      terminateActive = undefined
      clearTimeout(deadline); clearTimeout(escalation); clearTimeout(hardDeadline); clearInterval(watch)
      try { record.cleanup = child?.pid ? await cleanup(child.pid, record) : { confirmed: true, noChildCreated: true } }
      catch (error) { record.cleanup = { confirmed: false, error: String(error) } }
      closeSync(stdout); closeSync(stderr)
      // Do not move a journal still potentially owned by a live process.
      if (record.cleanup.confirmed) renameSync(ci, resolve(output, 'ci'))
    }
    record.finishedAt = new Date().toISOString()
    record.state = 'observed'
    record.newCores = cores().filter((name) => !before.has(name))
    record.outputBytes = treeBytes(output) + (record.cleanup.confirmed ? 0 : treeBytes(ci))
    try { account(record, output) } catch (error) { record.accountingError = String(error) }
    record.observedClean = record.complete === true && record.status === 0 && !record.signal &&
      !record.spawnError && !record.driverError && !record.signalError && !record.watchError && !record.accountingError &&
      !record.exitDeadlineExceeded && !record.terminationReason && record.outputBytes <= outputBudget &&
      record.cleanup.confirmed && record.cleanup.initiallyRemaining?.length === 0 && record.newCores.length === 0
    save()
    return record.cleanup.confirmed
  }

  try {
    if (process.version !== reference.node.version || process.versions.v8 !== reference.node.v8 || hash(process.execPath) !== reference.node.sha256)
      throw new Error('Node binary/version/V8 does not match the archived batch111 runtime')
    if (process.execArgv.length || process.env.NODE_OPTIONS) throw new Error('Unexpected driver Node options')
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8', timeout: 10000 })
    const clean = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: fixture, encoding: 'utf8', timeout: 10000 })
    summary.checkout = { head: git.stdout?.trim(), status: clean.stdout, gitStatus: git.status, cleanStatus: clean.status }
    if (git.status !== 0 || clean.status !== 0 || summary.checkout.head !== reference.commit || clean.stdout)
      throw new Error('Fixed batch111 checkout has changed or cannot be confirmed')
    summary.actualHashes = {}
    for (const [path, expected] of Object.entries({ ...reference.sourceSha256, ...reference.buildSha256 })) {
      const actual = hash(resolve(fixture, path)); summary.actualHashes[path] = actual
      if (actual !== expected) throw new Error(`Pinned batch111 file hash mismatch: ${path}`)
    }
    const buildInfo = readFileSync(resolve(ci, 'build-info.json'))
    const build = JSON.parse(buildInfo.toString())
    if (build.commit !== reference.commit || build.runId !== reference.runId || String(build.attempt) !== reference.attempt)
      throw new Error('Build provenance is not the exact archived batch111 run')
    summary.build = build
    copyFileSync(resolve(ci, 'build-info.json'), resolve(directory, 'build-info.json'))
    renameSync(ci, resolve(directory, 'initial-ci'))
    const flagArgs = mode === 'default' ? [] : ['--no-wasm-code-gc']
    const options = spawnSync(process.execPath, [...flagArgs, '--v8-options'], { env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
    writeFileSync(resolve(directory, 'v8-options.txt'), options.stdout ?? '')
    writeFileSync(resolve(directory, 'v8-options.stderr'), options.stderr ?? '')
    summary.optionCheck = { args: [...flagArgs, '--v8-options'], status: options.status, signal: options.signal, error: options.error && String(options.error) }
    // Check the actual binary's advertised option AND effective default for this
    // invocation. Never silently skip or substitute a different experimental flag.
    const entry = /--wasm-code-gc\b[^\n]*\n[^\n]*default: (--(?:no-)?wasm-code-gc)\b/.exec(options.stdout ?? '')
    summary.optionCheck.effective = entry?.[1]
    if (options.status !== 0 || entry?.[1] !== (mode === 'default' ? '--wasm-code-gc' : '--no-wasm-code-gc'))
      throw new Error('Actual hosted V8 does not confirm the requested wasm-code-gc setting')
    save()
    const started = performance.now()
    for (const record of summary.records) {
      let reason
      if (summary.interrupted) reason = 'Driver interrupted: ' + summary.interrupted
      else if (performance.now() - started + timeoutMs + 4 * graceMs > roundBudgetMs) reason = 'Whole-arm deadline budget'
      else if (freeBytes() < minFreeBytes) reason = 'Full-core disk reserve; existing cores preserved'
      if (reason) { for (const next of summary.records) if (next.state === 'not-started') next.notStarted = reason; break }
      if (!await attempt(record, buildInfo)) {
        for (const next of summary.records) if (next.state === 'not-started') next.notStarted = 'Previous owned process group cleanup was not confirmed'
        break
      }
    }
    summary.complete = summary.records.every((record) => record.state === 'observed')
    summary.observedClean = summary.complete && !summary.interrupted && summary.records.every((record) => record.observedClean)
  } catch (error) {
    summary.error = String(error); summary.stack = error instanceof Error ? error.stack : undefined
    for (const record of summary.records) if (record.state === 'not-started') record.notStarted = 'Preflight/driver failure: ' + String(error)
  }
  summary.counts = { planned: repetitions * definitions.length,
    registered: summary.records.reduce((n, record) => n + record.registered.length, 0),
    dequeued: summary.records.reduce((n, record) => n + record.dequeued.length, 0),
    completed: summary.records.reduce((n, record) => n + record.completed.length, 0),
    passed: summary.records.reduce((n, record) => n + record.passed.length, 0),
    failed: summary.records.reduce((n, record) => n + record.failed.length, 0),
    unreported: summary.records.reduce((n, record) => n + record.unreported.length, 0) }
  save()
  if (!summary.observedClean) process.exitCode = 1
}
