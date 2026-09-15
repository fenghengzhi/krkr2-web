import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

const source = String.raw`
var trace=[];
class ActivationWindow extends Window {
  var name,activations=0,deactivations=0,holdDeactivation=false;
  function ActivationWindow(name){super.Window();this.name=name;caption=name;}
  function onActivate(){activations++;trace.add(name+":activate:"+System.getKeyState(65));}
  function onDeactivate(){
    deactivations++;trace.add(name+":deactivate:begin");
    if(holdDeactivation){holdDeactivation=false;Scripts.execStorage("activation-gate.tjs");}
    trace.add(name+":deactivate:end");
  }
}
var a=new ActivationWindow("A"),b=new ActivationWindow("B"),c=new ActivationWindow("C");
a.visible=b.visible=c.visible=true;
function resetNotifications(){
  trace.clear();a.activations=b.activations=c.activations=0;
  a.deactivations=b.deactivations=c.deactivations=0;
}
function gateNextDeactivation(){a.holdDeactivation=true;}
`

async function fixture(binary: boolean) {
  let entered!: () => void, finish!: (source: string) => void
  const ready = new Promise<void>((resolve) => {
      entered = resolve
    }),
    gate = new Promise<string>((resolve) => {
      finish = resolve
    }),
    harness = await headless(
      {
        'startup.tjs': '',
        'activation.tjs': source,
        'activation-gate.tjs': 'multiwindow-activation-gate',
      },
      {
        decodeScript(bytes, mode, encoding) {
          if (new TextDecoder().decode(bytes) === 'multiwindow-activation-gate') {
            entered()
            return gate
          }
          return readScript(bytes, mode, encoding)
        },
      },
    )
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("activation.tjs","savedata/activation.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/activation.cjs")')
    } else await session.evaluate('Scripts.execStorage("activation.tjs")')
    await session.idle()
    const a = Number(await session.evaluate('a.__windowId')),
      b = Number(await session.evaluate('b.__windowId')),
      c = Number(await session.evaluate('c.__windowId'))
    await session.activateWindow(a)
    await session.idle()
    await session.evaluate('resetNotifications()')
    return {
      ...harness,
      a,
      b,
      c,
      ready,
      release: () => finish('0;'),
      stop: async () => {
        finish('0;')
        await session.stop()
      },
    }
  } catch (error) {
    finish('0;')
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: a physical held key survives observed A-to-B-to-A activation packets`, async () => {
    const f = await fixture(binary)
    try {
      f.session.keyState([65])
      await f.session.input({ type: 'deactivate', windowId: f.a })
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '1')
      await f.session.input({ type: 'activate', windowId: f.b })
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '1')
      await f.session.input({ type: 'deactivate', windowId: f.b })
      await f.session.input({ type: 'activate', windowId: f.a })
      assert.equal(f.session.snapshot().activeWindow, f.a)
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '1')
      assert.equal(
        await f.session.evaluate('trace.join("|")'),
        'A:deactivate:begin|A:deactivate:end|B:activate:1|B:deactivate:begin|B:deactivate:end|A:activate:1',
      )
      await f.session.input({ type: 'keyUp', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '0')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a local cancel followed by pointer movement does not overwrite the physical key snapshot`, async () => {
    const f = await fixture(binary)
    try {
      f.session.keyState([65])
      await f.session.input({ type: 'cancel', windowId: f.a })
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '1')
      await f.session.input({
        type: 'move',
        x: 3,
        y: 4,
        shift: 0,
        button: 0,
        clicks: 0,
        windowId: f.a,
      })
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '1')
      await f.session.input({
        type: 'move',
        x: 5,
        y: 6,
        shift: 0,
        button: 0,
        clicks: 0,
        windowId: f.b,
      })
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '1')
      f.session.keyState([])
      await f.session.input({
        type: 'move',
        x: 7,
        y: 8,
        shift: 0,
        button: 0,
        clicks: 0,
        windowId: f.a,
      })
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '0')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a newer C activation cannot be overtaken by B while A's deactivation is suspended`, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('gateNextDeactivation()')
      const toB = f.session.activateWindow(f.b)
      await f.ready
      assert.equal(f.session.snapshot().activeWindow, f.b)
      const toC = f.session.activateWindow(f.c)
      assert.equal(f.session.snapshot().activeWindow, f.c)
      f.release()
      await Promise.all([toB, toC])
      assert.equal(f.session.snapshot().activeWindow, f.c)
      assert.equal(
        await f.session.evaluate('trace.join("|")'),
        'A:deactivate:begin|A:deactivate:end|B:activate:0|B:deactivate:begin|B:deactivate:end|C:activate:0',
      )
      assert.equal(
        await f.session.evaluate('a.activations+","+b.activations+","+c.activations'),
        '0,1,1',
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: user pause and page-away activation requests leave the selected Window unchanged`, async () => {
    const f = await fixture(binary)
    try {
      f.session.pause()
      assert.equal(f.session.snapshot().state, 'paused')
      await f.session.activateWindow(f.b)
      await f.session.input({ type: 'activate', windowId: f.c })
      assert.equal(f.session.snapshot().activeWindow, f.a)
      f.session.resume()
      await f.session.activateWindow(f.a)
      assert.equal(
        await f.session.evaluate('a.activations+","+b.activations+","+c.activations'),
        '1,0,0',
      )
      f.session.setActivity({ sequence: 1, state: 'away', pauseWhenHidden: false })
      await f.session.activateWindow(f.b)
      await f.session.input({ type: 'activate', windowId: f.c })
      assert.equal(f.session.snapshot().activeWindow, f.a)
      f.session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
      await f.session.activateWindow(f.a)
      assert.equal(
        await f.session.evaluate('a.activations+","+b.activations+","+c.activations'),
        '2,0,0',
      )
      assert.equal(f.session.snapshot().state, 'running')
    } finally {
      await f.stop()
    }
  })

  for (const suspension of ['pause', 'hidden'] as const) {
    test(`${mode}: ${suspension} invalidates a pending activation and permits a fresh notification after return`, async () => {
      const f = await fixture(binary)
      try {
        await f.session.evaluate('gateNextDeactivation()')
        const toB = f.session.activateWindow(f.b)
        await f.ready
        assert.equal(f.session.snapshot().activeWindow, f.b)
        if (suspension === 'pause') {
          f.session.pause()
          f.session.resume()
        } else {
          // Background continuation must invalidate DOM input even when game
          // execution remains running; this does not depend on user pause.
          f.session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
          assert.equal(f.session.snapshot().state, 'running')
          f.session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
        }
        f.release()
        await toB
        assert.equal(await f.session.evaluate('b.activations'), '0')
        await f.session.activateWindow(f.b)
        assert.equal(await f.session.evaluate('b.activations'), '1')
        assert.equal(f.session.snapshot().activeWindow, f.b)
        assert.equal(
          await f.session.evaluate('trace.join("|")'),
          'A:deactivate:begin|A:deactivate:end|B:activate:0',
        )
      } finally {
        await f.stop()
      }
    })
  }
}
