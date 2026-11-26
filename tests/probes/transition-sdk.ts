import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transitionOptionCases, transitionOptionFiles, transitionOptionsSource } from '../helpers/transition-options.ts'
import { layerGammaCases, layerGammaExpected, layerGammaSource } from '../helpers/layer-gamma.ts'
import { layerOrderCases, layerOrderSource } from '../helpers/layer-order.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const output = resolve('out/verification/native-eri/transition'), game = resolve(output, 'game')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const files = transitionOptionFiles()
const cases = [...transitionOptionCases, ...layerGammaCases.map((row) => ({ id: row.id, expected: layerGammaExpected(row) })), ...layerOrderCases]
const save = (name: string, data: unknown) => writeFileSync(resolve(output, name), JSON.stringify(data, null, 2) + '\n')

if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(resolve(game, name), bytes)
  const startup = Buffer.from('\ufeff' + [
    'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;',
    'var nativeTransitionRows=[];function record(s){nativeTransitionRows.add(s);nativeTransitionRows.save("native-events.txt");}',
    'record("start");System.exceptionHandler=function(e){record("fatal|"+e.message);System.exit();return true;};',
    transitionOptionsSource,
    ...transitionOptionCases.map(({ id }) => `record("${id}|"+transitionOptionRun("${id}"));`),
    'transitionOptionClose();',
    layerGammaSource,
    ...layerGammaCases.map(({ id }) => `record("${id}|"+layerGammaRun("${id}"));`),
    'layerGammaClose();',
    layerOrderSource,
    ...layerOrderCases.map(({ id }) => `try{record("${id}|"+layerOrderRun("${id}"));}catch(e){record("${id}|error:"+e.message);}`),
    'layerOrderClose();record("done");System.exit();',
  ].join('\n'), 'utf16le')
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', {
    commit: process.env.GITHUB_SHA, startupSha256: sha(startup),
    helperSha256: sha(readFileSync('tests/helpers/transition-options.ts')),
    gammaHelperSha256: sha(readFileSync('tests/helpers/layer-gamma.ts')),
    orderHelperSha256: sha(readFileSync('tests/helpers/layer-order.ts')),
    cases,
    files: Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) })),
    scope: 'Original beginTransition options, Layer gamma contrast, and overlapping layer order and hit targets.',
  })
} else if (process.argv[2] === 'compare') {
  mkdirSync(output, { recursive: true })
  const evidenceErrors: string[] = []
  const loadJson = (name: string): Record<string, unknown> | undefined => {
    const path = resolve(output, name)
    try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\ufeff/, '')) as Record<string, unknown> }
    catch (error) { evidenceErrors.push(`${name}: ${String(error)}`); return undefined }
  }
  const manifest = loadJson('inputs.json'), sdk = loadJson('sdk-process.json')
  if (manifest?.commit !== process.env.GITHUB_SHA) evidenceErrors.push('Input commit differs from this checkout')
  if (sdk?.commit !== process.env.GITHUB_SHA) evidenceErrors.push('SDK process commit differs from this checkout')
  if (JSON.stringify(manifest?.cases) !== JSON.stringify(cases)) evidenceErrors.push('Case manifest differs')
  const expectedFiles = Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) }))
  if (JSON.stringify(manifest?.files) !== JSON.stringify(expectedFiles)) evidenceErrors.push('Fixture hash manifest differs')
  for (const [name, expected] of [
    [resolve(game, 'startup.tjs'), manifest?.startupSha256],
    [resolve('tests/helpers/transition-options.ts'), manifest?.helperSha256],
    [resolve('tests/helpers/layer-gamma.ts'), manifest?.gammaHelperSha256],
    [resolve('tests/helpers/layer-order.ts'), manifest?.orderHelperSha256],
  ] as const) {
    if (!existsSync(name) || sha(readFileSync(name)) !== expected) evidenceErrors.push(`${name}: source hash differs or is missing`)
  }
  for (const [name, bytes] of Object.entries(files)) {
    const path = resolve(game, name)
    if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(bytes))) evidenceErrors.push(`${name}: fixture bytes differ or are missing`)
  }
  const path = resolve(game, 'native-events.txt'), raw = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const lines = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8')
    .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const results = cases.map(({ id, expected }) => {
    const observed = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
    return { id, expected, observed, matched: observed.length === 1 && observed[0] === expected }
  })
  const sequenceMatches = lines.length === results.length + 2 && lines[0] === 'start' && lines.at(-1) === 'done' &&
    results.every((row, index) => lines[index + 1] === row.id + '|' + row.expected)
  const complete = evidenceErrors.length === 0 && sdk?.state === 'observed' && sdk.exitCode === 0 &&
    sdk.timedOut === false && sequenceMatches && results.every((row) => row.matched)
  save('comparison.json', {
    commit: process.env.GITHUB_SHA, planned: cases.length, reported: results.filter((row) => row.observed.length > 0).length,
    transitionOptions: { planned: transitionOptionCases.length,
      matched: results.slice(0, transitionOptionCases.length).filter((row) => row.matched).length },
    gamma: { planned: layerGammaCases.length,
      matched: results.slice(transitionOptionCases.length, transitionOptionCases.length + layerGammaCases.length).filter((row) => row.matched).length },
    layerOrder: { planned: layerOrderCases.length,
      matched: results.slice(-layerOrderCases.length).filter((row) => row.matched).length },
    complete, sequenceMatches, evidenceErrors, sdkState: sdk?.state ?? 'unreported',
    sdkExitCode: sdk?.exitCode ?? null, sdkTimedOut: sdk?.timedOut ?? null, results, lines,
    observationSha256: sha(raw),
    scope: 'Stock SDK option-read/error, gamma, sibling order and hit targets. Web source, bytecode and rendered game results are recorded by their respective jobs.',
  })
  assert(complete, 'Original transition option observations differ or are incomplete')
} else throw new Error('Expected prepare or compare')
