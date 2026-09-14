// Record only completed font/cursor verification, with exact build/source identities.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'
const directory = 'out/verification/fonts',
  digest = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  hash = async (path) => digest(await readFile(path)),
  json = async (path) => JSON.parse(await readFile(path, 'utf8'))
async function tree(directory) {
  const paths = (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => resolve(e.parentPath, e.name).slice(resolve(directory).length + 1))
      .sort(),
    entries = []
  let bytes = 0
  for (const path of paths) {
    const data = await readFile(resolve(directory, path))
    bytes += data.length
    entries.push([path, data.length, digest(data)])
  }
  return { files: paths.length, bytes, sha256: digest(JSON.stringify(entries)) }
}
const log = directory + '/check.log',
  check = await readFile(log, 'utf8'),
  previous = await json('out/verification/system-events-matrix.json')
assert(
  check.includes('ℹ tests 276\n') &&
    check.includes('ℹ pass 276\n') &&
    check.includes('ℹ fail 0\n') &&
    check.includes('ℹ skipped 0\n'),
)
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((s) => Number(s[1])),
  [375, 57, 35, 7],
)
assert(/7 passed \([^\n]+\)\s*$/.test(check))
const configs = [
  'playwright.config.ts',
  'playwright.library.config.ts',
  'playwright.pwa.config.ts',
  'playwright.activity.config.ts',
]
for (const path of configs) assert.equal(await hash(path), previous.criticalFiles[path])
const cases = check
  .split('\n')
  .filter((line) => /✓.*tests\/browser\/fonts\.spec\.ts:/.test(line))
  .map((line) => line.trim())
assert.equal(cases.length, 12)
for (const browser of ['chromium', 'firefox', 'webkit'])
  for (const backend of ['asyncify', 'jspi'])
    assert.equal(
      cases.filter((line) => line.includes(`[${browser}]`) && line.includes(`› ${backend}:`))
        .length,
      2,
    )
const wasm = await json('dist/wasm/manifest.json')
assert.deepEqual(wasm, previous.wasm)
assert.deepEqual(wasm, await json('.generated/wasm/manifest.json'))
assert.equal(wasm.abi, 2)
assert((await readFile('src/protocol/session.ts', 'utf8')).includes('PROTOCOL_VERSION = 7'))
const native = await json('tests/fixtures/font/native.json'),
  fixtures = await json('tests/fixtures/font/reference.json')
assert.deepEqual(native.sanitizers, ['address', 'undefined'])
assert.equal(native.reports.length, 2)
for (const report of native.reports) {
  assert.equal(report.glyphs.length, 6)
  assert.equal(report.shadows.length, 30)
}
for (const [path, sha] of Object.entries(native.sourceSha256))
  assert.equal(await hash('../kirikiroid2-web/cpp/core/visual/' + path), sha)
for (const [path, sha] of Object.entries(fixtures.files))
  assert.equal(await hash('tests/fixtures/font/' + path), sha)
const canvas = await json(directory + '/canvas.json'),
  lifetime = await json(directory + '/lifetime.json'),
  streamsLifetime = await json(directory + '/streams-lifetime.json'),
  kag = await json(directory + '/kag.json'),
  abi = await json(directory + '/abi-pwa.json')
assert.equal(canvas.results.length, 6)
assert.equal(canvas.indexSha256, await hash('dist/index.html'))
for (const result of canvas.results) {
  assert.equal(result.cssScale, '1:1')
  assert.deepEqual(result.pixels, [
    [255, 255, 255, 255],
    [18, 52, 86, 255],
    [18, 52, 86, 255],
  ])
  assert.deepEqual(result.errors, [])
}
assert.equal(lifetime.loaded, 64)
assert.equal(lifetime.evictedCollected, 32)
assert.equal(lifetime.residentAlive, 32)
assert.equal(lifetime.released, 64)
assert.equal(streamsLifetime.readers, 133)
assert.equal(streamsLifetime.collected, 133)
assert.equal(streamsLifetime.errorPaths, 4)
const isolation = await json(directory + '/streams-diagnostic.json'),
  streamResults = []
function collectResults(suite) {
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests ?? []) streamResults.push(...test.results)
  for (const child of suite.suites ?? []) collectResults(child)
}
collectResults(isolation)
assert.equal(streamResults.length, 6)
for (const result of streamResults) {
  assert.equal(result.status, 'passed')
  const attachment = result.attachments.find((item) => item.name === 'production-sources')
  assert(attachment)
  const sources = JSON.parse(Buffer.from(attachment.body, 'base64').toString())
  for (const [path, sha256] of Object.entries(sources)) assert.equal(await hash(path), sha256)
}
const cleanup = await readFile(directory + '/stream-cleanup-browser.log', 'utf8')
assert(/50 passed \([^\n]+\)\s*$/.test(cleanup))
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(cleanup))
assert.equal(kag.results.length, 36)
assert.equal(kag.indexSha256, await hash('dist/index.html'))
for (const result of kag.results) {
  assert.equal(await hash(result.report), result.sha256)
  assert.equal(await hash(result.log), result.logSha256)
}
assert.equal(abi.results.length, 6)
assert.deepEqual(abi.manifests[1], wasm)
for (const result of abi.results) {
  assert(result.oldWorkerRestartedOffline && result.newWorkerStartedOffline)
  assert.deepEqual(result.errors, [])
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
  'src/formats/font/prerendered.ts',
  'src/engine/graphics/font.ts',
  'src/engine/graphics/fonts.ts',
  'src/engine/graphics/glyph.ts',
  'src/engine/tvp/layer.ts',
  'src/engine/ports/graphics.ts',
  'src/engine/session.ts',
  'src/backends/text/browser/graphics.ts',
  'src/backends/files/blob-source.ts',
  'src/backends/input/browser.ts',
  'src/player/create-player.ts',
  'src/player/session-client.ts',
  'src/protocol/session.ts',
  'src/workers/session.worker.ts',
  'scripts/generate-font-fixtures.py',
  'tests/fixtures/font/reference.json',
  'tests/fixtures/font/native.json',
  'tests/conformance/prerendered-font.test.ts',
  'tests/conformance/glyph.test.ts',
  'tests/integration/fonts.test.ts',
  'tests/integration/input.test.ts',
  'tests/browser/fonts.spec.ts',
  'tests/browser/system-events.spec.ts',
  'tests/probes/fonts-native.py',
  'tests/probes/fonts-canvas.ts',
  'tests/probes/fonts-lifetime.ts',
  'tests/probes/fonts-matrix.mjs',
  'tests/probes/startup-diagnostic.spec.ts',
  'tests/probes/streams-diagnostic.spec.ts',
  'tests/probes/streams-lifetime.ts',
  'tests/probes/system-abi-pwa.ts',
  'tests/probes/system-kag-matrix.mjs',
  ...configs,
  'README.md',
  'docs/decisions/022-fonts.md',
  'docs/decisions/023-private-stream-cleanup.md',
  'package.json',
  'package-lock.json',
]
const evidence = [
  log,
  directory + '/first-check.log',
  directory + '/second-check.log',
  directory + '/third-check.log',
  directory + '/system-frame-failure/trace.zip',
  directory + '/system-frame-failure/webkit-trace.zip',
  directory + '/system-media-after.log',
  directory + '/system-media-exact.log',
  directory + '/system-frame-echo-failure/trace.zip',
  directory + '/image-start-failure/trace.zip',
  directory + '/image-start-repeat-failure/trace.zip',
  directory + '/image-writing-repeat.log',
  directory + '/startup-failed-spans.json',
  directory + '/startup-streaming-failure.json',
  directory + '/startup-native-stack-failure.json',
  directory + '/reader-release-deadlock/trace.zip',
  directory + '/reader-release-deadlock/worker-stack-58803.txt',
  directory + '/reader-release-deadlock/worker-stack-58834.txt',
  directory + '/reader-release-disassembly.txt',
  directory + '/reader-release-diagnosis.json',
  directory + '/ReadableStreamDefaultReader.cpp',
  directory + '/reader-outer-release-disassembly.txt',
  directory + '/reader-visitor-disassembly.txt',
  directory + '/streams-lifetime.json',
  directory + '/streams-lifetime.log',
  directory + '/streams-probe-type-error.log',
  directory + '/final-types.log',
  directory + '/stream-cleanup-node.log',
  directory + '/stream-cleanup-browser.log',
  directory + '/streams-isolation.log',
  directory + '/streams-diagnostic.json',
  directory + '/native-oracle.log',
  directory + '/native/reference.inc',
  directory + '/native/oracle.cpp',
  directory + '/canvas.json',
  directory + '/canvas.log',
  directory + '/canvas-css-scaled.log',
  directory + '/lifetime.json',
  directory + '/lifetime.log',
  directory + '/font-wait.log',
  directory + '/abi-pwa.json',
  directory + '/abi-pwa.log',
  directory + '/kag.json',
  directory + '/kag.log',
  directory + '/native-check.json',
  ...canvas.results.map((result) => result.screenshot),
  ...kag.results.map((result) => result.screenshot),
]
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 276,
    browser: 474,
    selectedSkipped: 0,
    addedBehaviorAndIntegration: 16,
    addedBrowser: 12,
    externalKag: 36,
    crossAbiPwa: 6,
    intrinsicCanvas: 6,
    referenceGlyphDecodes: 12,
    referenceShadowParameterSets: 30,
    referenceShadowOutputs: 60,
    webkitImageStress: 50,
    isolatedStreamRoundTrips: 3000,
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
  wasmUnchanged: true,
  sessionProtocol: 7,
  fontCases: cases,
  fixtures,
  nativeReference: native,
  intrinsicCanvas: canvas,
  lifetime,
  streamsLifetime,
  crossAbiPwa: abi,
  kag,
  verifiedBehaviors: [
    'Physical pointer observation bypasses blocked script input, ignores hidden movement and uses current layer/zoom coordinates',
    'Pre-rendered font v0/v1 restores UTF-16 indices, signed origins/advances and all 65 coverage levels',
    'Full font settings select session-wide shared mappings; failed replacement retains old mapping',
    'Mapped glyph placement uses IncX/IncY and ascent offsets; width uses Inc; AA does not rewrite pre-rendered coverage',
    'Font file loading uses Worker FontFace from resource bytes; synthetic widths and rendered pixels agree in three browsers and both WASM backends',
    'Integer native glyph shadows match independent extracted scalar routines',
    'Font loading cancellation releases late or simultaneously resolving faces exactly once',
    'V8 ownership probes collect evicted fonts before stop while resident cache entries remain alive',
    'Private compression readers close at EOF or cancel on failure without explicit releaseLock; real Node readers are collectible and WebKit image reload stress passes',
    'Original KAG XP3 and ZIP flow/save/transition cases pass under the updated text path',
  ],
  diagnostics: {
    priorFullChecks: [
      {
        log: directory + '/first-check.log',
        failedCases: 2,
        cause: 'Media counter was sampled once while a retry waited on the immutable result.',
      },
      {
        log: directory + '/second-check.log',
        failedCases: 1,
        cause:
          'The first-frame substring also matched the console echo of script source; the final assertion matches the exact callback log row.',
      },
      {
        log: directory + '/third-check.log',
        failedCases: 1,
        cause:
          'WebKit image load stalled; also reproduced in both WASM backends outside the full check.',
      },
    ],
    webkitReaderDeadlock: {
      evidence: 'reader-release-deadlock/worker-stack-58803.txt',
      revision: 'webkit-2359 / WebCore 626.1.6+',
      sampledThread: 1174202,
      samples: 757,
      mechanism:
        'releaseLock holds the reader stream lock while calling JS that allocates a TypeError; the resulting GC visitor waits on the same reader lock. The sampled folded symbol was identified through the actual binary symbol table and disassembly.',
      change:
        'Private exhausted streams are left unreachable; unfinished streams are cancelled. No second consumer requires releaseLock.',
      note: 'Verbose instrumentation changed timing and some diagnostic batches passed before the fix. The final diagnosis uses an unmodified-application failure and actual process stack, not just repeated successes.',
    },
    sourceFixes: [
      'Physical cursor positions previously only changed when an input packet was delivered',
      'Font cancellation now removes settled waiters rather than retaining each result on a shared pending Promise; a release closure handles settlement/cancellation races',
      'Private compression stream cleanup avoids the sampled WebKit reader lock/GC deadlock while preserving upstream cancellation on failure',
    ],
    fixtureCorrections: [
      'Pre-rendered font signature excludes its C string terminator',
      'Alpha coverage assertions require an alpha destination layer',
      'TJS does not construct the desired embedded null from the attempted literal escape',
      'Pointer tests wait for dimensions, keep the canvas visible and target logical pixel centers',
      'Canvas pixel probes use intrinsic CSS dimensions to exclude display enlargement interpolation',
    ],
  },
  priorMatrices: await Promise.all(
    ['system-events', 'activity', 'graphics', 'pwa', 'library', 'http', 'zip'].map(async (name) => {
      const path = `out/verification/${name}-matrix.json`
      return { path, sha256: await hash(path) }
    }),
  ),
  incomplete: [
    'Native font selection dialog, complete enumeration/filtering and getGlyphDrawRect/Rect semantics',
    'All original font cache ownership/source mutation permutations, font collections and multi-face selection',
    'Browser font rasterization/hinting/ascent is not claimed identical to every native system font',
    'All final glyph blend combinations and arbitrary-angle floating-point integer boundaries still need native differential coverage',
    'Complete KAG ruby/vertical text, full window/IME/events and remaining graphics APIs',
    'Streaming media, complete MIDI and old video codecs/containers',
    'Unified reservation of browser-native memory, mobile termination and actual BFCache',
    'The full non-plugin goal remains active',
  ],
}
await writeFile('out/verification/fonts-matrix.json', JSON.stringify(matrix, null, 2) + '\n')
console.log('WROTE ' + resolve('out/verification/fonts-matrix.json'))
