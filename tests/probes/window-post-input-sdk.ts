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
var pointerRows=[];
function recordPointer(stage){
 pointerRows.add(stage+"|tick="+System.getTickCount()+"|cursor="+postedRoot.cursorX+","+postedRoot.cursorY+
  "|inner="+postedA.innerWidth+","+postedA.innerHeight+"|primary="+postedRoot.width+","+postedRoot.height+
  "|position="+postedA.left+","+postedA.top+"|visible="+int(postedA.visible)+
  "|mouseKey="+int(postedA.useMouseKey)+"|disabled="+int(System.eventDisabled));
 pointerRows.save("native-pointer.txt");
}
record("start");
System.exceptionHandler=function(e){global.record("fatal|"+e.message);global.System.exit();return true;};
Scripts.execStorage("posted-input.tjs");postedHolders();
${Object.keys(postedInputErrors).map((id) => `record("error-${id}|"+postedInvalid(${id}));`).join('\n')}
record("ordinary-sync|"+postedOrdinary());
var postedPhase=0,postedTimer=new Timer(global,"postedObserve");
function postedObserve(){
 if(postedPhase==0){
  record("ordinary|"+postedTrace.join("|"));
  postedB.visible=false;postedA.bringToFront();recordPointer("before-set");postedRoot.setCursorPos(20,10);
  recordPointer("after-set");postedMouse();record("mouse-sync|"+postedTrace.join("|"));
  recordPointer("after-post");postedPhase=1;
 }else if(postedPhase==1){
  record("mouse|"+postedTrace.join("|"));recordPointer("observe-mouse");
  // A separate ordinary key from the same Timer and still-visible Window
  // distinguishes event delivery from the mouse-key cursor-in-client gate.
  // It runs after the original mouse observation, never retries that input.
  postedA.useMouseKey=false;postedTrace.clear();
  postedA.postInputEvent("onKeyDown",%[key:67,shift:0]);postedTrace.add("returned");postedPhase=2;
 }else if(postedPhase==2){
  record("timer-ordinary|"+postedTrace.join("|"));
  // Locale-dependent native CP_ACP is recorded, never compared to Web CP932.
  postedA.useMouseKey=false;postedTrace.clear();
  postedA.postInputEvent("onKeyPress",%[key:0x82]);postedA.postInputEvent("onKeyPress",%[key:0xa0]);postedPhase=3;
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
    'timer-ordinary': 'returned|A:D:67:0',
  }
if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  writeFileSync(resolve(game, 'posted-input.tjs'), program)
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, programSha256: hash(program), startupSha256: hash(startup), expected,
    scope: 'Original Window.postInputEvent. Only owned Window cursor positioning; no injected OS keyboard. High bytes remain native ACP observations. A separate four-row pointer journal and one subsequent Timer ordinary-key control localize the unchanged strict mouse expectation; no mouse retry or deadline increase.' })
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
  const pointerRaw = existsSync(resolve(game, 'native-pointer.txt')) ? readFileSync(resolve(game, 'native-pointer.txt')) : Buffer.alloc(0),
    pointerLines = decode(pointerRaw).replace(/^\ufeff/, '').trimEnd().split(/\r?\n/).filter(Boolean),
    pointerComplete = pointerLines.length === 4 && ['before-set', 'after-set', 'after-post', 'observe-mouse']
      .every((stage, i) => pointerLines[i]!.startsWith(stage + '|'))
  const raw = existsSync(resolve(game, 'native-events.txt')) ? readFileSync(resolve(game, 'native-events.txt')) : Buffer.alloc(0),
    lines = decode(raw).replace(/^\ufeff/, '').trimEnd().split(/\r?\n/),
    results = Object.entries(expected).map(([id, expected]) => {
      const observed = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
      return { id, expected, observed, state: !observed.length ? 'unreported'
        : observed.length === 1 && observed[0] === expected ? 'matched' : 'mismatched' }
    }), acp = lines.filter((line) => line.startsWith('native-acp|')),
    complete = processResult.state === 'observed' && processResult.commit === inputs.commit && processResult.exitCode === 0 &&
      lines.filter((line) => line === 'done').length === 1 && acp.length === 1 && pointerComplete && results.every((row) => row.state === 'matched')
  save('comparison.json', { commit: inputs.commit, complete, process: processResult, processError, results,
    nativeAcpObservation: acp, nativeAcpComparedToWeb: false, lines, rawSha256: hash(raw),
    pointerObservations: pointerLines, pointerComplete, pointerSha256: hash(pointerRaw),
    mouseScope: 'Final mouse event coordinates/order remain strict. Cursor getter observations do not prove Win32 HWND hit testing or successful SetCursorPos; they localize a missing delivery without accepting it.' })
  assert(complete, 'Original posted-input comparison incomplete or different; raw observations retained')
}
