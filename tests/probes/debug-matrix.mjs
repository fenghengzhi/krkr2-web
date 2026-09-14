import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'
const dir = 'out/verification/debug',
  digest = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  hash = async (path) => digest(await readFile(path)),
  json = async (path) => JSON.parse(await readFile(path, 'utf8')),
  priorPath = 'out/verification/text-layout-matrix.json',
  previous = await json(priorPath),
  log = dir + '/check.log',
  check = await readFile(log, 'utf8')
for (const line of ['ℹ tests 328\n', 'ℹ pass 328\n', 'ℹ fail 0\n', 'ℹ skipped 0\n'])
  assert(check.includes(line), line)
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const configs = [
    'playwright.config.ts',
    'playwright.library.config.ts',
    'playwright.pwa.config.ts',
    'playwright.activity.config.ts',
  ],
  stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((s) => Number(s[1])),
  [444, 57, 53, 7],
)
assert(/7 passed \([^\n]+\)\s*$/.test(check))
assert(/18 passed \([^\n]+\)\s*$/.test(await readFile(dir + '/graphics-startup/fixed.log', 'utf8')))
for (const path of [
  ...configs,
  'native/fonts/font.c',
  'src/backends/files/blob-source.ts',
  'tests/helpers/native-activity-browser.ts',
  'tests/activity-native-browser/freeze-deadlines.spec.ts',
])
  assert.equal(await hash(path), previous.criticalFiles[path], path)
const wasm = await json('dist/wasm/manifest.json'),
  font = await json('dist/fonts/manifest.json')
assert.deepEqual(wasm, previous.wasm)
assert.deepEqual(font, previous.font)
assert.deepEqual(wasm, await json('.generated/wasm/manifest.json'))
assert.deepEqual(font, await json('.generated/fonts/manifest.json'))
assert((await readFile('src/protocol/session.ts', 'utf8')).includes('PROTOCOL_VERSION = 8'))
const native = await json('tests/fixtures/debug/native.json')
assert.equal(native.cases.length, 96)
assert.deepEqual(native.sanitizers, ['address', 'undefined'])
assert.equal(await hash(native.source), native.sourceSha256)
assert.equal(await hash(dir + '/native/reference.inc'), native.extractedSha256)
assert.equal(await hash(dir + '/native/driver.cpp'), native.driverSha256)
assert.equal(await readFile(dir + '/native/stderr.txt', 'utf8'), '')
const kag = await json(dir + '/kag.json'),
  diagnostics = await json(dir + '/kag-diagnostics.json'),
  tjsAbi = await json(dir + '/abi-pwa.json'),
  fontAbi = await json(dir + '/font-abi-pwa.json'),
  indexSha256 = await hash('dist/index.html')
assert.equal(kag.results.length, 36)
assert.equal(diagnostics.results.length, 6)
for (const report of [kag, diagnostics]) {
  assert.equal(report.indexSha256, indexSha256)
  assert.equal(report.sourceSha256, previous.kag.sourceSha256)
}
for (const row of diagnostics.results) {
  assert(row.originalHandler && row.primaryLogged && row.observersNotified && row.recovered)
  assert.deepEqual(row.errors, [])
  assert.equal(await hash(row.log), row.logSha256)
  const bytes = await readFile(row.log)
  assert.equal(bytes.length, row.bytes)
  assert.deepEqual([...bytes.subarray(0, 2)], [255, 254])
  for (const marker of [
    'KAG-diagnostic-context',
    'KAG-diagnostic-primary',
    'KAG-diagnostic-recovered',
  ])
    assert(bytes.toString('utf16le').includes(marker))
}
for (const report of [tjsAbi, fontAbi]) {
  assert.equal(report.results.length, 6)
  assert.deepEqual(
    report.manifests.map((m) => m.abi),
    [1, 2],
  )
  for (const row of report.results) {
    assert(row.oldWorkerRestartedOffline && row.newWorkerStartedOffline)
    assert.deepEqual(row.errors, [])
  }
}
assert.deepEqual(tjsAbi.manifests[1], wasm)
assert.deepEqual(fontAbi.manifests[1], font)
assert.equal(fontAbi.manifestKind, 'fonts')
for (const row of fontAbi.results)
  for (const manifest of fontAbi.manifests)
    assert(row.fontRequests.some((url) => url.endsWith('/' + manifest.assets.wasm.file)))
const nativeCheck = await json(dir + '/native-check.json'),
  nativeIntervals = []
const persistentContexts = []
for (const [scope, count] of [
  ['library', 57],
  ['pwa', 53],
]) {
  const paths = (await readdir('test-results/' + scope, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name === 'persistent-context.json')
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort()
  assert.equal(paths.length, count, scope + ' persistent fixture records')
  for (const path of paths) {
    const record = await json(path)
    assert.equal(record.fixtureTimeoutMs, 30000)
    assert.equal(record.testTimeoutMs, 30000)
    assert(record.setupMs > 0 && record.setupMs < 30000)
    persistentContexts.push({ scope, ...record })
  }
}
await writeFile(
  dir + '/persistent-contexts.json',
  JSON.stringify(persistentContexts, null, 2) + '\n',
)
const mediaPaths = (await readdir('test-results', { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name === 'media-clock.json')
  .map((entry) => resolve(entry.parentPath, entry.name))
  .sort()
assert.equal(mediaPaths.length, 6)
const mediaClocks = []
for (const path of mediaPaths) {
  const record = await json(path)
  assert(record.setter && record.records.length > 0)
  assert(record.records.some((event) => event.event === 'visibilitychange'))
  mediaClocks.push({ case: path.split('/').at(-2), ...record })
}
await writeFile(dir + '/media-clocks.json', JSON.stringify(mediaClocks, null, 2) + '\n')
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
        const attachment = result.attachments.find((a) => a.name === 'trusted-lifecycle')
        assert(attachment?.body)
        const events = JSON.parse(Buffer.from(attachment.body, 'base64')),
          f = events.find((e) => e.event === 'freeze'),
          r = events.find((e) => e.event === 'resume')
        assert(f.trusted && r.trusted && r.time - f.time > 21000)
        nativeIntervals.push({ test: spec.title, milliseconds: r.time - f.time })
      }
  for (const sub of suite.suites ?? []) visit(sub)
}
for (const suite of nativeCheck.suites) visit(suite)
assert.equal(nativeIntervals.length, 1)
async function tree(directory) {
  const paths = (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => resolve(e.parentPath, e.name).slice(resolve(directory).length + 1))
      .sort(),
    entries = []
  for (const path of paths) {
    const bytes = await readFile(resolve(directory, path))
    entries.push([path, bytes.length, digest(bytes)])
  }
  return {
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e[1], 0),
    sha256: digest(JSON.stringify(entries)),
  }
}
const builds = []
for (const [path, base] of [
  ['dist', '/'],
  ['out/verification/pwa/site-a', '/player/'],
  ['out/verification/pwa/site-b', '/player/'],
])
  builds.push({ ...(await verifyOfflineBuild(path, base)), tree: await tree(path) })
for (const report of [tjsAbi, fontAbi])
  for (const row of report.results) assert.equal(row.newBuild, builds[0].build)
const oldFontRoot = 'out/verification/text-layout/font-abi1-root'
assert.deepEqual(
  await tree(oldFontRoot),
  previous.builds.find((b) => b.directory === oldFontRoot).tree,
)
const critical = [
  ...new Set([
    ...Object.keys(previous.criticalFiles),
    'src/engine/session.ts',
    'src/engine/storage/save-overlay.ts',
    'src/engine/diagnostics/log.ts',
    'src/engine/diagnostics/service.ts',
    'src/engine/tvp/debug.ts',
    'src/engine/tvp/bootstrap.ts',
    'tests/conformance/debug-log.test.ts',
    'tests/conformance/debug-native.test.ts',
    'tests/integration/debug.test.ts',
    'tests/integration/services.test.ts',
    'tests/browser/debug.spec.ts',
    'tests/browser/graphics-recovery.spec.ts',
    'tests/helpers/gpu-browser.ts',
    'tests/helpers/library-browser.ts',
    'tests/helpers/media-browser.ts',
    'tests/browser/activity-media.spec.ts',
    'tests/pwa-browser/debug.spec.ts',
    'tests/probes/debug-native.py',
    'tests/probes/debug-kag.ts',
    'tests/probes/debug-matrix.mjs',
    'tests/fixtures/debug/native.json',
    'docs/decisions/027-debug-logging.md',
  ]),
]
const evidence = [
  'check.log',
  'native-check.json',
  'native.log',
  'native-node-2.log',
  'native/reference.inc',
  'native/driver.cpp',
  'native/stdout.txt',
  'native/stderr.txt',
  'reference/krkr2-DebugIntf.cpp',
  'reference/krkrz-DebugIntf.cpp',
  'reference/Initialize.tjs',
  'native-initial.log',
  'native-node.log',
  'integration-initial.log',
  'integration.log',
  'integration-2.log',
  'integration-3.log',
  'log-unit.log',
  'session.log',
  'node-all.log',
  'before-failure-observer.log',
  'before-full-save.log',
  'full-save-fixed.log',
  'before-diagnostic-commit/check.log',
  'before-diagnostic-commit/red.log',
  'before-diagnostic-commit/session.ts',
  'before-diagnostic-commit/save-overlay.ts',
  'before-diagnostic-commit/log.ts',
  'diagnostic-commit.log',
  'diagnostic-isolation-node.log',
  'browser.log',
  'browser-2.log',
  'browser-3.log',
  'pwa-initial.log',
  'pwa.log',
  'kag.log',
  'kag-diagnostics.log',
  'kag-diagnostics.json',
  'abi-pwa.log',
  'abi-pwa.json',
  'font-abi-pwa.log',
  'font-abi-pwa.json',
  'graphics-startup/check.log',
  'graphics-startup/original.spec.ts',
  'graphics-startup/error-context.md',
  'graphics-startup/trace.zip',
  'graphics-startup/webkit-asyncify/error-context.md',
  'graphics-startup/webkit-asyncify/trace.zip',
  'graphics-startup/webkit-jspi/error-context.md',
  'graphics-startup/webkit-jspi/trace.zip',
  'graphics-startup/fixed.log',
  'before-explicit-void.log',
  'explicit-void-fixed.log',
  'library-profile/check.log',
  'library-profile/original.ts',
  'library-profile/firefox/error-context.md',
  'library-profile/firefox/trace.zip',
  'library-profile/fixed.log',
  'persistent-contexts.json',
  'media-clocks.json',
  'host-restart/check.log',
  'host-restart/boot.txt',
  'host-restart/state.json',
  'host-restart/media-webkit/error-context.md',
  'host-restart/media-webkit/trace.zip',
  'host-restart/media-repeat.log',
  'host-restart/media-instrumented.log',
  'host-restart/media-instrumented-records.json',
].map((p) => dir + '/' + p)
for (const row of kag.results) evidence.push(row.report, row.log, row.screenshot)
for (const row of diagnostics.results) evidence.push(row.log, row.screenshot)
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 328,
    browser: 561,
    addedBehaviorAndIntegration: 20,
    addedBrowser: 24,
    selectedSkipped: 0,
    nativeDebugCases: 96,
    graphicsStartupRepeats: 18,
    coldOfflineDebug: 6,
    externalKag: 36,
    externalKagDiagnostics: 6,
    crossTjsAbiPwa: 6,
    crossFontAbiPwa: 6,
  },
  checks: { log, sha256: await hash(log) },
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
  mediaClocks,
  persistentContextBudgets: { fixtureMs: 30000, testBodyMs: 30000, records: persistentContexts },
  source: await tree('src'),
  tests: await tree('tests'),
  scripts: await tree('scripts'),
  documentation: await tree('docs'),
  treeHashFormat: previous.treeHashFormat,
  builds,
  wasm,
  font,
  sessionProtocol: 8,
  wasmAndFontUnchanged: true,
  criticalFiles: Object.fromEntries(
    await Promise.all(critical.map(async (p) => [p, await hash(p)])),
  ),
  evidence: Object.fromEntries(await Promise.all(evidence.map(async (p) => [p, await hash(p)]))),
  native,
  kag,
  kagDiagnostics: diagnostics,
  crossTjsAbiPwa: tjsAbi,
  crossFontAbiPwa: fontAbi,
  interruptedRuns: [
    {
      log: dir + '/host-restart/check.log',
      exitCode: null,
      reason:
        'Host reboot at 2026-09-14 09:29:46 +08; the old process handle and OS processes were absent after restart. The partial log also preserves one earlier WebKit media-position failure.',
    },
    {
      log: dir + '/before-diagnostic-commit/check.log',
      exitCode: 130,
      reason:
        'Stopped after independently reproducing that a diagnostic-only failed transaction terminated the game; replaced by the final full regression after write-origin isolation.',
    },
  ],
  failedRuns: [
    {
      log: dir + '/graphics-startup/check.log',
      failed: 3,
      browserPassed: 441,
      reason:
        'GPU loss at a startup VM yield paused execution before the log that the old test awaited before restoration. The corrected test restores first, then checks startup completion, re-upload, program recreation and exact pixels.',
    },
    {
      log: dir + '/library-profile/check.log',
      failed: 1,
      browserPassed: 56,
      reason:
        'Persistent Firefox startup consumed 9.4 seconds of the scenario budget. The disk-profile fixture now has a separate 30-second setup/teardown bound; body timeout and assertions remain unchanged.',
    },
  ],
  priorMatrices: [{ path: priorPath, sha256: await hash(priorPath) }],
  incomplete: [
    'Pre-reboot WebKit media-position discontinuity was not reproduced by 6 unchanged and 12 instrumented repetitions; strict assertions and event/seek diagnostics remain for the unfinished media boundary work',
    'Debug Console/Controller UI objects, full VM console gateway and all native exception/finalizer paths',
    'All other non-plugin requirements retained in docs/non-plugin-progress.md',
    'The full non-plugin goal remains active',
  ],
}
await writeFile('out/verification/debug-matrix.json', JSON.stringify(matrix, null, 2) + '\n')
console.log('WROTE ' + resolve('out/verification/debug-matrix.json'))
