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
if (process.argv[2] === 'prepare') {
  assert.equal(process.env.RUNNER_OS, 'Windows')
  mkdirSync(game, { recursive: true })
  for (const [name, source] of Object.entries(kagFiles)) writeFileSync(resolve(game, name), textBytes(source))
  const startup = textBytes([
    'System.exitOnNoWindowStartup=false;',
    'var records=[];function record(s){records.add(s);records.save("native-events.txt");}',
    'record("start");System.exceptionHandler=function(e){record("fatal|"+e.message);System.exit();return true;};',
    kagControlSource, ...Object.keys(kagExpected).map((id) => `record("${id}|"+kagObserve("${id}"));`),
    `var bookmark=kagSavePoint();(Dictionary.saveStruct incontextof bookmark)("${nativeFile}");`,
    'record("done");System.exit();',
  ].join('\n'))
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, inputs: Object.keys(kagFiles).map((name) => ({ name, sha256: sha(read(name)) })), startup: sha(startup) })
} else if (process.argv[2] === 'native') {
  const manifest = JSON.parse(readFileSync(resolve(output, 'inputs.json'), 'utf8'))
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  for (const [name, source] of Object.entries(kagFiles)) assert.deepEqual(read(name), textBytes(source))
  assert.equal(manifest.startup, sha(read('startup.tjs')))
  const raw = existsSync(resolve(game, 'native-events.txt')) ? read('native-events.txt') : Buffer.alloc(0)
  const lines = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const sdk = JSON.parse(readFileSync(resolve(output, 'sdk-process.json'), 'utf8').replace(/^\ufeff/, ''))
  const results = Object.entries(kagExpected).map(([id, expected]) => {
    const found = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
    return { id, expected, found, matched: found.length === 1 && found[0] === expected }
  })
  const bookmark = existsSync(resolve(game, nativeFile)) ? read(nativeFile) : undefined
  const complete = sdk.state === 'observed' && sdk.exitCode === 0 && sdk.commit === manifest.commit && !!bookmark?.length &&
    lines.length === results.length + 2 && lines[0] === 'start' && lines.at(-1) === 'done' && results.every((r) => r.matched)
  save('comparison.json', { commit: manifest.commit, complete, results, observationsSha256: sha(raw), bookmarkSha256: bookmark && sha(bookmark) })
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
