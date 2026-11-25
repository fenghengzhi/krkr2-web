import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { postedInputErrors, postedInputSource } from '../helpers/window-post-input.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const root = resolve('out/verification/native-eri/window-input'), game = resolve(root, 'game'),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  bytes = (text: string) => Buffer.from('\ufeff' + text, 'utf16le'),
  save = (name: string, value: unknown) => writeFileSync(resolve(root, name), JSON.stringify(value, null, 2) + '\n'),
  decode = (data: Uint8Array) => new TextDecoder(data[0] === 255 && data[1] === 254 ? 'utf-16le' : 'utf-8').decode(data),
  program = bytes(postedInputSource), startup = bytes(`
var rows=[];function record(value){rows.add(value);rows.save("native-events.txt");}
record("start");
System.exceptionHandler=function(e){global.record("fatal|"+e.message);global.System.exit();return true;};
Scripts.execStorage("posted-input.tjs");postedHolders();
${Object.keys(postedInputErrors).map((id) => `record("error-${id}|"+postedInvalid(${id}));`).join('\n')}
record("ordinary-sync|"+postedOrdinary());
var postedPhase=0,postedTimer=new Timer(global,"postedObserve");
function postedObserve(){
 if(postedPhase==0){
  record("ordinary|"+postedTrace.join("|"));
  postedB.visible=false;postedA.bringToFront();postedRoot.setCursorPos(20,10);
  postedMouse();record("mouse-sync|"+postedTrace.join("|"));postedPhase=1;
 }else if(postedPhase==1){
  record("mouse|"+postedTrace.join("|"));
  // Locale-dependent native CP_ACP is recorded, never compared to Web CP932.
  postedA.useMouseKey=false;postedTrace.clear();
  postedA.postInputEvent("onKeyPress",%[key:0x82]);postedA.postInputEvent("onKeyPress",%[key:0xa0]);postedPhase=2;
 }else{
  record("native-acp|"+postedTrace.join("|"));postedTimer.enabled=false;
  invalidate postedB;invalidate postedA;record("done");System.exit();
 }
}
postedTimer.interval=100;postedTimer.enabled=true;
`), expected = {
    ...Object.fromEntries(Object.entries(postedInputErrors).map(([id, value]) => ['error-' + id, value])),
    'ordinary-sync': 'key,shift,key,shift',
    ordinary: 'returned|A:D:65:-1|A:U:65:127|A:T:A|B:D:66:0',
    'mouse-sync': 'returned',
    mouse: 'returned|A:down:20,10:0:0|A:click:20,10|button:10,5|A:up:20,10:0:0',
  }
if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  writeFileSync(resolve(game, 'posted-input.tjs'), program)
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, programSha256: hash(program), startupSha256: hash(startup), expected,
    scope: 'Original Window.postInputEvent. Only owned Window cursor positioning; no injected OS keyboard. High bytes remain native ACP observations.' })
} else {
  assert.equal(process.argv[2], 'compare')
  const inputs = JSON.parse(readFileSync(resolve(root, 'inputs.json'), 'utf8'))
  assert.equal(inputs.commit, process.env.GITHUB_SHA)
  assert.equal(inputs.programSha256, hash(program)); assert.equal(inputs.startupSha256, hash(startup))
  assert.deepEqual(readFileSync(resolve(game, 'posted-input.tjs')), program)
  assert.deepEqual(readFileSync(resolve(game, 'startup.tjs')), startup)
  let processResult: { state?: string; commit?: string; exitCode?: number } = {}, processError: string | undefined
  try { processResult = JSON.parse(decode(readFileSync(resolve(root, 'sdk-process.json')))) }
  catch (error) { processError = String(error) }
  const raw = existsSync(resolve(game, 'native-events.txt')) ? readFileSync(resolve(game, 'native-events.txt')) : Buffer.alloc(0),
    lines = decode(raw).replace(/^\ufeff/, '').trimEnd().split(/\r?\n/),
    results = Object.entries(expected).map(([id, expected]) => {
      const observed = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
      return { id, expected, observed, state: !observed.length ? 'unreported'
        : observed.length === 1 && observed[0] === expected ? 'matched' : 'mismatched' }
    }), acp = lines.filter((line) => line.startsWith('native-acp|')),
    complete = processResult.state === 'observed' && processResult.commit === inputs.commit && processResult.exitCode === 0 &&
      lines.filter((line) => line === 'done').length === 1 && acp.length === 1 && results.every((row) => row.state === 'matched')
  save('comparison.json', { commit: inputs.commit, complete, process: processResult, processError, results,
    nativeAcpObservation: acp, nativeAcpComparedToWeb: false, lines, rawSha256: hash(raw) })
  assert(complete, 'Original posted-input comparison incomplete or different; raw observations retained')
}
