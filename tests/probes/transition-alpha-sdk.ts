import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { alphaTransitionCases, alphaTransitionChecks, alphaTransitionFiles, alphaTransitionSource } from '../helpers/transition-alpha.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const output = resolve('out/verification/native-eri/transition-alpha'), game = resolve(output, 'game')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const files = alphaTransitionFiles(), fileManifest = Object.entries(files)
  .map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) }))
const save = (name: string, data: unknown) => writeFileSync(resolve(output, name), JSON.stringify(data, null, 2) + '\n')

if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(resolve(game, name), bytes)
  const scene = Buffer.from('\ufeff' + alphaTransitionSource, 'utf16le')
  writeFileSync(resolve(game, 'alpha-scene.tjs'), scene)
  const startup = Buffer.from('\ufeff' + [
    'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;',
    'var nativeAlphaRows=[];function record(s){nativeAlphaRows.add(s);nativeAlphaRows.save("native-events.txt");}',
    'var nativeAlphaProgress=[],nativeAlphaCase="scene";function progress(s){if(nativeAlphaProgress.count<1024){nativeAlphaProgress.add(s);nativeAlphaProgress.save("native-progress.txt");}}',
    'record("start");System.exceptionHandler=function(e){record("fatal|"+e.message);System.exit();return true;};',
    'progress("scene:before");try{Scripts.execStorage("alpha-scene.tjs");}catch(e){progress("scene:error|"+e.message);record("fatal|scene|"+e.message);throw e;}progress("scene:after");',
    'alphaTransitionTrace=function(phase){progress("phase|"+global.nativeAlphaCase+"|"+phase);};',
    // Preserve a script exception before the application's startup exception
    // UI can intercept it. A blocked call retains its last completed phase.
    'function observeAlpha(id,call){global.nativeAlphaCase=id;progress("before|"+id);var value;try{value=call();}catch(e){progress("error|"+id+"|"+e.message);record("error|"+id+"|"+e.message);throw e;}record(id+"|"+value);progress("after|"+id);}',
    ...alphaTransitionChecks.map(({ id, call }) => `observeAlpha("${id}",function(){return ${call};});`),
    'progress("done");record("done");System.exit();',
  ].join('\n'), 'utf16le')
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, startupSha256: sha(startup), sceneSha256: sha(scene),
    helperSha256: sha(readFileSync('tests/helpers/transition-alpha.ts')), checks: alphaTransitionChecks,
    cases: alphaTransitionCases, files: fileManifest,
    scope: 'Live original Layer.piledCopy/getMainPixel/getMaskPixel with independent literal rows; leaf direct-copy negative controls and real completion-clock observations. No product pixel implementation imported.' })
} else if (process.argv[2] === 'compare') {
  mkdirSync(output, { recursive: true })
  const evidenceErrors: string[] = []
  const load = (name: string): Record<string, unknown> | undefined => {
    try { return JSON.parse(readFileSync(resolve(output, name), 'utf8').replace(/^\ufeff/, '')) as Record<string, unknown> }
    catch (error) { evidenceErrors.push(`${name}: ${String(error)}`); return undefined }
  }
  const manifest = load('inputs.json'), sdk = load('sdk-process.json')
  if (manifest?.commit !== process.env.GITHUB_SHA || sdk?.commit !== process.env.GITHUB_SHA) evidenceErrors.push('Checkout identity differs')
  if (JSON.stringify(manifest?.checks) !== JSON.stringify(alphaTransitionChecks) ||
      JSON.stringify(manifest?.cases) !== JSON.stringify(alphaTransitionCases)) evidenceErrors.push('Literal contract inventory differs')
  if (JSON.stringify(manifest?.files) !== JSON.stringify(fileManifest)) evidenceErrors.push('Input file manifest differs')
  for (const [path, expected] of [[resolve(game, 'startup.tjs'), manifest?.startupSha256],
    [resolve(game, 'alpha-scene.tjs'), manifest?.sceneSha256],
    [resolve('tests/helpers/transition-alpha.ts'), manifest?.helperSha256]] as const)
    if (!existsSync(path) || sha(readFileSync(path)) !== expected) evidenceErrors.push(`Source hash differs or is missing: ${path}`)
  for (const [name, bytes] of Object.entries(files)) {
    const path = resolve(game, name)
    if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(bytes))) evidenceErrors.push(`Input differs or is missing: ${name}`)
  }
  const path = resolve(game, 'native-events.txt'), raw = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const lines = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8')
    .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const results = alphaTransitionChecks.map(({ id, expected }) => {
    const observed = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
    return { id, expected, observed, state: observed.length === 0 ? 'unreported' : observed.length > 1 ? 'duplicate'
      : observed[0] === expected ? 'matched' : 'mismatched', matched: observed.length === 1 && observed[0] === expected }
  })
  const sequenceMatches = lines.length === results.length + 2 && lines[0] === 'start' && lines.at(-1) === 'done' &&
    results.every((row, index) => lines[index + 1] === row.id + '|' + row.expected)
  const progressPath = resolve(game, 'native-progress.txt'), progressRaw = existsSync(progressPath) ? readFileSync(progressPath) : Buffer.alloc(0),
    progress = progressRaw.toString(progressRaw[0] === 255 && progressRaw[1] === 254 ? 'utf16le' : 'utf8')
      .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/),
    boundaries = progress.filter((line) => line.startsWith('before|') || line.startsWith('after|')),
    expectedBoundaries = alphaTransitionChecks.flatMap(({ id }) => ['before|' + id, 'after|' + id]),
    progressComplete = progress[0] === 'scene:before' && progress[1] === 'scene:after' && progress.at(-1) === 'done' &&
      progress.length <= 1024 && JSON.stringify(boundaries) === JSON.stringify(expectedBoundaries) &&
      !progress.some((line) => line.startsWith('error|') || line.startsWith('scene:error|'))
  const complete = !evidenceErrors.length && sdk?.state === 'observed' && sdk.exitCode === 0 && sdk.timedOut === false &&
    sequenceMatches && progressComplete && results.every((row) => row.matched)
  save('comparison.json', { commit: process.env.GITHUB_SHA, planned: results.length,
    plannedPixelFrames: alphaTransitionCases.reduce((sum, item) => sum + item.frames.length, 0),
    reported: results.filter((row) => row.observed.length > 0).length, complete, sequenceMatches, evidenceErrors,
    sdkState: sdk?.state ?? 'unreported', sdkExitCode: sdk?.exitCode ?? null, sdkTimedOut: sdk?.timedOut ?? null,
    results, lines, observationSha256: sha(raw), progressComplete, progress, progressSha256: sha(progressRaw),
    scope: 'Original live transition snapshot bytes and leaf/cache path observations. Source/bytecode Session and browser rendering are independently required.' })
  assert(complete, 'Original alpha transition pixels or observation boundaries differ or are incomplete')
} else throw new Error('Expected prepare or compare')
