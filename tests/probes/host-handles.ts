// Isolate native aborts while retaining every failed release scenario in the report.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostHandleCases } from '../helpers/host-handles.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const variant = process.argv[2]!
assert(['asyncify', 'jspi'].includes(variant))
const manifest = JSON.parse(readFileSync('.generated/wasm/manifest.json', 'utf8'))
const results = []
mkdirSync('out/ci', { recursive: true })
for (const debugMode of [false, true])
  for (const binary of [false, true])
    for (const name of hostHandleCases) {
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-wasm-jspi',
          '--import',
          'tsx',
          'tests/probes/host-handles-case.ts',
          variant,
          name,
          String(debugMode),
          String(binary),
        ],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      )
      const output = child.stdout + child.stderr
      const line = output.split('\n').find((line) => line.startsWith('HOST_HANDLES_RESULT '))
      const outcome = line ? JSON.parse(line.slice('HOST_HANDLES_RESULT '.length)) : null
      results.push({
        name,
        debugMode,
        binary,
        status: child.status,
        signal: child.signal,
        error: child.error ? String(child.error) : null,
        outcome,
        output,
      })
      writeFileSync(
        `out/ci/host-handles-${variant}.json`,
        JSON.stringify({ variant, manifest, results }, null, 2) + '\n',
      )
      console.log(
        `${child.status === 0 ? 'PASS' : 'FAIL'} ${variant}/${name}/debug=${debugMode}/binary=${binary}`,
      )
    }
assert(
  results.every((row) => row.status === 0 && !row.error && row.outcome?.result),
  'Host handle cases failed; see individual subprocess results',
)
