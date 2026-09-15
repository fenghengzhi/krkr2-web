import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

class Clock {
  time = 0
  tasks = new Set<{ at: number; run(): void }>()
  now = () => this.time
  schedule = (run: () => void, delay: number) => {
    const task = { run, at: this.time + delay }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  advance(ms: number) {
    this.time += ms
    for (const task of [...this.tasks])
      if (task.at <= this.time && this.tasks.delete(task)) task.run()
  }
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// The three Timer steps mirror native-reference/modal-hidden-timer.tjs, observed
// on the pinned original SDK in hosted run 34993108821. The third step supplies
// an explicit answer; a hidden close must not stand in for that answer.
const script = String.raw`
System.exitOnWindowClose=false;
function mark(text){Debug.message(text);}
class HiddenModalWindow extends Window {
  var queries=0;
  function HiddenModalWindow(){super.Window();caption="hidden-close-modal";setInnerSize(64,48);}
  function onCloseQuery(canClose){
    var emit=global.mark incontextof global;
    queries++;emit("query:"+queries);
    super.onCloseQuery(true);
    emit("query-return");
  }
}
var nativeMain=new Window();nativeMain.caption="hidden-close-owner";nativeMain.visible=true;
// Exclude an unrelated focus-restoration event from the final receipt assertion.
// The owner's focus eligibility does not change the hidden Window's close input.
nativeMain.focusable=false;
var nativeModal=new HiddenModalWindow();
var nativeTicks=0;
function nativeTick(event){
  nativeTicks++;
  mark("tick:"+nativeTicks+":visible="+int(nativeModal.visible)+":queries="+nativeModal.queries);
  if(nativeTicks==1){
    nativeModal.visible=false;
    mark("hide-after:"+int(nativeModal.visible));
  }else if(nativeTicks==2){
    mark("close-before");
    nativeModal.close();
    mark("close-after:queries="+nativeModal.queries);
  }else{
    nativeTimer.enabled=false;
    mark("explicit-answer-before");
    nativeModal.onCloseQuery(true);
    mark("explicit-answer-after");
  }
}
var nativeTimer=new Timer(global,"nativeTick");nativeTimer.enabled=false;nativeTimer.interval=150;
function runHidden(){
  mark("modal-before");nativeTimer.enabled=true;
  var result=nativeModal.showModal();
  nativeTimer.enabled=false;
  mark("modal-after:"+int(result===void)+":"+int(isvalid nativeModal)+":"+int(nativeModal.visible));
  return "complete";
}
`

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  nodeTest(
    `${mode}: a hidden modal close drops its query while Timers continue until an explicit answer`,
    { timeout: 60000 },
    async () => {
      const clock = new Clock()
      const { session, logs } = await headless(
        {
          'startup.tjs': binary
            ? 'Scripts.compileStorage("hidden-close.tjs","savedata/hidden-close.cjs",false,true,false);Scripts.execStorage("savedata/hidden-close.cjs");'
            : 'Scripts.execStorage("hidden-close.tjs");',
          'hidden-close.tjs': script,
        },
        { now: clock.now, schedule: clock.schedule },
      )
      type Result =
        | { ok: true; value: string; ownership: ReturnType<typeof session.inspectOwnership> }
        | { ok: false; error: unknown }
      let settled = false
      let opening: Promise<Result> | undefined
      const untilWaiting = async (marker: string) => {
        const deadline = performance.now() + 10000
        for (;;) {
          assert.equal(settled, false, `Modal returned before ${marker}: ${logs.join('|')}`)
          const ownership = session.inspectOwnership()
          if (
            logs.includes(marker) &&
            ownership.modalScopes === 1 &&
            ownership.modalWaits === 1 &&
            ownership.eventReceipts === 0 &&
            ownership.eventCheckpoints === 0
          )
            return
          assert.ok(
            performance.now() < deadline,
            `No waiting modal after ${marker}: ${JSON.stringify(ownership)}; ${logs.join('|')}`,
          )
          await new Promise<void>((resolve) => setTimeout(resolve, 1))
        }
      }
      try {
        await bounded(session.start(), 'start hidden close fixture')
        await bounded(session.idle(), 'complete startup before opening the modal')
        opening = session.evaluate('runHidden()').then<Result, Result>(
          (value) => {
            settled = true
            // Capture in the first completion reaction. An extra idle or polling
            // for zero here could hide unfinished modal/event ownership.
            return { ok: true, value, ownership: session.inspectOwnership() }
          },
          (error: unknown) => {
            settled = true
            return { ok: false, error }
          },
        )
        await untilWaiting('modal-before')

        clock.advance(150)
        await untilWaiting('hide-after:0')
        assert.ok(logs.includes('tick:1:visible=1:queries=0'))
        assert.equal(logs.filter((line) => line.startsWith('query:')).length, 0)
        assert.equal(settled, false)

        clock.advance(150)
        await untilWaiting('close-after:queries=0')
        assert.ok(logs.includes('tick:2:visible=0:queries=0'))
        assert.equal(logs.filter((line) => line.startsWith('query:')).length, 0)
        assert.equal(logs.includes('explicit-answer-before'), false)
        assert.equal(
          logs.some((line) => line.startsWith('modal-after:')),
          false,
        )
        assert.equal(settled, false)

        clock.advance(150)
        const result = await bounded(opening, 'explicit answer completes hidden modal')
        if (!result.ok) throw result.error
        assert.equal(result.value, 'complete')
        assert.equal(result.ownership.modalScopes, 0)
        assert.equal(result.ownership.modalWaits, 0)
        assert.equal(result.ownership.eventReceipts, 0)
        assert.equal(result.ownership.eventCheckpoints, 0)
        assert.ok(logs.includes('tick:3:visible=0:queries=0'))
        assert.equal(logs.filter((line) => line.startsWith('query:')).length, 1)
        assert.ok(logs.indexOf('explicit-answer-before') < logs.indexOf('query:1'))
        assert.ok(logs.indexOf('query-return') < logs.indexOf('explicit-answer-after'))
        assert.ok(logs.indexOf('explicit-answer-after') < logs.indexOf('modal-after:1:1:0'))
        assert.ok(
          session.snapshot().windows?.every((window) => !window.view.blocked),
          'modal completion must release parent input blocking',
        )
      } finally {
        await bounded(session.stop(), 'stop hidden modal fixture')
        if (opening) await bounded(opening, 'settle stopped hidden modal')
        assert.ok(
          Object.values(session.inspectOwnership()).every((count) => count === 0),
          JSON.stringify(session.inspectOwnership()),
        )
        assert.equal(session.snapshot().handles, 0)
        assert.equal(clock.tasks.size, 0)
      }
    },
  )
}
