import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'

const dir = 'out/verification/debug-panels',
  priorPath = 'out/verification/debug-matrix.json',
  digest = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  hash = async (path) => digest(await readFile(path)),
  json = async (path) => JSON.parse(await readFile(path, 'utf8')),
  previous = await json(priorPath),
  check = await readFile(dir + '/check.log', 'utf8'),
  configs = [
    'playwright.config.ts',
    'playwright.library.config.ts',
    'playwright.pwa.config.ts',
    'playwright.activity.config.ts',
  ]
for (const line of ['ℹ tests 331\n', 'ℹ pass 331\n', 'ℹ fail 0\n', 'ℹ skipped 0\n'])
  assert(check.includes(line), line)
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((s) => Number(s[1])),
  [462, 57, 53, 7],
)
assert(/7 passed \([^\n]+\)\s*$/.test(check))
for (const path of [
  ...configs,
  'native/fonts/font.c',
  'src/backends/files/blob-source.ts',
  'tests/helpers/native-activity-browser.ts',
  'tests/activity-native-browser/freeze-deadlines.spec.ts',
  'tests/helpers/library-browser.ts',
  'tests/helpers/media-browser.ts',
  'tests/browser/activity-media.spec.ts',
])
  assert.equal(await hash(path), previous.criticalFiles[path], path)
const wasm = await json('dist/wasm/manifest.json'),
  font = await json('dist/fonts/manifest.json')
assert.deepEqual(wasm, previous.wasm)
assert.deepEqual(font, previous.font)
assert((await readFile('src/protocol/session.ts', 'utf8')).includes('PROTOCOL_VERSION = 9'))
const kag = await json(dir + '/kag.json'),
  panels = await json(dir + '/kag-panels.json'),
  tjsAbi = await json(dir + '/abi-pwa.json'),
  fontAbi = await json(dir + '/font-abi-pwa.json'),
  protocol = await json(dir + '/protocol-pwa.json'),
  indexSha256 = await hash('dist/index.html')
assert.equal(kag.results.length, 36)
assert.equal(panels.results.length, 6)
for (const report of [kag, panels]) {
  assert.equal(report.indexSha256, indexSha256)
  assert.equal(report.sourceSha256, previous.kag.sourceSha256)
}
for (const row of panels.results) {
  assert(row.originalMenuHandlers && row.originalShortcuts && row.independentVisibility)
  assert.deepEqual(row.errors, [])
}
for (const report of [tjsAbi, fontAbi, protocol]) {
  assert.equal(report.results.length, 6)
  assert.deepEqual(
    report.manifests.map((m) => m.abi),
    report === protocol ? [2, 2] : [1, 2],
  )
  for (const row of report.results) {
    assert(row.oldWorkerRestartedOffline && row.newWorkerStartedOffline)
    assert.deepEqual(row.errors, [])
  }
}
assert.deepEqual(tjsAbi.manifests[1], wasm)
assert.deepEqual(fontAbi.manifests[1], font)
for (const [report, prior] of [
  [tjsAbi, previous.crossTjsAbiPwa],
  [fontAbi, previous.crossFontAbiPwa],
]) {
  assert.deepEqual(report.manifests[0], prior.manifests[0])
  for (const row of report.results) assert.equal(row.oldBuild, prior.results[0].oldBuild)
}
assert.deepEqual(protocol.manifests, [wasm, wasm])
for (const row of protocol.results)
  assert(row.oldProtocol === 8 && row.newProtocol === 9 && row.panelsVerified)
for (const row of fontAbi.results)
  for (const manifest of fontAbi.manifests)
    assert(row.fontRequests.some((url) => url.endsWith('/' + manifest.assets.wasm.file)))
const nativeCheck = await json(dir + '/native-check.json'),
  nativeIntervals = []
assert.deepEqual(
  [
    nativeCheck.stats.expected,
    nativeCheck.stats.unexpected,
    nativeCheck.stats.flaky,
    nativeCheck.stats.skipped,
  ],
  [7, 0, 0, 0],
)
function visit(suite) {
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests)
      for (const result of test.results) {
        assert.equal(result.status, 'passed')
        if (!spec.title.includes('longer than media request deadlines')) continue
        const a = result.attachments.find((a) => a.name === 'trusted-lifecycle')
        const events = JSON.parse(Buffer.from(a.body, 'base64')),
          f = events.find((e) => e.event === 'freeze'),
          r = events.find((e) => e.event === 'resume')
        assert(f.trusted && r.trusted && r.time - f.time > 21000)
        nativeIntervals.push({ test: spec.title, milliseconds: r.time - f.time })
      }
  for (const s of suite.suites ?? []) visit(s)
}
nativeCheck.suites.forEach(visit)
assert.equal(nativeIntervals.length, 1)
async function files(directory) {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => resolve(e.parentPath, e.name))
    .sort()
}
async function tree(directory) {
  const entries = []
  for (const path of await files(directory)) {
    const bytes = await readFile(path)
    entries.push([path.slice(resolve(directory).length + 1), bytes.length, digest(bytes)])
  }
  return {
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e[1], 0),
    sha256: digest(JSON.stringify(entries)),
  }
}
const budgets = [],
  clocks = []
for (const [scope, count] of [
  ['library', 57],
  ['pwa', 53],
]) {
  const paths = (await files('test-results/' + scope)).filter((p) =>
    p.endsWith('/persistent-context.json'),
  )
  assert.equal(paths.length, count)
  for (const path of paths) {
    const record = await json(path)
    assert(
      record.fixtureTimeoutMs === 30000 &&
        record.testTimeoutMs === 30000 &&
        record.setupMs > 0 &&
        record.setupMs < 30000,
    )
    budgets.push({ scope, ...record })
  }
}
for (const path of (await files('test-results')).filter((p) => p.endsWith('/media-clock.json'))) {
  const record = await json(path)
  assert(record.setter && record.records.some((e) => e.event === 'visibilitychange'))
  clocks.push({ case: path.split('/').at(-2), ...record })
}
assert.equal(clocks.length, 6)
await writeFile(dir + '/persistent-contexts.json', JSON.stringify(budgets, null, 2) + '\n')
await writeFile(dir + '/media-clocks.json', JSON.stringify(clocks, null, 2) + '\n')
const builds = []
for (const [path, base] of [
  ['dist', '/'],
  ['out/verification/pwa/site-a', '/player/'],
  ['out/verification/pwa/site-b', '/player/'],
  [dir + '/protocol8-root', '/'],
])
  builds.push({ ...(await verifyOfflineBuild(path, base)), tree: await tree(path) })
assert.deepEqual(builds[3].tree, previous.builds[0].tree)
assert.equal(builds[3].build, previous.builds[0].build)
for (const report of [tjsAbi, fontAbi, protocol])
  for (const row of report.results) assert.equal(row.newBuild, builds[0].build)
for (const row of protocol.results) assert.equal(row.oldBuild, builds[3].build)
const critical = [
  ...new Set([
    ...Object.keys(previous.criticalFiles),
    'src/engine/diagnostics/panels.ts',
    'src/engine/tvp/debug.ts',
    'src/engine/session.ts',
    'src/protocol/session.ts',
    'src/player/session-client.ts',
    'src/workers/session.worker.ts',
    'src/app/app.ts',
    'src/app/styles.css',
    'tests/integration/debug-panels.test.ts',
    'tests/browser/debug-panels.spec.ts',
    'tests/browser/activity.spec.ts',
    'tests/helpers/activity-browser.ts',
    'tests/probes/debug-panels-kag.ts',
    'tests/probes/system-abi-pwa.ts',
    'tests/probes/debug-panels-matrix.mjs',
    'docs/decisions/028-debug-panels.md',
  ]),
]
const evidence = [
  'check.log',
  'native-check.json',
  'browser.log',
  'browser-2.log',
  'node-initial.log',
  'kag.log',
  'kag.json',
  'kag-panels.log',
  'kag-panels.json',
  'abi-pwa.log',
  'abi-pwa.json',
  'font-abi-pwa.log',
  'font-abi-pwa.json',
  'protocol-pwa.log',
  'protocol-pwa.json',
  'persistent-contexts.json',
  'native-class-gap.json',
  'media-clocks.json',
].map((p) => dir + '/' + p)
for (const folder of ['focus-before', 'input-before', 'reference'])
  for (const path of await files(dir + '/' + folder)) evidence.push(path)
for (const row of kag.results) evidence.push(row.report, row.log, row.screenshot)
for (const row of panels.results) evidence.push(row.screenshot)
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 331,
    browser: 579,
    addedBehaviorAndIntegration: 3,
    addedBrowser: 18,
    selectedSkipped: 0,
    externalKag: 36,
    externalKagDebugPanels: 6,
    crossTjsAbiPwa: 6,
    crossFontAbiPwa: 6,
    crossProtocolPwa: 6,
  },
  checks: { log: dir + '/check.log', sha256: await hash(dir + '/check.log') },
  browserStages: stages.map((s, i) => ({
    ...previous.browserStages[i],
    passed: Number(s[1]),
    duration: s[2],
  })),
  previousBrowserConfigurationsUnchanged: true,
  excluded: previous.excluded,
  tracingControl: previous.tracingControl,
  nativeFixtureBudgets: previous.nativeFixtureBudgets,
  nativeIntervals,
  persistentContextBudgets: { fixtureMs: 30000, testBodyMs: 30000, records: budgets },
  mediaClocks: clocks,
  source: await tree('src'),
  tests: await tree('tests'),
  scripts: await tree('scripts'),
  documentation: await tree('docs'),
  treeHashFormat: previous.treeHashFormat,
  builds,
  wasm,
  font,
  wasmAndFontUnchanged: true,
  sessionProtocol: 9,
  criticalFiles: Object.fromEntries(
    await Promise.all(critical.map(async (p) => [p, await hash(p)])),
  ),
  evidence: Object.fromEntries(await Promise.all(evidence.map(async (p) => [p, await hash(p)]))),
  kag,
  kagDebugPanels: panels,
  crossTjsAbiPwa: tjsAbi,
  crossFontAbiPwa: fontAbi,
  crossProtocolPwa: protocol,
  failedRuns: [
    {
      log: dir + '/input-before/check.log',
      failed: 1,
      browserPassed: 461,
      reason:
        'The single console read of committed text returned false. Original tracing did not capture the commit time; 12 instrumented repetitions passed. The test now awaits the actual TJS onKeyPress acknowledgement before retaining all original value/key/click assertions. No production input change was made.',
    },
    {
      log: dir + '/focus-before/browser.log',
      failed: 2,
      browserPassed: 28,
      reason:
        'WebKit pointer clicks did not focus the hide button. Explicit focus restoration and expression-input focus fix the retained strict assertions.',
    },
  ],
  priorMatrices: [{ path: priorPath, sha256: await hash(priorPath) }],
  incomplete: [
    'Debug Console/Controller native class identity, construction and static member semantics; full VM console output gateway, Scripts.dump and all native error/finalizer paths',
    'Historical WebKit paused-video position discontinuity remains unrootcaused; strict media tests and diagnostics retained',
    'All other non-plugin requirements in docs/non-plugin-progress.md remain active',
  ],
}
await writeFile('out/verification/debug-panels-matrix.json', JSON.stringify(matrix, null, 2) + '\n')
console.log('WROTE ' + resolve('out/verification/debug-panels-matrix.json'))
