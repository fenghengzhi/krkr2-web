import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var order="";
var main=new Window();main.caption="main";main.visible=true;main.setInnerSize(100,80);
main.onMouseDown=function(x,y,button,shift){order+="down:"+button+";";};
main.onKeyDown=function(key,shift){order+="main-key:"+key+";";};
var p1=new Window();p1.caption="one";p1.focusable=false;p1.stayOnTop=true;p1.visible=true;
p1.onPopupHide=function(args*){order+="one:"+args.count+";";};
var p2=new Window();p2.caption="two";p2.focusable=false;p2.stayOnTop=true;p2.visible=true;
p2.action=function(event){if(event.type=="onPopupHide")order+="two:"+int(event.target===global.p2)+";";};
p2.onKeyDown=function(key,shift){order+="trap-key:"+key+";";};
var ordinary=new Window();ordinary.visible=true;ordinary.focusable=false;
var focusedTop=new Window();focusedTop.visible=true;focusedTop.stayOnTop=true;
var hidden=new Window();hidden.focusable=false;hidden.stayOnTop=true;hidden.visible=false;
ordinary.onPopupHide=focusedTop.onPopupHide=hidden.onPopupHide=function(){order+="ineligible;";};
`
async function fixture(binary: boolean) {
  const f = await headless({ 'startup.tjs': binary
    ? 'Scripts.compileStorage("popup.tjs","savedata/popup.cjs",false,true,false);Scripts.execStorage("savedata/popup.cjs");'
    : 'Scripts.execStorage("popup.tjs");', 'popup.tjs': source })
  try {
    await f.session.start()
    await f.session.idle()
    const main = Number(await f.session.evaluate('main.__windowId')),
      p1 = Number(await f.session.evaluate('p1.__windowId')),
      p2 = Number(await f.session.evaluate('p2.__windowId'))
    if (binary) {
      const bytes = f.session.exportSaves().find((file) => file.path === 'savedata/popup.cjs')?.bytes
      assert(bytes)
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'TJS2')
    }
    await f.session.evaluate('order=""')
    return { ...f, main, p1, p2,
      exec: (program: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(`${program};`)})`),
      order: () => f.session.evaluate('order'),
      popup: (windowId = main) => f.session.acceptWindowPopup({ type: 'window', windowId }),
      down: (windowId = main, button = 0) => f.session.input({ type: 'down', windowId,
        x: 10, y: 10, button, shift: button === 0 ? 8 : 16, clicks: 0 }),
    }
  } catch (error) { await f.session.stop(); throw error }
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 10000
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for popup lifecycle')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
const popups = 'two:1;one:0;'

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: popup eligibility and reverse registration precede real mouse down, with native action forwarding`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.down(f.p1)
      assert.equal(await f.order(), '', 'Inside a popup Form does not notify either popup')
      await f.session.activateWindow(f.main)
      await f.down()
      assert.equal(await f.order(), `${popups}down:0;`)
      assert.equal(await f.session.evaluate('int(p1.visible)+":"+int(p2.visible)'), '1:1',
        'Notification itself does not hide a Window')
      await f.session.evaluate('order=""')
      await f.down(f.main, 1)
      assert.equal(await f.order(), `${popups}down:1;`)
      await f.session.evaluate('order=""')
      await f.popup().completion
      assert.equal(await f.order(), popups, 'Non-client messages share the same dispatch contract')
    } finally { await f.session.stop() }
  })

  test(`${mode}: system keys notify the physical source before trap admission, while posted keys bypass Form conversion`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('p2.trapKey=true')
      await f.session.input({ type: 'keyDown', windowId: f.main, key: 18, shift: 2, systemKey: true })
      assert.equal(await f.order(), popups, 'Even an unarmed trap cannot swallow the earlier popup notification')
      await f.session.input({ type: 'keyDown', windowId: f.main, key: 65, shift: 0 })
      await f.session.evaluate('order=""')
      await f.session.input({ type: 'keyDown', windowId: f.main, key: 121, shift: 0, systemKey: true })
      assert.equal(await f.order(), `${popups}trap-key:121;`)
      await f.exec('order="";main.postInputEvent("onKeyDown",%[key:18,shift:2])')
      await f.session.idle()
      assert.equal(await f.order(), 'main-key:18;')
      await f.exec('p2.trapKey=false;main.useMouseKey=true;order=""')
      f.session.pointerState(10, 10, f.main)
      await f.session.input({ type: 'keyDown', windowId: f.main, key: 13, shift: 0 })
      assert.equal(await f.order(), `${popups}down:0;`, 'Mouse-key down really enters PaintBoxMouseDown')
      await f.exec('main.useMouseKey=false;order=""')
      const prelude = f.session.acceptInput({ type: 'popupHide', windowId: f.main }),
        key = f.session.acceptInput({ type: 'keyDown', windowId: f.main, key: 18, shift: 2,
          systemKey: true, popupHidePosted: true })
      await Promise.all([prelude.completion, key.completion])
      assert.equal(await f.order(), `${popups}main-key:18;`, 'A browser prelude is delivered exactly once')
    } finally { await f.session.stop() }
  })

  test(`${mode}: disabled popup events remain FIFO and snapshot eligibility without coalescing`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('System.eventDisabled=true')
      const first = f.popup(), second = f.popup()
      assert.equal(first.status, 'accepted')
      assert.equal(second.status, 'accepted')
      await f.exec('p2.focusable=true;p1.stayOnTop=false;hidden.visible=true')
      assert.equal(await f.order(), '')
      await f.session.evaluate('System.eventDisabled=false')
      await Promise.all([first.completion, second.completion])
      assert.equal(await f.order(), popups + popups,
        'Already posted targets survive focus/topmost changes; newly visible windows are not retroactively added')
    } finally { await f.session.stop() }
  })

  test(`${mode}: earlier popup callbacks can hide or invalidate later recipients without retaining dead Windows`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('p2.onPopupHide=function(){order+="two-hide;";p1.visible=false;};')
      await f.popup().completion
      assert.equal(await f.order(), 'two-hide;')
      await f.exec('order="";p1.visible=true;p2.onPopupHide=function(){order+="two-invalidate;";invalidate p1;};')
      await f.popup().completion
      assert.equal(await f.order(), 'two-invalidate;')
      assert.equal(f.session.snapshot().windows!.some((window) => window.id === f.p1), false)
      await f.exec('order="";p2.onPopupHide=function(){order+="two-self;";invalidate p2;};')
      await f.popup().completion
      assert.equal(await f.order(), 'two-self;')
      assert.equal(f.session.snapshot().windows!.some((window) => window.id === f.p2), false)
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: disabling events inside a popup callback consumes later immediate notices in that running input round`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('p2.onPopupHide=function(){order+="two-disable;";System.eventDisabled=true;};')
      await f.popup().completion
      assert.equal(f.session.snapshot().eventDisabled, true)
      assert.equal(await f.order(), 'two-disable;')
      // Native's input loop keeps taking events; their immediate TJS dispatch
      // checks eventDisabled. This differs from starting a disabled round.
      await f.session.evaluate('System.eventDisabled=false')
      assert.equal(await f.order(), 'two-disable;', 'The already consumed notice does not replay')
      await f.exec('order="";p2.onPopupHide=function(){order+="two-next;";};')
      await f.popup().completion
      assert.equal(await f.order(), 'two-next;one:0;')
    } finally { await f.session.stop() }
  })

  test(`${mode}: application blur/hidden is one transition, paused delivery resumes and modal-disabled recipients are skipped`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    let modal: Promise<string> | undefined
    try {
      const blur = f.session.acceptWindowPopup({ type: 'application', active: false }),
        duplicate = f.session.acceptWindowPopup({ type: 'application', active: false })
      assert.equal(duplicate.status, 'ignored')
      f.session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: true })
      assert.equal(f.session.snapshot().state, 'paused')
      f.session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: true })
      await blur.completion
      assert.equal(await f.order(), popups)
      await f.exec('order="";var dialog=new Window();dialog.visible=false;')
      const id = Number(await f.session.evaluate('dialog.__windowId'))
      modal = f.session.evaluate('dialog.showModal()')
      void modal.catch(() => {})
      await until(() => f.session.inspectOwnership().modalScopes === 1)
      await f.session.acceptWindowPopup({ type: 'application', active: false }).completion
      await f.session.closeWindow(id)
      await modal
      assert.equal(await f.order(), '', 'Visible parent popup Forms are disabled by the modal Window')
      await f.popup().completion
      assert.equal(await f.order(), popups, 'Surviving popup Forms work after modal retirement')
    } finally { await f.session.stop(); await modal?.catch(() => {}) }
  })

  test(`${mode}: Stop retires disabled queued popup receipts and late host messages cannot resurrect them`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('System.eventDisabled=true')
      const pending = f.popup().completion
      void pending.catch(() => {})
      await f.session.stop()
      await assert.rejects(pending)
      const late = f.popup()
      assert.equal(late.status, 'ignored')
      await late.completion
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    } finally { await f.session.stop() }
  })
}
