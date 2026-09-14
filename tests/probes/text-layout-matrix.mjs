import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'
const dir = 'out/verification/text-layout',
  hashBytes = (b) => createHash('sha256').update(b).digest('hex'),
  hash = async (p) => hashBytes(await readFile(p)),
  json = async (p) => JSON.parse(await readFile(p, 'utf8')),
  previous = await json('out/verification/font-selection-matrix.json'),
  log = dir + '/check.log',
  check = await readFile(log, 'utf8')
for (const line of ['ℹ tests 308\n', 'ℹ pass 308\n', 'ℹ fail 0\n', 'ℹ skipped 0\n'])
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
  [426, 57, 47, 7],
)
assert(/7 passed \([^\n]+\)\s*$/.test(check))
assert((await readFile(dir + '/cache-node.log', 'utf8')).includes('ℹ pass 8\n'))
assert(
  (await readFile(dir + '/before-cache-fix/cache-node.log', 'utf8')).includes(
    'Old font dependency must remain available: fonts/manifest-a.json',
  ),
)
for (const p of [
  ...configs,
  'src/backends/files/blob-source.ts',
  'tests/helpers/native-activity-browser.ts',
  'tests/activity-native-browser/freeze-deadlines.spec.ts',
])
  assert.equal(await hash(p), previous.criticalFiles[p])
const wasm = await json('dist/wasm/manifest.json'),
  font = await json('dist/fonts/manifest.json')
assert.deepEqual(wasm, previous.wasm)
assert.deepEqual(wasm, await json('.generated/wasm/manifest.json'))
assert.deepEqual(font, await json('.generated/fonts/manifest.json'))
assert.equal(wasm.abi, 2)
assert.equal(font.abi, 2)
assert.equal(font.version, 'VER-2-14-3')
assert.equal(font.sourceSha256, await hash('native/fonts/font.c'))
assert.equal(
  font.portSha256,
  await hash('../toolchains/krkr2/emsdk/upstream/emscripten/tools/ports/freetype.py'),
)
assert((await readFile('src/protocol/session.ts', 'utf8')).includes('PROTOCOL_VERSION = 8'))
const inputHash = createHash('sha256')
async function nativeInputs(dir) {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const p = dir + '/' + item.name
    if (p === 'native/fonts' || p === 'third_party/unicode') continue
    if (item.isDirectory()) await nativeInputs(p)
    else if (/\.(c|cc|cpp|h|hpp|inc|y|py|in|txt)$/.test(item.name))
      inputHash.update(p + '\0').update(await readFile(p))
  }
}
await nativeInputs('native')
await nativeInputs('third_party')
assert.equal(inputHash.digest('hex'), wasm.source.sha256)
const fixtures = await json('tests/fixtures/text-layout/fonts.json'),
  shaping = await json('tests/fixtures/text-layout/shaping.json'),
  unicode = await json('tests/fixtures/text-layout/unicode.json'),
  sanitizers = await json(dir + '/native/sanitizers.json')
assert.equal(fixtures.cases.length, 7)
assert.equal(shaping.cases.length, 56)
assert.equal(shaping.uharfbuzz, '0.56.1')
assert.equal(shaping.harfbuzz, '14.4.0')
for (const row of fixtures.cases) {
  const h = await hash('tests/fixtures/text-layout/' + row.file)
  assert.equal(h, row.sha256)
  assert.equal(h, shaping.fonts[row.file])
}
assert.equal(unicode.version, '17.0.0')
assert.equal(unicode.rangeCount, 163)
assert.equal(unicode.fallbackCount, 28)
for (const [p, h] of Object.entries(unicode.sources)) assert.equal(await hash(p), h)
assert.equal(
  await hash('public/licenses/unicode/LICENSE.txt'),
  await hash('third_party/unicode/LICENSE.txt'),
)
assert.equal(sanitizers.checks, 33792)
assert.deepEqual(sanitizers.sanitizers, ['address', 'undefined'])
assert.equal(sanitizers.sourceSha256, font.sourceSha256)
assert.equal(sanitizers.driverSha256, await hash(dir + '/native/kernel-sanitizers.c'))
assert.equal(
  sanitizers.librarySha256,
  await hash('out/verification/font-geometry/freetype-build/libfreetype.a'),
)
assert(sanitizers.cases.every((c) => c.checks === 16896 && c.invalidInputs === 3 && c.recovered))
assert.equal(await readFile(dir + '/native/sanitizer-stderr.txt', 'utf8'), '')
const kag = await json(dir + '/kag.json'),
  abi = await json(dir + '/abi-pwa.json'),
  fontAbi = await json(dir + '/font-abi-pwa.json'),
  indexSha = await hash('dist/index.html'),
  layouts = []
assert.equal(kag.results.length, 36)
assert.equal(kag.indexSha256, indexSha)
for (const browser of ['chromium', 'firefox', 'webkit'])
  for (const backend of ['asyncify', 'jspi']) {
    const path = `${dir}/kag/${browser}-${backend}.json`,
      report = await json(path)
    assert.equal(report.indexSha256, indexSha)
    assert.deepEqual(report.errors, [])
    assert.equal(report.cases.length, 3)
    assert.deepEqual(
      report.cases.map((c) => c.mode),
      ['horizontal', 'vertical', 'wrap'],
    )
    for (const row of report.cases)
      assert(row.copiedAndRestored && row.nonzero > 0 && row.trace.length > 0)
    layouts.push({ path, ...report })
  }
for (const report of [abi, fontAbi]) {
  assert.equal(report.results.length, 6)
  assert.deepEqual(
    report.manifests.map((m) => m.abi),
    [1, 2],
  )
  for (const result of report.results) {
    assert(result.oldWorkerRestartedOffline && result.newWorkerStartedOffline)
    assert.deepEqual(result.errors, [])
  }
}
assert.deepEqual(abi.manifests[1], wasm)
assert.deepEqual(fontAbi.manifests[1], font)
assert.equal(fontAbi.manifestKind, 'fonts')
for (const result of fontAbi.results)
  for (const m of fontAbi.manifests)
    assert(result.fontRequests.some((url) => url.endsWith('/' + m.assets.wasm.file)))
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
        const attachment = result.attachments.find((a) => a.name === 'trusted-lifecycle')
        assert(attachment?.body)
        const events = JSON.parse(Buffer.from(attachment.body, 'base64')),
          f = events.find((e) => e.event === 'freeze'),
          r = events.find((e) => e.event === 'resume'),
          milliseconds = r.time - f.time
        assert(f.trusted && r.trusted && milliseconds > 21000)
        nativeIntervals.push({ test: spec.title, milliseconds })
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
    entries = await Promise.all(
      paths.map(async (p) => {
        const b = await readFile(resolve(directory, p))
        return [p, b.length, hashBytes(b)]
      }),
    )
  return {
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e[1], 0),
    sha256: hashBytes(JSON.stringify(entries)),
  }
}
const builds = []
for (const [path, base] of [
  ['dist', '/'],
  ['out/verification/pwa/site-a', '/player/'],
  ['out/verification/pwa/site-b', '/player/'],
])
  builds.push({ ...(await verifyOfflineBuild(path, base)), tree: await tree(path) })
const preserved = await tree(dir + '/font-abi1-root')
assert.deepEqual(preserved, previous.builds[0].tree)
builds.push({
  ...previous.builds[0],
  directory: dir + '/font-abi1-root',
  tree: preserved,
  validation: 'Byte-identical to the previously verified font ABI 1 release',
})
for (const report of [abi, fontAbi])
  for (const result of report.results) assert.equal(result.newBuild, builds[0].build)
const critical = [
  ...new Set([
    ...Object.keys(previous.criticalFiles),
    '.prettierrc.json',
    'src/pwa/cache.ts',
    'tests/conformance/offline-cache.test.ts',
    'src/engine/graphics/vertical.ts',
    'src/formats/font/vertical-data.ts',
    'src/formats/font/vertical-substitutions.ts',
    'src/engine/ports/graphics.ts',
    'src/backends/text/freetype/face.ts',
    'src/backends/text/freetype/module.ts',
    'scripts/build-fonts.mjs',
    'scripts/build-wasm.mjs',
    'scripts/build/font-assets.ts',
    'scripts/verify-offline-build.mjs',
    'scripts/generate-vertical-data.py',
    'scripts/generate-vertical-font-fixtures.py',
    'tests/conformance/vertical-font.test.ts',
    'tests/integration/vertical-font.test.ts',
    'tests/browser/vertical-font.spec.ts',
    'tests/pwa-browser/vertical-font.spec.ts',
    'tests/probes/vertical-shaping.py',
    'tests/probes/vertical-kernel-sanitizers.py',
    'tests/probes/kag-text-layout.ts',
    'tests/probes/system-abi-pwa.ts',
    'tests/probes/text-layout-matrix.mjs',
    'tests/fixtures/text-layout/fonts.json',
    'tests/fixtures/text-layout/shaping.json',
    'tests/fixtures/text-layout/unicode.json',
    'docs/decisions/026-vertical-text.md',
    ...Object.keys(unicode.sources),
    'public/licenses/unicode/LICENSE.txt',
  ]),
]
const evidence = [
  'check.log',
  'cache-node.log',
  'cache-build.log',
  'before-cache-fix/check.log',
  'before-cache-fix/cache-node.log',
  'before-cache-fix/font-abi-pwa.log',
  'before-cache-fix/font-abi-pwa/chromium-asyncify.zip',
  'before-cache-fix/font-abi-pwa/chromium-asyncify.png',
  'native-check.json',
  'focused-browser.log',
  'vertical-pwa.log',
  'focused-node-2.log',
  'vertical-node-all.log',
  'native-vertical-node.log',
  'sanitizers-2.log',
  'native/sanitizers.json',
  'native/kernel-sanitizers.c',
  'native/sanitizer-stderr.txt',
  'font-build.log',
  'probe-types.log',
  'build-2.log',
  'pwa-build.log',
  'before-vertical-browser.log',
  'before-vertical-browser-2.log',
  'vertical-browser.log',
  'vertical-browser-2.log',
  'focused-node.log',
  'kag-first.log',
  'kag-second.log',
  'kag-third.log',
  'kag-fourth.log',
  'kag-checked.log',
  'kag-checked-2.log',
  'formatter-clean.ts',
  'formatter-result.ts',
  'formatter-diagnostic.json',
  'harfbuzz-install.log',
  'harfbuzz-install-2.log',
  'kag.log',
  'abi-pwa.log',
  'abi-pwa.json',
  'font-abi-pwa.log',
  'font-abi-pwa.json',
  'kag-layout.log',
  'reference/MessageLayer.tjs',
  'reference/Conductor.tjs',
  'reference/Config.tjs',
  'reference/wine-font.c',
  'reference/wine-freetype.c',
].map((p) => dir + '/' + p)
for (const result of kag.results) evidence.push(result.log, result.report, result.screenshot)
for (const report of layouts) {
  evidence.push(report.path)
  for (const row of report.cases) evidence.push(row.bitmap, row.screenshot)
}
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 308,
    browser: 537,
    selectedSkipped: 0,
    addedBehaviorAndIntegration: 7,
    addedBrowser: 15,
    unicodeCodeUnits: 65536,
    nativeShapingCases: 56,
    kernelSanitizerCases: 33792,
    coldOfflineVerticalFonts: 6,
    externalKag: 36,
    externalKagLayouts: 18,
    crossTjsAbiPwa: 6,
    crossFontAbiPwa: 6,
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
  excluded: previous.excluded,
  tracingControl: previous.tracingControl,
  nativeIntervals,
  nativeFixtureBudgets: previous.nativeFixtureBudgets,
  source: await tree('src'),
  tests: await tree('tests'),
  scripts: await tree('scripts'),
  documentation: await tree('docs'),
  treeHashFormat: previous.treeHashFormat,
  builds,
  wasm,
  font,
  tjsWasmUnchanged: true,
  sessionProtocol: 8,
  criticalFiles: Object.fromEntries(
    await Promise.all(critical.map(async (p) => [p, await hash(p)])),
  ),
  evidence: Object.fromEntries(await Promise.all(evidence.map(async (p) => [p, await hash(p)]))),
  unicode,
  shaping,
  sanitizers,
  kag,
  layouts,
  crossTjsAbiPwa: abi,
  crossFontAbiPwa: fontAbi,
  formatterDiagnostic: await json(dir + '/formatter-diagnostic.json'),
  priorMatrices: [
    {
      path: 'out/verification/font-selection-matrix.json',
      sha256: await hash('out/verification/font-selection-matrix.json'),
    },
  ],
  incomplete: [
    'Exact Windows/GDI font substitution and all system-font glyph metrics and pixels',
    'Contextual GSUB, lookup flags/mark filtering, variable fonts, complete collections and legacy charmaps',
    'Complete grapheme and final text blending coverage, unified browser/native memory reservation',
    'Debug file logging including logAsError, streaming media and the other non-plugin requirements',
    'The full non-plugin goal remains active',
  ],
}
await writeFile('out/verification/text-layout-matrix.json', JSON.stringify(matrix, null, 2) + '\n')
console.log('WROTE ' + resolve('out/verification/text-layout-matrix.json'))
