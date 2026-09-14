// Rerun the external original KAG scripts against the current release, serially.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
const source = process.argv[2] ?? '../kirikiroid2-web/tests/test_files/xp3/kag3_template.xp3',
  zip = process.env.KRKR_KAG_ZIP ?? 'out/verification/zip/kag3_template.zip',
  output = process.argv[3] ?? 'out/verification/system-events',
  directory = output + '/kag',
  hash = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  repack = JSON.parse(await readFile(zip + '.json', 'utf8')),
  indexSha256 = await hash('dist/index.html')
assert.equal(await hash(source), repack.sourceSha256)
assert.equal(await hash(zip), repack.zipSha256)
await mkdir(directory, { recursive: true })
const browsers = ['chromium', 'firefox', 'webkit']
const selected = process.env.KRKR_PROBE_BROWSER
if (selected && !browsers.includes(selected)) throw new Error('Unknown probe browser: ' + selected)
const results = []
for (const [container, filename] of [
  ['xp3', source],
  ['zip', zip],
])
  for (const browser of selected ? [selected] : browsers)
    for (const backend of ['asyncify', 'jspi'])
      for (const mode of ['flow', 'save', 'transition']) {
        const log = `${directory}/${container}-${browser}-${backend}-${mode}.log`,
          name = `${basename(filename, '.xp3')}-${browser}-${backend}-${mode}`,
          fd = openSync(log, 'w')
        try {
          await new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['--import', 'tsx', 'tests/probes/kag-browser.ts', filename, browser, backend, mode],
              { stdio: ['ignore', fd, fd] },
            )
            child.on('error', reject)
            child.on('exit', (code) =>
              code === 0 ? resolve() : reject(new Error('KAG scenario failed: ' + log)),
            )
          })
        } catch (error) {
          // Failed scenarios must retain the same source report/screenshot and
          // native browser trace as passing scenarios, before aborting the matrix.
          for (const suffix of ['.json', '.png', '-failure.zip']) {
            await copyFile(
              `out/verification/${name}${suffix}`,
              `${directory}/${name}${suffix}`,
            ).catch((copyError) => {
              if (copyError.code !== 'ENOENT') throw copyError
            })
          }
          throw error
        } finally {
          closeSync(fd)
        }
        const report = JSON.parse(await readFile(`out/verification/${name}.json`, 'utf8'))
        assert(report.observedWithoutError && !report.errors.length && report.steps.length)
        for (const ext of ['json', 'png'])
          await copyFile(`out/verification/${name}.${ext}`, `${directory}/${name}.${ext}`)
        const path = `${directory}/${name}.json`
        results.push({
          container,
          browser,
          backend,
          mode,
          report: path,
          sha256: await hash(path),
          steps: report.steps,
          log,
          logSha256: await hash(log),
          screenshot: `${directory}/${name}.png`,
        })
        console.log(`PASS ${container}/${browser}/${backend}/${mode}`)
      }
assert.equal(await hash('dist/index.html'), indexSha256)
await writeFile(
  output + '/kag.json',
  JSON.stringify(
    {
      date: new Date().toISOString(),
      indexSha256,
      sourceSha256: repack.sourceSha256,
      zipSha256: repack.zipSha256,
      results,
    },
    null,
    2,
  ) + '\n',
)
