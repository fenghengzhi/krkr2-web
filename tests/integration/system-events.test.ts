import test from 'node:test'
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

test('event disabling drops new timer ticks, defers triggers and drains synchronously when enabled', async () => {
  const clock = new Clock()
  const { session } = await headless(
    {
      'startup.tjs': `
var order="",ticks=0;
var timer=new Timer(function(){ticks++;},"");timer.interval=10;timer.enabled=true;
System.eventDisabled=true;
var normal=new AsyncTrigger(function(){order+="N";},""),exclusive=new AsyncTrigger(function(){order+="E";},""),idle=new AsyncTrigger(function(){order+="I";},"");
exclusive.mode=atmExclusive;idle.mode=atmAtIdle;
normal.trigger();idle.trigger();exclusive.trigger();
`,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    assert.equal(session.snapshot().state, 'running')
    assert.equal(session.snapshot().eventDisabled, true)
    clock.advance(50)
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '0')
    assert.equal(await session.evaluate('order'), '')
    assert.equal(
      await session.evaluate(
        '(function(){order+="B";System.eventDisabled=false;order+="A";return order;})()',
      ),
      'BENIA',
    )
    assert.equal(session.snapshot().eventDisabled, false)
    clock.advance(10)
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '1')
  } finally {
    await session.stop()
  }
})

test('continuous registry deduplicates bound closures and walks live removals/appends with one tick', async () => {
  const clock = new Clock()
  const { session } = await headless(
    {
      'startup.tjs': `
var order="";
function c(tick){order+="C"+tick+",";System.removeContinuousHandler(c);}
function b(tick){order+="B"+tick+",";}
function a(tick){order+="A"+tick+",";System.removeContinuousHandler(b);System.addContinuousHandler(c);System.removeContinuousHandler(a);}
System.addContinuousHandler(a);System.addContinuousHandler(a);System.addContinuousHandler(b);
`,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    clock.advance(7)
    await session.idle()
    assert.equal(await session.evaluate('order'), 'A7,C7,')
    assert.equal(clock.tasks.size, 0)
    await session.evaluate(
      'Scripts.exec(' +
        JSON.stringify(
          'class Item {var name;function Item(n){name=n;}function tick(t){order+=name+t+",";System.removeContinuousHandler(tick);}}var x=new Item("X"),y=new Item("Y");System.addContinuousHandler(x.tick);System.addContinuousHandler(x.tick);System.addContinuousHandler(y.tick);',
        ) +
        ')',
    )
    clock.advance(3)
    await session.idle()
    assert.equal(await session.evaluate('order'), 'A7,C7,X10,Y10,')
    // Native self-removal leaves tombstones until the next empty delivery.
    clock.advance(1)
    await session.idle()
    assert.equal(clock.tasks.size, 0)
  } finally {
    await session.stop()
  }
})

test('a failed continuous callback is removed and disables events while preserving the VM', async () => {
  const clock = new Clock()
  const { session, logs } = await headless(
    {
      'startup.tjs':
        'var value=42;function bad(t){throw new Exception("continuous failure");}System.addContinuousHandler(bad);',
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    clock.advance(1)
    await session.idle()
    assert.equal(session.snapshot().state, 'running')
    assert.equal(session.snapshot().eventDisabled, true)
    assert.equal(await session.evaluate('value'), '42')
    assert(logs.some((line) => line.includes('continuous failure')))
    await session.evaluate('System.eventDisabled=false')
    clock.advance(1)
    await session.idle()
    assert.equal(session.snapshot().eventDisabled, false)
    assert.equal(clock.tasks.size, 0)
  } finally {
    await session.stop()
  }
})

test('non-callable and null continuous entries disappear without becoming script exceptions', async () => {
  const clock = new Clock()
  const { session, logs } = await headless(
    {
      'startup.tjs': `
var calls=0;function negative(tick){calls++;return -1;}
System.addContinuousHandler(negative);System.addContinuousHandler(%[]);System.addContinuousHandler(null);
`,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    clock.advance(0)
    await session.idle()
    assert.equal(await session.evaluate('calls'), '1')
    assert.equal(session.snapshot().eventDisabled, false)
    clock.advance(1)
    await session.idle()
    assert.equal(await session.evaluate('calls'), '2')
    await session.evaluate('System.removeContinuousHandler(negative)')
    clock.advance(1)
    await session.idle()
    assert.equal(clock.tasks.size, 0)
    assert.deepEqual(logs, [])
  } finally {
    await session.stop()
  }
})

test('continuous frequency uses the native first wake and changes on the next unique registration', async () => {
  const clock = new Clock()
  clock.time = 17
  const { session } = await headless(
    {
      'startup.tjs': `
var ticks=[],extra=0;function tick(t){ticks.add(t);}function other(t){extra++;}
System.setArgument("-contfreq","10");System.addContinuousHandler(tick);
`,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    clock.advance(0)
    await session.idle()
    assert.equal(await session.evaluate('ticks.join(",")'), '17')
    await session.evaluate('System.setArgument("-contfreq","20.9")')
    await session.evaluate('System.addContinuousHandler(tick)')
    clock.advance(82)
    await session.idle()
    assert.equal(await session.evaluate('ticks.join(",")'), '17')
    await session.evaluate('System.addContinuousHandler(other)')
    clock.advance(0)
    await session.idle()
    assert.equal(await session.evaluate('ticks.join(",")'), '17,99')
    clock.advance(1)
    await session.idle()
    assert.equal(await session.evaluate('ticks.join(",")'), '17,99,100')
    assert.equal(await session.evaluate('extra'), '2')
    assert.equal(await session.evaluate('System.getArgument("-contfreq")'), '20.9')
  } finally {
    await session.stop()
  }
})

test('user and page pause freeze the remaining continuous deadline without catch-up', async () => {
  const clock = new Clock()
  clock.time = 17
  const { session } = await headless(
    {
      'startup.tjs':
        'var ticks=[];function tick(t){ticks.add(t);}System.setArgument("-contfreq",10);System.addContinuousHandler(tick);',
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    clock.advance(0)
    await session.idle()
    session.pause()
    clock.advance(1000)
    session.resume()
    clock.advance(82)
    await session.idle()
    assert.equal(await session.evaluate('ticks.join(",")'), '17')
    clock.advance(1)
    await session.idle()
    assert.equal(await session.evaluate('ticks.join(",")'), '17,1100')
    session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: true })
    clock.advance(1000)
    session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: true })
    clock.advance(99)
    await session.idle()
    assert.equal(await session.evaluate('ticks.count'), '2')
    clock.advance(1)
    await session.idle()
    assert.equal(await session.evaluate('ticks.join(",")'), '17,1100,2200')
  } finally {
    await session.stop()
  }
  assert.equal(clock.tasks.size, 0)
})

test('exception handler keeps other registrations alive and preserves explicit disable intent', async () => {
  const clock = new Clock()
  const { session, logs } = await headless(
    {
      'startup.tjs': `
var caught=0,calls=0;function bad(t){throw new Exception("handled");}function good(t){calls++;}
System.exceptionHandler=function(e){caught++;return true;};System.addContinuousHandler(bad);System.addContinuousHandler(good);
`,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    clock.advance(0)
    await session.idle()
    assert.equal(await session.evaluate('caught'), '1')
    assert.equal(session.snapshot().eventDisabled, false)
    clock.advance(1)
    await session.idle()
    assert.equal(await session.evaluate('calls'), '1')
    await session.evaluate(
      'System.exceptionHandler=function(e){System.eventDisabled=true;return true;}',
    )
    await session.evaluate('System.addContinuousHandler(bad)')
    clock.advance(1)
    await session.idle()
    assert.equal(session.snapshot().eventDisabled, true)
    assert.deepEqual(logs, [])
  } finally {
    await session.stop()
  }
})

test('a throwing exception handler stops event delivery without losing script state', async () => {
  const clock = new Clock()
  const { session, logs } = await headless(
    {
      'startup.tjs': `
var value=91;System.exceptionHandler=function(e){throw new Exception("handler failed");};
var timer=new Timer(function(){throw new Exception("event failed");},"");timer.interval=10;timer.enabled=true;
`,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    clock.advance(10)
    await session.idle()
    assert.equal(session.snapshot().eventDisabled, true)
    assert.equal(session.snapshot().state, 'running')
    assert.equal(await session.evaluate('value'), '91')
    assert(logs.some((log) => log.includes('event failed') && log.includes('handler failed')))
  } finally {
    await session.stop()
  }
})

test('disabled input is deferred while current physical key state remains observable', async () => {
  const { session } = await headless({
    'startup.tjs': `
var w=new Window();w.visible=true;var keys=[];
w.onKeyDown=function(key,shift){keys.add("D"+System.getKeyState(key));};w.onKeyUp=function(key,shift){keys.add("U"+System.getKeyState(key));};System.eventDisabled=true;
`,
  })
  try {
    await session.start()
    const down = session.input({ type: 'keyDown', key: 65, shift: 0 }),
      up = session.input({ type: 'keyUp', key: 65, shift: 0 })
    assert.equal(await session.evaluate('System.getKeyState(65)'), '0')
    assert.equal(await session.evaluate('keys.count'), '0')
    await session.evaluate('System.eventDisabled=false')
    await Promise.all([down, up])
    assert.equal(await session.evaluate('keys.join(",")'), 'D0,U0')
  } finally {
    await session.stop()
  }
})

test('timer capacity counts queued callbacks instead of a callback already running', async () => {
  const clock = new Clock()
  let entered!: () => void, finish!: (value: string) => void
  const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    }),
    data = new Promise<string>((resolve) => {
      finish = resolve
    })
  const { session } = await headless(
    {
      'startup.tjs':
        'var calls=0;var timer=new Timer(function(){calls++;if(calls==1)Scripts.evalStorage("late.tjs");},"");timer.interval=10;timer.capacity=2;timer.enabled=true;',
      'late.tjs': 'late',
    },
    {
      now: clock.now,
      schedule: clock.schedule,
      decodeScript(bytes) {
        const text = new TextDecoder().decode(bytes)
        if (text === 'late') {
          entered()
          return data
        }
        return text
      },
    },
  )
  try {
    await session.start()
    clock.advance(10)
    await enteredPromise
    clock.advance(20)
    finish('0')
    await session.idle()
    assert.equal(await session.evaluate('calls'), '3')
  } finally {
    finish('0')
    await session.stop()
  }
})

for (const kind of ['continuous', 'trigger'] as const)
  test(`stopping an unbounded ${kind} event chain releases the original VM`, async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const source =
      kind === 'continuous'
        ? 'function tick(t){Debug.message("entered");while(true){}}System.addContinuousHandler(tick);'
        : 'var calls=0;var trigger=new AsyncTrigger(function(){if(++calls==1)Debug.message("entered");trigger.trigger();},"");trigger.trigger();'
    const { session } = await headless(
      { 'startup.tjs': source },
      {
        event(event) {
          if (event.type === 'log' && event.text === 'entered') started()
        },
      },
    )
    try {
      await session.start()
      await ready
      await session.stop()
      assert.equal(session.snapshot().state, 'stopped')
      assert.equal(session.snapshot().handles, 0)
    } finally {
      await session.stop()
    }
  })

test('exception handler preserves a bound receiver and reads replacements once per exception', async () => {
  const clock = new Clock()
  const { session, logs } = await headless(
    {
      'startup.tjs': `
var original=0,reads=0;
class Receiver {var count=0;function handle(error){count++;return error===37;}}
var receiver=new Receiver();
property selectedHandler {getter(){reads++;return receiver.handle;}}
System.exceptionHandler=&selectedHandler;
function bad(t){throw 37;}
System.addContinuousHandler(bad);
`,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    clock.advance(0)
    await session.idle()
    assert.equal(await session.evaluate('receiver.count+","+reads'), '1,1')
    assert.equal(session.snapshot().eventDisabled, false)
    await session.evaluate(
      'Scripts.exec(' +
        JSON.stringify(
          'delete System.exceptionHandler;System.exceptionHandler=function(error){original++;return true;};System.addContinuousHandler(bad);',
        ) +
        ')',
    )
    clock.advance(1)
    await session.idle()
    assert.equal(await session.evaluate('receiver.count+","+reads+","+original'), '1,1,1')
    assert.deepEqual(logs, [])
  } finally {
    await session.stop()
  }
  assert.equal(session.snapshot().handles, 0)
})

test('primitive exceptions and absent or non-object handlers preserve the VM', async () => {
  const clock = new Clock()
  const { session, logs } = await headless(
    {
      'startup.tjs': `
function bad(t){throw "primitive failure";}System.exceptionHandler=42;System.addContinuousHandler(bad);
`,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  try {
    await session.start()
    for (const handler of ['42', 'null', 'void']) {
      if (handler !== '42') {
        await session.evaluate(
          'Scripts.exec(' +
            JSON.stringify(
              `System.exceptionHandler=${handler};System.eventDisabled=false;System.addContinuousHandler(bad);`,
            ) +
            ')',
        )
        clock.advance(1)
      } else clock.advance(0)
      await session.idle()
      assert.equal(session.snapshot().eventDisabled, true)
      assert.equal(session.snapshot().state, 'running')
      assert(logs.at(-1)?.includes('primitive failure'))
      assert(!logs.at(-1)?.includes('exception handler:'))
    }
  } finally {
    await session.stop()
  }
})

test('cached trigger replacement removes old queued jobs before the global queue budget', async () => {
  const { session } = await headless({
    'startup.tjs': `
var calls=0;var trigger=new AsyncTrigger(function(){calls++;},"");trigger.cached=true;
System.eventDisabled=true;for(var i=0;i<70000;i++)trigger.trigger();
`,
  })
  try {
    await session.start()
    assert.equal(session.snapshot().state, 'running')
    assert.equal(await session.evaluate('calls'), '0')
    await session.evaluate('System.eventDisabled=false')
    assert.equal(await session.evaluate('calls'), '1')
  } finally {
    await session.stop()
  }
})
