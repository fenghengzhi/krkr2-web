// Fixed independent repetitions, never a retry-until-green test runner.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'linux')
  throw new Error('Menu lifetime diagnosis requires a GitHub-hosted Linux runner')
const mode = process.argv[2]
if (!['default', 'liftoff-only'].includes(mode)) throw new Error('Expected default or liftoff-only')
const directory = resolve('out/ci/menu-lifetime-diagnostic', mode), records = []
mkdirSync(directory, { recursive: true })
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const timeoutMs = 300000, terminationGraceMs = 5000, outputBudget = 16 * 1024 * 1024
const provenance = {
  mode, node: process.version, versions: process.versions, execPath: process.execPath,
  execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '',
  commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  expectedRepetitions: 3, expectedDefinitionsPerRepetition: 24,
  timeoutMs, terminationGraceMs, outputBudget,
  claim: 'Bounded independent menu-modal observations; clean results do not resolve the historical malloc/RegisterDestroyHook SIGABRT',
}
const summary = { ...provenance, records, complete: false, observedClean: false }
const save = () => writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
let activeTermination
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  summary.interrupted = signal
  activeTermination?.('driver-' + signal)
  save()
})
save()

// Every attempt is a fresh Linux session/process group. Node's --test child and
// its descendants inherit that group; signalling only the parent is insufficient.
function groupMembers(group) {
  const members = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let raw
    try { raw = readFileSync(`/proc/${name}/stat`, 'utf8') }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error }
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (Number(fields[2]) === group) members.push({
      pid: Number(name), ppid: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]),
      state: fields[0], startTicks: fields[19],
    })
  }
  return members
}
function signalOwnedGroup(group, leaderStart, signal, actions) {
  if (!leaderStart) throw new Error('Refusing a numeric group signal without its original leader identity')
  const members = groupMembers(group)
  if (members.some((member) => member.session !== group ||
      (member.pid === group && leaderStart && member.startTicks !== leaderStart)))
    throw new Error('Refusing to signal a changed/unowned diagnostic process group')
  actions.push({ at: new Date().toISOString(), signal, members })
  if (!members.length) return
  try { process.kill(-group, signal) }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}
async function cleanupGroup(group, leaderStart, actions) {
  const initial = groupMembers(group)
  if (!initial.length) return { confirmed: true, initiallyRemaining: [], remaining: [] }
  signalOwnedGroup(group, leaderStart, 'SIGTERM', actions)
  let remaining = initial
  const graceEnd = performance.now() + terminationGraceMs
  while (remaining.length && performance.now() < graceEnd) { await delay(50); remaining = groupMembers(group) }
  if (remaining.length) {
    signalOwnedGroup(group, leaderStart, 'SIGKILL', actions)
    const killEnd = performance.now() + terminationGraceMs
    while (remaining.length && performance.now() < killEnd) { await delay(50); remaining = groupMembers(group) }
  }
  return { confirmed: remaining.length === 0, initiallyRemaining: initial, remaining }
}
function cores() {
  const root = resolve('out/native-menu-cores')
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('core.')).sort() : []
}
function journalEvents(journal) {
  return readdirSync(journal).filter((name) => name.endsWith('.jsonl')).sort().flatMap((name) =>
    readFileSync(resolve(journal, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
}
function logPrefix(path) {
  // Full raw output remains on disk even when its budget fails. Never load an
  // arbitrarily large child log into the diagnostic parent's heap afterwards.
  const buffer = Buffer.alloc(Math.min(statSync(path).size, outputBudget)), fd = openSync(path, 'r')
  let length = 0
  try {
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (!count) break
      length += count
    }
  } finally { closeSync(fd) }
  return buffer.subarray(0, length).toString('utf8')
}

async function attempt(repetition) {
  const prefix = resolve(directory, String(repetition)), journal = prefix + '-journal'
  const args = [...(mode === 'liftoff-only' ? ['--liftoff-only'] : []), '--import', 'tsx', '--import',
    './scripts/record-node-test-process.mjs', '--test', '--test-reporter=tap', 'tests/integration/menu-modal.test.ts']
  const record = { repetition, startedAt: new Date().toISOString(), args, journal,
    status: null, signal: null, terminationReason: null, signalActions: [], observedClean: false }
  records.push(record); save()
  const beforeCores = new Set(cores()), tapPath = prefix + '.tap', stderrPath = prefix + '.stderr.log'
  const output = openSync(tapPath, 'wx'), stderrOutput = openSync(stderrPath, 'wx')
  let child, deadline, escalation, hardDeadline, outputWatch, leaderStart
  try {
    child = spawn(process.execPath, args, { cwd: process.cwd(), detached: true,
      env: { ...process.env, KRKR_MENU_LIFETIME_JOURNAL: journal }, stdio: ['ignore', output, stderrOutput] })
    record.pid = child.pid ?? null
    const exited = new Promise((done) => {
      child.once('error', (error) => { record.spawnError = String(error); done() })
      child.once('exit', (status, signal) => { record.status = status; record.signal = signal; done() })
    })
    if (child.pid) {
      record.initialGroup = groupMembers(child.pid)
      const leader = record.initialGroup.find((member) => member.pid === child.pid)
      leaderStart = leader?.startTicks
      record.groupIdentityConfirmed = !!leaderStart && leader.group === child.pid && leader.session === child.pid
      if (!record.groupIdentityConfirmed || record.initialGroup.some((member) => member.session !== child.pid))
        throw new Error('Could not confirm the original leader of the owned Linux session')
    }
    const terminate = (reason) => {
      if (record.terminationReason || !child.pid) return
      record.terminationReason = reason
      try { signalOwnedGroup(child.pid, leaderStart, 'SIGTERM', record.signalActions) }
      catch (error) { record.signalError = String(error) }
      escalation = setTimeout(() => {
        try { signalOwnedGroup(child.pid, leaderStart, 'SIGKILL', record.signalActions) }
        catch (error) { record.signalError = String(error) }
      }, terminationGraceMs)
      save()
    }
    activeTermination = terminate
    if (summary.interrupted) terminate('driver-' + summary.interrupted)
    deadline = setTimeout(() => terminate('attempt-timeout'), timeoutMs)
    outputWatch = setInterval(() => {
      try {
        if (statSync(tapPath).size + statSync(stderrPath).size > outputBudget) terminate('output-budget')
      } catch (error) { record.outputError = String(error); terminate('output-observation-error') }
    }, 500)
    const boundedExit = new Promise((done) => { hardDeadline = setTimeout(() => {
      terminate('attempt-timeout'); record.exitDeadlineExceeded = true; done()
    }, timeoutMs + 2 * terminationGraceMs) })
    await Promise.race([exited, boundedExit])
  } catch (error) { record.driverError = String(error) }
  finally {
    activeTermination = undefined
    clearTimeout(deadline); clearTimeout(escalation); clearTimeout(hardDeadline); clearInterval(outputWatch)
    if (child?.pid) {
      try { record.cleanup = await cleanupGroup(child.pid, leaderStart, record.signalActions) }
      catch (error) { record.cleanup = { confirmed: false, error: String(error) } }
    } else record.cleanup = { confirmed: true, noChildCreated: true }
    closeSync(output); closeSync(stderrOutput)
  }
  record.finishedAt = new Date().toISOString()
  record.cores = cores().filter((name) => !beforeCores.has(name))
  let events = []
  try { events = journalEvents(journal) }
  catch (error) { record.journalError = String(error) }
  record.registered = events.filter((event) => event.event === 'definition:registered').map((event) => event.name)
  record.started = events.filter((event) => event.event === 'definition:start').map((event) => event.name)
  record.passed = events.filter((event) => event.event === 'definition:pass').map((event) => event.name)
  record.failed = events.filter((event) => event.event === 'definition:fail')
  record.processes = events.filter((event) => event.event === 'process:start')
  record.exceptions = events.filter((event) => event.event === 'process:uncaught-exception')
  record.processExits = events.filter((event) => event.event === 'process:exit')
  record.modeConfirmed = record.processes.length > 0 && record.processes.every((event) =>
    event.node === 'v24.19.0' && event.execPath === process.execPath && event.nodeOptions === '' &&
    Array.isArray(event.execArgv) && event.execArgv.includes('--liftoff-only') === (mode === 'liftoff-only'))
  const complete = [record.registered, record.started, record.passed].every((names) => names.length === 24 && new Set(names).size === 24) &&
    record.registered.every((name) => record.started.includes(name) && record.passed.includes(name)) &&
    record.failed.length === 0 && record.exceptions.length === 0 &&
    record.processes.every((entry) => record.processExits.some((exit) => exit.pid === entry.pid && exit.code === 0))
  record.outputBytes = { tap: statSync(tapPath).size, stderr: statSync(stderrPath).size }
  record.outputBudgetExceeded = record.outputBytes.tap + record.outputBytes.stderr > outputBudget
  const tap = logPrefix(tapPath), stderr = logPrefix(stderrPath)
  record.observedClean = record.status === 0 && !record.signal && !record.spawnError && !record.driverError &&
    !record.terminationReason && !record.signalError && !record.outputError && !record.outputBudgetExceeded && !record.exitDeadlineExceeded &&
    record.groupIdentityConfirmed && record.cleanup.confirmed && record.cleanup.initiallyRemaining?.length === 0 && !record.journalError &&
    complete && record.modeConfirmed && record.cores.length === 0 &&
    /^# tests 24\s*$/m.test(tap) && /^# pass 24\s*$/m.test(tap) && /^# fail 0\s*$/m.test(tap) &&
    /^# cancelled 0\s*$/m.test(tap) && /^# skipped 0\s*$/m.test(tap) && /^# todo 0\s*$/m.test(tap) &&
    !tap.includes('MENU_LIFETIME_JOURNAL_INCOMPLETE') && !stderr.includes('MENU_LIFETIME_JOURNAL_INCOMPLETE')
  save()
  return record.cleanup.confirmed
}

try {
  if (process.version !== 'v24.19.0') throw new Error('Menu crash comparison requires exact Node v24.19.0')
  if (provenance.nodeOptions || process.execArgv.length) throw new Error('Unexpected Node options in diagnostic driver')
  const manifest = JSON.parse(readFileSync('.generated/wasm/manifest.json', 'utf8')), assets = manifest.variants.asyncify
  summary.nodeHash = hash(process.execPath)
  summary.manifestHash = hash('.generated/wasm/manifest.json')
  summary.build = JSON.parse(readFileSync('out/ci/build-info.json', 'utf8'))
  summary.wasmHash = hash(resolve('.generated/wasm', assets.wasm.file))
  summary.moduleHash = hash(resolve('.generated/wasm', assets.mjs.file))
  summary.sources = Object.fromEntries(['tests/integration/menu-modal.test.ts', 'tests/helpers/menu-lifetime-journal.ts',
    'scripts/run-menu-lifetime-diagnostic.mjs', 'scripts/record-node-test-process.mjs'].map((path) => [path, hash(path)]))
  if (summary.build.commit !== provenance.commit || summary.build.runId !== provenance.runId || String(summary.build.attempt) !== provenance.attempt)
    throw new Error('Menu diagnosis must consume this exact workflow run/attempt build')
  if (summary.wasmHash !== assets.wasm.sha256 || summary.moduleHash !== assets.mjs.sha256)
    throw new Error('Restored menu diagnostic kernel does not match its manifest')
  save()
  for (let repetition = 1; repetition <= 3; repetition++) {
    if (summary.interrupted) {
      for (let next = repetition; next <= 3; next++) records.push({ repetition: next,
        observedClean: false, notStarted: 'Diagnostic driver interrupted by ' + summary.interrupted })
      break
    }
    const cleaned = await attempt(repetition)
    if (!cleaned) {
      // Never overlap a fresh experiment with an owned tree we could not reap.
      // Record missing repetitions as failure instead of silently omitting them.
      for (let next = repetition + 1; next <= 3; next++) records.push({ repetition: next,
        observedClean: false, notStarted: 'Previous owned process group cleanup could not be confirmed' })
      break
    }
  }
  summary.complete = records.length === 3 && records.every((record) => record.finishedAt)
  summary.observedClean = summary.complete && !summary.interrupted && records.every((record) => record.observedClean)
} catch (error) { summary.error = String(error); summary.stack = error instanceof Error ? error.stack : undefined }
save()
if (!summary.observedClean) process.exitCode = 1
