// Run after npm run check and repack-xp3.ts. Reference games stay outside normal CI fixtures.
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const source = process.argv[2] ?? '../kirikiroid2-web/tests/test_files/xp3/kag3_template.xp3'
const directory = 'out/verification/zip'
const zip = `${directory}/kag3_template.zip`
const checkLog = `${directory}/check.log`
const check = await readFile(checkLog, 'utf8')
const behaviorTests = Number(check.match(/^ℹ tests (\d+)$/m)?.[1])
const browserTests = Number(check.match(/(\d+) passed \([^\n]+\)\s*$/)?.[1])
if (
  !behaviorTests ||
  !browserTests ||
  !check.includes(`ℹ pass ${behaviorTests}\n`) ||
  !check.includes('ℹ fail 0\n') ||
  !check.includes('ℹ skipped 0\n') ||
  /\d+ skipped|\d+ failed/.test(check)
)
  throw new Error('A completed, successful full check without skipped cases is required')

const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const matrix = JSON.parse(await readFile('out/verification/image-cache-matrix.json', 'utf8'))
const repack = JSON.parse(await readFile(zip + '.json', 'utf8'))
if ((await hash(source)) !== repack.sourceSha256 || (await hash(zip)) !== repack.zipSha256)
  throw new Error('Reference archive no longer matches its repack record')
const implementationPaths = [
  ...new Set([
    ...Object.keys(matrix.implementationSha256),
    'src/formats/zip/archive.ts',
    'src/formats/zip/names.ts',
    'src/formats/xp3/archive.ts',
    'src/backends/files/import-resources.ts',
    'src/workers/session.worker.ts',
    'src/app/app.ts',
    'native/tjs2/bridge.cpp',
  ]),
]
const initialHashes = Object.fromEntries(
  await Promise.all(implementationPaths.map(async (path) => [path, await hash(path)])),
)
const distIndexSha256 = await hash('dist/index.html')
const wasm = JSON.parse(await readFile('dist/wasm/manifest.json', 'utf8'))
for (const variant of Object.values(wasm.variants))
  for (const kind of ['mjs', 'wasm'])
    if ((await hash('dist/wasm/' + variant[kind].file)) !== variant[kind].sha256)
      throw new Error('Published WASM asset hash mismatch')

await mkdir(directory, { recursive: true })
matrix.fixtureCases = []
for (const [container, filename] of [
  ['xp3', source],
  ['zip', zip],
])
  for (const browser of ['chromium', 'firefox', 'webkit'])
    for (const backend of ['asyncify', 'jspi'])
      for (const mode of ['flow', 'save', 'transition']) {
        const log = `${directory}/kag-${container}-${browser}-${backend}-${mode}.log`
        const fd = openSync(log, 'w')
        try {
          await new Promise((done, reject) => {
            const child = spawn(
              process.execPath,
              ['--import', 'tsx', 'tests/probes/kag-browser.ts', filename, browser, backend, mode],
              { stdio: ['ignore', fd, fd] },
            )
            child.on('error', reject)
            child.on('exit', (code) =>
              code === 0
                ? done()
                : reject(
                    new Error(`KAG ${container}/${browser}/${backend}/${mode} failed: ${log}`),
                  ),
            )
          })
        } finally {
          closeSync(fd)
        }
        const name = `${basename(filename, '.xp3')}-${browser}-${backend}-${mode}`
        const report = JSON.parse(await readFile(`out/verification/${name}.json`, 'utf8'))
        if (!report.observedWithoutError || report.errors.length || !report.steps.length)
          throw new Error('Incomplete KAG scenario report: ' + name)
        for (const extension of ['json', 'png'])
          await copyFile(
            `out/verification/${name}.${extension}`,
            `${directory}/${name}.${extension}`,
          )
        matrix.fixtureCases.push({
          container,
          browser,
          backend,
          mode,
          report: `${directory}/${name}.json`,
          steps: report.steps,
          log,
        })
        console.log(`PASS ${container}/${browser}/${backend}/${mode}`)
      }

for (const [path, expected] of Object.entries(initialHashes))
  if ((await hash(path)) !== expected)
    throw new Error('Implementation changed during verification: ' + path)
if ((await hash('dist/index.html')) !== distIndexSha256)
  throw new Error('Build changed during verification')
matrix.verifiedAt = new Date().toISOString()
matrix.check = { command: 'npm run check', behaviorTests, browserTests, skipped: 0, log: checkLog }
matrix.implementationSha256 = initialHashes
matrix.distIndexSha256 = distIndexSha256
matrix.wasm = wasm
matrix.kagProbe.sha256 = await hash(matrix.kagProbe.path)
matrix.zipReference = {
  archives: 16,
  memberReads: 90,
  metadata: 'tests/fixtures/zip/reference.json',
  metadataSha256: await hash('tests/fixtures/zip/reference.json'),
  repack: zip + '.json',
  sourceSha256: repack.sourceSha256,
  zipSha256: repack.zipSha256,
  memberCount: repack.entries.length,
  decodedBytes: repack.decodedBytes,
  preparation: 'node --import tsx tests/probes/repack-xp3.ts ' + source + ' ' + zip,
}
matrix.testSha256 = {}
for (const path of [
  'tests/conformance/zip.test.ts',
  'tests/integration/zip.test.ts',
  'tests/browser/zip.spec.ts',
  'tests/helpers/zip-fixtures.ts',
  'tests/helpers/browser-expression.ts',
  'tests/browser/audio.spec.ts',
  'tests/browser/video.spec.ts',
  'tests/browser/scene.spec.ts',
  'tests/probes/repack-xp3.ts',
  'tests/probes/zip-matrix.mjs',
])
  matrix.testSha256[path] = await hash(path)
matrix.browserTestFixes.push(
  'Bind expression assertions to unique response markers rather than the last asynchronous log',
  'Wait for a late autoplay prompt or the required playback event; fault-inject delayed denial',
  'Wait for session readiness and canvas dimensions before the initial scene screenshot',
  'Observe any nonzero published resource count while cancelling ZIP indexing',
  'Poll KAG history state after queued DOM input and bind each probe query to its own result',
)
matrix.storageWritePreflight =
  'Validate text/binary stream targets on the suspendable TJS stack before destructor-based queueing'
matrix.priorEvidence =
  'Fixed independent reference fixtures continue to be checked by the current suite; original generation records remain in their metadata and prior matrices.'
await writeFile('out/verification/zip-matrix.json', JSON.stringify(matrix, null, 2) + '\n')
console.log('WROTE ' + resolve('out/verification/zip-matrix.json'))
