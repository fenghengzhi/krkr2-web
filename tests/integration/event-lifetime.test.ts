import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'

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

// Definitions live across the baseline so class/function ownership is not
// confused with the event instances that each test creates and releases.
async function fixture(
  binary: boolean,
  definitions: string,
  overrides: Partial<SessionDependencies> = {},
) {
  const clock = new Clock()
  const harness = await headless(
    {
      'startup.tjs': '',
      'lifetime.tjs': `
var calls=0,finalized=0;
function lifetimeAction(){calls++;}
try {throw new Exception("warm lifetime exception");} catch(e) {}
${definitions}
`,
      'hold.tjs': 'hold-lifetime-callback',
    },
    { now: clock.now, schedule: clock.schedule, ...overrides },
  )
  const { session } = harness
  const execute = (code: string) => session.evaluate(`Scripts.exec(${JSON.stringify(code)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("lifetime.tjs","savedata/lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("lifetime.tjs")')
    assert.equal(await session.evaluate('6*7'), '42')
    const baseline = session.inspectOwnership(),
      handles = session.snapshot().handles
    const restored = async () => {
      await session.idle()
      assert.equal(await session.evaluate('6*7'), '42')
      assert.deepEqual(session.inspectOwnership(), baseline)
      assert.equal(session.snapshot().handles, handles)
      assert.equal(clock.tasks.size, 0)
      assert.equal(session.snapshot().state, 'running')
    }
    return { ...harness, clock, execute, baseline, handles, restored }
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  for (const kind of ['Timer', 'AsyncTrigger'] as const) {
    test(`${mode}: inactive ${kind} releases its registration with the last script reference`, async () => {
      const { session, execute, restored, baseline } = await fixture(
        binary,
        `
class EventOwner extends ${kind} {
  function EventOwner(){super.${kind}(lifetimeAction,"");}
  function finalize(){finalized++;super.finalize();}
}
function createOwner(){global.owner=new EventOwner();}
`,
      )
      try {
        await execute('createOwner();')
        assert.equal(session.inspectOwnership().eventSources, baseline.eventSources + 1)
        assert.equal(session.inspectOwnership().weakOwners, baseline.weakOwners + 1)
        await execute('delete global.owner;')
        assert.equal(await session.evaluate('finalized+","+calls'), '1,0')
        await restored()
      } finally {
        await session.stop()
      }
    })

    test(`${mode}: ${kind} subclass finalization needs no super call to remove host ownership`, async () => {
      const { session, clock, execute, restored, baseline } = await fixture(
        binary,
        `
class EventOwner extends ${kind} {
  function EventOwner(){super.${kind}(lifetimeAction,"");${kind === 'Timer' ? 'interval=10;enabled=true;' : ''}}
  function finalize(){finalized++;}
}
function createOwner(){global.owner=new EventOwner();}
`,
      )
      try {
        await execute('createOwner();')
        assert.equal(session.inspectOwnership().eventSources, baseline.eventSources + 1)
        assert.equal(clock.tasks.size, kind === 'Timer' ? 1 : 0)
        await execute('delete global.owner;')
        assert.equal(await session.evaluate('finalized'), '1')
        assert.equal(clock.tasks.size, 0)
        clock.advance(100)
        await session.idle()
        assert.equal(await session.evaluate('calls'), '0')
        await restored()
      } finally {
        await session.stop()
      }
    })

    test(`${mode}: failed explicit ${kind} finalization preserves ownership until a successful retry`, async () => {
      const { session, clock, execute, restored, baseline } = await fixture(
        binary,
        `
var caught="";
class EventOwner extends ${kind} {
  function EventOwner(){super.${kind}(lifetimeAction,"");${kind === 'Timer' ? 'interval=10;enabled=true;' : ''}}
  function finalize(){super.finalize();if(++finalized==1)throw new Exception("retry-finalize");}
}
function createOwner(){global.owner=new EventOwner();}
`,
      )
      try {
        await execute('createOwner();try{invalidate owner;}catch(e){caught=e.message;}')
        assert.match(await session.evaluate('caught'), /retry-finalize/)
        assert.equal(await session.evaluate('(isvalid owner)+","+finalized'), '1,1')
        assert.equal(session.inspectOwnership().eventSources, baseline.eventSources + 1)
        if (kind === 'Timer') clock.advance(10)
        else await execute('owner.trigger();')
        await session.idle()
        assert.equal(await session.evaluate('calls'), '1')
        await execute('invalidate owner;')
        assert.equal(await session.evaluate('(isvalid owner)+","+finalized'), '0,2')
        assert.equal(session.inspectOwnership().eventSources, baseline.eventSources)
        assert.equal(clock.tasks.size, 0)
        await execute('delete global.owner;')
        clock.advance(100)
        await session.idle()
        assert.equal(await session.evaluate('calls'), '1')
        await restored()
      } finally {
        await session.stop()
      }
    })

    test(`${mode}: calling ${kind}.finalize directly preserves the live event source`, async () => {
      const { session, clock, execute, restored, baseline } = await fixture(
        binary,
        `
function createOwner(){
  global.owner=new ${kind}(lifetimeAction,"");
  ${kind === 'Timer' ? 'owner.interval=10;owner.enabled=true;' : ''}
}
`,
      )
      try {
        await execute('createOwner();owner.finalize();owner.finalize();')
        assert.equal(await session.evaluate('isvalid owner'), '1')
        assert.equal(session.inspectOwnership().eventSources, baseline.eventSources + 1)
        assert.equal(session.inspectOwnership().weakOwners, baseline.weakOwners + 1)
        assert.equal(clock.tasks.size, kind === 'Timer' ? 1 : 0)
        if (kind === 'Timer') clock.advance(10)
        else await execute('owner.trigger();')
        await session.idle()
        assert.equal(await session.evaluate('calls'), '1')
        await execute('invalidate owner;')
        assert.equal(await session.evaluate('isvalid owner'), '0')
        assert.equal(session.inspectOwnership().eventSources, baseline.eventSources)
        assert.equal(session.inspectOwnership().weakOwners, baseline.weakOwners)
        assert.equal(clock.tasks.size, 0)
        await execute('delete global.owner;')
        clock.advance(100)
        await session.idle()
        assert.equal(await session.evaluate('calls'), '1')
        await restored()
      } finally {
        await session.stop()
      }
    })

    test(`${mode}: failed ${kind} construction removes the registration and preserves the constructor error`, async () => {
      const { session, clock, execute, restored } = await fixture(
        binary,
        `
var caught="";
class EventOwner extends ${kind} {
  function EventOwner(){
    super.${kind}(lifetimeAction,"");
    ${kind === 'Timer' ? 'interval=10;enabled=true;' : ''}
    throw new Exception("primary-constructor");
  }
  function finalize(){finalized++;throw new Exception("secondary-finalizer");}
}
function createOwner(){new EventOwner();}
`,
      )
      try {
        await execute('try{createOwner();}catch(e){caught=e.message;}')
        assert.match(await session.evaluate('caught'), /primary-constructor/)
        assert(!(await session.evaluate('caught')).includes('secondary-finalizer'))
        assert.equal(await session.evaluate('finalized'), '1')
        assert.equal(clock.tasks.size, 0)
        clock.advance(100)
        await session.idle()
        assert.equal(await session.evaluate('calls'), '0')
        await restored()
      } finally {
        await session.stop()
      }
    })

    test(`${mode}: ${kind} retains the user action object until the event owner is released`, async () => {
      const { session, logs, clock, execute, restored, baseline, handles } = await fixture(
        binary,
        `
var actionFinalized=0;
// Debug's variadic arguments initialize the shared native Array class.
// Warm logging before fixture() records the object baseline.
Debug.message("warm-action-log");
class ActionOwner {
  function action(){calls++;Debug.message("action-fired");delete global.owner;}
  function finalize(){actionFinalized++;Debug.message("action-finalized");}
}
class EventOwner extends ${kind} {
  function EventOwner(action){super.${kind}(action);${kind === 'Timer' ? 'interval=10;enabled=true;' : ''}}
  function finalize(){finalized++;Debug.message("event-finalized");}
}
function createOwner(){var action=new ActionOwner();global.owner=new EventOwner(action);}
`,
      )
      try {
        assert.deepEqual(logs, ['warm-action-log'])
        logs.length = 0
        await execute('createOwner();')
        assert.equal(await session.evaluate('actionFinalized'), '0')
        if (kind === 'Timer') clock.advance(10)
        else await execute('owner.trigger();')
        await session.idle()
        // No console evaluation here: another native entry could hide a lease
        // stranded after the event pump returns, allowing a timer to rearm it.
        assert.deepEqual(logs, ['action-fired', 'event-finalized', 'action-finalized'])
        assert.equal(session.inspectOwnership().pendingHandles, 0)
        assert.deepEqual(session.inspectOwnership(), baseline)
        assert.equal(session.snapshot().handles, handles)
        assert.equal(clock.tasks.size, 0)
        clock.advance(100)
        await session.idle()
        assert.deepEqual(logs, ['action-fired', 'event-finalized', 'action-finalized'])
        assert.deepEqual(session.inspectOwnership(), baseline)
        assert.equal(clock.tasks.size, 0)
        assert.equal(await session.evaluate('calls+","+finalized+","+actionFinalized'), '1,1,1')
        await restored()
      } finally {
        await session.stop()
      }
    })

    test(`${mode}: explicitly invalidating ${kind} breaks a user-created action cycle`, async () => {
      const { session, execute, restored } = await fixture(
        binary,
        `
var actionFinalized=0;
class ActionOwner {
  var event;
  function action(){calls++;}
  function finalize(){actionFinalized++;}
}
class EventOwner extends ${kind} {
  function EventOwner(action){super.${kind}(action);}
  function finalize(){finalized++;}
}
function createOwner(){
  var action=new ActionOwner();
  global.owner=new EventOwner(action);
  action.event=owner;
}
`,
      )
      try {
        await execute('createOwner();')
        assert.equal(await session.evaluate('finalized+","+actionFinalized'), '0,0')
        await execute('invalidate owner;delete global.owner;')
        assert.equal(await session.evaluate('finalized+","+actionFinalized'), '1,1')
        await restored()
      } finally {
        await session.stop()
      }
    })
  }

  test(`${mode}: an enabled timer can die before its first tick`, async () => {
    const { session, clock, execute, restored } = await fixture(
      binary,
      `
class EventOwner extends Timer {
  function EventOwner(){super.Timer(lifetimeAction,"");interval=10;enabled=true;}
  function finalize(){finalized++;super.finalize();}
}
function createOwner(){global.owner=new EventOwner();}
`,
    )
    try {
      await execute('createOwner();')
      assert.equal(clock.tasks.size, 1)
      clock.advance(9)
      await session.idle()
      await execute('delete global.owner;')
      assert.equal(await session.evaluate('calls+","+finalized'), '0,1')
      assert.equal(clock.tasks.size, 0)
      clock.advance(100)
      await session.idle()
      assert.equal(await session.evaluate('calls'), '0')
      await restored()
    } finally {
      await session.stop()
    }
  })

  for (const cached of [false, true])
    test(`${mode}: ${cached ? 'cached' : 'uncached'} queued triggers own the instance until their last delivery`, async () => {
      const { session, execute, restored, baseline } = await fixture(
        binary,
        `
class EventOwner extends AsyncTrigger {
  function EventOwner(){super.AsyncTrigger(lifetimeAction,"");cached=${cached};}
  function finalize(){finalized++;}
}
function createOwner(){global.owner=new EventOwner();}
`,
      )
      try {
        await execute(
          'System.eventDisabled=true;createOwner();owner.trigger();owner.trigger();owner.trigger();delete global.owner;',
        )
        assert.equal(await session.evaluate('calls+","+finalized'), '0,0')
        assert.equal(session.inspectOwnership().eventSources, baseline.eventSources + 1)
        await execute('System.eventDisabled=false;')
        await session.idle()
        assert.equal(await session.evaluate('calls+","+finalized'), `${cached ? 1 : 3},1`)
        await restored()
      } finally {
        await session.stop()
      }
    })

  test(`${mode}: cancelling queued triggers drops all event leases`, async () => {
    const { session, execute, restored } = await fixture(
      binary,
      `
class EventOwner extends AsyncTrigger {
  function EventOwner(){super.AsyncTrigger(lifetimeAction,"");cached=false;}
  function finalize(){finalized++;}
}
function createOwner(){global.owner=new EventOwner();}
`,
    )
    try {
      await execute(
        'System.eventDisabled=true;createOwner();owner.trigger();owner.trigger();owner.trigger();owner.cancel();delete global.owner;',
      )
      assert.equal(await session.evaluate('calls+","+finalized'), '0,1')
      await execute('System.eventDisabled=false;')
      await session.idle()
      assert.equal(await session.evaluate('calls'), '0')
      await restored()
    } finally {
      await session.stop()
    }
  })

  test(`${mode}: disabled event delivery drops timer ticks without retaining their owner`, async () => {
    const { session, clock, execute, restored } = await fixture(
      binary,
      `
class EventOwner extends Timer {
  function EventOwner(){super.Timer(lifetimeAction,"");interval=10;enabled=true;}
  function finalize(){finalized++;}
}
function createOwner(){global.owner=new EventOwner();}
`,
    )
    try {
      await execute('System.eventDisabled=true;createOwner();')
      clock.advance(100)
      await session.idle()
      assert.equal(await session.evaluate('calls'), '0')
      await execute('delete global.owner;')
      assert.equal(await session.evaluate('finalized'), '1')
      await execute('System.eventDisabled=false;')
      clock.advance(100)
      await session.idle()
      assert.equal(await session.evaluate('calls'), '0')
      await restored()
    } finally {
      await session.stop()
    }
  })

  test(`${mode}: queued trigger delivery resolves a replaced onFire member on its owner`, async () => {
    const { session, execute, restored } = await fixture(
      binary,
      `
var receiver="";
class EventOwner extends AsyncTrigger {
  var marker="owner";
  function EventOwner(){super.AsyncTrigger(lifetimeAction,"");}
  function finalize(){finalized++;}
}
function replacement(){receiver=this.marker;calls+=10;}
function createOwner(){global.owner=new EventOwner();}
`,
    )
    try {
      await execute(
        'System.eventDisabled=true;createOwner();owner.trigger();owner.onFire=replacement incontextof owner;delete global.owner;',
      )
      assert.equal(await session.evaluate('calls+","+finalized'), '0,0')
      await execute('System.eventDisabled=false;')
      await session.idle()
      assert.equal(await session.evaluate('receiver+","+calls+","+finalized'), 'owner,10,1')
      await restored()
    } finally {
      await session.stop()
    }
  })

  test(`${mode}: a trigger can invalidate itself during delivery and cancel its remaining callbacks`, async () => {
    const { session, execute, restored } = await fixture(
      binary,
      `
var completed=0;
class EventOwner extends AsyncTrigger {
  function EventOwner(){super.AsyncTrigger(lifetimeAction,"");cached=false;}
  function onFire(){calls++;invalidate this;global.completed++;}
  function finalize(){finalized++;}
}
function createOwner(){global.owner=new EventOwner();}
`,
    )
    try {
      await execute(
        'System.eventDisabled=true;createOwner();owner.trigger();owner.trigger();owner.trigger();delete global.owner;',
      )
      await execute('System.eventDisabled=false;')
      await session.idle()
      assert.equal(await session.evaluate('calls+","+completed+","+finalized'), '1,1,1')
      await restored()
    } finally {
      await session.stop()
    }
  })

  for (const cancel of [false, true])
    test(`${mode}: ${cancel ? 'stopping' : 'pausing and resuming'} a suspended trigger releases its final event lease`, async () => {
      let entered!: () => void, finish!: (source: string) => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const held = new Promise<string>((resolve) => {
        finish = resolve
      })
      const { session, clock, execute, restored, baseline } = await fixture(
        binary,
        `
var completed=0;
class EventOwner extends AsyncTrigger {
  function EventOwner(){super.AsyncTrigger(lifetimeAction,"");}
  function onFire(){calls++;Scripts.evalStorage("hold.tjs");global.completed++;}
  function finalize(){finalized++;}
}
function createOwner(){global.owner=new EventOwner();}
`,
        {
          async decodeScript(bytes, mode, encoding) {
            // Keep compiled storage as bytes; only the marker's decoded text
            // is replaced with a controllable asynchronous host completion.
            const source = await readScript(bytes, mode, encoding)
            if (source === 'hold-lifetime-callback') {
              entered()
              return held
            }
            return source
          },
        },
      )
      let delivery: Promise<string> | undefined
      try {
        await execute(
          'System.eventDisabled=true;createOwner();owner.trigger();delete global.owner;',
        )
        delivery = execute('System.eventDisabled=false;')
        let settled = false
        // Observe rejections immediately while stop drains the suspended call.
        const outcome = delivery.then(
          () => {
            settled = true
            return undefined
          },
          (error: unknown) => {
            settled = true
            return error
          },
        )
        await ready
        assert.equal(session.inspectOwnership().eventSources, baseline.eventSources + 1)
        if (cancel) {
          const stopping = session.stop()
          finish('0')
          await stopping
          const error = await outcome
          assert(error instanceof Error && error.name === 'AbortError')
          assert.equal(session.snapshot().state, 'stopped')
          assert.equal(session.snapshot().handles, 0)
          assert.deepEqual(session.inspectOwnership(), {
            eventSources: 0,
            soundSources: 0,
            pendingSoundCloses: 0,
            dependents: 0,
            pendingInvalidations: 0,
            weakOwners: 0,
            scriptObjects: 0,
            pendingHandles: 0,
          })
          assert.equal(clock.tasks.size, 0)
        } else {
          session.pause()
          assert.equal(session.snapshot().state, 'paused')
          finish('0')
          await new Promise((resolve) => setTimeout(resolve, 20))
          assert.equal(settled, false)
          assert.equal(session.inspectOwnership().eventSources, baseline.eventSources + 1)
          session.resume()
          assert.equal(await outcome, undefined)
          await session.idle()
          assert.equal(await session.evaluate('calls+","+completed+","+finalized'), '1,1,1')
          await restored()
        }
      } finally {
        finish('0')
        await session.stop()
        await delivery?.catch(() => {})
      }
    })
}
