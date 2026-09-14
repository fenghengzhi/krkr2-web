// Isolate native aborts so one broken destructor cannot hide the remaining cases.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { objectLifetimeCases } from '../helpers/object-lifetime.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const variant = process.argv[2]!
assert(['asyncify', 'jspi'].includes(variant))
const manifest = JSON.parse(readFileSync('.generated/wasm/manifest.json', 'utf8'))
const results = []
mkdirSync('out/ci', { recursive: true })
for (const debugMode of [false, true])
  for (const binary of [false, true])
    for (const fixture of objectLifetimeCases) {
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-wasm-jspi',
          '--import',
          'tsx',
          'tests/probes/object-lifetime-case.ts',
          variant,
          fixture.name,
          String(debugMode),
          String(binary),
        ],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      )
      const output = child.stdout + child.stderr
      const line = output.split('\n').find((line) => line.startsWith('OBJECT_RESULT '))
      const outcome = line ? JSON.parse(line.slice('OBJECT_RESULT '.length)) : null
      const row = {
        name: fixture.name,
        debugMode,
        binary,
        status: child.status,
        signal: child.signal,
        error: child.error ? String(child.error) : null,
        outcome,
        output,
      }
      results.push(row)
      writeFileSync(
        `out/ci/object-lifetime-${variant}.json`,
        JSON.stringify({ variant, manifest, results }, null, 2) + '\n',
      )
      console.log(
        `${child.status === 0 ? 'PASS' : 'FAIL'} ${variant}/${fixture.name}/debug=${debugMode}/binary=${binary}`,
      )
    }
assert(
  results.every((row) => row.status === 0 && !row.error && row.outcome?.result),
  'Object lifetime cases failed; see individual subprocess results',
)
