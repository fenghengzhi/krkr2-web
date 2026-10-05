import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { cursorDib, cursorFile } from '../helpers/cursor-fixtures.ts'
import type { InputView } from '../../src/engine/ports/input.ts'

class Clock {
  time = 0
  tasks = new Set<{ at: number; run(): void }>()
  now = () => this.time
  schedule = (run: () => void, delay: number) => {
    const task = { run, at: this.time + delay }
    this.tasks.add(task)
    return () => { this.tasks.delete(task) }
  }
  advance(ms: number) {
    this.time += ms
    for (const task of [...this.tasks]) if (task.at <= this.time && this.tasks.delete(task)) task.run()
  }
}
const source = String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(64,48);
var root=new Layer(win,null);win.add(root);root.setSize(64,48);
root.fillRect(0,0,64,48,0xffffffff);root.cursor=crCross;win.visible=true;
var leaveCount=0;
win.onMouseLeave=function(){global.leaveCount++;};
var group=new MenuItem(win,"Popup"),item=new MenuItem(win,"Item");
win.menu.add(group);group.add(item);
function moveScript(){global.root.cursor="pointer.cur";global.root.setCursorPos(12,14);}
var timer=new Timer();timer.enabled=false;timer.interval=10;
timer.onTimer=function(){global.timer.enabled=false;global.moveScript();Debug.message("cursor:changed");};
win.onKeyDown=function(key,shift){if(key==120){
  global.timer.enabled=true;global.group.popup(0,20,20);Debug.message("popup:returned");
}};
`
const pointer = cursorFile([{ width: 1, height: 1,
  payload: cursorDib({ width: 1, height: 1, depth: 24, xorRows: [[51,34,17]] }) }])

for (const binary of [false,true]) {
  test(`${binary ? 'bytecode' : 'source'}: a pre-popup leave cannot overwrite a newer script cursor, while new and legacy leaves still deliver`,
    { timeout: 60000 }, async () => {
      const clock = new Clock(), f = await headless({
        'startup.tjs': binary
          ? 'Scripts.compileStorage("leave.tjs","savedata/leave.cjs",false,true,false);Scripts.execStorage("savedata/leave.cjs");'
          : 'Scripts.execStorage("leave.tjs");',
        'leave.tjs': source, 'pointer.cur': pointer,
      }, { now: clock.now, schedule: clock.schedule }), failures: unknown[] = []
      let popupSettled = false
      let popupResult: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
      let delayedLeaveResult: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
      const until = async (predicate: () => boolean, description: string) => {
        const deadline = performance.now() + 10000
        while (!predicate()) {
          if (popupSettled) throw new Error(`Popup completed before ${description}: ${JSON.stringify(await popupResult)}`)
          assert(performance.now() < deadline, `Timed out waiting for ${description}: ${f.logs.join('|')}`)
          await new Promise<void>((resolve) => setTimeout(resolve, 1))
        }
      }
      try {
        await f.session.start(); await f.session.idle()
        if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
          .find((file) => file.path === 'savedata/leave.cjs')!.bytes.subarray(0,4)), 'TJS2')
        const id = Number(await f.session.evaluate('win.__windowId')),
          input = (): InputView => {
            const event = f.events.findLast((event) => event.type === 'window-input' && event.windowId === id)
            assert(event?.type === 'window-input')
            return event.input
          }, popup = () => {
            const event = f.events.findLast((event) => event.type === 'window-menus')
            return event?.type === 'window-menus'
              ? event.windows.find((window) => window.windowId === id)?.menus.popup : undefined
          }
        await f.session.acceptInput({ type: 'move', windowId: id, x: 10, y: 10,
          button: 0, clicks: 0, shift: 0, pointerSequence: 1 }).completion
        assert.equal(input().cursor, -3)
        const opening = f.session.acceptInput({ type: 'keyDown', windowId: id, key: 120, shift: 0 })
        popupResult = opening.completion.then(() => { popupSettled = true; return { ok: true as const } },
          (error: unknown) => { popupSettled = true; return { ok: false as const, error } })
        await until(() => !!popup(), 'real TJS popup')
        // Browser transport holds this callback behind the opening key. Its
        // separate physical RPC runs immediately, before the popup's Timer.
        f.session.pointerState(90,40,id,2)
        const queuedLeave = { type: 'leave' as const, windowId: id, pointerSequence: 2 }
        clock.advance(10)
        await until(() => f.logs.includes('cursor:changed'), 'Timer cursor replacement')
        assert.equal(popupSettled, false)
        f.session.menuDismiss(popup()!)
        const outcome = await popupResult
        if (!outcome.ok) throw outcome.error
        await f.session.idle()
        assert.equal(input().cursor, 2)
        const revision = input().virtualCursor?.revision
        assert.ok(revision)
        assert.equal(input().virtualCursor?.basePhysicalSequence, 2)
        assert.equal(await f.session.evaluate('root.cursorX+","+root.cursorY'), '12,14')
        await f.session.acceptInput(queuedLeave).completion
        assert.equal(await f.session.evaluate('leaveCount'), '0')
        assert.equal(input().cursor, 2)
        assert.equal(input().virtualCursor?.revision, revision)

        // Also cover an already admitted receipt, not just a packet delayed in
        // browser transport: validity must be checked again at callback time.
        await f.session.evaluate('System.eventDisabled=true')
        f.session.pointerState(90,40,id,3)
        const delayed = f.session.acceptInput({ type: 'leave', windowId: id, pointerSequence: 3 })
        delayedLeaveResult = delayed.completion.then(() => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }))
        assert.equal(delayed.status, 'accepted')
        await f.session.evaluate('moveScript();System.eventDisabled=false;')
        const delayedOutcome = await delayedLeaveResult
        if (!delayedOutcome.ok) throw delayedOutcome.error
        await f.session.idle()
        assert.equal(await f.session.evaluate('leaveCount'), '0')
        assert.equal(input().cursor, 2)
        assert.equal(input().virtualCursor?.basePhysicalSequence, 3)

        f.session.pointerState(91,41,id,4)
        await f.session.acceptInput({ type: 'leave', windowId: id, pointerSequence: 4 }).completion
        assert.equal(await f.session.evaluate('leaveCount'), '1')
        assert.equal(input().cursor, 0)
        assert.equal(input().virtualCursor ?? null, null)
        assert.equal(await f.session.evaluate('root.cursorX+","+root.cursorY'), '91,41')

        await f.session.evaluate('moveScript()'); await f.session.idle()
        assert.equal(input().cursor, 2)
        await f.session.acceptInput({ type: 'leave', windowId: id }).completion
        assert.equal(await f.session.evaluate('leaveCount'), '2', 'Legacy unsequenced embedding input remains deliverable')
        assert.equal(input().cursor, 0)
      } catch (error) { failures.push(error) }
      finally {
        try { await f.session.stop() } catch (error) { failures.push(error) }
        try {
          await popupResult
          await delayedLeaveResult
          assert.equal(f.session.snapshot().handles, 0)
          assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
          assert.equal(clock.tasks.size, 0)
        } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Cursor leave scenario or cleanup failed', { cause: failures[0] })
    })
}
