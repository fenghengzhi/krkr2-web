// Record this phase only after the entire npm run check pipeline succeeds.
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
const log = 'out/verification/activity/check.log',
  check = await readFile(log, 'utf8')
assert(check.includes('ℹ pass 230\n') && check.includes('ℹ tests 230\n'))
assert(check.includes('ℹ fail 0\n') && check.includes('ℹ skipped 0\n'))
assert(!/\b[1-9]\d* (?:failed|skipped|flaky)\b/.test(check))
const stages = [...check.matchAll(/^\s+(\d+) passed \(([^\n]+)\)$/gm)]
assert.deepEqual(
  stages.map((stage) => Number(stage[1])),
  [339, 57, 35, 7],
)
assert(/7 passed \([^\n]+\)\s*$/.test(check))
const activityCases = check
  .split('\n')
  .filter((line) =>
    /✓.*tests\/browser\/activity(?:-media|-settings|-controls)?\.spec\.ts:/.test(line),
  )
  .map((line) => line.trim())
assert.equal(activityCases.length, 45)
for (const browser of ['chromium', 'firefox', 'webkit']) {
  assert.equal(activityCases.filter((line) => line.includes(`[${browser}]`)).length, 15)
  for (const backend of ['asyncify', 'jspi'])
    assert.equal(
      activityCases.filter(
        (line) => line.includes(`[${browser}]`) && line.includes(`› ${backend}:`),
      ).length,
      6,
    )
}
const previous = await json('out/verification/graphics-matrix.json')
const configs = [
  'playwright.config.ts',
  'playwright.library.config.ts',
  'playwright.pwa.config.ts',
  'playwright.activity.config.ts',
]
for (const path of configs.slice(0, 3)) assert.equal(await hash(path), previous.criticalFiles[path])
const reportPath = 'out/verification/activity/native-check.json',
  nativeReport = await json(reportPath)
assert.deepEqual(
  [
    nativeReport.stats.expected,
    nativeReport.stats.unexpected,
    nativeReport.stats.skipped,
    nativeReport.stats.flaky,
  ],
  [7, 0, 0, 0],
)
const nativeCases = []
function collect(suites) {
  for (const suite of suites) {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests) {
        assert.equal(test.status, 'expected')
        assert.equal(test.results.length, 1)
        const result = test.results[0]
        assert.equal(result.status, 'passed')
        const attachment = result.attachments.find((item) => item.name === 'trusted-lifecycle')
        const events = JSON.parse(Buffer.from(attachment.body, 'base64').toString())
        for (const event of ['visibilitychange', 'freeze', 'resume'])
          assert(events.some((item) => item.event === event && item.trusted))
        nativeCases.push({
          title: spec.title,
          project: test.projectName,
          durationMs: result.duration,
          events,
        })
      }
    collect(suite.suites ?? [])
  }
}
collect(nativeReport.suites)
assert.equal(nativeCases.length, 7)
const longFreeze = nativeCases.find((item) => item.title.includes('longer than media'))
assert(
  longFreeze.events.find((item) => item.event === 'resume').time -
    longFreeze.events.find((item) => item.event === 'freeze').time >
    21000,
)
const builds = []
for (const [directory, base] of [
  ['dist', '/'],
  ['out/verification/pwa/site-a', '/player/'],
  ['out/verification/pwa/site-b', '/player/'],
])
  builds.push({ ...(await verifyOfflineBuild(directory, base)), tree: await tree(directory) })
const critical = [
  'src/engine/ports/activity.ts',
  'src/player/page-activity.ts',
  'src/player/create-player.ts',
  'src/player/create-session.ts',
  'src/player/session-client.ts',
  'src/engine/session.ts',
  'src/engine/scheduler/control.ts',
  'src/engine/scheduler/events.ts',
  'src/engine/input/controller.ts',
  'src/backends/input/browser.ts',
  'src/backends/audio/web/host.ts',
  'src/backends/video/browser/host.ts',
  'src/backends/script/tjs-wasm/runtime.ts',
  'src/protocol/session.ts',
  'src/workers/session.worker.ts',
  'src/app/preferences.ts',
  'src/app/dom.ts',
  'src/app/offline.ts',
  'src/app/app.ts',
  'src/app/styles.css',
  'tests/integration/activity.test.ts',
  'tests/browser/activity.spec.ts',
  'tests/browser/activity-media.spec.ts',
  'tests/browser/activity-settings.spec.ts',
  'tests/browser/activity-controls.spec.ts',
  'tests/helpers/native-activity-browser.ts',
  'tests/helpers/activity-browser.ts',
  'tests/helpers/media-browser.ts',
  'tests/activity-native-browser/activity.spec.ts',
  'tests/activity-native-browser/media.spec.ts',
  'tests/activity-native-browser/freeze-deadlines.spec.ts',
  'tests/browser/graphics-recovery-media.spec.ts',
  'tests/probes/activity-matrix.mjs',
  ...configs,
  'package.json',
  'package-lock.json',
  'tsconfig.tools.json',
  '.gitignore',
  'README.md',
]
const matrix = {
  verifiedAt: new Date().toISOString(),
  command: 'npm run check',
  passed: {
    behaviorAndIntegration: 230,
    browser: 438,
    selectedSkipped: 0,
    addedBehaviorAndIntegration: 14,
    addedBrowser: 52,
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
  builds,
  wasm: await json('dist/wasm/manifest.json'),
  sessionProtocol: 5,
  activityCases,
  native: {
    report: reportPath,
    sha256: await hash(reportPath),
    cases: nativeCases,
    defaultFocusOverrideDisabled: true,
    ownedTemporaryProfiles: true,
  },
  verifiedBehaviors: [
    'Default background pause and opt-out, initial hidden loading, stop/restart and preserved user/GPU pause',
    'TJS async host values/errors and initial decoding wait for resume; cancellation releases waits without duplicate execution',
    'Queued timers are invalidated and remaining deadlines exclude acknowledged pause time',
    'Queued and in-flight mouse/touch input cannot recreate stale capture; old IME commit/input pairs are discarded',
    'Materialized save overlay commits while TJS is waiting; failures retain exportable dirty bytes',
    'Actual Worklet voice and video positions stop/resume; hidden opt-out continues playback',
    'Real storage events synchronize preference; failed preference persistence still applies the current choice',
    'Chromium isTrusted visibility/freeze/resume with noDefaults, both WASM backends and actual media',
    'One 21-second native freeze during normal playback resumes without a media timeout',
    'Held pause and sound-toggle clicks survive intervening timer/Worklet updates; unchanged button text nodes are preserved',
  ],
  diagnostics: {
    artifacts: Object.fromEntries(
      await Promise.all(
        [
          'out/verification/activity/settings-failure/check.log',
          'out/verification/activity/settings-failure/trace.zip',
          'out/verification/activity/settings-lifetime.log',
          'out/verification/activity/settings-lifetime.json',
          'out/verification/activity/native-complete.json',
          'out/verification/activity/pause-click-failure/check.log',
          'out/verification/activity/pause-click-failure/trace.zip',
          'out/verification/activity/pause-click-failure/button-probe.log',
          'out/verification/activity/pause-click-failure/button-probe.mjs',
          'out/verification/activity/pause-click-failure/held-before.log',
          'out/verification/activity/pause-click-failure/held-before-trace.zip',
          'out/verification/activity/controls-after.json',
        ].map(async (path) => [path, await hash(path)]),
      ),
    ),
    implementationBugs: [
      'An async host completion previously resumed TJS during pause; guarded before and after host calls, on errors and before execute/invoke',
      'Repeated unchanged textContent assignments can suppress WebKit clicks between press/release; reproduced on a minimal button and the actual player, now preserving unchanged labels',
    ],
    testCorrections: [
      'Visibility helper must expect frozen while freeze remains outstanding',
      'TJS lacks the JS lastIndexOf method used by the first IME assertion',
      'Console expression cannot contain a var declaration',
    ],
    automationCorrections: [
      'Default Playwright CDP focus override prevents native visibility; raw owned Chromium with noDefaults produces trusted events',
      'Native configuration uses object spread to replace project list; automatic trace already starts on CDP connection',
      'One full run exceeded the WebKit case timeout after successful cross-tab assertions; closing the second page immediately after its assertions preserves coverage and recording while removing unneeded two-page overhead',
    ],
  },
  priorMatrices: await Promise.all(
    ['graphics', 'pwa', 'library', 'http', 'zip'].map(async (name) => {
      const path = `out/verification/${name}-matrix.json`
      return { path, sha256: await hash(path), independentMatrixRerunThisPhase: false }
    }),
  ),
  incomplete: [
    'Actual BFCache restoration, mobile OS process termination, long-term suspension and resource pressure are not verified',
    'Firefox/WebKit test application lifecycle signals, not native browser freezing',
    'All in-progress decode/seek/request timeout and OS scheduling permutations remain unverified',
    'Streaming media, exact fonts, full System/window/IME events and remaining non-plugin engine APIs',
    'Original external KAG 36-scenario probe matrix was not rerun this phase',
  ],
}
assert.deepEqual(matrix.wasm, await json('.generated/wasm/manifest.json'))
assert.deepEqual(matrix.wasm, previous.wasm)
const output = 'out/verification/activity-matrix.json'
await writeFile(output, JSON.stringify(matrix, null, 2) + '\n')
console.log('WROTE ' + resolve(output))
