import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'

function clock() {
  let time = 0,
    token = 0
  const tasks = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => time,
    schedule(callback: () => void, delay: number) {
      const id = ++token
      tasks.set(id, { at: time + delay, callback })
      return () => {
        tasks.delete(id)
      }
    },
    advance(milliseconds: number) {
      time += milliseconds
      for (const [id, task] of [...tasks]) if (task.at <= time && tasks.delete(id)) task.callback()
    },
    get pending() {
      return tasks.size
    },
  }
}

function gate() {
  let enter!: () => void, release!: () => void
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve
    }),
    released: new Promise<void>((resolve) => {
      release = resolve
    }),
    enter: () => enter(),
    release: () => release(),
  }
}

async function fixture(
  binary: boolean,
  body: string,
  overrides: Partial<SessionDependencies> = {},
) {
  const timer = clock(),
    harness = await headless(
      {
        'startup.tjs': '',
        'redraw-gate.bin': new Uint8Array([1]),
        'fairness.tjs': String.raw`
var win=new Window();win.visible=true;win.setInnerSize(8,4);
var root=new Layer(win,null);root.setSize(8,4);
var other=new Layer(win,root);other.setSize(4,4);other.left=4;other.visible=true;
var snapshot=new Layer(win,root);snapshot.setSize(1,1);
var aPaints=0,bPaints=0;
${body}
`,
      },
      { now: timer.now, schedule: timer.schedule, ...overrides },
    )
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("fairness.tjs","savedata/fairness.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/fairness.cjs")')
    } else await session.evaluate('Scripts.execStorage("fairness.tjs")')
    await session.idle()
    return {
      ...harness,
      timer,
      execute: (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`),
      a: () => harness.logs.filter((line) => line.startsWith('fair-a:')),
      b: () => harness.logs.filter((line) => line.startsWith('fair-b:')),
      async advance(milliseconds: number) {
        timer.advance(milliseconds)
        await session.idle()
      },
      async stop() {
        await session.stop()
        assert.equal(timer.pending, 0)
        assert.equal(session.snapshot().handles, 0)
      },
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: another Layer's 8ms paints cannot postpone a self-update's 16ms deadline`, async () => {
    const f = await fixture(
      binary,
      String.raw`
root.onPaint=function(){aPaints++;Debug.message("fair-a:"+aPaints);if(aPaints<4)root.update();};
other.onPaint=function(){bPaints++;Debug.message("fair-b:"+bPaints);};
root.update();
`,
    )
    try {
      assert.deepEqual(f.a(), ['fair-a:1'])
      for (let time = 8; time <= 48; time += 8) {
        await f.advance(8)
        await f.execute('other.update();')
        assert.equal(f.a().length, 1 + Math.floor(time / 16), `A at ${time}ms`)
        assert.equal(f.b().length, time / 8, `B at ${time}ms`)
      }
      assert.equal(f.timer.pending, 0)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: an unrelated asynchronous paint preserves the overdue Layer's deadline`, async () => {
    const blocker = gate(),
      f = await fixture(
        binary,
        String.raw`
root.onPaint=function(){aPaints++;Debug.message("fair-a:"+aPaints);if(aPaints<2)root.update();};
other.onPaint=function(){Debug.message("fair-b:entered");other.loadImages("redraw-gate.bin");Debug.message("fair-b:returned");};
root.update();
`,
        {
          graphics: {
            async decode() {
              blocker.enter()
              await blocker.released
              return { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) }
            },
            text() {
              throw new Error('Unexpected text drawing')
            },
          },
        },
      )
    let operation: Promise<unknown> | undefined
    try {
      await f.advance(8)
      operation = f.execute('other.update();')
      await Promise.race([blocker.entered, operation])
      assert.deepEqual(f.b(), ['fair-b:entered'])
      // The deadline expires while B owns the serialized VM. It must remain
      // due, rather than acquire a fresh interval when B finally returns.
      f.timer.advance(8)
      assert.deepEqual(f.a(), ['fair-a:1'])
      blocker.release()
      await operation
      await f.session.idle()
      assert.deepEqual(f.a(), ['fair-a:1', 'fair-a:2'])
      assert.deepEqual(f.b(), ['fair-b:entered', 'fair-b:returned'])
      assert.equal(f.timer.pending, 0)
    } finally {
      blocker.release()
      await operation?.catch(() => {})
      await f.stop()
    }
  })

  test(`${mode}: a child paint can schedule an earlier unpainted ancestor for the next frame`, async () => {
    const f = await fixture(
      binary,
      String.raw`
root.onPaint=function(){aPaints++;Debug.message("fair-a:"+aPaints);};
other.onPaint=function(){bPaints++;Debug.message("fair-b:"+bPaints);root.update();};
`,
    )
    try {
      await f.execute('other.update();')
      assert.deepEqual(f.a(), [])
      assert.deepEqual(f.b(), ['fair-b:1'])
      assert.equal(f.timer.pending, 1)
      await f.advance(15)
      assert.deepEqual(f.a(), [])
      await f.advance(1)
      assert.deepEqual(f.a(), ['fair-a:1'])
      assert.equal(f.timer.pending, 0)
    } finally {
      await f.stop()
    }
  })
}
