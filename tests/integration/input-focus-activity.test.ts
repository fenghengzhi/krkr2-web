import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

test('backgrounding before a queued mouse callback drops the unestablished text focus', async () => {
  const { session } = await headless({
    'startup.tjs': `
    var w=new Window();w.visible=true;w.setInnerSize(4,4);
    var root=new Layer(w,null);root.setSize(4,4);root.focusable=true;root.imeMode=imOpen;
    var downs=0,committed="";
    root.onMouseDown=function(){downs++;root.focus();};
    root.onKeyPress=function(key,process){committed+=key;};
  `,
  })
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const bytes = new TextEncoder().encode('var released=1;')
  session.mount([
    {
      name: 'gate.tjs',
      size: bytes.length,
      read: async () => {
        entered()
        await gate
        return bytes
      },
    },
  ])
  try {
    await session.start()
    const blocked = session.evaluate('Scripts.execStorage("gate.tjs")')
    await started
    const pendingDown = session.input({ type: 'down', x: 1, y: 1, shift: 8, button: 0, clicks: 0 })
    session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: true })
    session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: true })
    release()
    await blocked
    await pendingDown
    assert.equal(await session.evaluate('downs'), '0')
    assert.equal(await session.evaluate('w.focusedLayer===null'), '1')
    await session.input({ type: 'text', text: '旧' })
    assert.equal(await session.evaluate('committed'), '')
    await session.input({ type: 'down', x: 1, y: 1, shift: 8, button: 0, clicks: 0 })
    assert.equal(await session.evaluate('downs'), '1')
    assert.equal(await session.evaluate('w.focusedLayer===root'), '1')
    await session.input({ type: 'text', text: '新' })
    assert.equal(await session.evaluate('committed'), '新')
  } finally {
    release()
    await session.stop()
  }
})
