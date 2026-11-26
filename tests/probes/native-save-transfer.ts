import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { kagControlSource, kagFiles } from '../helpers/kag-scenarios.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const root = resolve('out/verification/native-eri/player-saves'), game = resolve(root, 'game')
const enc = (s: string) => Buffer.from('\ufeff' + s, 'utf16le')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const modes = ['source', 'bytecode']
const expected = '1193046,11259375|Alice|1|Alice|live|1|Alice|live|finished|0|1'
for (const mode of modes) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'web', mode + '.json'), 'utf8'))
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  assert.equal(manifest.run, process.env.GITHUB_RUN_ID)
  assert.equal(manifest.mode, mode); assert.equal(manifest.file, 'Slot.bmp')
  assert.equal(sha(readFileSync(resolve(root, 'web', mode + '.zip'))), manifest.zipSha256)
  const slot = readFileSync(resolve(game, mode, 'Slot.bmp'))
  assert.equal(sha(slot), manifest.fileSha256); assert.equal(slot.length, manifest.bytes)
  assert.equal(slot.readUInt32LE(2), 62)
}

if (process.argv[2] === 'prepare') {
  for (const [name, src] of Object.entries(kagFiles)) writeFileSync(resolve(game, name), enc(src))
  writeFileSync(resolve(game, 'controls.tjs'), enc(kagControlSource))
  writeFileSync(resolve(game, 'startup.tjs'), enc([
    'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;',
    'var log=[];function record(s){log.add(s);log.save("native-events.txt");}record("start");',
    'System.exceptionHandler=function(e){record("fatal|"+e.message);System.exit();return true;};',
    'try{Scripts.execStorage("controls.tjs");var win=new Window(),pic=new Layer(win,null);win.add(pic);',
    ...modes.map((mode) => `pic.loadImages("${mode}/Slot.bmp");record("${mode}|"+pic.getMainPixel(0,0)+","+pic.getMainPixel(1,0)+"|"+kagResumePoint(Scripts.evalStorage("${mode}/Slot.bmp","o62")));`),
    'record("done");}catch(e){record("fatal|"+e.message);}System.exit();',
  ].join('\n')))
} else if (process.argv[2] === 'compare') {
  const sdk = JSON.parse(readFileSync(resolve(root, 'sdk-process.json'), 'utf8').replace(/^\ufeff/, ''))
  const raw = readFileSync(resolve(game, 'native-events.txt'))
  const rows = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const wanted = ['start', ...modes.map((mode) => mode + '|' + expected), 'done']
  const complete = sdk.state === 'observed' && sdk.commit === process.env.GITHUB_SHA && sdk.exitCode === 0 && sdk.timedOut === false
    && JSON.stringify(rows) === JSON.stringify(wanted)
  writeFileSync(resolve(root, 'comparison.json'), JSON.stringify({ commit: process.env.GITHUB_SHA, complete, rows, wanted, journalSha256: sha(raw) }, null, 2))
  assert(complete, 'Stock KRKR2 did not restore both Web-written thumbnails and macro return positions')
} else throw new Error('Expected prepare or compare')
