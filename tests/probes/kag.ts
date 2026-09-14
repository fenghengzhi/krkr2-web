// Local, opt-in verification using user-supplied KAG fixtures. No game assets
// are bundled with the application or copied into its distribution.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { headless } from '../helpers/headless.ts'
import { BlobSource, inflate } from '../../src/backends/files/blob-source.ts'
import { readXp3 } from '../../src/formats/xp3/archive.ts'

const filename = process.argv[2]
if (!filename)
  throw new Error('Usage: node --import tsx tests/probes/kag.ts fixture.xp3 [conductor]')
const conductor = process.argv[3] === 'conductor'
const bytes = new Uint8Array(await readFile(filename))
const resources = await readXp3(new BlobSource(new Blob([bytes])), inflate)
const harness = String.raw`
function dm(message) { Debug.message(message); }
Scripts.execStorage("system/Conductor.tjs");
var result="", stopped=false;
class TestConductor extends BaseConductor {
  function TestConductor() { super.BaseConductor(); debugLevel=tkdlNone; }
  function onTag(tag) {
    if(tag.tagname=="ch") result+=tag.text;
    if(tag.tagname=="wait") return 10;
    if(tag.tagname=="yield") return -4;
    return 0;
  }
  function onStop() { stopped=true; Debug.message("Conductor result="+result); }
}
var conductor=new TestConductor();
conductor.loadScenario("verification.ks");
conductor.startProcess();
`
const { session, logs } = await headless(
  conductor
    ? {
        'probe.tjs': harness,
        'verification.ks':
          '*start\n[macro name=say][emb exp="mp.text"][endmacro]\\\n[say text=A][wait][say text=B][yield][call target=*sub]D[jump target=*end]\n*sub\nC[return]\n*end\n',
      }
    : {},
)
session.mount(resources)
let failure: unknown, result: string | undefined
let snapshot: ReturnType<typeof session.snapshot> | undefined
try {
  await session.start(conductor ? 'probe.tjs' : 'startup.tjs')
  if (conductor) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await session.idle()
      if ((await session.evaluate('stopped')) === '1') break
    }
    result = await session.evaluate('result')
    if (result !== 'ABCD' || (await session.evaluate('stopped')) !== '1')
      throw new Error('Conductor did not finish expected scenario')
  } else {
    // Startup schedules Conductor work. A synchronous return is not proof that
    // the first scenario can run; observe the queued callbacks before reporting.
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await session.idle()
      if (session.snapshot().state === 'failed')
        throw new Error(logs.at(-1) ?? 'Asynchronous KAG startup failed')
    }
  }
} catch (error) {
  failure =
    error instanceof Error ? { ...error, name: error.name, message: error.message } : String(error)
} finally {
  snapshot = session.snapshot()
  await session.stop()
}
const report = {
  fixture: basename(filename),
  mode: conductor ? 'conductor' : 'startup',
  date: new Date().toISOString(),
  passed: !failure,
  result,
  snapshot,
  logs,
  failure,
}
const directory = resolve('out/verification')
await mkdir(directory, { recursive: true })
await writeFile(
  resolve(directory, `${basename(filename, '.xp3')}-${report.mode}.json`),
  JSON.stringify(report, null, 2) + '\n',
)
console.log(JSON.stringify(report, null, 2))
if (failure) process.exitCode = 1
