// Run after the complete npm run check; does not rerun external KAG scenarios.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hash = async (path) => digest(await readFile(path))
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
async function tree(directory) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((file) => file.isFile())
    .map((file) => resolve(file.parentPath, file.name).slice(resolve(directory).length + 1))
    .sort()
  let bytes = 0
  const entries = []
  for (const file of files) {
    const content = await readFile(resolve(directory, file))
    bytes += content.length
    entries.push([file, content.length, digest(content)])
  }
  return { files: files.length, bytes, sha256: digest(JSON.stringify(entries)) }
}
const log = 'out/verification/pwa/check.log'
const check = await readFile(log, 'utf8')
assert(check.includes('ℹ tests 209\n') && check.includes('ℹ pass 209\n'))
assert(check.includes('ℹ fail 0\n') && check.includes('ℹ skipped 0\n'))
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((stage) => Number(stage[1])),
  [246, 57, 35],
)
assert(/35 passed \([^\n]+\)\s*$/.test(check))
const builds = []
for (const [directory, base] of [
  ['dist', '/'],
  ['out/verification/pwa/site-a', '/player/'],
  ['out/verification/pwa/site-b', '/player/'],
])
  builds.push({ ...(await verifyOfflineBuild(directory, base)), tree: await tree(directory) })
assert.notEqual(builds[1].build, builds[2].build)
assert.notEqual(builds[1].wasmManifest, builds[2].wasmManifest)
const wasm = await json('dist/wasm/manifest.json')
assert.deepEqual(wasm, await json('.generated/wasm/manifest.json'))
const criticalFiles = [
  'README.md',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.worker.json',
  'tsconfig.engine.json',
  'tsconfig.tools.json',
  'playwright.config.ts',
  'playwright.library.config.ts',
  'playwright.pwa.config.ts',
  'scripts/build/icons.ts',
  'scripts/build/offline-shell.ts',
  'scripts/build-pwa-fixtures.mjs',
  'scripts/verify-offline-build.mjs',
  'src/app/app.ts',
  'src/app/offline.ts',
  'src/app/game-library.ts',
  'src/app/styles.css',
  'src/player/build-info.ts',
  'src/player/session-client.ts',
  'src/pwa/manifest.ts',
  'src/pwa/cache.ts',
  'src/pwa/cancel.ts',
  'src/pwa/client.ts',
  'src/pwa/service-worker.ts',
  'tests/conformance/offline-cache.test.ts',
  'tests/helpers/pwa-server.ts',
  'tests/helpers/offline-browser.ts',
  'tests/helpers/library-browser.ts',
  'tests/pwa-browser/offline.spec.ts',
  'tests/pwa-browser/emulation.spec.ts',
  'tests/pwa-browser/media.spec.ts',
  'tests/pwa-browser/lifecycle.spec.ts',
  'tests/probes/pwa-matrix.mjs',
]
const browsers = (await json('node_modules/playwright-core/browsers.json')).browsers.filter(
  (browser) => ['chromium', 'firefox', 'webkit'].includes(browser.name),
)
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: { behaviorAndIntegration: 209, browser: 338, selectedSkipped: 0 },
  browserStages: stages.map((stage, i) => ({
    config: ['playwright.config.ts', 'playwright.library.config.ts', 'playwright.pwa.config.ts'][i],
    passed: Number(stage[1]),
    duration: stage[2],
    workers: 2,
    testTimeoutMs: 30000,
    assertionTimeoutMs: 12000,
  })),
  excluded: [
    {
      browser: 'webkit',
      test: 'tests/pwa-browser/emulation.spec.ts',
      cases: 1,
      reason:
        'Network emulation prevents even a synthetic Service Worker response; real server shutdown remains tested',
      probe: 'out/verification/pwa/platform-probe-source.ts',
      probeSha256: await hash('out/verification/pwa/platform-probe-source.ts'),
      diagnosticLog: 'out/verification/pwa/platform-probe.log',
      diagnosticLogSha256: await hash('out/verification/pwa/platform-probe.log'),
      diagnosticCountedAsFunctionalPass: false,
    },
  ],
  browsers,
  checks: { log, sha256: await hash(log) },
  tracingControl: {
    limitation: 'WebKit continuous trace screenshots slow down two persistent pages on this host',
    change:
      'Only WebKit library/PWA disable continuous trace screenshots; DOM, network, source traces and failure screenshots remain',
    assertionsAndTimeoutsUnchanged: true,
    diagnosticFiles: Object.fromEntries(
      await Promise.all(
        [
          'out/verification/pwa/library-refresh-failure/check.log',
          'out/verification/pwa/library-refresh-failure/trace.zip',
          'out/verification/pwa/library-refresh-failure/focused-trace.zip',
          'out/verification/pwa/library-refresh-focused.log',
          'out/verification/pwa/library-refresh-no-trace.log',
          'out/verification/pwa/library-refresh-dom-trace.log',
        ].map(async (path) => [path, await hash(path)]),
      ),
    ),
  },
  source: await tree('src'),
  tests: await tree('tests'),
  scripts: await tree('scripts'),
  documentation: await tree('docs'),
  treeHashFormat:
    'SHA-256 of JSON array of [relative path, byte count, SHA-256], sorted by ordinal relative path',
  criticalFiles: Object.fromEntries(
    await Promise.all(criticalFiles.map(async (path) => [path, await hash(path)])),
  ),
  builds,
  wasm,
  priorMatrices: await Promise.all(
    ['library', 'http', 'zip'].map(async (name) => ({
      path: `out/verification/${name}-matrix.json`,
      sha256: await hash(`out/verification/${name}-matrix.json`),
      independentMatrixRerunThisPhase: false,
    })),
  ),
  verifiedBehaviors: [
    'All emitted application files, including public licenses, match the release manifest',
    'Real application server shutdown reload and full browser restart in all three engines',
    'OPFS game/save identity and offline Asyncify/JSPI, Vorbis/AudioWorklet and MP4',
    'Explicit A/B activation preserves another running document and its older hashed WASM manifest',
    'Corrupted update rolls back; retry and eviction repair preserve library and saves',
    'Range, private files and other scopes do not enter the application cache',
    'Library import blocks reload; failed save flush retains exportable pending bytes',
    'Bounded parallel downloads, late cancellation, cache publication and generation budgets',
  ],
  limits: {
    generationBytes: 32 * 1048576,
    assetBytes: 16 * 1048576,
    assets: 1024,
    generations: 8,
    storageBytes: 64 * 1048576,
    parallelDownloads: 4,
    downloadTimeoutMs: 15000,
    installationDownloadTimeoutMs: 60000,
  },
  incomplete: [
    'Native OS application installation and mobile installation UI are not verified',
    'GPU context recovery and full background/foreground lifecycle policy',
    'Streaming media, persistent partial HTTP cache and download resumption',
    'Full non-plugin engine coverage; see docs/non-plugin-progress.md',
  ],
}
const output = 'out/verification/pwa-matrix.json'
await writeFile(output, JSON.stringify(matrix, null, 2) + '\n')
console.log('WROTE ' + resolve(output))
