// Bind the completed System phase to its exact implementation and artifacts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'
const directory = 'out/verification/system-events',
  digest = (data) => createHash('sha256').update(data).digest('hex'),
  hash = async (path) => digest(await readFile(path)),
  json = async (path) => JSON.parse(await readFile(path, 'utf8'))
async function tree(directory) {
  const paths = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name).slice(resolve(directory).length + 1))
    .sort()
  const entries = []
  let bytes = 0
  for (const path of paths) {
    const data = await readFile(resolve(directory, path))
    bytes += data.length
    entries.push([path, data.length, digest(data)])
  }
  return { files: paths.length, bytes, sha256: digest(JSON.stringify(entries)) }
}
const log = directory + '/check.log',
  check = await readFile(log, 'utf8')
assert(check.includes('ℹ pass 260\n') && check.includes('ℹ tests 260\n'))
assert(check.includes('ℹ fail 0\n') && check.includes('ℹ skipped 0\n'))
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((stage) => Number(stage[1])),
  [363, 57, 35, 7],
)
assert(/7 passed \([^\n]+\)\s*$/.test(check))
const configs = [
    'playwright.config.ts',
    'playwright.library.config.ts',
    'playwright.pwa.config.ts',
    'playwright.activity.config.ts',
  ],
  previous = await json('out/verification/activity-matrix.json')
for (const path of configs) assert.equal(await hash(path), previous.criticalFiles[path])
const cases = check
  .split('\n')
  .filter((line) => /✓.*tests\/browser\/system-events\.spec\.ts:/.test(line))
  .map((line) => line.trim())
assert.equal(cases.length, 24)
for (const browser of ['chromium', 'firefox', 'webkit'])
  for (const backend of ['asyncify', 'jspi'])
    assert.equal(
      cases.filter((line) => line.includes(`[${browser}]`) && line.includes(`› ${backend}:`))
        .length,
      4,
    )
const wasm = await json('dist/wasm/manifest.json')
assert.equal(wasm.abi, 2)
assert.deepEqual(wasm, await json('.generated/wasm/manifest.json'))
for (const variant of ['asyncify', 'jspi'])
  assert.notEqual(wasm.variants[variant].wasm.sha256, previous.wasm.variants[variant].wasm.sha256)
const oracle = await json('tests/fixtures/system-events/events.json')
assert.equal(Object.keys(oracle.cases).length, 10)
assert.equal(await hash('../kirikiroid2-web/cpp/core/base/EventIntf.cpp'), oracle.sourceSha256)
const abi = await json(directory + '/abi-pwa.json')
assert.equal(abi.results.length, 6)
for (const result of abi.results) {
  assert.equal(result.oldAbi, 1)
  assert.equal(result.newAbi, 2)
  assert(result.oldWorkerRestartedOffline && result.newWorkerStartedOffline)
  assert.deepEqual(result.errors, [])
}
assert.deepEqual(abi.manifests[1], wasm)
const kag = await json(directory + '/kag.json')
assert.equal(kag.results.length, 36)
assert.equal(kag.indexSha256, await hash('dist/index.html'))
for (const entry of kag.results) {
  assert.equal(await hash(entry.report), entry.sha256)
  assert.equal(await hash(entry.log), entry.logSha256)
}
const builds = []
for (const [path, base] of [
  ['dist', '/'],
  ['out/verification/pwa/site-a', '/player/'],
  ['out/verification/pwa/site-b', '/player/'],
])
  builds.push({ ...(await verifyOfflineBuild(path, base)), tree: await tree(path) })
for (const entry of abi.results) assert.equal(entry.newBuild, builds[0].build)
const critical = [
  'src/engine/scheduler/system-events.ts',
  'src/engine/scheduler/events.ts',
  'src/engine/tvp/system.ts',
  'src/engine/tvp/bootstrap.ts',
  'src/engine/tvp/input.ts',
  'src/engine/tvp/sound.ts',
  'src/engine/tvp/video.ts',
  'src/engine/tvp/menus.ts',
  'src/engine/session.ts',
  'src/engine/media/videos.ts',
  'src/engine/scene/menus.ts',
  'src/engine/script/runtime.ts',
  'src/backends/script/tjs-wasm/runtime.ts',
  'native/tjs2/bridge.cpp',
  'src/player/create-session.ts',
  'src/protocol/session.ts',
  'src/app/app.ts',
  'src/app/game-menus.ts',
  'scripts/build-wasm.mjs',
  'tests/integration/system-events.test.ts',
  'tests/integration/system-order.test.ts',
  'tests/integration/menus.test.ts',
  'tests/integration/sound.test.ts',
  'tests/conformance/tjs.test.ts',
  'tests/browser/system-events.spec.ts',
  'tests/fixtures/system-events/events.json',
  'tests/probes/system-events-native.py',
  'tests/probes/system-abi-pwa.ts',
  'tests/probes/system-kag-matrix.mjs',
  'tests/probes/system-events-matrix.mjs',
  ...configs,
  'package.json',
  'package-lock.json',
  'README.md',
]
const evidence = [
  log,
  directory + '/native-oracle.log',
  directory + '/native-check.json',
  directory + '/native/output.txt',
  directory + '/abi-pwa.json',
  directory + '/abi-pwa.log',
  directory + '/kag.json',
  directory + '/kag.log',
  directory + '/focused-node.log',
  directory + '/sound.log',
  directory + '/media-browser.log',
  directory + '/first-browser-failure/check.log',
  directory + '/media-observation-failure/check.log',
  directory + '/media-start-failure/check.log',
]
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 260,
    browser: 462,
    selectedSkipped: 0,
    addedBehaviorAndIntegration: 30,
    addedBrowser: 24,
    externalKag: 36,
    crossAbiPwa: 6,
    nativeReferenceTraces: 10,
  },
  checks: { log, sha256: await hash(log) },
  browserStages: stages.map((stage, i) => ({
    config: configs[i],
    passed: Number(stage[1]),
    duration: stage[2],
    workers: 2,
    testTimeoutMs: 30000,
    assertionTimeoutMs: 12000,
  })),
  previousBrowserConfigurationsUnchanged: true,
  excluded: previous.excluded,
  tracingControl: previous.tracingControl,
  browsers: (await json('node_modules/playwright-core/browsers.json')).browsers.filter((browser) =>
    ['chromium', 'firefox', 'webkit'].includes(browser.name),
  ),
  source: await tree('src'),
  tests: await tree('tests'),
  scripts: await tree('scripts'),
  documentation: await tree('docs'),
  treeHashFormat:
    'SHA-256 of JSON array of [relative path, byte count, SHA-256], sorted by ordinal relative path',
  criticalFiles: Object.fromEntries(
    await Promise.all(critical.map(async (path) => [path, await hash(path)])),
  ),
  evidence: Object.fromEntries(
    await Promise.all(evidence.map(async (path) => [path, await hash(path)])),
  ),
  builds,
  wasm,
  sessionProtocol: 6,
  systemCases: cases,
  nativeReference: {
    ...oracle,
    sanitizers: ['address', 'undefined'],
    scope:
      'Extracted event functions with inert platform/callback stubs; not full native GUI/TJS/clock execution',
  },
  crossAbiPwa: abi,
  kag,
  verifiedBehaviors: [
    'Native priority groups, shared nested generation cutoff, live continuous additions/removals and reentry guard',
    'Exact Object/ObjThis closure identity, deduplication, status-only call failures distinct from user negative return values',
    'Continuous 16-bit fractional interval, unique-registration frequency refresh, pause deadline compensation and coalesced disabled wakes',
    'System event disabling leaves VM evaluation and media clocks usable; deferred versus discarded events remain distinct',
    'Exception closures preserve anonymous global and bound receivers, getter reads once, replacement and primitive thrown values work',
    'Timer capacity excludes active callbacks and 70,000 cached posts do not exhaust the pending-event queue',
    'Menu visibility and input epochs reject stale clicks; popup results survive event disabling and dismiss on page/user pause',
    'Both WASM backends stop infinite continuous loops and can start a fresh game in all three browsers',
    'Actual video and Worklet playback completes while events are disabled; natural completion notifications drain on reenable',
    'Preserved ABI 1 and current ABI 2 Workers restart offline side by side without mixed runtime generations',
    'Original KAG XP3 and byte-preserving ZIP: three browsers, two WASM backends, flow/save/transition',
  ],
  diagnostics: {
    implementationFixes: [
      'Dictionary member invocation bound an anonymous exception handler to System; loading the closure before invocation preserves its context',
      'TJS Object typeof is capitalized; diagnostics must also accept primitive thrown values',
    ],
    testCorrections: [
      'Released player displays idle rather than the transient engine stopped state',
      'Video completion cannot stand in for independent audio completion',
      'A looping sound may end between disabling its loop and seeking; the completion case explicitly stops, configures and starts playback before observing the sample clock',
    ],
  },
  priorMatrices: await Promise.all(
    ['activity', 'graphics', 'pwa', 'library', 'http', 'zip'].map(async (name) => {
      const path = `out/verification/${name}-matrix.json`
      return { path, sha256: await hash(path) }
    }),
  ),
  incomplete: [
    'Full native window update tail, immediate exception dispatch and all event reentry permutations',
    'Timer/AsyncTrigger implicit GC ownership and native host object type semantics',
    'Window cursor queries currently follow delivered packets and can remain stale while move events are disabled',
    'Complete IME, native multiwindow/fullscreen, fonts and remaining graphics methods',
    'Streaming media, complete MIDI and old video containers/codecs',
    'Mobile termination, actual BFCache and long-term resource pressure',
    'The complete non-plugin goal remains active',
  ],
}
await writeFile(
  'out/verification/system-events-matrix.json',
  JSON.stringify(matrix, null, 2) + '\n',
)
console.log('WROTE ' + resolve('out/verification/system-events-matrix.json'))
