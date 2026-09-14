import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { ActivityState } from '../../src/engine/ports/activity.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'

const scene = `var w=new Window();w.visible=true;w.setInnerSize(4,4);var root=new Layer(w,null);root.setSize(4,4);root.fillRect(0,0,4,4,0xff123456);var value=17;var clicks=0;root.onClick=function(){clicks++;};`
const activity = (
  sequence: number,
  state: ActivityState['state'],
  pauseWhenHidden = true,
): ActivityState => ({ sequence, state, pauseWhenHidden })

test('freeze suspends media request budgets before sending pause commands and ignores stale states', async () => {
  const calls: string[] = []
  const backend = (name: string) => ({
    setRequestTimeoutsPaused(paused: boolean) {
      calls.push(`${name}:deadline:${paused}`)
    },
    async command(command: { op: string; paused?: boolean }) {
      if (command.op === 'pauseAll') calls.push(`${name}:pause:${command.paused}`)
      return { events: [] }
    },
    listen() {
      return () => {}
    },
    async close() {},
  })
  const { session } = await headless(
    { 'startup.tjs': scene },
    {
      audio: backend('audio'),
      video: backend('video'),
    },
  )
  try {
    assert.deepEqual(calls.slice(0, 2), ['audio:deadline:false', 'video:deadline:false'])
    await session.start()
    calls.length = 0
    session.setActivity(activity(2, 'frozen', false))
    assert.deepEqual(calls, [
      'audio:deadline:true',
      'video:deadline:true',
      'audio:pause:true',
      'video:pause:true',
    ])
    session.setActivity(activity(1, 'visible'))
    assert.equal(calls.length, 4)
    calls.length = 0
    session.setActivity(activity(3, 'hidden', false))
    assert.deepEqual(calls, [
      'audio:deadline:false',
      'video:deadline:false',
      'audio:pause:false',
      'video:pause:false',
    ])
    session.setActivity(activity(4, 'visible'))
    calls.length = 0
    session.pause()
    session.resume()
    assert(calls.every((call) => !call.includes('deadline:')))
  } finally {
    await session.stop()
  }
})

test('page suspension preserves modified VM state and user pause across reordered signals', async () => {
  let frames = 0
  const { session } = await headless(
    { 'startup.tjs': scene },
    {
      renderer: {
        present() {
          frames++
        },
        dispose() {},
      },
    },
  )
  try {
    await session.start()
    await session.evaluate('value=91')
    const handles = session.snapshot().handles
    session.setActivity(activity(2, 'hidden'))
    assert.equal(session.snapshot().state, 'paused')
    session.setActivity(activity(1, 'visible'))
    assert.equal(session.snapshot().activity.state, 'hidden')
    const count = frames
    session.present()
    assert.equal(frames, count)
    session.pause()
    session.setActivity(activity(3, 'frozen'))
    session.setActivity(activity(4, 'visible'))
    session.present()
    assert(frames > count)
    assert.equal(session.snapshot().state, 'paused')
    session.resume()
    assert.equal(await session.evaluate('value'), '91')
    assert.equal(session.snapshot().handles, handles)
    assert.throws(
      () => session.setActivity({ ...activity(5, 'visible'), sequence: NaN }),
      /Invalid/,
    )
  } finally {
    await session.stop()
  }
  const snapshot = session.snapshot()
  session.setActivity(activity(99, 'hidden'))
  assert.deepEqual(session.snapshot(), snapshot)
})

test('background continuation still blocks input and stops at freeze or pagehide', async () => {
  const { session } = await headless({ 'startup.tjs': scene })
  try {
    await session.start()
    session.keyState([65, 1])
    await session.input({ type: 'down', x: 1, y: 1, button: 0, shift: 8, clicks: 0 })
    session.setActivity(activity(1, 'hidden', false))
    assert.equal(session.snapshot().state, 'running')
    session.keyState([65, 1])
    await session.click(1, 1)
    assert.equal(await session.evaluate('System.getKeyState(65)||System.getKeyState(1)'), '0')
    session.setActivity(activity(2, 'frozen', false))
    assert.equal(session.snapshot().state, 'paused')
    session.resume()
    assert.equal(session.snapshot().state, 'paused')
    session.setActivity(activity(3, 'away', false))
    assert.equal(session.snapshot().state, 'paused')
    session.setActivity(activity(4, 'visible', false))
    assert.equal(await session.evaluate('clicks'), '0')
    await session.click(1, 1)
    assert.equal(await session.evaluate('clicks'), '1')
  } finally {
    await session.stop()
  }
})

test('a hidden startup waits for visibility and can be cancelled without executing game code', async () => {
  const { session, logs } = await headless(
    { 'startup.tjs': 'Debug.message("started");' + scene },
    { activity: activity(1, 'hidden') },
  )
  const running = session.start(),
    rejected = assert.rejects(running, /cancelled/)
  assert.equal(session.snapshot().state, 'paused')
  assert.deepEqual(logs, [])
  await session.stop()
  await rejected
  assert.equal(session.snapshot().state, 'stopped')
})

test('a resource completion during background pause resumes exactly once in the original VM', async () => {
  let resolveRead!: (source: string) => void,
    reached!: () => void,
    reads = 0
  const reading = new Promise<void>((resolve) => {
    reached = resolve
  })
  const bytes = new Promise<string>((resolve) => {
    resolveRead = resolve
  })
  const { session, logs } = await headless(
    {
      'startup.tjs':
        'var value=7;value+=Scripts.evalStorage("late.tjs");Debug.message("continued="+value);',
      'late.tjs': 'late',
    },
    {
      decodeScript(data) {
        const text = new TextDecoder().decode(data)
        if (text === 'late') {
          reads++
          reached()
          return bytes
        }
        return text
      },
    },
  )
  try {
    const running = session.start()
    await reading
    session.setActivity(activity(1, 'hidden'))
    resolveRead('35')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(logs, [])
    session.setActivity(activity(2, 'visible'))
    await running
    assert.deepEqual(logs, ['continued=42'])
    assert.equal(reads, 1)
  } finally {
    await session.stop()
  }
})

test('queued input before hiding is discarded rather than replayed after the blocking script', async () => {
  let resolveRead!: (source: string) => void, reached!: () => void
  const reading = new Promise<void>((resolve) => {
    reached = resolve
  })
  const bytes = new Promise<string>((resolve) => {
    resolveRead = resolve
  })
  const { session } = await headless(
    { 'startup.tjs': scene, 'late.tjs': 'late' },
    {
      decodeScript(data) {
        const text = new TextDecoder().decode(data)
        if (text === 'late') {
          reached()
          return bytes
        }
        return text
      },
    },
  )
  try {
    await session.start()
    const evaluating = session.evaluate('Scripts.evalStorage("late.tjs")')
    await reading
    const down = session.input({ type: 'down', x: 1, y: 1, button: 0, shift: 8, clicks: 0 })
    const up = session.input({ type: 'up', x: 1, y: 1, button: 0, shift: 0, clicks: 1 })
    session.setActivity(activity(1, 'hidden'))
    resolveRead('42')
    session.setActivity(activity(2, 'visible'))
    await Promise.all([evaluating, down, up])
    assert.equal(await session.evaluate('clicks'), '0')
    await session.click(1, 1)
    assert.equal(await session.evaluate('clicks'), '1')
  } finally {
    await session.stop()
  }
})

test('resuming and immediately pausing again cannot release a waiter into the suspended VM', async () => {
  const control = new ExecutionControl()
  control.pause()
  let finished = false
  const waiting = control.wait().then(() => {
    finished = true
  })
  control.resume()
  control.pause()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(finished, false)
  control.resume()
  await waiting
  assert.equal(finished, true)
})

test('page suspension removes queued timer ticks while preserving the next remaining deadline', async () => {
  let now = 0,
    releaseRead!: (source: string) => void,
    reached!: () => void
  const reading = new Promise<void>((resolve) => {
      reached = resolve
    }),
    data = new Promise<string>((resolve) => {
      releaseRead = resolve
    })
  const tasks = new Set<{ at: number; callback: () => void }>()
  const { session } = await headless(
    {
      'startup.tjs':
        scene +
        'var ticks=0;var timer=new Timer(function(){ticks++;},"");timer.interval=100;timer.enabled=true;',
      'late.tjs': 'late',
    },
    {
      now: () => now,
      schedule(callback, delay) {
        const task = { at: now + delay, callback }
        tasks.add(task)
        return () => {
          tasks.delete(task)
        }
      },
      decodeScript(bytes) {
        const text = new TextDecoder().decode(bytes)
        if (text === 'late') {
          reached()
          return data
        }
        return text
      },
    },
  )
  try {
    await session.start()
    const pending = session.evaluate('Scripts.evalStorage("late.tjs")')
    await reading
    now = 100
    for (const task of [...tasks])
      if (task.at <= now) {
        tasks.delete(task)
        task.callback()
      }
    session.setActivity(activity(1, 'hidden'))
    now = 1100
    releaseRead('42')
    session.setActivity(activity(2, 'visible'))
    await pending
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '0')
    assert.equal(Math.min(...[...tasks].map((task) => task.at)), 1200)
    now = 1200
    for (const task of [...tasks])
      if (task.at <= now) {
        tasks.delete(task)
        task.callback()
      }
    await session.idle()
    assert.equal(await session.evaluate('ticks'), '1')
  } finally {
    await session.stop()
  }
})

for (const mode of ['startup', 'error', 'cancel'] as const)
  test(`${mode}: asynchronous script completion respects pause and cancellation`, async () => {
    let entered!: () => void, finish!: (source: string) => void, rejectRead!: (error: Error) => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const data = new Promise<string>((resolve, reject) => {
      finish = resolve
      rejectRead = reject
    })
    const { session, logs } = await headless(
      {
        'startup.tjs':
          mode === 'startup'
            ? 'late'
            : 'try { Scripts.evalStorage("late.tjs"); } catch(e) { Debug.message("caught"); } Debug.message("finished");',
        'late.tjs': 'late',
      },
      {
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
    const running = session.start()
    // Attach rejection handling before stopping, so cancellation is never unhandled.
    const result = running.then(
      () => undefined,
      (error) => error as Error,
    )
    try {
      await reading
      session.setActivity(activity(1, 'hidden'))
      if (mode === 'error') rejectRead(new Error('deliberate resource failure'))
      else finish('Debug.message("decoded");')
      await new Promise((resolve) => setTimeout(resolve, 5))
      assert.deepEqual([...logs], [])
      if (mode === 'cancel') {
        await session.stop()
        assert.match(String(await result), /cancelled/)
        assert.deepEqual([...logs], [])
      } else {
        session.setActivity(activity(2, 'visible'))
        assert.equal(await result, undefined)
        if (mode === 'error') {
          assert.match(logs[0]!, /An exception occurred at startup.tjs/)
          assert(logs.includes('-- Disassembled VM code --'))
          assert.deepEqual(logs.slice(-2), ['caught', 'finished'])
        } else assert.deepEqual(logs, mode === 'startup' ? ['decoded'] : ['caught', 'finished'])
      }
    } finally {
      await session.stop()
    }
  })

for (const fail of [false, true])
  test(`background save commit ${fail ? 'failure retains exportable bytes' : 'finishes without reentering blocked TJS'}`, async () => {
    let entered!: () => void, finish!: (source: string) => void, committed!: () => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const data = new Promise<string>((resolve) => {
      finish = resolve
    })
    const attempt = new Promise<void>((resolve) => {
      committed = resolve
    })
    let failCommit = fail,
      commits = 0
    const { session, logs } = await headless(
      {
        'startup.tjs':
          '["keep me"].save("savedata/state.txt");Scripts.evalStorage("late.tjs");Debug.message("resumed");',
        'late.tjs': 'late',
      },
      {
        saveStore: {
          async load() {
            return []
          },
          async commit(files) {
            commits++
            assert.equal(files[0]!.path, 'savedata/state.txt')
            committed()
            if (failCommit) throw new Error('deliberate quota failure')
          },
          close() {},
        },
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
    const running = session.start()
    try {
      await reading
      assert.equal(session.snapshot().pendingSaves, 1)
      session.setActivity(activity(1, 'hidden'))
      await attempt
      await new Promise((resolve) => setTimeout(resolve, 5))
      assert.equal(session.snapshot().state, 'paused')
      assert.equal(session.snapshot().pendingSaves, Number(fail))
      assert.equal(logs.includes('resumed'), false)
      assert.equal(session.exportSaves()[0]!.path, 'savedata/state.txt')
      if (fail) assert(logs.some((log) => log.includes('deliberate quota failure')))
      failCommit = false
      finish('42')
      session.setActivity(activity(2, 'visible'))
      await running
      assert.equal(commits, fail ? 2 : 1)
      assert.equal(session.snapshot().pendingSaves, 0)
      assert(logs.includes('resumed'))
    } finally {
      failCommit = false
      finish('42')
      await session.stop()
    }
  })

for (const touch of [false, true])
  test(`an in-flight ${touch ? 'touch' : 'mouse'} callback cannot recreate stale capture after pause`, async () => {
    let entered!: () => void, finish!: (source: string) => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const data = new Promise<string>((resolve) => {
      finish = resolve
    })
    const { session } = await headless(
      {
        'startup.tjs':
          scene +
          'var moves=0;root.onMouseDown=root.onTouchDown=function(){Scripts.evalStorage("late.tjs");};root.onMouseMove=root.onTouchMove=function(){moves++;};',
        'late.tjs': 'late',
      },
      {
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
      const pending = session.input(
        touch
          ? { type: 'touchDown', x: 1, y: 1, width: 1, height: 1, id: 1 }
          : { type: 'down', x: 1, y: 1, button: 0, shift: 8, clicks: 0 },
      )
      await reading
      session.setActivity(activity(1, 'hidden'))
      finish('42')
      session.setActivity(activity(2, 'visible'))
      await pending
      await session.evaluate('moves=0')
      await session.input(
        touch
          ? { type: 'touchMove', x: 20, y: 20, width: 1, height: 1, id: 1 }
          : { type: 'move', x: 20, y: 20, button: 0, shift: 0, clicks: 0 },
      )
      assert.equal(await session.evaluate('moves'), '0')
      await session.input({ type: 'up', x: 1, y: 1, button: 0, shift: 0, clicks: 1 })
      assert.equal(await session.evaluate('clicks'), '0')
      await session.click(1, 1)
      assert.equal(await session.evaluate('clicks'), '1')
    } finally {
      finish('42')
      await session.stop()
    }
  })
