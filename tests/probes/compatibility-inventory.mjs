// Current per-browser inventory; the protocol-9 vm-console historical report
// retains its original counts and requirements. Missing/cancelled work never
// becomes a passing result merely because another report exists.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run compatibility inventory on GitHub Actions')
const directory = resolve(process.argv[2] ?? 'out/verification/compatibility'),
  browser = process.argv[3],
  browsers = ['chromium', 'firefox', 'webkit'], backends = ['asyncify', 'jspi'],
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  json = async (path) => JSON.parse(await readFile(path, 'utf8')),
  series = [
    { name: 'kag', keys: ['xp3', 'zip'].flatMap((container) => backends.flatMap((backend) => ['flow', 'save', 'transition'].map((mode) => `${container}/${backend}/${mode}`))) },
    ...['kag-panels', 'kag-diagnostics', 'kag-storage-selector', 'kag-help', 'kag-cursor', 'abi-pwa', 'runtime-abi-pwa', 'font-abi-pwa', 'trace-abi-pwa', 'scripts-abi-pwa'].map((name) => ({ name, keys: backends })),
  ],
  results = series.flatMap(({ name, keys }) => keys.map((key) => ({ series: name, key, status: 'unreported' }))),
  evidenceErrors = []
assert(browsers.includes(browser), 'A single known browser is required')
assert.equal(results.length, 32)
await mkdir(directory, { recursive: true })
let buildInfo, indexSha256, wasm, font, release
try {
  buildInfo = await json('out/ci/build-info.json')
  indexSha256 = hash(await readFile('dist/index.html'))
  wasm = await json('dist/wasm/manifest.json')
  font = await json('dist/fonts/manifest.json')
  const worker = await readFile('dist/sw.js', 'utf8')
  release = JSON.parse(worker.slice('self.__KRKR_SHELL__='.length, worker.indexOf(';\n')))
  assert.equal(wasm.capabilities?.nativeHelp, 1)
} catch (error) {
  evidenceErrors.push('Current build provenance: ' + String(error))
}
const artifact = (path) => {
  assert.equal(typeof path, 'string')
  const prefix = 'out/verification/compatibility/'
  const normalized = path.startsWith(prefix) ? path.slice(prefix.length) : path
  assert(!normalized.split(/[\\/]/).includes('..'), 'Evidence path cannot escape the artifact directory')
  const absolute = resolve(directory, normalized)
  assert(absolute.startsWith(directory + sep), 'Evidence must be inside the artifact directory')
  return absolute
}
const nonempty = async (path) => assert((await readFile(artifact(path))).length > 0, `Empty evidence: ${path}`)
const validateManifest = async (name) => {
  const manifest = await json(resolve(directory, name, 'artifact-manifest.json'))
  assert.equal(manifest.indexSha256, indexSha256)
  assert.equal(manifest.githubRun, process.env.GITHUB_RUN_ID)
  assert.equal(manifest.githubSha, process.env.GITHUB_SHA)
  assert(Array.isArray(manifest.files) && manifest.files.length > 0)
  const seen = new Set()
  for (const entry of manifest.files) {
    assert(!seen.has(entry.path), 'Duplicate artifact manifest entry')
    seen.add(entry.path)
    const bytes = await readFile(artifact(entry.path))
    assert.equal(bytes.length, entry.bytes, entry.path)
    assert.equal(hash(bytes), entry.sha256, entry.path)
  }
  assert(seen.has(name + '.json'), 'The top-level summary must be bound to its evidence')
}

for (const { name, keys } of series) {
  const rows = results.filter((result) => result.series === name)
  let report
  try {
    report = await json(resolve(directory, `${name}.json`))
    assert(Array.isArray(report.results))
    if (name.startsWith('kag')) {
      assert.equal(report.indexSha256, indexSha256)
      assert.equal(report.sourceSha256, '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    } else {
      assert.deepEqual(report.manifests[1], name === 'font-abi-pwa' ? font : wasm)
    }
    const keyFor = (row) => name === 'kag' ? `${row.container}/${row.backend}/${row.mode}` : row.backend
    assert.deepEqual(report.results.map(keyFor).sort(), [...keys].sort(), 'The report must contain each expected case exactly once')
    assert(report.results.every((row) => row.browser === browser), 'Reports cannot mix browsers')
    let manifestError
    if (name === 'kag-storage-selector' || name === 'kag-help' || name === 'kag-cursor') {
      try { await validateManifest(name) }
      catch (error) { manifestError = error }
    }
    for (const result of rows) {
      const row = report.results.find((row) => keyFor(row) === result.key)
      try {
        if (name === 'kag-storage-selector' || name === 'kag-help' || name === 'kag-cursor') {
          // Preserve an interrupted/failed probe's identity before reading a
          // potentially absent per-case report.
          if (row.status !== 'passed') {
            result.status = row.status === 'failed' ? 'failed' : 'unreported'
            result.error = row.error ?? `Probe status: ${row.status}`
            result.probeStatus = row.status
            continue
          }
          if (manifestError) throw manifestError
          const detail = await json(artifact(row.report))
          assert.equal(detail.status, 'passed')
          assert.equal(detail.observedWithoutError, true)
          assert.equal(detail.browser, browser)
          assert.equal(detail.backend, result.key)
          assert.equal(detail.sourceSha256, report.sourceSha256)
          assert.equal(detail.indexSha256, indexSha256)
          assert.equal(detail.originalXp3Bytes, true)
          assert.deepEqual(detail.errors, [])
          assert.deepEqual(detail.evidenceErrors, [])
          assert(Array.isArray(detail.steps) && detail.steps.length > 0)
          await nonempty(`${name}/${browser}-${result.key}/trace.zip`)
          if (name === 'kag-help') {
            assert.equal(detail.originalMenuHandler, true)
            for (const step of [
              'first-original-menu-visible-and-script-continued',
              'close-removes-help-with-session-running',
              'reopened-original-menu-visible-and-script-continued',
              'stop-with-help-open', 'fresh-session-has-no-old-help',
              'fresh-original-menu-visible-and-script-continued',
              'stale-close-cannot-affect-new-session', 'final-stop-releases-help',
            ]) assert(detail.steps.includes(step), `Missing KAG help stage: ${step}`)
            assert.equal(detail.workers.length, 2)
            assert(detail.workers.every((worker) => worker.closed))
            for (const stage of ['first-open', 'closed', 'reopened-open', 'stop-with-help-open', 'fresh-ready-without-old-help', 'fresh-open', 'stale-close-cannot-affect-new-session', 'final-stop-releases-help'])
              await nonempty(`${name}/${browser}-${result.key}/${stage}.png`)
          } else {
            assert.equal(detail.originalMethods, true)
            if (name === 'kag-cursor') {
              for (const step of [
                'first-link-highlight', 'second-link-highlight', 'previous-link-highlight',
                'tab-link-highlight', 'enter-runs-original-link-target',
                'physical-pointer-takes-over', 'stop-releases-marker-and-worker',
              ]) assert(detail.steps.includes(step), `Missing KAG cursor stage: ${step}`)
              assert.equal(detail.workers.length, 1)
              assert(detail.workers[0].closed)
              for (const stage of ['first-link-highlight', 'second-link-highlight', 'previous-link-highlight', 'tab-link-highlight', 'entered-second-target', 'physical-takeover', 'stopped'])
                await nonempty(`${name}/${browser}-${result.key}/${stage}.png`)
            }
          }
        } else if (name === 'kag') {
          const bytes = await readFile(artifact(row.report)), detail = JSON.parse(bytes)
          assert.equal(hash(bytes), row.sha256)
          assert.equal(hash(await readFile(artifact(row.log))), row.logSha256)
          assert.equal(detail.observedWithoutError, true)
          assert.deepEqual(detail.errors, [])
          assert.deepEqual(row.steps, {
            flow: ['line', 'history', 'page', 'link', 'choice'],
            save: ['plain-save', 'plain-load', 'thumbnail-8', 'thumbnail-24', 'reload'],
            transition: ['crossfade', 'scroll', 'universal', 'done'],
          }[row.mode])
          await nonempty(row.screenshot)
        } else if (name === 'kag-panels' || name === 'kag-diagnostics') {
          assert.deepEqual(row.errors, [])
          if (name === 'kag-panels') assert(row.originalMenuHandlers && row.originalShortcuts && row.independentVisibility)
          else {
            assert(row.originalHandler && row.primaryLogged && row.observersNotified && row.recovered)
            assert.equal(hash(await readFile(artifact(row.log))), row.logSha256)
          }
          await nonempty(row.screenshot)
        } else {
          assert.equal(row.newBuild, release.build)
          assert(row.oldWorkerRestartedOffline && row.newWorkerStartedOffline)
          assert.deepEqual(row.errors, [])
          assert.equal(row.startupTimeoutMs, 12000)
          assert.deepEqual(row.startups.map(({ release, offline }) => ({ release, offline })), [
            { release: 'old', offline: false }, { release: 'old', offline: true }, { release: 'current', offline: true },
          ])
          assert(row.startups.every((startup) => Number.isFinite(startup.milliseconds) && startup.milliseconds > 0))
          if (name === 'trace-abi-pwa') assert.equal(row.nativeTraceVerified, true)
          if (name === 'scripts-abi-pwa') assert.equal(row.nativeScriptsClassAndCompilerVerified, true)
        }
        result.status = 'passed'
      } catch (error) {
        result.status = 'failed'
        result.error = String(error)
      }
    }
  } catch (error) {
    const absent = error?.code === 'ENOENT' && !report
    for (const result of rows) {
      result.status = absent ? 'unreported' : 'failed'
      result.error = String(error)
    }
  }
}
const counts = Object.fromEntries(['passed', 'failed', 'unreported'].map((status) => [status, results.filter((row) => row.status === status).length]))
const summary = {
  recordedAt: new Date().toISOString(), githubRun: process.env.GITHUB_RUN_ID,
  githubSha: process.env.GITHUB_SHA, browser, buildInfo, indexSha256,
  inventory: { perBrowser: 32, matrixBrowsers: browsers, matrixCases: 96, originalHelpCases: 6, originalCursorCases: 6 },
  counts, evidenceErrors, results,
  passing: counts.passed === 32 && evidenceErrors.length === 0,
}
await writeFile(resolve(directory, 'current-inventory.json'), JSON.stringify(summary, null, 2) + '\n')
const markdown = `Compatibility ${browser}: ${counts.passed}/32 passed, ${counts.failed} failed, ${counts.unreported} unreported. Full matrix inventory: 96 cases (including 6 original KAG help and 6 cursor cases).\n`
console.log(markdown.trim())
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
if (!summary.passing) process.exitCode = 1
