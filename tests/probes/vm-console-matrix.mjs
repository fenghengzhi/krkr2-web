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
const binaryPhase = wasm.capabilities?.binaryScripts === 1
const compilerPhase = wasm.capabilities?.cooperativeCompilation === 1
if (binaryPhase) assert(compilerPhase)
const scriptsPhase = wasm.abi === 5
if (compilerPhase) assert(scriptsPhase)
const tracePhase = wasm.abi >= 4
const nodeCount = binaryPhase
  ? 383
  : compilerPhase
    ? 371
    : scriptsPhase
      ? 362
      : tracePhase
        ? 351
        : 346
const browserCount = binaryPhase
  ? 627
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
  overlayFrames = []
for (const browser of browsers)
  for (const suite of ['browser', 'library', 'pwa']) {
    const root = `${base.root}/artifacts/browser-results-${browser}-${suite}`
    const report = await json(root + '/out/ci/results.json')
    const count =
      suite === 'browser'
        ? binaryPhase
          ? 168
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
assert.deepEqual(runtime.manifest, wasm)
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
    ...(binaryPhase ? { binaryInputControls: 12 } : {}),
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
  runtime,
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
    ...(binaryPhase
      ? { compiler: 'bd314e7bf7383553468685c6cea0db2d53998f265dd09b882d09733cdc7c55b9' }
      : {}),
    ...(compilerPhase
      ? { 'native-scripts': '1fab816e278b9746589c729509606aa1c0ad29156309136ce719f80dc22d0b7d' }
      : {}),
  },
  historicalFailures: [
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
    ...(tracePhase ? [] : ['Scripts.getTraceString']),
    ...(scriptsPhase
      ? [
          'Automatic legacy text detection and decoder latching, full bytecode validation and complete storage paths remain incomplete',
          ...(binaryPhase
            ? [
                'Structural bytecode validation does not prove native allocation cleanup, deep try/call stack budgets or every VM instruction semantic; these still require audit',
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
    'Native error UI policy, remaining exception and finalizer paths, TJS bridge frames in other TVP methods',
    'Historical WebKit paused-video position discontinuity remains unrootcaused',
    ...(compilerPhase
      ? [
          'Historical Chromium overlay initial-frame screenshot cause remains unconfirmed; explicit native presentation readiness now precedes pixel assertions',
        ]
      : []),
    'Historical one-shot committed-input failure has no proven product root cause; acknowledgement-based checks remain',
    'Protocol 8 to 9 historical same-kernel probe was not rerun in this phase',
    'All remaining requirements in docs/non-plugin-progress.md; full non-plugin compatibility is not complete',
  ],
}
const reportName = binaryPhase
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
