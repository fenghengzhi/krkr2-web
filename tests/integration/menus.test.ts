import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const setup = String.raw`
var window=new Window(), group=new MenuItem(window,"Game(&G)"), clicks=0;
window.visible=true;
window.menu.add(group);
var first=new MenuItem(window,"First"), second=new MenuItem(window,"Second");
first.radio=second.radio=true; first.group=second.group=1;
group.add(first); group.add(second); first.checked=true; second.checked=true;
first.onClick=function(){clicks++;}; second.onClick=function(){clicks+=10;};
`
test('MenuItem parent/order/radio semantics and native callbacks stay synchronized', async () => {
  const { session } = await headless({ 'startup.tjs': setup })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        '!first.checked && second.checked && first.parent===group && first.root===window.menu',
      ),
      '1',
    )
    await session.evaluate('second.index=0')
    assert.equal(await session.evaluate('group.children[0]===first && first.index==1'), '1')
    const firstId = Number(await session.evaluate('first.__menuId'))
    await session.menuClick(firstId)
    assert.equal(await session.evaluate('clicks'), '1')
    await session.evaluate('group.enabled=false')
    await session.menuClick(firstId)
    assert.equal(await session.evaluate('clicks'), '1')
    await session.evaluate('(function(){group.enabled=true;group.remove(first);return 0;})()')
    await session.menuClick(firstId)
    assert.equal(await session.evaluate('clicks'), '1')
    assert.equal(
      await session.evaluate(
        '(function(){var copy=group.children;copy.clear();return group.children.count;})()',
      ),
      '0',
    )
    assert.equal(
      await session.evaluate(
        '(function(){try{second.add(window.menu);}catch(error){return "cycle rejected";}})()',
      ),
      'cycle rejected',
    )
    await session.evaluate('(function(){invalidate group;return 0;})()')
    assert.equal(await session.evaluate('window.menu.children.count'), '1')
    assert.equal(await session.evaluate('isvalid window.menu.children[0]'), '0')
  } finally {
    await session.stop()
  }
})

test('popup selection resumes its suspended caller; cancellation and stop release the wait', async () => {
  const { session, events } = await headless({ 'startup.tjs': setup })
  const waitPopup = async () => {
    for (let i = 0; i < 100; i++) {
      if (
        events.at(-1)?.type === 'menus' &&
        (events.at(-1) as { menus: { popup?: unknown } }).menus.popup
      )
        return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw new Error('Popup did not open')
  }
  try {
    await session.start()
    const firstId = Number(await session.evaluate('first.__menuId'))
    const selected = session.evaluate('group.popup(0,20,30)')
    await waitPopup()
    await session.menuClick(firstId)
    assert.equal(await selected, String(firstId))
    assert.equal(await session.evaluate('clicks'), '1')
    const cancelled = session.evaluate('group.popup(tpmReturnCmd,20,30)')
    await waitPopup()
    session.menuDismiss()
    assert.equal(await cancelled, '0')
    const pending = session.evaluate('group.popup(0,20,30)')
    const rejected = assert.rejects(pending, /cancelled/)
    await waitPopup()
    await session.stop()
    await rejected
    assert.equal(session.snapshot().handles, 0)
  } finally {
    await session.stop()
  }
})

test('hidden menu input and clicks queued before a visibility epoch change are discarded', async () => {
  let entered!: () => void, finish!: (source: string) => void
  const ready = new Promise<void>((resolve) => {
      entered = resolve
    }),
    delayed = new Promise<string>((resolve) => {
      finish = resolve
    })
  const { session } = await headless(
    { 'startup.tjs': setup, 'late.tjs': 'late' },
    {
      decodeScript(bytes) {
        const text = new TextDecoder().decode(bytes)
        if (text === 'late') {
          entered()
          return delayed
        }
        return text
      },
    },
  )
  try {
    await session.start()
    const firstId = Number(await session.evaluate('first.__menuId'))
    session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
    await session.menuClick(firstId)
    assert.equal(await session.evaluate('clicks'), '0')
    session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
    const reading = session.evaluate('Scripts.evalStorage("late.tjs")')
    await ready
    const click = session.menuClick(firstId)
    session.setActivity({ sequence: 3, state: 'hidden', pauseWhenHidden: false })
    session.setActivity({ sequence: 4, state: 'visible', pauseWhenHidden: false })
    finish('0')
    await Promise.all([reading, click])
    assert.equal(await session.evaluate('clicks'), '0')
    await session.menuClick(firstId)
    assert.equal(await session.evaluate('clicks'), '1')
  } finally {
    finish('0')
    await session.stop()
  }
})

test('event disabling suppresses menu notifications while popup selection still returns', async () => {
  let opened: (() => void) | undefined
  const { session } = await headless(
    { 'startup.tjs': setup },
    {
      event(event) {
        if (event.type === 'menus' && event.menus.popup) opened?.()
      },
    },
  )
  const popup = async (expression: string) => {
    const ready = new Promise<void>((resolve) => {
      opened = resolve
    })
    const result = session.evaluate(expression)
    await ready
    return { result }
  }
  try {
    await session.start()
    const firstId = Number(await session.evaluate('first.__menuId'))
    await session.evaluate('System.eventDisabled=true')
    await session.menuClick(firstId)
    const { result } = await popup('group.popup(0,20,30)')
    await session.menuClick(firstId)
    assert.equal(await result, String(firstId))
    assert.equal(await session.evaluate('clicks'), '0')
    await session.evaluate('System.eventDisabled=false')
    const returned = await popup('group.popup(tpmReturnCmd,20,30)')
    await session.menuClick(firstId)
    assert.equal(await returned.result, String(firstId))
    assert.equal(await session.evaluate('clicks'), '0')
    await session.menuClick(firstId)
    assert.equal(await session.evaluate('clicks'), '1')
  } finally {
    await session.stop()
  }
})

test('hidden and paused popups dismiss without reentering a suspended script', async () => {
  let opened: (() => void) | undefined
  const { session } = await headless(
    { 'startup.tjs': setup },
    {
      event(event) {
        if (event.type === 'menus' && event.menus.popup) opened?.()
      },
    },
  )
  try {
    await session.start()
    const ready = new Promise<void>((resolve) => {
      opened = resolve
    })
    const hidden = session.evaluate('group.popup(0,20,30)')
    await ready
    session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
    assert.equal(await hidden, '0')
    assert.equal(await session.evaluate('group.popup(0,20,30)'), '0')
    session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
    const readyAgain = new Promise<void>((resolve) => {
      opened = resolve
    })
    const paused = session.evaluate('group.popup(0,20,30)')
    let resolved = false
    void paused.then(() => {
      resolved = true
    })
    await readyAgain
    session.pause()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(resolved, false)
    session.resume()
    assert.equal(await paused, '0')
    assert.equal(await session.evaluate('clicks'), '0')
  } finally {
    await session.stop()
  }
})
