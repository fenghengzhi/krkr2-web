// Fixed repetitions of the failing original KAG path, executed only on Actions.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, open } from 'node:fs/promises'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const root = 'out/verification/kag-native-diagnostic'
const results = []
for (let index = 0; index < 20; index++) {
  const directory = `${root}/${String(index).padStart(2, '0')}`
  await mkdir(directory, { recursive: true })
  const log = await open(directory + '/process.log', 'w')
  let exit
  try {
    exit = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'tests/probes/kag-browser.ts',
          'tests/fixtures/compatibility/kag3_template.zip',
          'webkit',
          'jspi',
          'transition',
        ],
        {
          stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, KRKR_KAG_DIAGNOSTIC: '1', KRKR_KAG_OUTPUT: directory },
        },
      )
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
  } finally {
    await log.close()
  }
  const report = await readFile(
    directory + '/kag3_template.zip-webkit-jspi-transition.json',
    'utf8',
  ).then(JSON.parse, (error) => ({ error: String(error), observedWithoutError: false }))
  results.push({ index, ...exit, report })
  console.log(
    JSON.stringify({ index, ...exit, passed: report.observedWithoutError, error: report.error }),
  )
}
await writeFile(
  root + '/results.json',
  JSON.stringify(
    {
      build: JSON.parse(await readFile('out/ci/build-info.json', 'utf8')),
      scriptDebug: process.env.KRKR_KAG_SCRIPT_DEBUG === '1',
      results,
    },
    null,
    2,
  ) + '\n',
)
if (results.some((row) => row.code !== 0 || !row.report.observedWithoutError)) process.exitCode = 1
