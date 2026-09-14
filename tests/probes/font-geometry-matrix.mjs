// Bind the completed font-geometry verification to actual source and release identities.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'
const directory = 'out/verification/font-geometry'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hash = async (path) => digest(await readFile(path))
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
async function tree(directory) {
  const paths = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => resolve(e.parentPath, e.name).slice(resolve(directory).length + 1))
    .sort()
  const entries = await Promise.all(
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
const log = directory + '/check.log',
  check = await readFile(log, 'utf8'),
  previous = await json('out/verification/fonts-matrix.json')
for (const line of ['ℹ tests 290\n', 'ℹ pass 290\n', 'ℹ fail 0\n', 'ℹ skipped 0\n'])
  assert(check.includes(line), line)
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((s) => Number(s[1])),
  [390, 57, 41, 7],
)
const configs = [
  'playwright.config.ts',
  'playwright.library.config.ts',
  'playwright.pwa.config.ts',
  'playwright.activity.config.ts',
]
for (const path of configs) assert.equal(await hash(path), previous.criticalFiles[path])
const wasm = await json('dist/wasm/manifest.json'),
  font = await json('dist/fonts/manifest.json')
assert.deepEqual(wasm, previous.wasm)
assert.deepEqual(wasm, await json('.generated/wasm/manifest.json'))
const tjsSources = createHash('sha256')
async function hashTjsSources(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const path = directory + '/' + entry.name
    if (path === 'native/fonts') continue
    if (entry.isDirectory()) await hashTjsSources(path)
    else if (/\.(c|cc|cpp|h|hpp|inc|y|py|in|txt)$/.test(entry.name))
      tjsSources.update(path + '\0').update(await readFile(path))
  }
}
await hashTjsSources('native')
await hashTjsSources('third_party')
assert.equal(tjsSources.digest('hex'), wasm.source.sha256)
assert.deepEqual(font, await json('.generated/fonts/manifest.json'))
assert.equal(wasm.abi, 2)
assert.equal(font.abi, 1)
assert.equal(font.version, 'VER-2-14-3')
assert.equal(font.sourceSha256, await hash('native/fonts/font.c'))
assert.equal(
  font.portSha256,
  await hash('../toolchains/krkr2/emsdk/upstream/emscripten/tools/ports/freetype.py'),
)
assert((await readFile('src/protocol/session.ts', 'utf8')).includes('PROTOCOL_VERSION = 7'))
const geometry = await json('tests/fixtures/font-geometry/reference.json'),
  native = await json('tests/fixtures/font-geometry/freetype.json'),
  outline = await json('tests/fixtures/font-geometry/outlines.json')
assert.equal(geometry.coordinates.length, 25200)
assert.equal(geometry.rectangles.length, 337)
assert.equal(native.cases.length, 512)
assert.deepEqual(native.version, [2, 14, 3])
assert.deepEqual(native.sanitizers, ['address', 'undefined'])
assert.equal(native.fontSha256, await hash('tests/fixtures/font-geometry/outlines.ttf'))
assert.equal(outline.sha256, native.fontSha256)
assert.equal(native.librarySha256, await hash(directory + '/freetype-build/libfreetype.a'))
for (const report of [geometry, native])
  for (const [path, sha] of Object.entries(report.sourceSha256))
    assert.equal(sha, await hash('../kirikiroid2-web/cpp/core/visual/' + path))
const versions = await json(directory + '/freetype-version-differences.json')
assert.equal(versions.cases, 512)
assert.equal(versions.differentCases, 68)
assert(versions.differences.every((row) => row.flags & 16 && row.fields.join(',') === 'coverage'))
const abi = await json(directory + '/abi-pwa.json'),
  kag = await json(directory + '/kag.json'),
  canvas = await json(directory + '/canvas.json')
assert.equal(abi.results.length, 6)
assert.equal(kag.results.length, 36)
assert.equal(canvas.results.length, 6)
assert.deepEqual(abi.manifests[1], wasm)
const nativeCheck = await json(directory + '/native-check.json')
assert.equal(nativeCheck.stats.expected, 7)
assert.equal(nativeCheck.stats.unexpected, 0)
assert.equal(nativeCheck.stats.flaky, 0)
assert.equal(nativeCheck.stats.skipped, 0)
const nativeIntervals = []
function visitNative(suite) {
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests)
      for (const result of test.results) {
        assert.equal(result.status, 'passed')
        if (!spec.title.includes('longer than media request deadlines')) continue
        const attachment = result.attachments.find((a) => a.name === 'trusted-lifecycle')
        assert(attachment?.body)
        const events = JSON.parse(Buffer.from(attachment.body, 'base64'))
        const freeze = events.find((e) => e.event === 'freeze'),
          resume = events.find((e) => e.event === 'resume')
        assert(freeze.trusted && resume.trusted)
        const milliseconds = resume.time - freeze.time
        assert(milliseconds > 21000)
        nativeIntervals.push({ test: spec.title, milliseconds })
      }
  for (const child of suite.suites ?? []) visitNative(child)
}
for (const suite of nativeCheck.suites) visitNative(suite)
assert.equal(nativeIntervals.length, 1)
const indexSha = await hash('dist/index.html')
assert.equal(kag.indexSha256, indexSha)
assert.equal(canvas.indexSha256, indexSha)
for (const result of abi.results) {
  assert(result.oldWorkerRestartedOffline && result.newWorkerStartedOffline)
  assert.deepEqual(result.errors, [])
}
for (const result of canvas.results) assert.deepEqual(result.errors, [])
const builds = []
for (const [path, base] of [
  ['dist', '/'],
  ['out/verification/pwa/site-a', '/player/'],
  ['out/verification/pwa/site-b', '/player/'],
])
  builds.push({ ...(await verifyOfflineBuild(path, base)), tree: await tree(path) })
for (const result of abi.results) assert.equal(result.newBuild, builds[0].build)
const critical = [
  'src/engine/tvp/rect.ts',
  'src/engine/tvp/layer.ts',
  'src/engine/graphics/font.ts',
  'src/engine/graphics/fonts.ts',
  'src/engine/ports/graphics.ts',
  'src/engine/session.ts',
  'src/backends/text/freetype/face.ts',
  'src/backends/text/freetype/module.ts',
  'src/backends/text/browser/graphics.ts',
  'src/player/build-info.ts',
  'src/player/create-session.ts',
  'src/backends/files/blob-source.ts',
  'native/fonts/font.c',
  'scripts/build-fonts.mjs',
  'scripts/build-wasm.mjs',
  'scripts/build/font-assets.ts',
  'scripts/build/offline-shell.ts',
  'scripts/verify-offline-build.mjs',
  'scripts/generate-font-geometry-fixtures.py',
  'tests/probes/font-geometry-native.py',
  'tests/probes/freetype-native.py',
  'tests/probes/font-geometry-matrix.mjs',
  'tests/probes/fonts-canvas.ts',
  'tests/probes/font-bounds-inspect.ts',
  'tests/helpers/native-activity-browser.ts',
  'tests/activity-native-browser/freeze-deadlines.spec.ts',
  'tests/integration/rect.test.ts',
  'tests/integration/font-bounds.test.ts',
  'tests/integration/freetype.test.ts',
  'tests/conformance/font-geometry.test.ts',
  'tests/browser/font-backend.spec.ts',
  'tests/browser/font-geometry.spec.ts',
  'tests/pwa-browser/fonts.spec.ts',
  'tests/fixtures/font-geometry/reference.json',
  'tests/fixtures/font-geometry/freetype.json',
  'tests/fixtures/font-geometry/outlines.json',
  'tests/fixtures/font-geometry/outlines.ttf',
  'public/licenses/freetype/LICENSE.TXT',
  'public/licenses/freetype/FTL.TXT',
  'public/licenses/freetype/CREDITS.txt',
  'README.md',
  'docs/architecture.md',
  'docs/non-plugin-progress.md',
  'docs/compatibility/current.md',
  'docs/decisions/022-fonts.md',
  'docs/decisions/024-font-geometry.md',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  ...configs,
]
const evidence = [
  log,
  'first-check.log',
  'third-check.log',
  'freeze-repeat.log',
  'freeze-repeat.json',
  'native-check.json',
  'freeze-types.log',
  'freeze-deadline-failure/trace.zip',
  'freeze-deadline-failure/diagnosis.json',
  'interrupted-check.log',
  'host-interruption.json',
  'monitor-check.log',
  'recovery-repeat.log',
  'full-check-failures/trace-summary.json',
  'full-check-failures/http-asyncify-stopping-dur-bd5bc-rts-network-and-can-restart-webkit/trace.zip',
  'full-check-failures/graphics-recovery-jspi-rep-d8282--images-and-preserves-input-webkit/trace.zip',
  'first-node-failure.log',
  'first-browser-failure.log',
  'focused-browser.log',
  'before-coordinate-differences.json',
  'browser-glyphs.json',
  'browser-inspect.log',
  'uppercase-license-build-failure.log',
  'backend-browser.log',
  'font-pwa.log',
  'final-font-build.log',
  'freetype-version-difference.log',
  'freetype-version-differences.json',
  'freetype-2.13.2.json',
  'freetype-node.log',
  'freetype-214-native.log',
  'freetype-cmake.log',
  'freetype-native/reference.inc',
  'freetype-native/oracle.cpp',
  'freetype-native/stderr.txt',
  'native/reference.inc',
  'native/oracle.cpp',
  'native/input.txt',
  'abi-pwa.log',
  'abi-pwa.json',
  'kag.log',
  'kag.json',
  'canvas.log',
  'canvas.json',
].map((p) => (p.startsWith('out/') ? p : directory + '/' + p))
for (const result of kag.results) evidence.push(result.log, result.report, result.screenshot)
for (const result of canvas.results) evidence.push(result.screenshot)
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 290,
    browser: 495,
    selectedSkipped: 0,
    addedBehaviorAndIntegration: 14,
    addedBrowser: 21,
    nativeRectanglePairs: 337,
    nativeFontCoordinates: 25200,
    nativeFileGlyphCases: 512,
    externalKag: 36,
    crossAbiPwa: 6,
    intrinsicCanvas: 6,
    coldOfflineFonts: 6,
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
  nativeFixtureBudgets: {
    browserSetupMs: 30000,
    mediaSetupMs: 30000,
    bodyTimeoutMs: 30000,
    requiredTrustedFreezeMs: 21000,
  },
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
    await Promise.all(critical.map(async (p) => [p, await hash(p)])),
  ),
  evidence: Object.fromEntries(await Promise.all(evidence.map(async (p) => [p, await hash(p)]))),
  builds,
  wasm,
  tjsWasmUnchanged: true,
  font,
  sessionProtocol: 7,
  nativeGeometry: {
    sourceSha256: geometry.sourceSha256,
    extractedSha256: geometry.extractedSha256,
    sanitizers: geometry.sanitizers,
    scope: geometry.scope,
  },
  nativeFont: {
    sourceSha256: native.sourceSha256,
    extractedSha256: native.extractedSha256,
    librarySha256: native.librarySha256,
    version: native.version,
    scope: native.scope,
  },
  fontVersionDifferences: versions,
  crossAbiPwa: abi,
  kag,
  intrinsicCanvas: canvas,
  verifiedBehaviors: [
    'Rect arithmetic matches bounded original C++ vectors; script tests cover object methods, copied state, invalid arguments and signed-32 coordinate assignments',
    'Font bounds return fresh Rect values, ignore pre-rendered mapping and angle, preserve a first empty anchor and visit every UTF-16 unit',
    'Original angle/ascent arithmetic fixes 20 boundary mismatches over 25200 vectors',
    'File-font measurement and coverage use an independently loaded FreeType WASM kernel; all 512 synthetic native cases pass in Node and three browser Workers',
    'Native masks survive later calls and WASM memory growth; malformed fonts and exhausted handle slots recover without poisoning other faces',
    'Ordinary missing BMP glyphs fall back to browser sans-serif; spaces, surrogates and noncharacters keep the file-font default path',
    'Font backend failure retry, unique face identities, cancellation, late kernel cleanup and Canvas registration disposal have real Worker checks',
    'New browser processes load font components for the first time from the offline app after the server closes, then check TJS bounds and layer pixels',
  ],
  diagnostics: {
    freezeDeadline: await json(directory + '/freeze-deadline-failure/diagnosis.json'),
    interruptedCheck: await json(directory + '/host-interruption.json'),
    priorFullCheck: {
      log: directory + '/first-check.log',
      failed: 2,
      observation:
        'WebKit stalled while creating an HTTP-test browser context and clicking #evaluate in a graphics recovery test. The latter had already restored two contexts and verified its pixels; neither trace fetched font assets. Original processes exited before stack sampling, so no root cause or application fix is claimed. Focused repeats and the fresh full regression are recorded separately.',
    },
    canvasDifferenceEvidence: directory + '/browser-glyphs.json',
    freeTypeVersionDifference:
      '68 of 512 outputs differ only in monochrome coverage between native FreeType 2.13.2 and 2.14.3; metrics and dimensions agree. The final baseline uses independently built native 2.14.3, not production-generated expectations.',
    fixtureCorrections: [
      'TJS expression mode requires an IIFE for multiple statements',
      'Expected script errors are caught inside TJS to keep subsequent cases executable',
      'Intrinsic screenshot CSS dimensions and integer pixel placement avoid resampling at fractional canvas positions',
      'FreeType license files use uppercase .TXT; the offline MIME classifier normalizes extension case',
    ],
  },
  priorMatrices: [
    {
      path: 'out/verification/fonts-matrix.json',
      sha256: await hash('out/verification/fonts-matrix.json'),
    },
  ],
  incomplete: [
    'Rect is a TJS value class with observable fields, not native opaque storage or NativeInstanceSupport',
    'Font nativeArray pointer ABI remains in the excluded plugin scope',
    'Complete font selection/enumeration, collections, legacy charmaps and native cache lifetimes',
    'System fallback/GDI/vertical/ruby and all final glyph blending combinations',
    'Streaming media, old video codecs, complete window/IME/events and remaining non-plugin APIs',
    'Unified browser/native memory reservation and all lifecycle interruptions',
    'The full non-plugin goal remains active',
  ],
}
await writeFile(
  'out/verification/font-geometry-matrix.json',
  JSON.stringify(matrix, null, 2) + '\n',
)
console.log('WROTE ' + resolve('out/verification/font-geometry-matrix.json'))
