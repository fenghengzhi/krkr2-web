// Bind completed selection checks to their source, native reference and release.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'
const directory = 'out/verification/font-selection',
  digest = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  hash = async (path) => digest(await readFile(path)),
  json = async (path) => JSON.parse(await readFile(path, 'utf8')),
  previous = await json('out/verification/font-geometry-matrix.json'),
  log = directory + '/check.log',
  check = await readFile(log, 'utf8')
for (const line of ['ℹ tests 301\n', 'ℹ pass 301\n', 'ℹ fail 0\n', 'ℹ skipped 0\n'])
  assert(check.includes(line), line)
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((s) => Number(s[1])),
  [417, 57, 41, 7],
)
assert(/7 passed \([^\n]+\)\s*$/.test(check))
const configs = [
  'playwright.config.ts',
  'playwright.library.config.ts',
  'playwright.pwa.config.ts',
  'playwright.activity.config.ts',
]
for (const path of configs) assert.equal(await hash(path), previous.criticalFiles[path])
for (const path of [
  'native/fonts/font.c',
  'tests/helpers/native-activity-browser.ts',
  'tests/activity-native-browser/freeze-deadlines.spec.ts',
  'src/backends/files/blob-source.ts',
])
  assert.equal(await hash(path), previous.criticalFiles[path])
const wasm = await json('dist/wasm/manifest.json'),
  font = await json('dist/fonts/manifest.json')
assert.deepEqual(wasm, previous.wasm)
assert.deepEqual(wasm, await json('.generated/wasm/manifest.json'))
assert.deepEqual(font, previous.font)
assert.deepEqual(font, await json('.generated/fonts/manifest.json'))
assert.equal(wasm.abi, 2)
assert.equal(font.abi, 1)
assert((await readFile('src/protocol/session.ts', 'utf8')).includes('PROTOCOL_VERSION = 8'))
const native = await json('tests/fixtures/font-selection/filter-reference.json'),
  fixtures = await json('tests/fixtures/font-selection/reference.json')
assert.equal(native.cases.length, 256)
assert.deepEqual(native.sanitizers, ['address', 'undefined'])
assert.equal(await hash('../' + native.source), native.sourceSha256)
assert.equal(await hash(directory + '/native/reference.inc'), native.extractedSha256)
assert.equal(await readFile(directory + '/native/stderr.txt', 'utf8'), '')
assert.equal(fixtures.cases.length, 7)
for (const row of fixtures.cases)
  assert.equal(await hash('tests/fixtures/font-selection/' + row.file), row.sha256)
const local = await json(directory + '/local-fonts.json'),
  kag = await json(directory + '/kag.json'),
  abi = await json(directory + '/abi-pwa.json'),
  indexSha = await hash('dist/index.html')
assert(local.nativeApi && local.rendered && local.selected)
assert(local.filteredFamilies > 0)
assert.deepEqual(local.errors, [])
assert.equal(local.indexSha256, indexSha)
assert.equal(kag.indexSha256, indexSha)
assert.equal(kag.results.length, 36)
assert.equal(abi.results.length, 6)
assert.deepEqual(abi.manifests[1], wasm)
for (const result of abi.results) {
  assert(result.oldWorkerRestartedOffline && result.newWorkerStartedOffline)
  assert.deepEqual(result.errors, [])
}
const nativeCheck = await json(directory + '/native-check.json'),
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
function visitNative(suite) {
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests)
      for (const result of test.results) {
        assert.equal(result.status, 'passed')
        if (!spec.title.includes('longer than media request deadlines')) continue
        const attachment = result.attachments.find((a) => a.name === 'trusted-lifecycle')
        assert(attachment?.body)
        const events = JSON.parse(Buffer.from(attachment.body, 'base64')),
          freeze = events.find((e) => e.event === 'freeze'),
          resume = events.find((e) => e.event === 'resume'),
          milliseconds = resume.time - freeze.time
        assert(freeze.trusted && resume.trusted && milliseconds > 21000)
        nativeIntervals.push({ test: spec.title, milliseconds })
      }
  for (const child of suite.suites ?? []) visitNative(child)
}
for (const suite of nativeCheck.suites) visitNative(suite)
assert.equal(nativeIntervals.length, 1)
async function tree(directory) {
  const paths = (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => resolve(e.parentPath, e.name).slice(resolve(directory).length + 1))
      .sort(),
    entries = await Promise.all(
      paths.map(async (path) => {
        const bytes = await readFile(resolve(directory, path))
        return [path, bytes.length, digest(bytes)]
      }),
    )
  return {
    files: entries.length,
    bytes: entries.reduce((sum, e) => sum + e[1], 0),
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
for (const result of abi.results) assert.equal(result.newBuild, builds[0].build)
const critical = [
  'src/formats/font/metadata.ts',
  'src/engine/ports/fonts.ts',
  'src/engine/graphics/font-catalog.ts',
  'src/engine/graphics/font-selection.ts',
  'src/engine/graphics/fonts.ts',
  'src/engine/scheduler/cancelable.ts',
  'src/engine/session.ts',
  'src/engine/tvp/layer.ts',
  'src/protocol/session.ts',
  'src/player/session-client.ts',
  'src/player/create-session.ts',
  'src/player/create-player.ts',
  'src/workers/session.worker.ts',
  'src/backends/text/browser/families.ts',
  'src/backends/text/browser/local-fonts.ts',
  'src/backends/text/browser/graphics.ts',
  'src/app/game-fonts.ts',
  'src/app/game-menus.ts',
  'src/app/app.ts',
  'src/app/styles.css',
  'src/backends/files/blob-source.ts',
  'native/fonts/font.c',
  'tests/helpers/native-activity-browser.ts',
  'tests/activity-native-browser/freeze-deadlines.spec.ts',
  'tests/conformance/font-metadata.test.ts',
  'tests/integration/font-selection.test.ts',
  'tests/browser/font-selection.spec.ts',
  'tests/browser/font-backend.spec.ts',
  'tests/pwa-browser/fonts.spec.ts',
  'tests/probes/local-fonts.ts',
  'tests/probes/font-selection-native.py',
  'tests/probes/font-selection-matrix.mjs',
  'scripts/generate-font-selection-fixtures.py',
  'tests/fixtures/font-selection/reference.json',
  'tests/fixtures/font-selection/filter-reference.json',
  'README.md',
  'docs/architecture.md',
  'docs/non-plugin-progress.md',
  'docs/compatibility/current.md',
  'docs/decisions/025-font-selection.md',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  ...configs,
]
const evidence = [
  'check.log',
  'native-check.json',
  'final-focused-browser.log',
  'style-node-2.log',
  'final-build.log',
  'local-fonts.log',
  'local-fonts.json',
  'focused-pwa.log',
  'pwa-build.log',
  'kag.log',
  'kag.json',
  'abi-pwa.log',
  'abi-pwa.json',
  'native/oracle.cpp',
  'native/reference.inc',
  'native/stderr.txt',
].map((path) => directory + '/' + path)
for (const result of kag.results) evidence.push(result.log, result.report, result.screenshot)
const cases = check
  .split('\n')
  .filter((line) => /✓.*tests\/browser\/font-selection\.spec\.ts:/.test(line))
  .map((line) => line.trim())
assert.equal(cases.length, 27)
assert.equal(
  check.split('\n').filter((line) => /✓.*tests\/pwa-browser\/fonts\.spec\.ts:/.test(line)).length,
  6,
)
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 301,
    browser: 522,
    selectedSkipped: 0,
    addedBehaviorAndIntegration: 11,
    addedBrowser: 27,
    nativeFilterCases: 256,
    fontMetadataFiles: 7,
    coldOfflineFontSelection: 6,
    realLocalFontAccess: 1,
    externalKag: 36,
    crossAbiPwa: 6,
  },
  checks: { log, sha256: await hash(log) },
  browserStages: stages.map((s, i) => ({
    config: configs[i],
    passed: Number(s[1]),
    duration: s[2],
    workers: 2,
    testTimeoutMs: 30000,
    assertionTimeoutMs: 12000,
  })),
  previousBrowserConfigurationsUnchanged: true,
  nativeIntervals,
  nativeFixtureBudgets: previous.nativeFixtureBudgets,
  excluded: previous.excluded,
  tracingControl: previous.tracingControl,
  browsers: (await json('node_modules/playwright-core/browsers.json')).browsers.filter((b) =>
    ['chromium', 'firefox', 'webkit'].includes(b.name),
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
  font,
  tjsWasmUnchanged: true,
  fontWasmUnchanged: true,
  sessionProtocol: 8,
  nativeFilter: {
    source: native.source,
    sourceSha256: native.sourceSha256,
    extractedSha256: native.extractedSha256,
    sanitizers: native.sanitizers,
    scope: native.scope,
  },
  localFontAccess: local,
  selectionCases: cases,
  kag,
  crossAbiPwa: abi,
  verifiedBehaviors: [
    'Font getList applies original filter order, outline distinctions, charset matching and deduplication on controlled native rows',
    'Real synthetic SFNT metadata covers Unicode/Mac Roman names, first TTC face, code pages, symbol and vertical records, pitch and bold selection',
    'Game family names select regular or physical bold sources without repeated synthesis; current namespace bindings outrank archive aliases',
    'Font dialog suspends TJS, preserves other font settings and permits cancellation or stopping during startup',
    'Real engine pixels render the sample and game-family labels; generic CSS names retain their keyword behavior',
    'Raster operations remain serialized across finishing previews and subsequent script calls, including LRU face eviction',
    'Hidden confirmation is ignored and cancellation remains behind the VM pause gate; stale request and permission results cannot modify later selections',
    'Permission requests originate from clicks; denial and retry, narrow layout, keyboard choice and menu shortcut isolation are covered',
    'Cold new browser processes with the server closed can enumerate, preview and choose saved game fonts',
  ],
  priorMatrices: [
    {
      path: 'out/verification/font-geometry-matrix.json',
      sha256: await hash('out/verification/font-geometry-matrix.json'),
    },
  ],
  incomplete: [
    'Exact Windows font substitution and current-charset inference; Local Font Access does not exist on every browser',
    'Unenumerated game-family discovery, mixed game/system fallback lists, TTC multi-face selection and variable font axes',
    'Legacy charmaps, complete font cache lifetimes, opaque native font identity, ruby and complete vertical layout',
    'All final text blend combinations and the remaining non-plugin APIs in docs/non-plugin-progress.md',
    'The full non-plugin goal remains active',
  ],
}
await writeFile(
  'out/verification/font-selection-matrix.json',
  JSON.stringify(matrix, null, 2) + '\n',
)
console.log('WROTE ' + resolve('out/verification/font-selection-matrix.json'))
