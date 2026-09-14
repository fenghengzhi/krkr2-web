// This report validates and archives existing hosted results; it runs on Actions.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run verification reports on GitHub Actions')
const directory = 'out/verification/hosted-evidence'
const browsers = ['chromium', 'firefox', 'webkit']
const backends = ['asyncify', 'jspi']
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hash = async (path) => digest(await readFile(path))
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8' })
const applicationPaths = [
  'src',
  'native',
  'third_party',
  'public',
  'examples',
  'scripts',
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.ts',
  'tsconfig*.json',
]
const regularTestPaths = [
  '.github/workflows/test.yml',
  'tests/conformance',
  'tests/integration',
  'tests/browser',
  'tests/library-browser',
  'tests/pwa-browser',
  'tests/activity-native-browser',
  'tests/helpers',
  'tests/fixtures',
  'playwright*.ts',
  'tests/probes/vm-runtime-browser.ts',
  'tests/probes/vm-runtime-entry.ts',
  ':(exclude)tests/helpers/probe-browsers.ts',
  ':(exclude)tests/fixtures/compatibility',
]
function unchanged(commit, paths) {
  assert.match(commit, /^[a-f0-9]{40}$/)
  execFileSync('git', ['diff', '--exit-code', commit, 'HEAD', '--', ...paths], { stdio: 'inherit' })
}
await mkdir(directory, { recursive: true })
async function run(key, workflow, jobCount, downloadArgs) {
  const id = process.env[key]
  assert.match(id ?? '', /^\d+$/)
  const info = JSON.parse(
    command('gh', [
      'run',
      'view',
      id,
      '--json',
      'databaseId,status,conclusion,headSha,jobs,url,workflowName,attempt',
    ]),
  )
  assert.equal(info.status, 'completed')
  assert.equal(info.conclusion, 'success')
  assert.equal(info.workflowName, workflow)
  assert.equal(info.jobs.length, jobCount)
  for (const job of info.jobs) assert.equal(job.conclusion, 'success', job.name)
  unchanged(info.headSha, applicationPaths)
  const root = `${directory}/${id}`
  await mkdir(root, { recursive: true })
  await writeFile(root + '/run.json', JSON.stringify(info, null, 2) + '\n')
  execFileSync('gh', ['run', 'download', id, ...downloadArgs, '--dir', root + '/artifacts'], {
    stdio: 'inherit',
  })
  return { id, root, info }
}
const base = await run('KRKR_BUILD_RUN', 'Tests', 14, ['--pattern', '*-results*'])
unchanged(base.info.headSha, regularTestPaths)
const compatibility = await run('KRKR_COMPATIBILITY_RUN', 'KAG and release compatibility', 3, [
  '--pattern',
  'compatibility-*',
])
unchanged(compatibility.info.headSha, [
  'tests/fixtures',
  'tests/helpers',
  // Only the full/native lifecycle suites import this helper. Their exact
  // version is checked with regularTestPaths (and the optional freeze run).
  ':(exclude)tests/helpers/native-activity-browser.ts',
  // Only regular/direct runtime and allocator diagnostics import this fixture.
  // Both exact versions are checked separately in this report.
  ':(exclude)tests/helpers/bytecode-lifetime.ts',
  ':(exclude)tests/helpers/execution-budget.ts',
  'tests/probes/system-abi-pwa.ts',
  'tests/probes/system-kag-matrix.mjs',
  'tests/probes/kag-browser.ts',
  'tests/probes/debug-kag.ts',
  'tests/probes/debug-panels-kag.ts',
  'tests/probes/prepare-compatibility.py',
  '.github/workflows/compatibility.yml',
])
const freeze = process.env.KRKR_FREEZE_RUN
  ? await run('KRKR_FREEZE_RUN', 'Native lifecycle diagnostic', 1, [
      '--name',
      'native-diagnostic-results',
    ])
  : undefined
if (freeze)
  unchanged(freeze.info.headSha, [
    'tests/activity-native-browser/freeze-deadlines.spec.ts',
    'tests/helpers/native-activity-browser.ts',
  ])
const buildInfo = await json('out/ci/build-info.json')
assert.equal(buildInfo.commit, base.info.headSha)
assert.equal(buildInfo.runId, base.id)
assert.equal(Number(buildInfo.attempt), base.info.attempt)
const build = await verifyOfflineBuild('dist', '/')
const wasm = await json('dist/wasm/manifest.json')
const font = await json('dist/fonts/manifest.json')
assert([3, 4, 5].includes(wasm.abi))
const lifetimePhase = wasm.capabilities?.bytecodeLifecycle === 1
const executionPhase = wasm.capabilities?.executionBudgets === 1
if (executionPhase) assert(lifetimePhase)
if (lifetimePhase) assert.equal(wasm.diagnosticAllocator, false)
const binaryPhase = wasm.capabilities?.binaryScripts === 1
const compilerPhase = wasm.capabilities?.cooperativeCompilation === 1
if (binaryPhase) assert(compilerPhase)
const scriptsPhase = wasm.abi === 5
if (compilerPhase) assert(scriptsPhase)
const tracePhase = wasm.abi >= 4
const nodeCount = executionPhase
  ? 398
  : lifetimePhase
    ? 392
    : binaryPhase
      ? 384
      : compilerPhase
        ? 371
        : scriptsPhase
          ? 362
          : tracePhase
            ? 351
            : 346
const browserCount = binaryPhase
  ? 639
  : compilerPhase
    ? 621
    : scriptsPhase
      ? 615
      : tracePhase
        ? 609
        : 603
const compatibilityCount = scriptsPhase ? 78 : tracePhase ? 72 : 66
if (!tracePhase) assert(freeze, 'The historical VM console phase requires its freeze diagnostic')
assert.equal(font.abi, 2)
assert((await readFile('src/protocol/session.ts', 'utf8')).includes('PROTOCOL_VERSION = 9'))
const indexSha256 = await hash('dist/index.html')
const fixture = await json('out/ci/compatibility-fixtures.json')
const fixtureManifest = await json('tests/fixtures/compatibility/manifest.json')

async function files(root) {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort()
}
async function tree(root) {
  const entries = []
  for (const path of await files(root)) {
    const bytes = await readFile(path)
    entries.push([relative(resolve(root), path), bytes.length, digest(bytes)])
  }
  return {
    files: entries.length,
    bytes: entries.reduce((n, row) => n + row[1], 0),
    sha256: digest(JSON.stringify(entries)),
  }
}
function combinations(rows, expected, key) {
  assert.equal(rows.length, expected.length)
  assert.deepEqual(rows.map(key).sort(), [...expected].sort())
}
function checkGraphics(report, browser) {
  assert.equal(report.browser, browser)
  assert.deepEqual(report.graphics.pixel, [255, 0, 0, 255])
  assert.equal(report.graphics.error, 0)
  assert.equal(report.graphics.jspi, true)
}
function playwright(report, count) {
  assert.deepEqual(
    [report.stats.expected, report.stats.unexpected, report.stats.flaky, report.stats.skipped],
    [count, 0, 0, 0],
  )
  assert.deepEqual(report.errors, [])
  const cases = []
  function visit(suite) {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests) {
        assert.equal(spec.ok, true)
        assert.equal(test.expectedStatus, 'passed')
        assert.equal(test.status, 'expected')
        assert.equal(test.results.length, 1, 'No retry can replace a failing result')
        const result = test.results[0]
        assert.equal(result.status, 'passed')
        assert.equal(result.retry, 0)
        assert.deepEqual(result.errors, [])
        cases.push({ title: spec.title, project: test.projectName, result })
      }
    for (const child of suite.suites ?? []) visit(child)
  }
  report.suites.forEach(visit)
  assert.equal(cases.length, count)
  return cases
}
function frozenIntervals(cases, count) {
  const intervals = []
  for (const row of cases.filter((row) =>
    row.title.includes('longer than media request deadlines'),
  )) {
    const attachment = row.result.attachments.find((a) => a.name === 'trusted-lifecycle')
    assert(attachment?.body)
    const events = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'))
    const frozen = events.find((e) => e.event === 'freeze')
    const resumed = events.find((e) => e.event === 'resume')
    assert(frozen.trusted && resumed.trusted && resumed.time - frozen.time > 21000)
    intervals.push({ milliseconds: resumed.time - frozen.time, events })
  }
  assert.equal(intervals.length, count)
  return intervals
}

const nodeLog = await readFile(base.root + '/artifacts/node-results/node.log', 'utf8')
for (const line of [
  `ℹ tests ${nodeCount}\n`,
  `ℹ pass ${nodeCount}\n`,
  'ℹ fail 0\n',
  'ℹ skipped 0\n',
  'ℹ cancelled 0\n',
])
  assert(nodeLog.includes(line), line)
const suites = [],
  contexts = [],
  mediaClocks = [],
  overlayFrames = [],
  browserControls = []
for (const browser of browsers)
  for (const suite of ['browser', 'library', 'pwa']) {
    const root = `${base.root}/artifacts/browser-results-${browser}-${suite}`
    const report = await json(root + '/out/ci/results.json')
    const count =
      suite === 'browser'
        ? binaryPhase
          ? 172
          : compilerPhase
            ? 166
            : scriptsPhase
              ? 164
              : tracePhase
                ? 162
                : 160
        : suite === 'pwa' && browser !== 'webkit'
          ? 20
          : 19
    const cases = playwright(report, count)
    assert(cases.every((row) => row.project === browser))
    if (binaryPhase && suite === 'browser') {
      for (const [kind, title] of [
        ['menuUpdate', 'KAG callbacks, macros and script menus work in the Worker'],
        [
          'videoFirstFrame',
          'video open waits for its first frame and stop releases the pending callback',
        ],
        [
          'videoClock',
          'media clock delivers period and EOF segment loops when presentation callbacks are withheld',
        ],
        ['tlgCancellation', 'stopping during TLG expansion cancels without terminating the worker'],
      ]) {
        const selected = cases.filter((row) => row.title.endsWith(title))
        combinations(selected, backends, (row) => row.title.split(':')[0])
        browserControls.push(...selected.map((row) => ({ browser, kind, title: row.title })))
      }
    }
    if (compilerPhase && suite === 'browser') {
      const overlays = cases.filter((row) => row.title.includes('overlay geometry, mixer alpha'))
      assert.equal(overlays.length, 2)
      for (const row of overlays) {
        const attachment = row.result.attachments.find((item) => item.name === 'overlay-frame')
        assert(attachment?.body)
        const observed = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'))
        assert.equal(observed.mediaTime, 0.5)
        assert.equal(observed.seeking, false)
        assert.equal(observed.paused, true)
        assert(observed.presentedFrames > 0 && Math.abs(observed.position - 0.5) < 0.001)
        assert(observed.pixel[0] > 100 && observed.pixel[1] > 100 && observed.pixel[2] < 30)
        overlayFrames.push({ browser, title: row.title, ...observed })
      }
    }
    checkGraphics(await json(root + '/out/ci/capabilities.json'), browser)
    assert.deepEqual(await json(root + '/out/ci/build-info.json'), buildInfo)
    suites.push({ browser, suite, ...report.stats, workers: report.config.workers })
    for (const path of await files(root)) {
      if (path.endsWith('/persistent-context.json')) {
        const record = await json(path)
        assert(
          record.fixtureTimeoutMs === 30000 &&
            record.testTimeoutMs === 30000 &&
            record.setupMs > 0 &&
            record.setupMs < 30000,
        )
        contexts.push({ suite, ...record })
      }
      if (path.endsWith('/media-clock.json')) {
        const record = await json(path)
        assert(record.setter && record.records.some((e) => e.event === 'visibilitychange'))
        mediaClocks.push({ browser, ...record })
      }
    }
  }
assert.equal(contexts.length, 116)
assert.equal(mediaClocks.length, 6)
const native = await json(
  base.root + '/artifacts/native-activity-results/out/verification/activity/native-check.json',
)
const nativeIntervals = frozenIntervals(playwright(native, 7), 1)
const repeatedIntervals = freeze
  ? frozenIntervals(
      playwright(
        await json(freeze.root + '/artifacts/out/verification/activity/native-check.json'),
        3,
      ),
      3,
    )
  : []
const inputRun =
  (tracePhase && !scriptsPhase) || process.env.KRKR_INPUT_RUN
    ? await run('KRKR_INPUT_RUN', 'Input activity diagnostic', 3, ['--pattern', 'input-activity-*'])
    : undefined
if (inputRun) {
  unchanged(inputRun.info.headSha, [
    'tests/browser/activity.spec.ts',
    'tests/integration/input-focus-activity.test.ts',
    'tests/helpers/activity-browser.ts',
    '.github/workflows/input-activity.yml',
  ])
  for (const browser of browsers) {
    const root = `${inputRun.root}/artifacts/input-activity-${browser}/out/ci`
    const cases = playwright(await json(root + '/input-results.json'), 10)
    assert(
      cases.every(
        (row) => row.project === browser && row.title.includes('backgrounding drops held input'),
      ),
    )
    if (browser === 'chromium') {
      const log = await readFile(root + '/input-focus.log', 'utf8')
      for (const line of ['tests 1', 'pass 1', 'fail 0', 'cancelled 0', 'skipped 0'])
        assert(log.includes('ℹ ' + line + '\n'))
    }
  }
}
const runtime = await json(
  base.root + '/artifacts/runtime-results/verification/vm-console/runtime-browser.json',
)
function releasedExecution(state) {
  for (const field of ['depth', 'bytes', 'functions', 'tries', 'delegations'])
    assert.equal(state[field], 0, field)
  assert.equal(state.depthLimit, 256)
  assert.equal(state.functionLimit, 128)
  assert.equal(state.delegationLimit, 128)
  assert.equal(state.byteLimit, 16 * 1024 * 1024)
  assert.equal(state.stackReserve, 64 * 1024)
  assert(state.peakDepth <= state.depthLimit)
  assert(state.peakFunctions <= state.functionLimit)
  assert(state.peakDelegations <= state.delegationLimit)
  assert(state.peakBytes <= state.byteLimit)
}
assert.deepEqual(runtime.manifest, wasm)
if (lifetimePhase) assert.deepEqual(runtime.failures, [])
combinations(
  runtime.results,
  browsers.flatMap((b) => backends.map((v) => b + '/' + v)),
  (row) => row.browser + '/' + row.backend,
)
for (const row of runtime.results) {
  assert(row.compiledBytes > 0 && row.dumpBytes > 0 && row.held)
  assert.equal(row.handles, 0)
  assert.equal(row.shutdownMessages, 0)
  assert.equal(row.cancelled, 'AbortError: Execution cancelled')
  assert.match(row.primary, /browserPrimaryMissing/)
  assert.deepEqual(row.errors, [])
  if (executionPhase) {
    const execution = row.executionBudgets
    combinations(execution.checks, ['false', 'true'], (item) => String(item.debugMode))
    for (const check of execution.checks) {
      combinations(
        check.results,
        [
          'function/source',
          'function/bytecode',
          'try/source',
          'try/bytecode',
          'mixed/source',
          'mixed/bytecode',
          'superclass-cycle',
          'host-continuations',
          'wide-registers',
          'argument-memory',
          'argument-count',
        ],
        (item) => item.scenario,
      )
      for (const result of check.results) {
        assert(result.message.includes('VM '))
        releasedExecution(result.state)
      }
      combinations(check.automaticInstances, ['false', 'true'], (item) => String(item.binary))
      for (const instance of check.automaticInstances) {
        assert.equal(instance.finalized, 1)
        releasedExecution(instance.state)
      }
      releasedExecution(check.final)
      assert.equal(check.native.contexts, 0)
      assert.equal(check.native.blocks, 0)
    }
    for (const controls of [execution.continuations, execution.arguments]) {
      combinations(controls, ['false', 'true'], (item) => String(item.cancel))
      for (const control of controls) {
        releasedExecution(control.after)
        assert.equal(control.heldMs, 25)
        assert.equal(control.error, control.cancel ? 'AbortError' : null)
      }
    }
    for (const control of execution.continuations) {
      assert(control.held.functions >= 65 && control.held.tries >= 65)
      assert.equal(control.nativeReplyKind, control.cancel ? 1 : 0)
    }
    for (const control of execution.arguments) {
      assert(control.observed.bytes > 8 * 1024 * 1024)
      assert.equal(control.resources.blocks, control.before.blocks)
      assert.equal(control.resources.contexts, control.before.contexts)
      assert(control.resources.heap <= control.before.heap + 64 * 1024)
    }
  }
  if (lifetimePhase) {
    const lifetime = row.bytecode.lifetime
    assert.equal(lifetime.loads, 13)
    assert.equal(lifetime.rejected, 39)
    assert.deepEqual(lifetime.before, lifetime.after)
    assert.equal(lifetime.after.contexts, 0)
    assert.equal(lifetime.after.blocks, 0)
    assert.equal(lifetime.handles, 0)
    combinations(
      row.bytecode.controls,
      ['6/false', '6/true', '7/false', '7/true', '8/false', '8/true'],
      (item) => item.phase + '/' + item.cancel,
    )
    for (const item of row.bytecode.controls) {
      assert.equal(item.heldMs, 25)
      assert.equal(item.yields, 1)
      assert.equal(item.after.blocks, item.before.blocks)
      assert.equal(item.after.contexts, item.before.contexts)
      assert.equal(item.error, item.cancel ? 'AbortError' : null)
      assert(item.observed.heap > item.before.heap)
      if (item.phase !== 6) assert(item.observed.contexts > item.before.contexts)
    }
  }
  if (binaryPhase) {
    combinations(row.binary, ['false', 'true'], (item) => String(item.cancel))
    for (const item of row.binary) {
      assert.equal(item.heldMs, 25)
      assert(item.yields > 0)
      assert.equal(item.elements, item.cancel ? 0 : 500000)
      assert.equal(item.handles, 0)
      assert.equal(item.invalidRejected, 2)
      assert.equal(item.error, item.cancel ? 'AbortError' : null)
    }
  }
  if (compilerPhase) {
    combinations(
      row.compiler,
      ['1/false', '1/true', '2/false', '2/true', '3/false', '3/true'],
      (item) => item.phase + '/' + item.cancel,
    )
    for (const item of row.compiler) {
      assert.equal(item.handles, 0)
      assert.equal(item.heldMs, 25)
      assert(item.yields[item.phase] > 0)
      assert.equal(item.error, item.cancel ? 'AbortError' : null)
      if (item.cancel) assert.equal(item.bytes, 0)
      else {
        assert(item.bytes > 8 * 1024 * 1024)
        for (const phase of [1, 2, 3]) assert(item.yields[phase] > 0)
      }
    }
  }
  if (tracePhase) {
    assert(row.trace.nativeMethod && row.trace.defaultDisabled)
    assert.equal(row.trace.cancelled, 'AbortError: Execution cancelled')
    assert.equal(row.trace.traces.recovered, 'trace-recovery.tjs(1)[(top level script) global]')
    assert.equal(row.trace.traces.fresh, 'fresh-trace.tjs(1)[(top level script) global]')
    assert.equal(Object.keys(row.trace.traces).length, 7)
  }
}
assert.equal(
  await hash(base.root + '/artifacts/runtime-results/verification/vm-console/runtime/runtime.mjs'),
  runtime.bundleSha256,
)

const external = []
for (const browser of browsers) {
  const root = `${compatibility.root}/artifacts/compatibility-${browser}`
  const reports = root + '/verification/compatibility'
  // Compatibility may reuse an earlier build while the full suite fixes tests.
  // Its application sources and complete release digests must still match.
  const compatibilityBuild = await json(root + '/ci/build-info.json')
  unchanged(compatibilityBuild.commit, applicationPaths)
  assert.deepEqual(await json(root + '/ci/compatibility-fixtures.json'), fixture)
  checkGraphics(await json(root + '/ci/capabilities.json'), browser)
  const pathFor = (path) => {
    assert(path.startsWith('out/verification/compatibility/') && !path.split('/').includes('..'))
    return root + '/' + path.slice(4)
  }
  for (const name of ['kag', 'kag-panels', 'kag-diagnostics']) {
    const report = await json(`${reports}/${name}.json`)
    assert.equal(report.indexSha256, indexSha256)
    assert.equal(report.sourceSha256, fixture.kag.sourceSha256)
    if (name === 'kag') {
      assert.equal(report.zipSha256, fixture.kag.zipSha256)
      combinations(
        report.results,
        ['xp3', 'zip'].flatMap((c) =>
          backends.flatMap((b) => ['flow', 'save', 'transition'].map((m) => `${c}/${b}/${m}`)),
        ),
        (row) => `${row.container}/${row.backend}/${row.mode}`,
      )
    } else combinations(report.results, backends, (row) => row.backend)
    for (const row of report.results) {
      assert.equal(row.browser, browser)
      if (name === 'kag') {
        assert.equal(await hash(pathFor(row.report)), row.sha256)
        assert.equal(await hash(pathFor(row.log)), row.logSha256)
        const expected = {
          flow: ['line', 'history', 'page', 'link', 'choice'],
          save: ['plain-save', 'plain-load', 'thumbnail-8', 'thumbnail-24', 'reload'],
          transition: ['crossfade', 'scroll', 'universal', 'done'],
        }
        assert.deepEqual(row.steps, expected[row.mode])
      } else {
        assert.deepEqual(row.errors, [])
        if (name === 'kag-panels')
          assert(row.originalMenuHandlers && row.originalShortcuts && row.independentVisibility)
        else {
          assert(row.originalHandler && row.primaryLogged && row.observersNotified && row.recovered)
          assert.equal(await hash(pathFor(row.log)), row.logSha256)
        }
      }
      assert((await readFile(pathFor(row.screenshot))).length > 0)
    }
    external.push({ browser, name, ...report })
  }
  for (const [name, id, manifestKind] of [
    ['abi-pwa', 'tjs-abi1', 'wasm'],
    ['runtime-abi-pwa', 'tjs-abi2', 'wasm'],
    ['font-abi-pwa', 'font-abi1', 'fonts'],
    ...(tracePhase ? [['trace-abi-pwa', 'tjs-abi3', 'wasm']] : []),
    ...(scriptsPhase ? [['scripts-abi-pwa', 'tjs-abi4', 'wasm']] : []),
  ]) {
    const report = await json(`${reports}/${name}.json`)
    const old = fixtureManifest.releases.find((release) => release.id === id)
    const oldManifest = await json(
      `out/verification/compatibility-baselines/${id}/${manifestKind}/manifest.json`,
    )
    assert.deepEqual(report.manifests, [oldManifest, manifestKind === 'wasm' ? wasm : font])
    combinations(report.results, backends, (row) => row.backend)
    for (const row of report.results) {
      assert.equal(row.browser, browser)
      assert.equal(row.oldBuild, old.build)
      assert.equal(row.newBuild, build.build)
      assert.equal(row.oldAbi, oldManifest.abi)
      assert.equal(row.newAbi, manifestKind === 'wasm' ? wasm.abi : 2)
      if (id === 'tjs-abi3') assert(row.nativeTraceVerified)
      if (id === 'tjs-abi4') assert(row.nativeScriptsClassAndCompilerVerified)
      assert(row.oldWorkerRestartedOffline && row.newWorkerStartedOffline)
      assert(row.caches.some((key) => key.endsWith(row.oldBuild)))
      assert(row.caches.some((key) => key.endsWith(row.newBuild)))
      assert.deepEqual(row.errors, [])
      assert.equal(row.startupTimeoutMs, 12000)
      assert.deepEqual(
        row.startups.map(({ release, offline }) => ({ release, offline })),
        [
          { release: 'old', offline: false },
          { release: 'old', offline: true },
          { release: 'current', offline: true },
        ],
      )
      assert(
        row.startups.every(
          (startup) => Number.isFinite(startup.milliseconds) && startup.milliseconds > 0,
        ),
      )
      if (manifestKind === 'wasm') assert(row.nativeClassesAndDumpVerified)
      else
        for (const manifest of report.manifests)
          assert(row.fontRequests.some((url) => url.endsWith('/' + manifest.assets.wasm.file)))
    }
    external.push({ browser, name, ...report })
  }
}
assert.equal(
  external.reduce((n, report) => n + report.results.length, 0),
  compatibilityCount,
)
let allocations
const allocatorReports = []
const executionAllocatorReports = []
if (lifetimePhase) {
  allocations = await run('KRKR_ALLOCATIONS_RUN', 'Bytecode allocation diagnostic', 2, [
    '--pattern',
    'bytecode-allocations-*',
  ])
  unchanged(allocations.info.headSha, [
    'tests/helpers/bytecode-lifetime.ts',
    'tests/helpers/binary-scripts.ts',
    'tests/probes/bytecode-allocation-faults.ts',
    ...(executionPhase
      ? ['tests/helpers/execution-budget.ts', 'tests/probes/execution-allocation-faults.ts']
      : []),
    '.github/workflows/bytecode-allocations.yml',
  ])
  for (const backend of backends) {
    const root = `${allocations.root}/artifacts/bytecode-allocations-${backend}`
    const report = await json(`${root}/out/ci/allocations-${backend}.json`)
    assert.equal(report.variant, backend)
    assert.equal(report.manifest.diagnosticAllocator, true)
    assert.equal(report.manifest.capabilities.bytecodeLifecycle, 1)
    assert.notEqual(report.manifest.source.sha256, wasm.source.sha256)
    assert.deepEqual(report.failures, [])
    for (const phase of [6, 7, 8]) {
      const rows = report.results.filter((item) => item.phase === phase)
      assert(rows.length > 1)
      rows.forEach((item, index) => {
        assert.equal(item.after, index)
        assert.equal(item.hits, index === rows.length - 1 ? 0 : 1)
        assert.deepEqual(item.current, item.before)
        assert.equal(item.current.contexts, 0)
        assert.equal(item.current.blocks, 0)
      })
    }
    const growth = report.results.filter((item) => item.target)
    combinations(growth, ['baseline', 'string_block', 'string_index'], (item) => item.target)
    for (const item of growth) assert.deepEqual(item.disposed, growth[0].disposed)
    const manifest = await json(`${root}/.generated/wasm/manifest.json`)
    assert.deepEqual(manifest, report.manifest)
    for (const asset of [manifest.variants[backend].mjs, manifest.variants[backend].wasm])
      assert.equal(await hash(`${root}/.generated/wasm/${asset.file}`), asset.sha256)
    allocatorReports.push(report)
    if (executionPhase) {
      const execution = await json(`${root}/out/ci/execution-allocations-${backend}.json`)
      assert.deepEqual(execution.manifest, manifest)
      assert.equal(execution.variant, backend)
      assert.equal(execution.manifest.capabilities.executionBudgets, 1)
      assert.deepEqual(execution.failures, [])
      for (const debugMode of [false, true])
        for (const [name, phase] of [
          ['pooled-frames', 9],
          ['collapsed-arguments', 9],
          ['expanded-arguments', 10],
        ]) {
          const rows = execution.results.filter(
            (item) => item.name === name && item.debugMode === debugMode,
          )
          assert(rows.length > 2)
          rows.forEach((item, index) => {
            assert.equal(item.phase, phase)
            assert.equal(item.after, index - 1)
            assert.equal(item.hits, index === 0 || index === rows.length - 1 ? 0 : 1)
            assert.deepEqual(item.disposed, rows[0].disposed)
            assert.deepEqual(item.baseline, rows[0].disposed)
            assert.equal(item.current.contexts, item.before.contexts)
            assert.equal(item.current.blocks, item.before.blocks)
            releasedExecution(item.state)
          })
        }
      executionAllocatorReports.push(execution)
    }
  }
}
const pwaDiagnostic = process.env.KRKR_PWA_RUN
  ? await run('KRKR_PWA_RUN', 'PWA native crash diagnostic', 1, [
      '--name',
      'pwa-native-crash-results',
    ])
  : undefined
let offlineRestarts = []
if (pwaDiagnostic) {
  unchanged(pwaDiagnostic.info.headSha, [
    ...regularTestPaths,
    '.github/workflows/pwa-native-diagnostic.yml',
  ])
  const report = await json(`${pwaDiagnostic.root}/artifacts/out/ci/results.json`)
  // A named single artifact extracts its contents directly into artifacts/.
  offlineRestarts = playwright(report, 20)
  for (const row of offlineRestarts) {
    assert.equal(
      row.title,
      'jspi: native Debug classes and dump files survive a cold offline browser restart',
    )
    assert.equal(row.project, 'webkit')
  }
}
const evidence = {}
for (const path of await files(directory))
  evidence[relative(resolve(directory), path)] = await hash(path)
const matrix = {
  verifiedAt: new Date().toISOString(),
  execution: 'GitHub-hosted GitHub Actions',
  reportCommit: process.env.GITHUB_SHA,
  reportRun: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  runs: [
    base.info,
    compatibility.info,
    ...(allocations ? [allocations.info] : []),
    ...(pwaDiagnostic ? [pwaDiagnostic.info] : []),
    ...(freeze ? [freeze.info] : []),
    ...(inputRun ? [inputRun.info] : []),
  ],
  applicationSourcesMatchAllRuns: true,
  regularTestsMatchBaseRun: true,
  compatibilityProbesMatchRun: true,
  buildInfo,
  build,
  wasm,
  font,
  sessionProtocol: 9,
  passed: {
    node: nodeCount,
    browser: browserCount,
    directRuntime: 6,
    ...(executionPhase
      ? {
          executionBudgets: 132,
          automaticInstances: 24,
          deepContinuationControls: 12,
          argumentControls: 12,
          executionAllocatorFailures: executionAllocatorReports.reduce(
            (sum, report) => sum + report.results.filter((item) => item.hits === 1).length,
            0,
          ),
        }
      : {}),
    ...(pwaDiagnostic ? { coldOfflineRestartDiagnostics: offlineRestarts.length } : {}),
    ...(lifetimePhase
      ? {
          bytecodeControls: 36,
          bytecodeLifetimes: 6,
          allocatorFailures: allocatorReports.reduce(
            (sum, report) => sum + report.results.filter((item) => item.hits === 1).length + 2,
            0,
          ),
        }
      : {}),
    ...(binaryPhase ? { binaryInputControls: 12, browserControls: browserControls.length } : {}),
    ...(compilerPhase ? { nativeCompilerControls: 36 } : {}),
    kag: 36,
    kagPanels: 6,
    kagDiagnostics: 6,
    tjsAbi1: 6,
    tjsAbi2: 6,
    ...(tracePhase ? { tjsAbi3: 6 } : {}),
    ...(scriptsPhase ? { tjsAbi4: 6, exportedOperatorCombinations: 64 } : {}),
    ...(inputRun ? { inputFocusReproduction: 1, repeatedInputCleanup: 30 } : {}),
    fontAbi1: 6,
    repeatedTrustedFreeze: repeatedIntervals.length,
    selectedSkipped: 0,
    flaky: 0,
    retries: 0,
  },
  suites,
  nativeIntervals,
  repeatedIntervals,
  persistentContexts: contexts,
  mediaClocks,
  overlayFrames,
  browserControls,
  runtime,
  allocatorReports,
  executionAllocatorReports,
  offlineRestarts,
  external,
  fixtureManifest,
  fixture,
  source: await tree('src'),
  tests: await tree('tests'),
  scripts: await tree('scripts'),
  documentation: await tree('docs'),
  releaseTree: await tree('dist'),
  treeHashFormat: fixtureManifest.treeHashFormat,
  evidence,
  previousMatrices: {
    ...fixtureManifest.historicalMatrices,
    ...(executionPhase
      ? { 'bytecode-lifetime': 'c3c5c665b1de52cc989edc0a3abad39001c0db1fc560baa49b1dfe63f798089b' }
      : {}),
    ...(lifetimePhase
      ? { 'binary-scripts': 'b941be09c8d5803d19a8c1014fad9b8dfa1a78351a17734808133117cd1c3041' }
      : {}),
    ...(binaryPhase
      ? { compiler: 'bd314e7bf7383553468685c6cea0db2d53998f265dd09b882d09733cdc7c55b9' }
      : {}),
    ...(compilerPhase
      ? { 'native-scripts': '1fab816e278b9746589c729509606aa1c0ad29156309136ce719f80dc22d0b7d' }
      : {}),
  },
  historicalFailures: [
    ...(executionPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34853858703',
            reason:
              'Initial execution-budget run passed 394/396 Node cases, but the new cases reached an Asyncify host RangeError before catchable recovery; other direct combinations exposed a try fixture block-scope mistake. Independent function/delegation limits and bounded resource-error formatting were added; the fixture now declares its result outside the try block. All six direct results failed and remain archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34854635620',
            reason:
              'All 188 existing bytecode allocation failures passed. New pooled-frame and expanded-argument allocation cases passed, but lazy Array native class construction leaked members/debug registrations when allocation failed. The failed enumeration and actual post-disposal heap differences remain archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34856407118',
            reason:
              'Both allocator jobs failed installing Emscripten with HTTP 504. No build or test ran and no test artifact was produced; workflow logs and metadata preserve this infrastructure failure.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34856337571',
            reason:
              'The corrected depth cases progressed, but Node passed 394/396 and all six direct combinations failed the argument-memory fixture: one million expanded arguments fit in the 16 MiB budget because native variants are smaller than the fixture assumed. The fixture now includes a collapsed-argument callee so the combined live copies actually exceed the budget. All 639 browser cases passed; this remains an overall failed run.',
          },
        ]
      : []),
    ...(lifetimePhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34847758637',
            reason:
              'All 392 Node cases passed; browser results were 638/639, with a WebKit JSPI cold offline native Debug restart reporting Page crashed. Its native cause remains unconfirmed and separate twenty-case macOS diagnosis preserves process/crash reports. The direct runtime failed in Chromium JSPI because copying one 8 MiB string finished within a time slice and never paused in phase 6. The fixed fixture now interns 32,700 independent strings while preserving pause/cancel/cleanup assertions; all six direct combinations are recorded without retry.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34847308669',
            reason:
              'Asyncify passed 92 allocation-site failures and two string-heap growth failures; JSPI failed before module creation because Node 24 required the explicit experimental-wasm-jspi flag. This is a partial diagnostic, not a two-backend pass.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34846307441',
            reason:
              'First lifecycle run failed three of 391 Node cases and the direct runtime. It exposed rejection of a superclass RET/NOP sentinel and instance-member self-reference retention. Sentinel validation was repaired; instances in explicit lifecycle tests are invalidated after checking their methods. Automatic cyclic instance reclamation remains incomplete. Preserve the original complete run and individual outcomes.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34846470235',
            reason:
              'Both diagnostic kernels failed linking because --wrap=malloc removed the export required by generated glue. No allocation failure test ran. The diagnostic now uses the supported Emscripten builtin allocator aliases.',
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34841341297',
            reason:
              'The initial TLG timer gate was superseded by a change selecting exactly one timer at registration. Build completed, test jobs were cancelled, and this run is not a verification pass.',
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34839918126',
            reason:
              'All 384 Node and six direct runtime cases passed; browser results were 638/639. The original WebKit Asyncify TLG cancellation case had already logged completion when stop was checked. Its fixed 4096-square fixture now holds the actual zero-delay decoder yield after allocating the expansion buffer, and releases it after the real stop RPC listener runs. Original pixels, stop budget and cancellation assertions are unchanged; the original failure remains archived.',
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34839357671',
            reason:
              'One original ZIP/WebKit/JSPI KAG startup failed with an unreadable native member name after construction. Forty independent repetitions of that transition case, twenty each with script tracing disabled/enabled, passed without reproducing it; no product root cause is claimed. The regular KAG runner now retains failing JSON/screenshots/traces inside its uploaded directory. The original failure log remains archived.',
            diagnostic: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34840243332',
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34839287423',
            reason:
              'The held-pointer menu fixture submitted the expression after pressing the menu; console focus scrolled the page and moved the physical mouse target. Node and direct runtimes passed, and Chromium video checks passed. The fixture now submits before opening the menu, holds only the outgoing evaluate request, and releases it after pointerdown. It verifies original node ownership and the physical hit target before release; original failed browser evidence remains archived.',
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34837825141',
            reason:
              'Menu typecheck rejected focus() on a generic Element selector. The selector now explicitly returns HTMLButtonElement; no tests ran in this failed build.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34838160395',
            reason:
              'The new held-pointer menu fixture submitted multiple statements to the expression console, so its acknowledgement never ran. The fixture now uses a comma expression. Native build, 384 Node cases and six direct runtimes passed; failed or superseded browser jobs remain archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34837150688',
            reason:
              'The WebKit original-overlay diagnostic reproduced 15 failures in 40 cases: seeked/currentTime acknowledged 0.5 while pixels and presentation metadata remained at the initial frame. A first-frame barrier comparison passed all 40 initial pixel assertions but failed one later segment-loop case (39/40 overall); hidden-layer comparison also exposed transparent loadeddata readback. Open now awaits the first native frame and media-clock events supplement presentation for crossed periods and segment boundaries. These diagnostics remain failures and are not full-suite passes.',
            comparisons: ['34838225383', '34838394481'],
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34836507523',
            reason:
              'All 384 Node cases and six direct runtimes passed; browser results were 626/627. WebKit Asyncify again retained the initial video frame after seek. Original failure logs, screenshot and trace are retained with the independent WebKit presentation diagnostic.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34836898714',
            reason:
              'Firefox JSPI original KAG menu validation timed out because a new menu snapshot replaced the DOM and closed the open Debug menu before the Controller click. Menu rendering now reconciles stable item IDs, and a held-pointer browser regression delivers a real TJS update between press and release. The failed compatibility trace remains archived.',
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34834878908',
            reason:
              'Node passed 383/384 cases and all seven unchanged input cases completed with TAP records. One new source-string expectation conflated zero-character escape append with binary NUL termination: native source yields ab, while a binary embedded NUL terminates the string. The distinct rules are now asserted explicitly. Browser results were 625/627: both WebKit overlay cases retained presented time 0 after seek and the failure screenshots showed the initial red frame. Original logs, screenshots and traces remain archived; a separate WebKit presentation diagnostic investigates this failure. The earlier input-process termination remains unexplained.',
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34833337700',
            reason:
              'Native build passed. New fixture assumptions conflicted with native NUL-terminated strings, nonempty member names, class-name instanceof checks and constructor syntax. Expectations now follow inspected TJS source, with empty keys retained as rejection cases. The Node input test subprocess also ended early without useful spec-reporter detail; TAP output was added. Failed and superseded results remain archived.',
          },
        ]
      : []),
    ...(binaryPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34832886756',
            reason:
              'The initial native validator build referenced a global error-message constant as a TJS namespace member. Compilation failed before tests; the namespace was corrected and the original build log is retained.',
          },
        ]
      : []),
    ...(compilerPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34827988522',
            reason:
              'All compiler and shutdown regressions passed. One Chromium Asyncify overlay screenshot still showed the initial red frame after the script seek acknowledgement; the original pixel assertion failed. Forty separately instrumented original cases passed without reproducing it and recorded distinct seeked/presentation events. The test now requires the target native frame callback before taking the same screenshot; browser-internal cause remains unconfirmed. Original logs and trace remain archived.',
            diagnostic: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34828858754',
          },
        ]
      : []),
    ...(compilerPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34827073341',
            reason:
              'All 371 Node cases, six direct browser runtimes with 36 compiler controls and native lifecycle checks passed. New page tests exposed startup rejection racing with user stop: both cleanup paths sent a stop RPC, so one disposed the other. Launch now leaves pending stop in charge of cleanup and UI state; Player also shares shutdown work. Failed browser logs and any superseded jobs remain historical evidence.',
          },
        ]
      : []),
    ...(scriptsPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34819597478',
            reason:
              'The first native Scripts run exposed omitted member/property variants in bytecode export. The exporter now converts all four forms. New statement fixtures now call Scripts.exec instead of the single-expression console; anonymous names and protected native exceptions follow the original VM semantics. The same run also exposed font selection moving during async previews; final bitmap geometry is now reserved before opening the dialog, with a held-pointer regression. Original failure evidence remains archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34821034573',
            reason:
              'GitHub billing prevented any build or test step from starting. A later source-changing run was admitted; this terminal run is not verification evidence.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34821659023',
            reason:
              'Native compilation passed, then typecheck rejected the font test gate because it omitted the transfer-array postMessage overload. The test now forwards both signatures.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34822033340',
            reason:
              'New compile cases exposed ignored Bison syntax errors and invalid bytecode metadata loading. Syntax errors now prevent execution/export; unnamed context indices and debug-table allocation use their correct native representations. Debug-output tests inspect character-position tables; native bytecode contains no original line table. Superseded tests remain recorded as cancelled.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34822580654',
            reason:
              'All 362 Node cases passed, but one native lifecycle fixture tried to create a CDP session before Chromium published its initial page. It now awaits that page within the original fixture budget. Other test jobs were superseded; this run is not a full pass.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34823107202',
            reason:
              'Importing the next game while stop was pending sent two stop RPCs; the first disposed the client before the second completed. App stop now shares one Promise. A browser gate holds stop until the next import, asserts one request, then verifies nested compilation and final shutdown. The original Firefox trace and superseded WebKit run remain archived.',
          },
        ]
      : []),
    ...(tracePhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34814477725',
            reason:
              'The background composition test hid the page before queued onMouseDown established script focus. The trace retained inputmode=none. The test now waits for the script focus acknowledgement; a blocked-VM reproduction and 30 original browser cleanup repetitions passed without changing production input handling.',
          },
        ]
      : []),
    {
      run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34811575232',
      reason:
        'Old font release startup on WebKit exceeded the standalone 5 s assertion. The failing trace already contains the ready marker at about 5.5 s after import; only startup now uses the regular suite 12 s budget. Old release bytes and upgrade assertions are unchanged.',
    },
    {
      run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34808210462',
      reason:
        'Media RPC timers counted trusted frozen time. Pausable request budgets were implemented; original failed runs remain historical evidence.',
    },
    {
      run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34809235409',
      reason:
        'Hosted WebKit concurrent startup was slow. Single-worker diagnosis and the subsequent complete regression passed; shared assertion budgets remain unchanged.',
    },
  ],
  incomplete: [
    ...(binaryPhase
      ? [
          'The historical WebKit JSPI original KAG startup member-name corruption was not reproduced in forty diagnostic cases; its native cause remains unconfirmed',
        ]
      : []),
    ...(tracePhase ? [] : ['Scripts.getTraceString']),
    ...(scriptsPhase
      ? [
          'Automatic legacy text detection and decoder latching, full bytecode validation and complete storage paths remain incomplete',
          ...(binaryPhase
            ? [
                executionPhase
                  ? 'Execution budgets and selected frame/argument allocation rollback are covered; arbitrary object cycles, implicit finalizer failures and remaining VM semantics still require implementation'
                  : lifetimePhase
                    ? 'Selected bytecode ownership, cancellation and allocator failures are covered; automatic cyclic instance reclamation, deep try/call stack budgets and remaining VM semantics still require implementation'
                    : 'Structural bytecode validation does not prove native allocation cleanup, deep try/call stack budgets or every VM instruction semantic; these still require audit',
              ]
            : [
                'Serialized Array/Dictionary resource execution and prefixed bytecode remain incomplete',
              ]),
          ...(compilerPhase
            ? [
                'Compiler checkpoints do not preempt allocations, native library algorithms, UTF-16 bridge copies or destruction; exact worst-case latency and native allocation leak accounting remain unverified',
              ]
            : ['Cooperative long compilation remains incomplete']),
        ]
      : []),
    ...(lifetimePhase
      ? [
          'Historical WebKit JSPI cold offline native Debug restart page-process crash has no confirmed root cause',
        ]
      : []),
    'Native error UI policy, remaining exception and finalizer paths, TJS bridge frames in other TVP methods',
    'Historical WebKit paused-video position discontinuity remains unrootcaused',
    ...(compilerPhase
      ? [
          'Historical Chromium overlay initial-frame screenshot cause remains unconfirmed; explicit native presentation readiness now precedes pixel assertions',
        ]
      : []),
    'Historical one-shot committed-input failure has no proven product root cause; acknowledgement-based checks remain',
    ...(binaryPhase
      ? [
          'The historical Node input.test.ts subprocess termination was not reproduced with TAP; its cause remains unconfirmed',
        ]
      : []),
    'Protocol 8 to 9 historical same-kernel probe was not rerun in this phase',
    'All remaining requirements in docs/non-plugin-progress.md; full non-plugin compatibility is not complete',
  ],
}
const reportName = executionPhase
  ? 'execution-budgets-matrix.json'
  : lifetimePhase
    ? 'bytecode-lifetime-matrix.json'
    : binaryPhase
      ? 'binary-scripts-matrix.json'
      : compilerPhase
        ? 'compiler-matrix.json'
        : scriptsPhase
          ? 'native-scripts-matrix.json'
          : tracePhase
            ? 'stack-traces-matrix.json'
            : 'vm-console-matrix.json'
const output = 'out/verification/' + reportName
await writeFile(output, JSON.stringify(matrix, null, 2) + '\n')
await appendFile(
  process.env.GITHUB_STEP_SUMMARY,
  `Verified **${nodeCount} Node + ${browserCount} browser + 6 direct runtime + ${compatibilityCount} compatibility** cases.\n\n` +
    `Sources, builds and individual results are bound in \`${reportName}\`. SHA-256: \`${await hash(output)}\`.\n`,
)
console.log('WROTE ' + output)
