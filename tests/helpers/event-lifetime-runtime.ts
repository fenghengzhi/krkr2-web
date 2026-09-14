import { EngineSession } from '../../src/engine/session.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory } from '../../src/backends/script/tjs-wasm/module.ts'
import { readScript, readText, writeText } from '../../src/backends/files/text-codecs.ts'
import { inflateImage, deflateImage } from '../../src/backends/files/blob-source.ts'

class EventClock {
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
  advance(ms: number): void {
    this.time += ms
    for (const task of [...this.tasks])
      if (task.at <= this.time && this.tasks.delete(task)) task.run()
  }
}

const definitions = `
var calls=0,finalized=0,receiver="";
function lifetimeAction(){global.calls++;}
function lifetimeReplacement(){global.receiver=this.marker;global.calls+=10;}
try{throw new Exception("warm event ownership");}catch(e){}
class LifetimeTimer extends Timer {
  function LifetimeTimer(){super.Timer(lifetimeAction,"");interval=10;enabled=true;}
  function finalize(){global.finalized++;}
}
class LifetimeTrigger extends AsyncTrigger {
  var marker="event-owner";
  function LifetimeTrigger(){super.AsyncTrigger(lifetimeAction,"");}
  function finalize(){global.finalized++;}
}
function createPair(){global.owner=new LifetimeTimer();global.spare=new LifetimeTrigger();}
function createQueued(){global.owner=new LifetimeTrigger();owner.cached=false;}
function createBase(){
  global.owner=new Timer(lifetimeAction,"");owner.interval=10;owner.enabled=true;
  global.spare=new AsyncTrigger(lifetimeAction,"");
}
`

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Browser-safe real EngineSession coverage, also shared by both native WASM backends. */
export async function exerciseEventLifetime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: string,
  binary: boolean,
) {
  const clock = new EventClock(),
    logs: string[] = []
  const session = new EngineSession({
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    inflateImage,
    deflateImage,
    createRuntime: (handler, control, options) =>
      TjsWasmRuntime.create(factory, handler, { control, wasmBinary, variant, ...options }),
    renderer: { present() {}, dispose() {} },
    graphics: {
      decode: async () => {
        throw new Error('Unexpected event lifetime image decoding')
      },
      text: () => {
        throw new Error('Unexpected event lifetime text rendering')
      },
    },
    now: clock.now,
    schedule: clock.schedule,
    decodeScript: readScript,
    readText,
    writeText,
    event: (event) => {
      if (event.type === 'log') logs.push(event.text)
    },
  })
  const state = () => ({
    ...session.inspectOwnership(),
    handles: session.snapshot().handles,
    clockTasks: clock.tasks.size,
  })
  const execute = (code: string) => session.evaluate(`Scripts.exec(${JSON.stringify(code)})`)
  const cases: {
    name: string
    owned: ReturnType<typeof state>
    retained?: ReturnType<typeof state>
    result: string
    after: ReturnType<typeof state>
  }[] = []
  let baseline: ReturnType<typeof state> | undefined
  let active = 'initialize'
  try {
    await session.initialize()
    session.mount(
      Object.entries({ 'startup.tjs': '', 'lifetime.tjs': definitions }).map(([name, source]) => {
        const bytes = new TextEncoder().encode(source)
        return { name, size: bytes.length, read: async () => bytes }
      }),
    )
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("lifetime.tjs","savedata/lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("lifetime.tjs")')
    check((await session.evaluate('6*7')) === '42', 'Warm VM arithmetic failed')
    baseline = state()
    check(
      baseline.clockTasks === 0 && baseline.pendingHandles === 0,
      'Baseline has pending event work',
    )
    const restored = async () => {
      await session.idle()
      check((await session.evaluate('6*7')) === '42', 'Event cleanup poisoned the VM')
      const after = state()
      check(
        JSON.stringify(after) === JSON.stringify(baseline),
        `Event resources did not return to baseline: ${JSON.stringify(after)}`,
      )
      check(session.snapshot().state === 'running', 'Event cleanup stopped the session')
      return after
    }
    const owns = (count: number) => {
      const owned = state()
      check(
        owned.eventSources === baseline!.eventSources + count,
        'Event source registration count is incorrect',
      )
      check(
        owned.weakOwners === baseline!.weakOwners + count,
        'Weak owner registration count is incorrect',
      )
      return owned
    }

    active = 'no-super-finalization'
    await execute('createPair();')
    const pair = owns(2)
    check(pair.clockTasks === 1, 'Enabled timer did not register a clock wake')
    await execute('delete global.owner;delete global.spare;')
    check(clock.tasks.size === 0, 'Implicit finalization left a timer wake registered')
    clock.advance(100)
    await session.idle()
    const pairResult = await session.evaluate('calls+","+finalized')
    check(
      pairResult === '0,2',
      'Timer/Trigger without super.finalize did not finalize once before delivery',
    )
    cases.push({ name: active, owned: pair, result: pairResult, after: await restored() })

    active = 'queued-owner-dynamic-member'
    await execute(
      'calls=0;finalized=0;System.eventDisabled=true;createQueued();owner.trigger();owner.onFire=lifetimeReplacement incontextof owner;delete global.owner;',
    )
    const queued = owns(1)
    check(
      (await session.evaluate('calls+","+finalized')) === '0,0',
      'Queued event lost its sole strong owner before delivery',
    )
    await execute('System.eventDisabled=false;')
    await session.idle()
    const queuedResult = await session.evaluate('receiver+","+calls+","+finalized')
    check(
      queuedResult === 'event-owner,10,1',
      'Queued delivery did not resolve the replaced member and release its owner',
    )
    cases.push({ name: active, owned: queued, result: queuedResult, after: await restored() })

    active = 'direct-base-finalize'
    await execute(
      'calls=0;finalized=0;createBase();owner.finalize();owner.finalize();spare.finalize();spare.finalize();',
    )
    const base = owns(2)
    check(
      (await session.evaluate('(isvalid owner)+","+(isvalid spare)')) === '1,1',
      'Calling base finalize directly invalidated an instance',
    )
    check(base.clockTasks === 1, 'Calling base finalize directly stopped the timer')
    clock.advance(10)
    await session.idle()
    await execute('spare.trigger();')
    await session.idle()
    const retained = owns(2)
    check((await session.evaluate('calls')) === '2', 'Base finalize disabled event delivery')
    await execute('invalidate owner;invalidate spare;')
    const baseResult = await session.evaluate('(isvalid owner)+","+(isvalid spare)+","+calls')
    check(baseResult === '0,0,2', 'Explicit invalidate did not invalidate both base owners')
    check(clock.tasks.size === 0, 'Explicit invalidate retained a timer wake')
    await execute('delete global.owner;delete global.spare;')
    cases.push({ name: active, owned: base, retained, result: baseResult, after: await restored() })

    active = 'queued-trigger-cancellation'
    await execute(
      'calls=0;finalized=0;System.eventDisabled=true;createQueued();owner.trigger();owner.trigger();owner.trigger();',
    )
    const cancelled = owns(1)
    await execute('owner.cancel();delete global.owner;')
    check(
      (await session.evaluate('calls+","+finalized')) === '0,1',
      'Cancelling queued triggers retained an event lease',
    )
    await execute('System.eventDisabled=false;')
    await session.idle()
    const cancelledResult = await session.evaluate('calls+","+finalized')
    check(cancelledResult === '0,1', 'A cancelled trigger was delivered')
    cases.push({ name: active, owned: cancelled, result: cancelledResult, after: await restored() })
    check(logs.length === 0, 'Event lifetime checks logged a runtime error: ' + logs.join('\n'))

    await session.stop()
    const stopped = state()
    check(
      Object.values(stopped).every((value) => value === 0),
      'Session stop retained ownership or scheduled work',
    )
    return { variant, binary, baseline, cases, stopped }
  } catch (error) {
    throw new Error(
      `${String(error)}; event ownership observations=${JSON.stringify({ variant, binary, active, baseline, cases, current: state(), logs })}`,
    )
  } finally {
    await session.stop()
  }
}
