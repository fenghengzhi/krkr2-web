import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { kagControlSource, kagExpected, kagFiles } from '../helpers/kag-scenarios.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const output = resolve('out/verification/native-eri/kag'), game = resolve(output, 'game')
const textBytes = (source: string) => Buffer.from('\ufeff' + source, 'utf16le')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const read = (name: string) => readFileSync(resolve(game, name))
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n')
const nativeFile = 'native-bookmark.tjs'
const controlsFile = 'kag-controls.tjs'
if (process.argv[2] === 'prepare') {
  assert.equal(process.env.RUNNER_OS, 'Windows')
  mkdirSync(game, { recursive: true })
  for (const [name, source] of Object.entries(kagFiles)) writeFileSync(resolve(game, name), textBytes(source))
  const controls = textBytes(kagControlSource)
  writeFileSync(resolve(game, controlsFile), controls)
  const startup = textBytes([
    'System.exitOnNoWindowStartup=false;',
    'var records=[];function record(s){records.add(s);records.save("native-events.txt");}',
    'var progress=[];function mark(s){progress.add(s);progress.save("native-progress.txt");}',
    'record("start");mark("setup:begin");System.exceptionHandler=function(e){record("fatal|"+e.message);mark("fatal|"+e.message);System.exit();return true;};',
    // Keep authored controls out of startup's initial compilation unit. A
    // syntax error is then recorded after the minimal journal is installed.
    `try{Scripts.execStorage("${controlsFile}");mark("setup:end");`,
    ...Object.keys(kagExpected).map((id) => `mark("control:begin:${id}");record("${id}|"+kagObserve("${id}"));mark("control:end:${id}");`),
    'mark("bookmark:begin");',
    `var bookmark=kagSavePoint();(Dictionary.saveStruct incontextof bookmark)("${nativeFile}");`,
    'mark("bookmark:end");record("done");',
    '}catch(error){record("fatal|"+error.message);mark("fatal|"+error.message);}',
    'mark("exit:requested");System.exit();',
  ].join('\n'))
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, inputs: Object.keys(kagFiles).map((name) => ({ name, sha256: sha(read(name)) })),
    startup: sha(startup), controls: { name: controlsFile, bytes: controls.length, sha256: sha(controls) } })
} else if (process.argv[2] === 'native') {
  const manifest = JSON.parse(readFileSync(resolve(output, 'inputs.json'), 'utf8'))
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  for (const [name, source] of Object.entries(kagFiles)) assert.deepEqual(read(name), textBytes(source))
  assert.equal(manifest.startup, sha(read('startup.tjs')))
  assert.equal(manifest.controls.name, controlsFile)
  assert.equal(manifest.controls.bytes, read(controlsFile).length)
  assert.equal(manifest.controls.sha256, sha(read(controlsFile)))
  assert.deepEqual(read(controlsFile), textBytes(kagControlSource))
  const raw = existsSync(resolve(game, 'native-events.txt')) ? read('native-events.txt') : Buffer.alloc(0)
  const lines = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const sdk = JSON.parse(readFileSync(resolve(output, 'sdk-process.json'), 'utf8').replace(/^\ufeff/, ''))
  const progressRaw = existsSync(resolve(game, 'native-progress.txt')) ? read('native-progress.txt') : Buffer.alloc(0),
    progress = progressRaw.toString(progressRaw[0] === 255 && progressRaw[1] === 254 ? 'utf16le' : 'utf8')
      .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/).filter(Boolean)
  const results = Object.entries(kagExpected).map(([id, expected]) => {
    const found = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
    const matched = found.length === 1 && found[0] === expected
    return { id, expected, found, matched, state: !found.length ? 'unreported' : matched ? 'matched' : 'mismatched' }
  })
  const bookmark = existsSync(resolve(game, nativeFile)) ? read(nativeFile) : undefined
  const complete = sdk.state === 'observed' && sdk.exitCode === 0 && sdk.commit === manifest.commit && !!bookmark?.length &&
    lines.length === results.length + 2 && lines[0] === 'start' && lines.at(-1) === 'done' && results.every((r) => r.matched)
  save('comparison.json', { commit: manifest.commit, complete, results, observationsSha256: sha(raw), bookmarkSha256: bookmark && sha(bookmark),
    progress, progressSha256: sha(progressRaw), lastPhase: progress.at(-1),
    unreported: results.filter((result) => result.state === 'unreported').map((result) => result.id),
    scope: 'The separate progress journal localizes a non-returning control; it never turns a timeout or absent result into a native semantic result.' })
  assert(complete, 'Incomplete original SDK scenario or bookmark observations')
} else if (process.argv[2] === 'web') {
  const native = JSON.parse(readFileSync(resolve(output, 'comparison.json'), 'utf8')) as {
    commit: string; complete: boolean; bookmarkSha256?: string; results: { id: string; found: string[] }[] }
  assert.equal(native.commit, process.env.GITHUB_SHA)
  assert.equal(JSON.parse(readFileSync('out/ci/build-info.json', 'utf8')).commit, native.commit)
  const bookmark = read(nativeFile)
  assert.equal(sha(bookmark), native.bookmarkSha256)
  const { headless } = await import('../helpers/headless.ts')
  const results: { mode: string; id: string; observed: string; expected: string; matched: boolean }[] = []
  const cleanup: string[] = []
  for (const mode of ['source', 'bytecode']) {
    const entries = Object.fromEntries(Object.keys(kagFiles).map((name) => [name, read(name)]))
    const { session } = await headless({ ...entries, [nativeFile]: bookmark, 'controls.tjs': kagControlSource,
      'startup.tjs': mode === 'source' ? 'Scripts.execStorage("controls.tjs");'
        : 'Scripts.compileStorage("controls.tjs","savedata/controls.cjs",false,true,false);Scripts.execStorage("savedata/controls.cjs");' })
    try {
      await session.start()
      for (const [id, expected] of Object.entries(kagExpected)) {
        const observed = await session.evaluate(`kagObserve("${id}")`), original = native.results.find((r) => r.id === id)?.found
        results.push({ mode, id, observed, expected, matched: original?.length === 1 && original[0] === observed && expected === observed })
      }
      const id = 'import-original-bookmark', expected = 'Alice|1|Alice|live|1|Alice|live|finished|0|1'
      const observed = await session.evaluate(`kagResumePoint(Scripts.evalStorage("${nativeFile}"))`)
      results.push({ mode, id, observed, expected, matched: expected === observed })
    } finally {
      try { await session.stop(); assert.equal(session.snapshot().handles, 0) } catch (error) { cleanup.push(String(error)) }
      save('web-comparison.json', { commit: native.commit, bookmarkSha256: sha(bookmark), results, cleanup })
    }
  }
  assert(native.complete && results.every((r) => r.matched) && !cleanup.length, 'KAG SDK and Web behavior differed')
} else throw new Error('Expected prepare, native or web')
