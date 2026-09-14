// Record this phase only after a complete successful npm run check.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyOfflineBuild } from '../../scripts/verify-offline-build.mjs'

const digest = (data) => createHash('sha256').update(data).digest('hex')
const hash = async (path) => digest(await readFile(path))
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
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
const log = 'out/verification/graphics/check.log',
  check = await readFile(log, 'utf8')
assert(check.includes('ℹ pass 216\n') && check.includes('ℹ tests 216\n'))
assert(check.includes('ℹ fail 0\n') && check.includes('ℹ skipped 0\n'))
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((stage) => Number(stage[1])),
  [294, 57, 35],
)
assert(/35 passed \([^\n]+\)\s*$/.test(check))
const graphicsCases = check
  .split('\n')
  .filter((line) => /✓.*tests\/browser\/graphics-recovery(?:-media)?\.spec\.ts:/.test(line))
  .map((line) => line.trim())
assert.equal(graphicsCases.length, 48)
for (const browser of ['chromium', 'firefox', 'webkit'])
  for (const backend of ['asyncify', 'jspi'])
    assert.equal(
      graphicsCases.filter(
        (line) => line.includes(`[${browser}]`) && line.includes(`› ${backend}:`),
      ).length,
      8,
    )
const previous = await json('out/verification/pwa-matrix.json')
const configs = ['playwright.config.ts', 'playwright.library.config.ts', 'playwright.pwa.config.ts']
for (const path of configs) assert.equal(await hash(path), previous.criticalFiles[path])
const builds = []
for (const [directory, base] of [
  ['dist', '/'],
  ['out/verification/pwa/site-a', '/player/'],
  ['out/verification/pwa/site-b', '/player/'],
])
  builds.push({ ...(await verifyOfflineBuild(directory, base)), tree: await tree(directory) })
const critical = [
  'src/backends/render/webgl2/renderer.ts',
  'src/backends/render/webgl2/program.ts',
  'src/engine/ports/graphics.ts',
  'src/engine/session.ts',
  'src/backends/audio/web/mixer.worklet.ts',
  'src/protocol/session.ts',
  'src/player/session-client.ts',
  'src/workers/session.worker.ts',
  'src/app/app.ts',
  'tests/helpers/gpu-browser.ts',
  'tests/integration/graphics-lifecycle.test.ts',
  'tests/conformance/worklet-stats.test.ts',
  'tests/browser/graphics-recovery.spec.ts',
  'tests/browser/graphics-recovery-media.spec.ts',
  'tests/probes/graphics-matrix.mjs',
  ...configs,
  'package.json',
  'package-lock.json',
  'README.md',
]
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 216,
    browser: 386,
    selectedSkipped: 0,
    addedBehaviorAndIntegration: 7,
    addedBrowser: 48,
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
  browserConfigurationsMatchPreviousPhase: true,
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
  builds,
  wasm: await json('dist/wasm/manifest.json'),
  sessionProtocol: 4,
  graphicsCases,
  screenshots: await Promise.all(
    ['chromium', 'firefox', 'webkit'].map(async (browser) => {
      const path = `out/verification/graphics/retry-${browser}.png`
      return { browser, path, sha256: await hash(path) }
    }),
  ),
  verifiedBehaviors: [
    'Real WEBGL_lose_context loss/restoration in the actual session Worker, both WASM backends, all three browsers',
    'Program, uniform, blend and texture reconstruction with unchanged CPU image revisions and reference canvas colors',
    'Loss during context construction, texture upload, and repeated restoration',
    'Program or texture allocation failure preserves the VM/save backup and supports explicit display retry',
    'Automatic graphics suspension preserves user pause intent and waits for a submitted frame before resuming',
    'Timer remaining deadlines and automatic transition completion order exclude suspension time',
    'Stopping a lost context cancels pending startup and a fresh Worker can run again',
    'Actual AudioWorklet voice position and native video currentTime freeze and then resume',
    'Real Worklet outputs zero PCM while paused and continues reporting statistics without advancing playback frames',
    'Narrow-screen display-retry controls remain within the viewport',
  ],
  priorMatrices: await Promise.all(
    ['pwa', 'library', 'http', 'zip'].map(async (name) => {
      const path = `out/verification/${name}-matrix.json`
      return { path, sha256: await hash(path), independentMatrixRerunThisPhase: false }
    }),
  ),
  incomplete: [
    'Physical GPU reset, exhaustive driver behavior and long-term video-memory stress are not verified',
    'Browser decides whether a physically lost context can be restored',
    'Full background/foreground policy, streaming media, fonts and remaining non-plugin APIs',
    'Original external KAG 36-scenario probe matrix was not rerun in this phase',
  ],
}
assert.deepEqual(matrix.wasm, await json('.generated/wasm/manifest.json'))
assert.deepEqual(matrix.wasm, previous.wasm)
const output = 'out/verification/graphics-matrix.json'
await writeFile(output, JSON.stringify(matrix, null, 2) + '\n')
console.log('WROTE ' + resolve(output))
