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
const base = await run('KRKR_BUILD_RUN', 'Tests', 14, [
  '--pattern',
  '*-results*',
  '--pattern',
  'build-logs',
])
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
  ':(exclude)tests/helpers/object-lifetime.ts',
  // These fixtures are imported only by the new regular/direct runtime and
  // isolated host diagnostics, whose exact sources are checked separately.
  ':(exclude)tests/helpers/host-handles.ts',
  ':(exclude)tests/helpers/owner-observation.ts',
  ':(exclude)tests/helpers/event-lifetime-runtime.ts',
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
const objectPhase = wasm.capabilities?.objectFinalization === 1
const hostPhase = wasm.capabilities?.hostObjectLifetime === 1
const soundPhase = wasm.capabilities?.soundObjectLifetime === 1
const videoPhase = wasm.capabilities?.videoObjectLifetime === 1
if (videoPhase) assert(soundPhase)
if (soundPhase) assert(hostPhase)
if (hostPhase) assert(objectPhase)
if (objectPhase) assert(executionPhase)
if (executionPhase) assert(lifetimePhase)
const fontPortDownloads =
  executionPhase && !buildInfo.kernels.cacheHit
    ? await json(base.root + '/artifacts/build-logs/font-ports.json')
    : []
if (fontPortDownloads.length) {
  assert.deepEqual(fontPortDownloads.map((item) => item.name).sort(), ['freetype', 'zlib'])
  for (const item of fontPortDownloads) {
    assert.match(item.url, /^https:\/\/codeload\.github\.com\//)
    assert.match(item.sha512, /^[a-f0-9]{128}$/)
    assert(item.bytes > 0)
  }
}
if (lifetimePhase) assert.equal(wasm.diagnosticAllocator, false)
const binaryPhase = wasm.capabilities?.binaryScripts === 1
const compilerPhase = wasm.capabilities?.cooperativeCompilation === 1
if (binaryPhase) assert(compilerPhase)
const scriptsPhase = wasm.abi === 5
if (compilerPhase) assert(scriptsPhase)
const tracePhase = wasm.abi >= 4
const nodeCount = videoPhase
  ? 776
  : soundPhase
    ? 710
    : hostPhase
      ? 594
      : objectPhase
        ? 466
        : executionPhase
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
const browserCount = videoPhase
  ? 675
  : soundPhase
    ? 651
    : binaryPhase
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
  videoHostOwnership = [],
  mediaAudioOwnership = [],
  browserControls = []
for (const browser of browsers)
  for (const suite of ['browser', 'library', 'pwa']) {
    const root = `${base.root}/artifacts/browser-results-${browser}-${suite}`
    const report = await json(root + '/out/ci/results.json')
    const count =
      suite === 'browser'
        ? videoPhase
          ? 184
          : soundPhase
            ? 176
            : binaryPhase
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
    if (videoPhase && suite === 'browser') {
      const attachment = (row, name) => {
        const item = row.result.attachments.find((value) => value.name === name)
        assert(item?.body, `Missing ${name} observation in ${row.title}`)
        return JSON.parse(Buffer.from(item.body, 'base64').toString('utf8'))
      }
      const videoCases = cases.filter((row) => row.title.startsWith('browser video resources: '))
      combinations(
        videoCases,
        [
          'creation-after-audio',
          'insertion-after-registration',
          'close-first-frame',
          'supersede-first-frame',
          'shutdown-failure',
        ],
        (row) => row.title.slice('browser video resources: '.length),
      )
      for (const row of videoCases) {
        const observed = attachment(row, 'video-host-ownership')
        assert.equal(row.title, 'browser video resources: ' + observed.name)
        assert.equal(
          observed.connected,
          ['shutdown-failure', 'supersede-first-frame'].includes(observed.name) ? 2 : 1,
        )
        assert.equal(observed.audioCloses, observed.connected)
        assert.equal(observed.revokedUrls, observed.createdUrls)
        assert.equal(observed.observerCloses, 1)
        for (const key of ['pendingReplies', 'liveAudio', 'liveUrls', 'pendingFrames', 'videos'])
          assert.equal(observed[key], 0)
        assert.deepEqual(observed.messages, [])
        videoHostOwnership.push({ browser, ...observed })
      }
      const audioCases = cases.filter((row) =>
        row.title.startsWith('video audio graph cleans every '),
      )
      combinations(
        audioCases,
        ['create', 'connect', 'disconnect'],
        (row) => attachment(row, 'media-audio-ownership').fault,
      )
      for (const row of audioCases) {
        const observed = attachment(row, 'media-audio-ownership')
        assert.equal(observed.device, 'controlled Web Audio API')
        const expected = { create: 8, connect: 9, disconnect: 15 }[observed.fault]
        combinations(
          observed.results,
          Array.from({ length: expected }, (_, index) => index + 1),
          (item) => item.at,
        )
        assert.equal(observed.control.at, 0)
        for (const item of [observed.control, ...observed.results]) {
          assert.equal(item.fault, observed.fault)
          assert.equal(item.contextCloses, 1)
          assert.equal(item.intervals, 0)
          for (const node of item.nodes) {
            assert.equal(node.disconnects, 1)
            assert.equal(node.connections, 0)
          }
          if (item.at)
            assert(
              (observed.fault === 'disconnect' ? item.closeError : item.error).includes(
                `media-${observed.fault}-primary`,
              ),
            )
          else assert.equal(item.error, null)
        }
        mediaAudioOwnership.push({ browser, ...observed })
      }
    }
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
const objectCases = [
  'ordinary-scope',
  'throwing-scope',
  'primary-body',
  'closure-pair',
  'array-clear',
  'dictionary-small',
  'dictionary-large',
  'primary-constructor',
  'deep-array',
  'deep-dictionary',
  'deep-throwing-array',
  'explicit-retry',
  'caught-cleanup',
  'resurrection',
  'explicit-cycle',
]
function objectLifetimes(rows) {
  combinations(
    rows,
    objectCases.flatMap((name) =>
      [false, true].flatMap((debug) => [false, true].map((binary) => `${name}/${debug}/${binary}`)),
    ),
    (row) => `${row.name}/${row.debugMode}/${row.binary}`,
  )
  for (const row of rows) {
    assert.equal(row.after.blocks, 0)
    assert.equal(row.after.contexts, 0)
    releasedExecution(row.budget)
    assert.equal(row.destruction.pending, 0)
    assert.equal(row.destruction.depth, 0)
    assert(row.destruction.peakDepth <= 32)
    assert.equal(row.destruction.objects, row.beforeObjects)
    if (row.name.startsWith('deep-')) assert(row.destruction.queued > 0)
    if (
      [
        'throwing-scope',
        'closure-pair',
        'array-clear',
        'dictionary-small',
        'dictionary-large',
        'deep-throwing-array',
        'primary-body',
        'primary-constructor',
      ].includes(row.name)
    ) {
      assert.equal(row.error.name, 'ScriptError')
      assert(row.error.message.includes(row.name.startsWith('primary-') ? row.name : 'finalizer-A'))
    } else {
      assert.equal(row.error, null)
      assert.equal(row.value, '42')
    }
  }
}
const hostHandleNames = [
  'batch-throwing',
  'stale-during-finalize',
  'duplicate-release',
  'nested-release',
  'primary-host-error',
  'primary-storage-error',
]
const hostControlNames = ['paused-resume', 'paused-cancel']
const ownerObservationNames = [
  'implicit-release',
  'observer-self-remove',
  'observer-other-remove',
  'explicit-retry',
  'explicit-revoke',
  'upgrade-owner',
  'unobserve',
  'vm-isolation',
  'vm-dispose',
  'invalid-owners',
]
function debugCombinations(rows, names) {
  combinations(
    rows,
    names.flatMap((name) =>
      [false, true].flatMap((debug) => [false, true].map((binary) => `${name}/${debug}/${binary}`)),
    ),
    (row) => `${row.name}/${row.debugMode}/${row.binary}`,
  )
}
function handleBoundary(row, backend) {
  assert.equal(row.variant, backend)
  assert.equal(row.boundary.objects, row.before.objects)
  assert.equal(row.boundary.blocks, row.before.blocks)
  assert.equal(row.boundary.contexts, row.before.contexts)
  assert.equal(row.boundary.handles, 0)
  assert.equal(row.boundary.pendingDestructions, 0)
  assert.equal(row.boundary.destructionDepth, 0)
  releasedExecution(row.boundary.budget)
}
function hostHandleLifetimes(cases, controls, backend) {
  debugCombinations(cases, hostHandleNames)
  debugCombinations(controls, hostControlNames)
  for (const row of cases) {
    handleBoundary(row, backend)
    const expectedError = {
      'batch-throwing': 'release-A',
      'primary-host-error': 'host-primary',
      'primary-storage-error': 'storage-primary',
    }[row.name]
    if (expectedError) {
      assert.equal(row.error.name, 'ScriptError')
      assert(row.error.message.includes(expectedError))
    } else {
      assert.equal(row.error, null)
      assert.equal(row.value, '42')
    }
    const primary = row.name.startsWith('primary-')
    const expectedLog =
      row.name === 'batch-throwing'
        ? 'ABC'
        : primary
          ? 'AB'
          : row.name === 'nested-release'
            ? 'ABa'
            : 'Aa'
    assert.equal(row.log.split('').sort().join(''), expectedLog)
    const callback = {
      'stale-during-finalize': 'handle-inspect',
      'duplicate-release': 'handle-duplicate',
      'nested-release': 'handle-hold',
      'primary-host-error': 'handle-primary',
      'primary-storage-error': 'Storage.readText',
    }[row.name]
    assert.deepEqual(row.callbacks, callback ? [callback] : [])
    if (row.name === 'stale-during-finalize') {
      assert(row.stale.depth > 0)
      assert.equal(row.stale.retained, undefined)
      assert.equal(row.stale.identity, undefined)
      for (const field of ['retainError', 'identityError', 'snapshotError']) {
        assert.equal(row.stale[field].name, 'Error')
        assert(
          row.stale[field].message.includes(
            field === 'snapshotError' ? 'Released object handle' : 'Released TJS object handle',
          ),
        )
      }
    }
    if (row.name === 'duplicate-release') {
      assert(row.duplicate.depth > 0)
      assert.equal(row.duplicate.handles, 0)
    }
    if (row.name === 'nested-release') assert(row.suspended.destructionDepth > 0)
    assert.equal(row.after.blocks, 0)
    assert.equal(row.after.contexts, 0)
    assert.equal(row.after.handles, 0)
    releasedExecution(row.after.budget)
  }
  for (const row of controls) {
    handleBoundary(row, backend)
    assert.equal(row.cancel, row.name === 'paused-cancel')
    assert.equal(row.heldMs, 25)
    assert.equal(row.nativeReplyKind, row.cancel ? 1 : 0)
    assert(row.suspended.destructionDepth > 0)
    assert(row.paused.destructionDepth > 0)
    assert.equal(row.paused.settled, false)
    assert.equal(row.paused.paused, true)
    assert.equal(row.paused.hostCalls, 1)
    if (row.cancel) assert.equal(row.error.name, 'AbortError')
    else {
      assert.equal(row.error, null)
      assert.equal(row.value, '42')
      assert.equal(row.log, 'AB')
    }
  }
}
function ownerObservations(rows, backend) {
  debugCombinations(rows, ownerObservationNames)
  for (const row of rows) {
    assert.equal(row.variant, backend)
    for (const event of row.events) assert.deepEqual(event.upgraded, [])
    if (row.watched) {
      assert.equal(row.watched.handles, row.owned.handles)
      assert.equal(row.watched.scriptObjects, row.owned.scriptObjects)
      assert.equal(
        row.watched.weakOwners,
        ['upgrade-owner', 'unobserve'].includes(row.name) ? 1 : 2,
      )
    }
    if (row.name === 'vm-dispose') {
      assert.equal(row.eventsAfterDispose, 2)
      assert.equal(row.events.length, 2)
      assert.equal(row.events.at(-1).weakOwners, 0)
      assert.equal(row.disposalReentries, 1)
      continue
    }
    assert.equal(row.after.blocks, 0)
    assert.equal(row.after.contexts, 0)
    for (const field of [
      'handles',
      'pendingHandles',
      'weakOwners',
      'destructionDepth',
      'pendingDestructions',
    ])
      assert.equal(row.after[field], 0, field)
    releasedExecution(row.after.budget)
    assert.equal(row.boundary.scriptObjects, row.before.scriptObjects)
    if (row.name === 'vm-isolation') {
      assert.equal(row.events.length, 1)
      assert.equal(row.other.calls, 1)
      assert.equal(row.other.after.scriptObjects, row.other.before.scriptObjects)
      for (const field of ['handles', 'pendingHandles', 'weakOwners'])
        assert.equal(row.other.after[field], 0)
      combinations(
        Object.keys(row.rejections),
        ['observe', 'reverseObserve', 'upgrade', 'unobserve', 'reverseUpgrade'],
        (key) => key,
      )
    } else if (row.name === 'invalid-owners') {
      assert.equal(row.events.length, 0)
      combinations(
        Object.keys(row.rejections),
        ['function', 'class', 'different-context', 'released', 'invalidated'],
        (key) => key,
      )
    } else {
      const expected =
        row.name === 'unobserve'
          ? 0
          : ['observer-other-remove', 'upgrade-owner'].includes(row.name)
            ? 1
            : 2
      assert.equal(row.events.length, expected)
      assert.equal(row.finalizeCount, row.name === 'explicit-retry' ? '2' : '1')
      if (row.name.startsWith('explicit-')) {
        assert.equal(row.revoked.weakOwners, 0)
        assert.equal(row.revoked.handles, 1)
        assert.equal(row.revoked.scriptObjects, row.owned.scriptObjects)
        assert(row.invalidatedObserve.includes('Cannot observe'))
      }
      if (row.name === 'explicit-retry') {
        assert(row.retry.error.includes('owner-finalize-first'))
        assert.equal(row.retry.after.weakOwners, 2)
      }
    }
    for (const rejection of Object.values(row.rejections ?? {}))
      assert.equal(typeof rejection, 'string')
  }
}
function eventOwnership(rows, backend) {
  combinations(rows, ['false', 'true'], (row) => String(row.binary))
  const expected = {
    'no-super-finalization': [2, '0,2'],
    'queued-owner-dynamic-member': [1, 'event-owner,10,1'],
    'direct-base-finalize': [2, '0,0,2'],
    'queued-trigger-cancellation': [1, '0,1'],
  }
  for (const row of rows) {
    assert.equal(row.variant, backend)
    assert.equal(row.baseline.pendingHandles, 0)
    assert.equal(row.baseline.clockTasks, 0)
    combinations(row.cases, Object.keys(expected), (item) => item.name)
    for (const item of row.cases) {
      const [count, result] = expected[item.name]
      assert.equal(item.result, result)
      assert.equal(item.owned.eventSources, row.baseline.eventSources + count)
      assert.equal(item.owned.weakOwners, row.baseline.weakOwners + count)
      assert.deepEqual(item.after, row.baseline)
      if (item.name === 'direct-base-finalize') {
        assert.equal(item.retained.eventSources, item.owned.eventSources)
        assert.equal(item.retained.weakOwners, item.owned.weakOwners)
        assert.equal(item.retained.clockTasks, 1)
      }
    }
    assert.deepEqual(Object.keys(row.stopped).sort(), Object.keys(row.baseline).sort())
    for (const value of Object.values(row.stopped)) assert.equal(value, 0)
  }
}
function dependentLifetimes(rows, backend) {
  const expected = {
    'owner-release': ['owner', 'child'],
    'child-first': ['child', 'owner'],
    'owner-retry': ['owner', 'owner', 'child'],
    'child-error': ['owner', 'child', 'child'],
    'primary-error': ['owner', 'child', 'child'],
    'invalid-bindings': ['child', 'owner'],
    'vm-dispose': [],
  }
  debugCombinations(rows, Object.keys(expected))
  for (const row of rows) {
    assert.equal(row.variant, backend)
    assert.deepEqual(row.marks, expected[row.name])
    assert.equal(row.owned.scriptObjects, row.baseline.scriptObjects + 2)
    if (row.name === 'vm-dispose') {
      assert.equal(row.disposed.scriptObjects, 0)
      assert.deepEqual(row.disposed.marks, [])
      continue
    }
    for (const field of ['handles', 'scriptObjects', 'blocks', 'contexts'])
      assert.equal(row.after[field], row.baseline[field])
    for (const field of ['weakOwners', 'dependents', 'pendingInvalidations', 'pendingHandles'])
      assert.equal(row.after[field], 0)
    if (row.name === 'invalid-bindings') {
      combinations(
        Object.keys(row.rejections),
        [
          'self',
          'ownerFunction',
          'childFunction',
          'ownerClass',
          'childClass',
          'released',
          'foreignOwner',
          'foreignChild',
          'invalidChild',
          'invalidOwner',
        ],
        (key) => key,
      )
      for (const error of Object.values(row.rejections)) assert.equal(typeof error, 'string')
    } else {
      assert.equal(row.bound.dependents, 1)
      assert.equal(row.bound.handles, 2)
      assert.equal(row.retired.dependents, 0)
      assert.equal(row.retired.pendingInvalidations, 0)
    }
    if (row.name === 'owner-retry') {
      assert(row.error.includes('owner-finalizer'))
      assert.equal(row.retry.dependents, 1)
    }
    if (row.name === 'child-error' || row.name === 'primary-error') {
      assert(row.error.includes(row.name === 'child-error' ? 'child-finalizer' : 'primary-body'))
      if (row.name === 'primary-error') assert(!row.error.includes('child-finalizer'))
      assert.equal(row.failed.dependents, 0)
      assert.equal(row.failed.pendingInvalidations, 0)
    }
  }
}
function weakReturnOwnership(rows, backend) {
  const names = ['retained', 'invalidated', 'revoked', 'foreign', 'collect', 'collect-error']
  combinations(
    rows,
    names.flatMap((name) =>
      [false, true].flatMap((debug) => [false, true].map((binary) => `${name}/${debug}/${binary}`)),
    ),
    (row) => `${row.name}/${row.debugMode}/${row.binary}`,
  )
  for (const row of rows) {
    assert.equal(row.variant, backend)
    const collecting = row.name === 'collect' || row.name === 'collect-error'
    assert.equal(row.owned.handles, row.baseline.handles + (collecting ? 1 : 0))
    for (const field of ['handles', 'scriptObjects', 'weakOwners', 'pendingHandles'])
      assert.equal(row.after[field], row.baseline[field])
    if (collecting) {
      assert.equal(row.finalizerCalls, 1)
      if (row.name === 'collect-error') assert(row.error.includes('collected-finalizer'))
      else assert.equal(row.error, null)
    }
  }
}
function videoOwnership(rows, backend) {
  combinations(rows, ['false', 'true'], (row) => String(row.binary))
  const expected = {
    'implicit-resource-release': '1',
    'returned-object-release': '[TJS object]',
    'queued-dynamic-member': 'movie-owner:stop,1,1',
    'cancel-queued-event': '0,1',
    'frame-last-reference': '1,1',
    'period-last-reference': '1,1',
    'retry-invalidation': '2',
    'weak-layer-return': '1',
    'await-asynchronous-close': 'closed',
    'window-disconnect': '1,unload,0,0',
  }
  for (const row of rows) {
    assert.equal(row.variant, backend)
    combinations(row.cases, Object.keys(expected), (item) => item.name)
    for (const item of row.cases) {
      assert.equal(item.result, expected[item.name])
      if (item.name === 'window-disconnect') {
        // Invalidating the fixture window changes the baseline; teardown still
        // must return every resource and native ownership counter to zero.
        for (const field of ['videoSources', 'pendingVideoCloses', 'movies'])
          assert.equal(item.retired[field], 0)
      } else assert.deepEqual(item.retired, row.baseline)
      if (item.name === 'returned-object-release') assert.deepEqual(item.owned, row.baseline)
      else {
        assert.equal(item.owned.movies, 1)
        if (item.name === 'await-asynchronous-close') {
          assert.equal(item.owned.videoSources, 0)
          assert.equal(item.owned.pendingVideoCloses, 1)
        } else {
          assert.equal(item.owned.videoSources, row.baseline.videoSources + 1)
          if (item.name !== 'weak-layer-return')
            assert.equal(item.owned.weakOwners, row.baseline.weakOwners + 2)
        }
      }
    }
    assert.deepEqual(Object.keys(row.stopped).sort(), Object.keys(row.baseline).sort())
    for (const value of Object.values(row.stopped)) assert.equal(value, 0)
    assert.equal(row.terminalCloses, 1)
    assert.equal(row.rendererCloses, 1)
    assert.equal(row.closedIds.length, 10)
    assert.equal(new Set(row.closedIds).size, 10)
  }
}
function soundOwnership(rows, backend) {
  combinations(rows, ['false', 'true'], (row) => String(row.binary))
  const expected = {
    'implicit-resource-release': '1',
    'queued-dynamic-member': 'sound-owner:cue,1,1',
    'flags-labels-filters': '0,0,0,1,42,1',
    'retry-invalidation': '2',
    'await-asynchronous-close': 'closed',
  }
  for (const row of rows) {
    assert.equal(row.variant, backend)
    combinations(row.cases, Object.keys(expected), (item) => item.name)
    for (const item of row.cases) {
      assert.equal(item.result, expected[item.name])
      assert.deepEqual(item.retired, row.baseline)
      assert.equal(item.owned.voices, 1)
      if (item.name === 'await-asynchronous-close') {
        assert.equal(item.owned.soundSources, 0)
        assert.equal(item.owned.pendingSoundCloses, 1)
      } else {
        assert.equal(item.owned.soundSources, row.baseline.soundSources + 1)
        assert.equal(item.owned.weakOwners, row.baseline.weakOwners + 1)
      }
      if (item.name === 'flags-labels-filters')
        assert.equal(item.owned.dependents, row.baseline.dependents + 1)
    }
    assert.deepEqual(Object.keys(row.stopped).sort(), Object.keys(row.baseline).sort())
    for (const value of Object.values(row.stopped)) assert.equal(value, 0)
    assert.equal(row.terminalCloses, 1)
    // The property case closes the first media resource before reopening the
    // same sound ID, then closes its replacement when the owner retires.
    assert.equal(row.closedIds.length, 6)
    assert.equal(new Set(row.closedIds).size, 5)
    assert.equal(row.closedIds[2], row.closedIds[3])
  }
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
  if (videoPhase) {
    weakReturnOwnership(row.weakReturns, row.backend)
    videoOwnership(row.videoOwnership, row.backend)
  }
  if (soundPhase) {
    dependentLifetimes(row.dependentLifetimes, row.backend)
    soundOwnership(row.soundOwnership, row.backend)
  }
  if (hostPhase) {
    hostHandleLifetimes(row.hostHandles.cases, row.hostHandles.controls, row.backend)
    ownerObservations(row.ownerObservations, row.backend)
    eventOwnership(row.eventOwnership, row.backend)
  }
  if (objectPhase) {
    objectLifetimes(row.objects.cases)
    combinations(
      row.objects.controls,
      [false, true].flatMap((explicit) =>
        [false, true].flatMap((binary) =>
          [false, true].map((cancel) => `${explicit}/${binary}/${cancel}`),
        ),
      ),
      (item) => `${item.explicit}/${item.binary}/${item.cancel}`,
    )
    for (const control of row.objects.controls) {
      assert.equal(control.heldMs, 25)
      if (!control.explicit) assert(control.heldDepth > 0)
      assert.equal(control.nativeReplyKind, control.cancel ? 1 : 0)
      assert.equal(control.error, control.cancel ? 'AbortError' : null)
      assert.equal(control.after.contexts, control.before.contexts)
      assert.equal(control.after.blocks, control.before.blocks)
      assert.equal(control.objects, control.beforeObjects)
      releasedExecution(control.budget)
    }
  }
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
      if (soundPhase) {
        assert.equal(control.clock, 'forced-native-checkpoint')
        assert(control.checkpointClockReads > 0)
      }
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
const finalizationAllocatorReports = []
const ownerAllocatorReports = []
const dependentAllocatorReports = []
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
    ...(objectPhase ? ['tests/probes/finalization-allocation-faults.ts'] : []),
    ...(hostPhase ? ['tests/probes/owner-observation-allocations.ts'] : []),
    ...(soundPhase ? ['tests/probes/dependent-allocation-faults.ts'] : []),
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
    if (objectPhase) {
      const cleanup = await json(`${root}/out/ci/finalization-allocations-${backend}.json`)
      assert.deepEqual(cleanup.manifest, manifest)
      assert.equal(cleanup.variant, backend)
      assert.equal(cleanup.manifest.capabilities.objectFinalization, 1)
      assert.deepEqual(cleanup.failures, [])
      for (const debugMode of [false, true])
        for (const collection of ['array', 'dictionary'])
          for (const implicit of [false, true]) {
            const rows = cleanup.results.filter(
              (item) =>
                item.debugMode === debugMode &&
                item.collection === collection &&
                item.implicit === implicit,
            )
            assert(rows.length > 2)
            rows.forEach((item, index) => {
              assert.equal(item.after, index - 1)
              assert.equal(item.hits, index === 0 || index === rows.length - 1 ? 0 : 1)
              assert.deepEqual(item.disposed, rows[0].disposed)
              assert.deepEqual(item.baseline, rows[0].disposed)
              assert.equal(item.current.blocks, item.before.blocks)
              assert.equal(item.current.contexts, item.before.contexts)
              assert.equal(item.finalized, implicit || !item.hits ? 128 : 0)
              assert.equal(item.objects, item.beforeObjects - (implicit || item.hits ? 0 : 128))
              releasedExecution(item.budget)
            })
          }
      finalizationAllocatorReports.push(cleanup)
    }
    if (hostPhase) {
      const owners = await json(`${root}/out/ci/owner-observation-allocations-${backend}.json`)
      assert.deepEqual(owners.manifest, manifest)
      assert.equal(owners.variant, backend)
      assert.equal(owners.manifest.capabilities.hostObjectLifetime, 1)
      assert.deepEqual(owners.failures, [])
      const groupKey = (item) => `${item.operation}/${item.debugMode}/${item.binary}`
      const groups = ['register', 'dispose', 'upgrade'].flatMap((operation) =>
        [false, true].flatMap((debugMode) =>
          [false, true].map((binary) => `${operation}/${debugMode}/${binary}`),
        ),
      )
      combinations([...new Set(owners.results.map(groupKey))], groups, (key) => key)
      for (const group of groups) {
        const rows = owners.results.filter((item) => groupKey(item) === group)
        // Each group needs a control, a real fault and a terminal no-hit sample.
        // The number of intervening allocation sites comes from the actual run.
        assert(rows.length >= 3)
        rows.forEach((item, index) => {
          assert.equal(item.after, index - 1)
          assert.equal(item.hits, index === 0 || index === rows.length - 1 ? 0 : 1)
          if (item.hits) assert(item.failedBytes > 0)
          for (const field of ['bytes', 'blocks', 'strings', 'objects']) {
            assert(Number.isSafeInteger(item.disposed[field]) && item.disposed[field] >= 0)
            assert(Number.isSafeInteger(item.baseline[field]) && item.baseline[field] >= 0)
          }
          assert.deepEqual(item.disposed, rows[0].disposed)
          assert.deepEqual(item.baseline, rows[0].disposed)
          assert.equal(item.before.pendingHandles, 0)
          if (item.operation === 'dispose') {
            assert.equal(item.status, 'disposed')
            assert.equal(item.before.weakOwners, 8)
            assert.equal(item.before.handles, 4)
            assert.equal(item.error, null)
            assert.equal(item.notifications, 8)
            assert.deepEqual(item.weakCounts, [7, 6, 5, 4, 3, 2, 1, 0])
            assert.deepEqual(item.upgrades, [])
            assert.equal(item.disposalReentries, 1)
            assert.equal(item.disposed.objects, 0)
            releasedExecution(item.budget)
          } else {
            assert.equal(item.before.handles, 1)
            assert.equal(item.before.weakOwners, item.operation === 'upgrade' ? 1 : 0)
            const current = item.operation === 'upgrade' ? item.upgraded : item.registered
            assert.equal(current.pendingHandles, 0)
            assert.equal(current.scriptObjects, item.before.scriptObjects)
            assert.equal(current.blocks, item.before.blocks)
            assert.equal(current.contexts, item.before.contexts)
            assert.equal(item.notifications, 1)
            for (const field of ['handles', 'pendingHandles', 'weakOwners'])
              assert.equal(item.released[field], 0)
            assert.equal(item.released.scriptObjects, item.before.scriptObjects - 1)
            assert.equal(item.released.blocks, item.before.blocks)
            assert.equal(item.released.contexts, item.before.contexts)
            releasedExecution(item.released.budget)
            if (item.operation === 'register') {
              assert.equal(current.handles, item.before.handles)
              assert.equal(current.weakOwners, item.hits ? 0 : 1)
              if (item.hits) assert(item.error.includes('Cannot observe'))
              else assert.equal(item.error, null)
            } else {
              assert.equal(item.status, 'upgraded')
              assert.equal(current.weakOwners, 1)
              assert.equal(current.handles, item.before.handles + (item.hits ? 0 : 1))
              assert.equal(item.error, item.hits ? 'TJS owner upgrade allocation failed' : null)
              if (item.hits) assert.equal(item.lease, undefined)
              else assert(Number.isSafeInteger(item.lease) && item.lease > 0)
              assert(Number.isSafeInteger(item.retry) && item.retry > 0)
              assert.notEqual(item.retry, item.lease)
              assert.equal(item.retried.handles, item.before.handles + (item.hits ? 1 : 2))
              assert.equal(item.retried.weakOwners, 1)
              assert.equal(item.leased.handles, 1)
              assert.equal(item.leased.weakOwners, 1)
              assert.equal(item.leased.pendingHandles, 0)
              assert.equal(item.leased.scriptObjects, item.before.scriptObjects)
            }
          }
        })
      }
      ownerAllocatorReports.push(owners)
    }
    if (soundPhase) {
      const dependents = await json(`${root}/out/ci/dependent-allocations-${backend}.json`)
      assert.deepEqual(dependents.manifest, manifest)
      assert.equal(dependents.variant, backend)
      assert.equal(dependents.manifest.capabilities.soundObjectLifetime, 1)
      assert.deepEqual(dependents.failures, [])
      const groupKey = (item) => `${item.operation}/${item.debugMode}/${item.binary}`
      const groups = ['register', 'invalidate'].flatMap((operation) =>
        [false, true].flatMap((debugMode) =>
          [false, true].map((binary) => `${operation}/${debugMode}/${binary}`),
        ),
      )
      combinations([...new Set(dependents.results.map(groupKey))], groups, (key) => key)
      for (const group of groups) {
        const rows = dependents.results.filter((item) => groupKey(item) === group)
        assert(rows.length >= 3)
        rows.forEach((item, index) => {
          assert.equal(item.after, index - 1)
          assert.equal(item.hits, index === 0 || index === rows.length - 1 ? 0 : 1)
          assert.equal(item.status, 'released')
          assert.deepEqual(item.disposed, rows[0].disposed)
          assert.deepEqual(item.baseline, rows[0].disposed)
          assert.equal(item.disposed.objects, 0)
          for (const field of [
            'handles',
            'pendingHandles',
            'weakOwners',
            'dependents',
            'pendingInvalidations',
          ])
            assert.equal(item.released[field], 0)
          assert.equal(item.released.scriptObjects, item.before.scriptObjects - 2)
          for (const field of ['blocks', 'contexts'])
            assert.equal(item.released[field], item.before[field])
          if (item.hits) {
            assert(item.failedBytes > 0)
            assert(
              item.allocationTrace.includes(
                `Native allocation phase ${item.operation === 'register' ? 14 : 11}`,
              ),
            )
            assert(
              item.error.message.includes(
                item.operation === 'register' ? 'Cannot bind' : 'bad_alloc',
              ),
            )
          } else assert.equal(item.error, null)
          if (item.operation === 'register') {
            assert.equal(item.before.handles, 2)
            assert.equal(item.current.handles, 2)
            assert.equal(item.current.dependents, item.hits ? 0 : 1)
            assert.equal(item.current.scriptObjects, item.before.scriptObjects)
          } else {
            assert.equal(item.before.handles, 1)
            assert.equal(item.before.dependents, 1)
            assert.deepEqual(item.current, item.released)
          }
        })
      }
      dependentAllocatorReports.push(dependents)
    }
  }
}
const objects = objectPhase
  ? await run('KRKR_OBJECTS_RUN', 'Object lifetime diagnostic', 2, [
      '--pattern',
      'object-lifetime-*',
    ])
  : undefined
const objectReports = []
if (objects) {
  unchanged(objects.info.headSha, [
    'tests/helpers/object-lifetime.ts',
    'tests/helpers/execution-budget.ts',
    'tests/helpers/bytecode-lifetime.ts',
    'tests/probes/object-lifetime.ts',
    'tests/probes/object-lifetime-case.ts',
    '.github/workflows/object-lifetime.yml',
  ])
  for (const backend of backends) {
    const report = await json(
      `${objects.root}/artifacts/object-lifetime-${backend}/object-lifetime-${backend}.json`,
    )
    assert.equal(report.variant, backend)
    assert.deepEqual(report.manifest, wasm)
    for (const row of report.results) {
      assert.equal(row.status, 0)
      assert.equal(row.signal, null)
      assert.equal(row.error, null)
      assert.equal(row.outcome.result.name, row.name)
      assert.equal(row.outcome.result.debugMode, row.debugMode)
      assert.equal(row.outcome.result.binary, row.binary)
    }
    objectLifetimes(report.results.map((row) => row.outcome.result))
    objectReports.push(report)
  }
}
const handles = hostPhase
  ? await run('KRKR_HANDLES_RUN', 'Host handle lifetime diagnostic', 2, [
      '--pattern',
      'host-handles-*',
    ])
  : undefined
const hostHandleReports = []
if (handles) {
  unchanged(handles.info.headSha, [
    'tests/helpers/host-handles.ts',
    'tests/helpers/bytecode-lifetime.ts',
    'tests/helpers/execution-budget.ts',
    'tests/probes/host-handles.ts',
    'tests/probes/host-handles-case.ts',
    '.github/workflows/host-handles.yml',
    '.github/actions/prepare-tests/action.yml',
  ])
  for (const backend of backends) {
    const report = await json(
      `${handles.root}/artifacts/host-handles-${backend}/host-handles-${backend}.json`,
    )
    assert.equal(report.variant, backend)
    assert.deepEqual(report.manifest, wasm)
    debugCombinations(report.results, [...hostHandleNames, ...hostControlNames])
    for (const row of report.results) {
      assert.equal(row.status, 0)
      assert.equal(row.signal, null)
      assert.equal(row.error, null)
      assert.equal(row.outcome.result.name, row.name)
      assert.equal(row.outcome.result.debugMode, row.debugMode)
      assert.equal(row.outcome.result.binary, row.binary)
    }
    hostHandleLifetimes(
      report.results
        .filter((row) => hostHandleNames.includes(row.name))
        .map((row) => row.outcome.result),
      report.results
        .filter((row) => hostControlNames.includes(row.name))
        .map((row) => row.outcome.result),
      backend,
    )
    hostHandleReports.push(report)
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
const fontRestart = process.env.KRKR_FONT_RESTART_RUN
  ? await run('KRKR_FONT_RESTART_RUN', 'WebKit startup diagnostic', 1, [
      '--name',
      'webkit-diagnostic-results',
    ])
  : undefined
let fontRestarts = []
let fontRestartWorkers
if (fontRestart) {
  unchanged(fontRestart.info.headSha, [
    'tests/browser/font-selection.spec.ts',
    'tests/helpers/browser-expression.ts',
    'tests/helpers/browser-launch.ts',
    'playwright.config.ts',
    '.github/workflows/webkit-diagnostic.yml',
    '.github/actions/prepare-tests/action.yml',
  ])
  const steps = fontRestart.info.jobs[0].steps
  assert.equal(
    steps.find((step) => step.name === 'Repeat font dialog cancellation and fresh session startup')
      ?.conclusion,
    'success',
  )
  assert.equal(
    steps.find((step) => step.name === 'Record Worker startup spans and native stacks')?.conclusion,
    'skipped',
  )
  const root = fontRestart.root + '/artifacts/out/ci'
  const restoredBuild = await json(root + '/build-info.json')
  unchanged(restoredBuild.commit, applicationPaths)
  const report = await json(root + '/font-restart.json')
  fontRestarts = playwright(report, 20)
  fontRestartWorkers = report.config.workers
  assert([1, 2].includes(fontRestartWorkers))
  const project = report.config.projects.find((item) => item.name === 'webkit')
  assert(project)
  assert.equal(project.repeatEach, 10)
  assert.equal(project.retries, 0)
  assert.equal(project.timeout, 30_000)
  combinations(
    fontRestarts,
    backends.flatMap((backend) =>
      Array(10).fill(
        `${backend}: a font dialog during startup can stop the game and a fresh session can start`,
      ),
    ),
    (row) => row.title,
  )
  for (const row of fontRestarts) assert.equal(row.project, 'webkit')
  const protocol = await readFile(root + '/font-restart.log', 'utf8')
  assert(protocol.includes('pw:browser'), 'Browser process diagnostics are missing')
  assert(protocol.includes('pw:protocol'), 'Browser protocol diagnostics are missing')
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
    ...(objects ? [objects.info] : []),
    ...(handles ? [handles.info] : []),
    ...(pwaDiagnostic ? [pwaDiagnostic.info] : []),
    ...(fontRestart ? [fontRestart.info] : []),
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
  fontPortDownloads,
  sessionProtocol: 9,
  passed: {
    node: nodeCount,
    browser: browserCount,
    directRuntime: 6,
    ...(videoPhase
      ? {
          weakReturns: runtime.results.reduce((sum, row) => sum + row.weakReturns.length, 0),
          videoOwnershipSessions: runtime.results.reduce(
            (sum, row) => sum + row.videoOwnership.length,
            0,
          ),
          videoOwnershipCases: runtime.results.reduce(
            (sum, row) =>
              sum + row.videoOwnership.reduce((count, session) => count + session.cases.length, 0),
            0,
          ),
          videoHostOwnership: videoHostOwnership.length,
          mediaAudioFaults: mediaAudioOwnership.reduce((sum, row) => sum + row.results.length, 0),
          mediaAudioControls: mediaAudioOwnership.length,
        }
      : {}),
    ...(soundPhase
      ? {
          dependentLifetimes: runtime.results.reduce(
            (sum, row) => sum + row.dependentLifetimes.length,
            0,
          ),
          soundOwnershipSessions: runtime.results.reduce(
            (sum, row) => sum + row.soundOwnership.length,
            0,
          ),
          soundOwnershipCases: runtime.results.reduce(
            (sum, row) =>
              sum + row.soundOwnership.reduce((count, session) => count + session.cases.length, 0),
            0,
          ),
          dependentAllocatorGroups: dependentAllocatorReports.reduce(
            (sum, report) =>
              sum +
              new Set(
                report.results.map((item) => `${item.operation}/${item.debugMode}/${item.binary}`),
              ).size,
            0,
          ),
          dependentAllocatorFailures: dependentAllocatorReports.reduce(
            (sum, report) => sum + report.results.filter((item) => item.hits === 1).length,
            0,
          ),
          dependentAllocatorFailuresByOperation: Object.fromEntries(
            ['register', 'invalidate'].map((operation) => [
              operation,
              dependentAllocatorReports.reduce(
                (sum, report) =>
                  sum +
                  report.results.filter((item) => item.operation === operation && item.hits === 1)
                    .length,
                0,
              ),
            ]),
          ),
        }
      : {}),
    ...(hostPhase
      ? {
          hostHandleCases: runtime.results.reduce(
            (sum, row) => sum + row.hostHandles.cases.length,
            0,
          ),
          hostHandleControls: runtime.results.reduce(
            (sum, row) => sum + row.hostHandles.controls.length,
            0,
          ),
          ownerObservations: runtime.results.reduce(
            (sum, row) => sum + row.ownerObservations.length,
            0,
          ),
          eventOwnershipSessions: runtime.results.reduce(
            (sum, row) => sum + row.eventOwnership.length,
            0,
          ),
          eventOwnershipCases: runtime.results.reduce(
            (sum, row) =>
              sum + row.eventOwnership.reduce((count, session) => count + session.cases.length, 0),
            0,
          ),
          isolatedHostHandles: hostHandleReports.reduce(
            (sum, report) => sum + report.results.length,
            0,
          ),
          ownerAllocatorGroups: ownerAllocatorReports.reduce(
            (sum, report) =>
              sum +
              new Set(
                report.results.map((item) => `${item.operation}/${item.debugMode}/${item.binary}`),
              ).size,
            0,
          ),
          ownerAllocatorFailures: ownerAllocatorReports.reduce(
            (sum, report) => sum + report.results.filter((item) => item.hits === 1).length,
            0,
          ),
          ownerAllocatorFailuresByOperation: Object.fromEntries(
            ['register', 'dispose', 'upgrade'].map((operation) => [
              operation,
              ownerAllocatorReports.reduce(
                (sum, report) =>
                  sum +
                  report.results.filter((item) => item.operation === operation && item.hits === 1)
                    .length,
                0,
              ),
            ]),
          ),
        }
      : {}),
    ...(objectPhase
      ? {
          objectLifetimes: 360,
          finalizationControls: 48,
          isolatedObjectLifetimes: objectReports.reduce(
            (sum, report) => sum + report.results.length,
            0,
          ),
          finalizationAllocatorFailures: finalizationAllocatorReports.reduce(
            (sum, report) => sum + report.results.filter((item) => item.hits === 1).length,
            0,
          ),
        }
      : {}),
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
    ...(fontRestart ? { fontRestartDiagnostics: fontRestarts.length } : {}),
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
  ...(videoPhase ? { videoHostOwnership, mediaAudioOwnership } : {}),
  executionAllocatorReports,
  finalizationAllocatorReports,
  ownerAllocatorReports,
  dependentAllocatorReports,
  hostHandleReports,
  objectReports,
  offlineRestarts,
  ...(fontRestart ? { fontRestarts, fontRestartWorkers } : {}),
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
    ...(videoPhase
      ? {
          'sound-object-lifetime':
            'bd7c8848e1e0183457644d67a8f6dbfbf41a8a951576db2f608046e7e60307da',
        }
      : {}),
    ...(soundPhase
      ? {
          'host-object-lifetime':
            'e2c75876777e77b4b834551a7558d3527e4431ef5f7daf6180fd85d148368d9c',
        }
      : {}),
    ...(hostPhase
      ? {
          'object-finalization': '0387418a08e9a011d261937358510575a31f10061efaaff1e67c7ae910217d51',
        }
      : {}),
    ...(objectPhase
      ? { 'execution-budgets': '2079d47f87fd1f035b7eb7626249a183fbef66a2b0723f93ebe458e80a78c109' }
      : {}),
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
    ...(videoPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34899772270',
            reason:
              'The first native video ownership implementation passed 762/764 Node cases, 651 browser cases and six direct runtimes. Cancelling a queued video event retained one native handle and object until a later VM entry. A suspendable collect entry now drains releases at the Session event boundary; the exact baseline assertions remain. Original failed artifacts are retained.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34901201286',
            reason:
              'The new collect entry was missing from JSPI_EXPORTS. JSPI ccall rejected its ordinary return with ret.then is not a function, including native media startup. The CMake export list was corrected. The same run also recorded 751 passing Node cases and one sound-lifetime.test.ts file failure with SIGSEGV; only 61 of its 82 cases completed. That process crash has no confirmed root cause. The unchanged sound file passed three independent 82-case diagnostic runs in 34902191020, which does not prove the crash fixed. Both complete original runs are archived, and future full Node failures retain native core hashes/backtraces on hosted runners.',
          },
        ]
      : []),
    ...(soundPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34885096935',
            reason:
              'The first sound ownership run passed 679/682 Node cases, all 651 browser checks and all six direct runtimes. All 82 real Session sound lifecycle cases passed. Three fixture failures were corrected: the short-fade clock assertion now accounts for native-style immediate completion below 60 ms before separately exercising a 120 ms fade; two stopped-session expectations include the four new zero ownership counters. Original failed artifacts and metadata remain archived. This failed run is not counted as passing verification.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34894629812',
            reason:
              'Node passed 710/710 and all 651 browser tests passed, but only four of six direct runtime combinations passed. Chromium/JSPI and Firefox/JSPI completed the existing argument workload without entering its qualifying phase-10 suspension hook. The failure did not record physical copy duration. The fixture now advances its own temporary deadline clock until the real native argument buffer is observed, retaining the real 25 ms pause, cancellation, context and heap cleanup assertions and restoring the original clock in finally. This verifies controlled suspension without claiming a physical worst-case latency. The complete failed run and the earlier standalone passing run remain archived; no retry is counted as a pass.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34897104201',
            reason:
              'The first sound evidence report stopped because the per-browser suite expectation still used the previous 172 cases, although its total expected count had been updated to 651. Each browser now has 176 regular cases after adding four audio lifetime scenarios. The report expectation was corrected; the underlying complete regression remains 710 Node, 651 browser and six direct passes. This failed report and its downloaded evidence remain archived.',
          },
        ]
      : []),
    ...(hostPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34869766340',
            commit: '4bc02b9f95a6ba4c398c1aa38dc90bca99e8012e',
            reason:
              'Initial isolated host handle diagnostics passed only the four nested-release debug/bytecode combinations out of 20 cases per backend. Batch release stranded later objects after a finalizer error, retiring handles remained accessible, and host primary errors were mishandled. Duplicate release caused WASM memory access out of bounds or a subprocess timeout. Full failed artifacts and metadata remain archived; timeouts are failures, not passing evidence.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34871902361',
            commit: '7c08baa9951b114a1ae22eacb8a7e7a455dec93f',
            reason:
              'Node passed 592/594; the bytecode suspended-trigger resume and stop fixtures failed with ScriptError syntax errors because their custom decoder converted compiled storage to text. The fixture now uses readScript to preserve bytecode while replacing only the asynchronous marker text. All 639 browser checks and six direct runtime combinations passed, including 240 owner observation rows, but the complete run remains failed. Its original Node, browser and runtime artifacts and metadata remain archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34872335592',
            commit: 'b3e895c079c9f03e5c5296ed37f54e7b2a4b7249',
            reason:
              'Owner allocation diagnostics failed four of 324 rows per backend: all debug/bytecode disposal combinations aborted at allocation index 71, a 440-byte phase-11 request. Each had already notified all eight observers and reached zero native dispatch objects, yet retained 33,278 bytes without debug or 90,688 bytes with debug compared with its successful disposal control. Registration and upgrade cases completed; these failed disposal rows prove that zero object and observer counts alone do not establish complete native cleanup. Both failed artifacts and metadata remain archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34873432311',
            commit: 'cf6248c0c9bb9fe6f60d1c5d5fd50586a2c1d50a',
            reason:
              'The repeated allocator run still failed the same four disposal rows per backend at allocation index 71, with a 440-byte failed request and the same 33,278/90,688-byte retained-allocation differences. All owner registration and upgrade rows completed, but disposal still aborted after observer revocation and native object release. The full failed enumeration and metadata remain archived; this repeated failure is not a passing verification.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34874097344',
            commit: '90a5c7eefeb5aabd532fac28c8add935e9e27177',
            reason:
              'Both allocator variants again failed all four debug/bytecode disposal rows at allocation index 71. The Asyncify allocation trace identified DeleteAllMembers called through TJSReservedWordsHashRelease and tTJS::Cleanup during engine destruction; the thrown allocation error escaped the destructor and terminated cleanup. The reserved-word hash release now clears its global pointer and initialization state before using the non-throwing native release helper, allowing later string-pool, regex and debug cleanup to continue. The diagnostic run, traces and retained-allocation evidence remain archived as failures.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34875061460',
            commit: 'e2adc68128b6925010695a57950f5a5c85da75f6',
            reason:
              'All 324 owner registration, upgrade and disposal rows passed on each backend, including 300 injected failures per backend. The separate Asyncify collection-cleanup probe failed its debug Dictionary implicit-release row at allocation index 1 because the allocator reported a hit but execution reported no error. Disposal still matched its control. That probe asserted before recording allocation size and trace, so the exact historical allocation cannot be identified from this run. A later repeated diagnostic passed without reproducing it; the failed run and missing diagnostic fields remain recorded, not retroactively counted as success.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34875029792',
            commit: 'e2adc68128b6925010695a57950f5a5c85da75f6',
            reason:
              'Node passed 594/594 and all six direct runtime combinations passed; browser checks passed 638/639. The WebKit Asyncify font-dialog stop assertions succeeded and fresh Worker assets downloaded, but the new-session assertion failed after about 184 ms despite its configured 12-second timeout; the entire test lasted 1,984 ms. The empty protocol-error log matches the closed/crashed-session path in Playwright 1.63, without identifying its cause. The loading snapshot does not prove a 12-second application hang. Original trace, context and reports remain archived as a failure; a repeated diagnostic cannot establish that its root cause is fixed.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34876763323',
            commit: 'c579a67b1d1a8442f7d97fb355319a5056ef6325',
            reason:
              'Node passed 590/594: four strengthened event cases recorded complete finalizer logs and zero sources, observers and pending handles, but first-use variadic Debug logging initialized 25 shared Array-class objects after the fixture baseline. The fixture now warms logging before taking its baseline and retains exact pre-evaluate cleanup assertions. Browsers passed 638/639; the WebKit library file-flush failure scenario stopped during initial game loading, before the injected save/flush operation, with an empty protocol-error log after about 613 ms. All six direct runtime combinations passed. The complete failed run, trace and original Node report remain archived; no failure is counted as a pass.',
          },
        ]
      : []),
    ...(objectPhase
      ? [
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34861822171',
            reason:
              'Initial isolated object diagnostics passed only 4/32 cases per backend. Finalizer errors retained contexts, interrupted closure and array cleanup, or replaced constructor errors. Dictionary fixtures also used a nonexistent instance method and were corrected separately.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34863624702',
            reason:
              'The first cleanup implementation failed compilation because GetValue was defined later in the file. No tests ran; the complete build failure remains archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34864904432',
            reason:
              'Node passed 462/466 and all 639 browser tests passed. Four caught-cleanup cases and all direct runtime combinations failed because the fixture retained a constructor temporary beyond its try block. The fixture now establishes sole ownership in a separate setup execution; the failed run remains archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34865379657',
            reason:
              'The same caught-cleanup fixture failed all four debug/bytecode combinations per backend; each backend passed 56/60 isolated cases. Individual subprocess failures remain archived.',
          },
        ]
      : []),
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
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34857464849',
            reason:
              'Asyncify did not run allocation tests because a font dependency download returned HTTP 504; allocator builds now omit unused font kernels. JSPI exposed six positive retained-heap differences in Array construction cleanup and 417 smaller-than-control malloc chunk totals. Array finalization now tolerates interruption before native instance registration; a diagnostic live-request ledger distinguishes ownership from allocator chunk rounding and is checked for overflow and real malloc/free accounting.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34857699012',
            reason:
              'Emscripten installation failed with HTTP 504 before the production build. All dependent tests were skipped; there is no test artifact and this run is not a verification pass. The workflow log and metadata remain archived.',
          },
          {
            run: 'https://github.com/fenghengzhi/krkr2-web/actions/runs/34858181535',
            reason:
              'The production build again failed downloading zlib with HTTP 504 and no tests ran. Tests now prefetch the same font-port archives through GitHub codeload, require the exact pinned Emscripten SHA-512 hashes and record the URLs and archive bytes; dependency versions and compilation options remain unchanged.',
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
              'First lifecycle run failed three of 391 Node cases and the direct runtime. It exposed rejection of a superclass RET/NOP sentinel and retained instance method contexts. Sentinel validation was repaired; instances in those lifecycle tests are explicitly invalidated. The initial self-reference explanation was a hypothesis: decision 037 records existing self-closure reference adjustment and fixes stale expression registers, with separate automatic-finalization cases. Arbitrary object cycles remain incomplete. Preserve the original complete run and individual outcomes.',
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
    ...(videoPhase
      ? [
          'Historical Node sound-lifetime.test.ts SIGSEGV has no confirmed cause; three isolated unchanged 82-case runs passed without reproducing it',
          'Window disconnect currently silently closes video resources; native Window/Video event ordering needs further comparison with the complete native window lifecycle',
        ]
      : []),
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
                videoPhase
                  ? 'Selected Sound, VideoOverlay, Timer and AsyncTrigger weak ownership, queued event leases, dependent retirement and asynchronous media resource cleanup are covered. Layer, Window, MenuItem and remaining host/VM ownership semantics still require implementation. Registered callbacks and explicit reference cycles retain their original ownership; arbitrary cycle collection is not part of TJS2.'
                  : soundPhase
                    ? 'Selected Sound, Timer and AsyncTrigger weak ownership, dependent retirement, queued event leases and asynchronous audio resource closes are covered; Layer, Window, VideoOverlay, MenuItem and remaining host/VM ownership semantics still require implementation. Registered callbacks and explicit reference cycles retain their original ownership; arbitrary cycle collection is not part of TJS2.'
                    : hostPhase
                      ? 'Selected host handle drains, native weak observation and Timer/AsyncTrigger event leases are covered; Sound, Layer, Window, VideoOverlay, MenuItem and remaining host/VM ownership semantics still require implementation. Genuine registered callbacks and explicit reference cycles retain their original ownership; arbitrary cycle collection is not part of TJS2.'
                      : objectPhase
                        ? 'Reference-counted cleanup, explicit cycle breaking and selected finalizer failures are covered; host object ownership and remaining VM semantics still require implementation. Arbitrary cycle collection is not part of the TJS2 reference behavior.'
                        : executionPhase
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
const reportName = videoPhase
  ? 'video-object-lifetime-matrix.json'
  : soundPhase
    ? 'sound-object-lifetime-matrix.json'
    : hostPhase
      ? 'host-object-lifetime-matrix.json'
      : objectPhase
        ? 'object-finalization-matrix.json'
        : executionPhase
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
    (fontRestart
      ? `Also verified **${fontRestarts.length} WebKit font-dialog restart diagnostics** with ${fontRestartWorkers} worker(s).\n\n`
      : '') +
    `Sources, builds and individual results are bound in \`${reportName}\`. SHA-256: \`${await hash(output)}\`.\n`,
)
console.log('WROTE ' + output)
