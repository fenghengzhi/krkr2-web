import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { MenuPopup, MenuView } from '../../src/engine/scene/menus.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

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

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
interface Pending<T> {
  result: Promise<Outcome<T>>
  settled(): boolean
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function succeeded<T>(pending: Pending<T>, description = 'menu operation'): Promise<T> {
  const result = await bounded(pending.result, description)
  if (!result.ok) throw result.error
  return result.value
}

const definitions = String.raw`
System.exitOnWindowClose=false;
var trace=[],clicks=0,nextClicks=0,modalClicks=0;
function mark(text){trace.add(text);Debug.message(text);}
class MenuWindow extends Window {
  function MenuWindow(label,shown=false){
    super.Window();caption=label;setInnerSize(64,48);visible=shown;
  }
  function onCloseQuery(canClose){super.onCloseQuery(true);}
  function respond(){super.onCloseQuery(true);}
}
// Release a platform command before creating the visible tree. Recycling that
// Word must not recycle a view identity or make popup(R) return the view ID.
var retiredMenu=new MenuItem(null,"retired");invalidate retiredMenu;retiredMenu=null;
var a=new MenuWindow("menu-A",true),b=new MenuWindow("menu-B",true);
var modal=new MenuWindow("menu-modal");
var group=new MenuItem(b,"First popup"),item=new MenuItem(b,"First item"),sibling=new MenuItem(null,"Sibling");
a.menu.add(group);group.add(item);group.add(sibling);
item.onClick=function(){global.clicks++;mark("item:click");};
var nextGroup=new MenuItem(a,"Next popup"),nextItem=new MenuItem(a,"Next item");
b.menu.add(nextGroup);nextGroup.add(nextItem);
nextItem.onClick=function(){global.nextClicks++;mark("next:click");};
var modalGroup=new MenuItem(a,"Modal popup"),modalItem=new MenuItem(a,"Modal item");
modal.menu.add(modalGroup);modalGroup.add(modalItem);
modalItem.onClick=function(){global.modalClicks++;mark("modal:item-click");};
function run(){var result=group.popup(0,10,20);mark("run:after:"+result);return result;}
`

async function fixture(binary: boolean, body: string, duringStartup = false) {
  const clock = new Clock(),
    pending: Promise<unknown>[] = []
  const track = <T>(promise: Promise<T>): Pending<T> => {
    let settled = false
    const result = promise.then<Outcome<T>, Outcome<T>>(
      (value) => {
        settled = true
        return { ok: true, value }
      },
      (error: unknown) => {
        settled = true
        return { ok: false, error }
      },
    )
    // Observe each rejection immediately, including the input which owns an
    // outer popup and cannot complete while its descendant is still waiting.
    pending.push(result)
    return { result, settled: () => settled }
  }
  const harness = await headless(
    {
      'startup.tjs':
        (binary
          ? 'Scripts.compileStorage("menu-modal.tjs","savedata/menu-modal.cjs",false,true,false);Scripts.execStorage("savedata/menu-modal.cjs");'
          : 'Scripts.execStorage("menu-modal.tjs");') +
        (duringStartup ? 'run();mark("startup:after");' : ''),
      'menu-modal.tjs': definitions + '\n' + body,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  const { session, logs, events } = harness
  const windowView = (caption: string) => {
    const window = session.snapshot().windows?.find((entry) => entry.view.caption === caption)
    assert.ok(window, `Missing Window ${caption}`)
    return window
  }
  const menuSnapshots = () => {
    const event = [...events].reverse().find((entry) => entry.type === 'window-menus')
    return event?.type === 'window-menus' ? event.windows : []
  }
  const popup = () => menuSnapshots().find((entry) => entry.menus.popup)?.menus.popup
  const menuId = (caption: string) => {
    const find = (item: MenuView | undefined): MenuView | undefined =>
      item?.caption === caption ? item : item?.children.map(find).find(Boolean)
    const item = menuSnapshots()
      .map((entry) => find(entry.menus.root))
      .find(Boolean)
    assert.ok(item, `Missing menu ${caption}`)
    return item.id
  }
  const until = async (
    predicate: () => boolean,
    description: string,
    opening?: Pending<unknown>,
  ) => {
    const deadline = performance.now() + 10000
    while (!predicate()) {
      if (opening?.settled()) {
        const result = await opening.result
        assert.fail(
          `Menu ended before ${description}: ${JSON.stringify(result)}; ${logs.join('|')}`,
        )
      }
      assert.ok(
        performance.now() < deadline,
        `Timed out waiting for ${description}: ${JSON.stringify(session.inspectOwnership())}; ${logs.join('|')}`,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }
  const waitPopup = async (
    caption: string,
    depth: number,
    opening: Pending<unknown>,
    previous?: number,
  ): Promise<MenuPopup> => {
    await until(
      () => {
        const current = popup()
        return (
          !!current &&
          current.id === menuId(caption) &&
          current.requestId !== previous &&
          session.inspectOwnership().modalScopes === depth &&
          session.inspectOwnership().modalWaits === 1
        )
      },
      `${caption} at modal depth ${depth}`,
      opening,
    )
    assert.equal(opening.settled(), false)
    return popup()!
  }
  const settled = async <T>(operation: Pending<T>): Promise<T> => {
    const value = await succeeded(operation)
    await bounded(session.idle(), 'settle menu event/native/frame cleanup')
    assert.equal(session.inspectOwnership().modalScopes, 0)
    assert.equal(session.inspectOwnership().modalWaits, 0)
    assert.equal(session.inspectOwnership().eventReceipts, 0)
    assert.equal(session.inspectOwnership().eventCheckpoints, 0)
    return value
  }
  const stop = async () => {
    await bounded(session.stop(), 'stop menu Session')
    await bounded(Promise.all(pending), 'settle cancelled menu operations')
    assert.equal(session.snapshot().state, 'stopped')
    assert.equal(session.snapshot().handles, 0)
    assert.ok(
      Object.values(session.inspectOwnership()).every((count) => count === 0),
      JSON.stringify(session.inspectOwnership()),
    )
    assert.equal(clock.tasks.size, 0)
  }
  try {
    const starting = track(session.start())
    if (duringStartup) await waitPopup('First popup', 1, starting)
    else {
      await succeeded(starting, 'start menu fixture')
      await bounded(session.idle(), 'settle menu fixture startup')
    }
    return {
      ...harness,
      clock,
      track,
      windowView,
      menuId,
      popup,
      until,
      waitPopup,
      settled,
      stop,
      starting,
      open: (expression = 'run()') => track(session.evaluate(expression)),
      choose(id: number, identity: MenuPopup) {
        const admission = session.acceptMenuClick(id, identity)
        return { status: admission.status, ...track(admission.completion) }
      },
      key(caption: string, key: number) {
        const admission = session.acceptInput({
          type: 'keyDown',
          windowId: windowView(caption).id,
          key,
          shift: 0,
        })
        return { status: admission.status, ...track(admission.completion) }
      },
    }
  } catch (error) {
    await stop()
    throw error
  }
}

function before(logs: string[], first: string, second: string) {
  assert.ok(logs.includes(first), `Missing ${first}: ${logs.join('|')}`)
  assert.ok(logs.includes(second), `Missing ${second}: ${logs.join('|')}`)
  assert.ok(
    logs.indexOf(first) < logs.indexOf(second),
    `${first} must precede ${second}: ${logs.join('|')}`,
  )
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: startup popup pumps Timer and AsyncTrigger before returning and queues selection after its caller resumes`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var trigger=new AsyncTrigger(function(){mark("trigger:inside");},"");
var timer=new Timer(function(){timer.enabled=false;mark("timer:inside");trigger.trigger();},"");timer.interval=10;
run=function(){var local=["kept",37];mark("run:before");timer.enabled=true;
  var result=group.popup(0,10,20);mark("run:after:"+result+":"+local[0]+":"+local[1]);return result;};
`,
      true,
    )
    try {
      const popup = f.popup()!
      f.clock.advance(10)
      await f.until(
        () => f.logs.includes('trigger:inside'),
        'startup Timer and trigger',
        f.starting,
      )
      assert.equal(f.starting.settled(), false)
      assert.ok(!f.logs.includes('startup:after'))
      await succeeded(f.choose(f.menuId('First item'), popup))
      await f.settled(f.starting)
      before(f.logs, 'run:before', 'timer:inside')
      before(f.logs, 'timer:inside', 'trigger:inside')
      before(f.logs, 'trigger:inside', 'run:after:1:kept:37')
      before(f.logs, 'run:after:1:kept:37', 'startup:after')
      before(f.logs, 'startup:after', 'item:click')
      assert.equal(f.logs.filter((entry) => entry === 'item:click').length, 1)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a menu opened from a host input callback accepts its selection while the original callback is still suspended`, async () => {
    const f = await fixture(
      binary,
      String.raw`
a.onKeyDown=function(key,shift){if(key==65){mark("input:before");run();mark("input:after");}};
`,
    )
    try {
      const input = f.key('menu-A', 65)
      assert.equal(input.status, 'accepted')
      const popup = await f.waitPopup('First popup', 1, input)
      assert.equal(input.settled(), false)
      await succeeded(f.choose(f.menuId('First item'), popup))
      await f.settled(input)
      before(f.logs, 'input:before', 'run:after:1')
      before(f.logs, 'run:after:1', 'input:after')
      before(f.logs, 'input:after', 'item:click')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: popup returns BOOL or an independent stable Word command and preserves flags below an imprecise Number boundary`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){
  var flags=[0,tpmReturnCmd,tpmNoNotify,tpmNoNotify|tpmReturnCmd,4611686018427388160],results=[];
  for(var i=0;i<flags.count;i++){
    if(i==2)item.index=1;
    results.add(group.popup(flags[i],10,20));mark("flags:return:"+i);
  }
  return results.join(",");
};
`,
    )
    try {
      const item = f.menuId('First item'),
        opening = f.open()
      let request: number | undefined
      for (const flags of [0, 0x100, 0x80, 0x180, 0x100]) {
        const popup = await f.waitPopup('First popup', 1, opening, request)
        request = popup.requestId
        assert.equal(popup.flags, flags)
        await succeeded(f.choose(item, popup))
      }
      const results = (await f.settled(opening)).split(',').map(Number)
      assert.equal(results.length, 5)
      assert.equal(results[0], 1)
      assert.equal(results[2], 1)
      assert.ok(Number.isInteger(results[1]) && results[1]! > 0 && results[1]! <= 0xffff)
      assert.notEqual(results[1], item)
      assert.equal(results[3], results[1])
      assert.equal(results[4], results[1])
      // N-only follows the documented Web policy; hosted Win32 synthetic-key
      // observations disagree, so this is not an original-VCL compatibility claim.
      assert.equal(f.logs.filter((entry) => entry === 'item:click').length, 1)
      before(f.logs, 'flags:return:0', 'item:click')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: ordinary cancellation returns BOOL or zero for R and stale cancellation identities cannot end the next popup`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){var first=group.popup(0,10,20);mark("cancel:first:"+first);
  var second=group.popup(tpmReturnCmd,10,20);return first+","+second;};
`,
    )
    try {
      const opening = f.open(),
        first = await f.waitPopup('First popup', 1, opening)
      f.session.menuDismiss(first)
      const second = await f.waitPopup('First popup', 1, opening, first.requestId)
      f.session.menuDismiss(first)
      await succeeded(f.choose(f.menuId('First item'), first))
      assert.equal(f.popup()?.requestId, second.requestId)
      assert.equal(opening.settled(), false)
      f.session.menuDismiss(second)
      assert.equal(await f.settled(opening), '1,0')
      assert.ok(!f.logs.includes('item:click'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a Timer popup without recurse returns zero while preserving the original popup and its caller`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;mark("nested:before");
  var result=nextGroup.popup(0,30,40);mark("nested:after:"+result);},"");timer.interval=10;
run=function(){timer.enabled=true;return group.popup(0,10,20);};
`,
    )
    try {
      const opening = f.open(),
        first = await f.waitPopup('First popup', 1, opening)
      f.clock.advance(10)
      await f.until(() => f.logs.includes('nested:after:0'), 'rejected recursive popup', opening)
      assert.equal(f.popup()?.requestId, first.requestId)
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.includes('next:click'))
      await succeeded(f.choose(f.menuId('First item'), first))
      assert.equal(await f.settled(opening), '1')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a recursive popup restores the parent request and dispatches its selected notification after the child returns`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;mark("child:before");
  var result=nextGroup.popup(tpmRecurse,30,40);mark("child:after:"+result);},"");timer.interval=10;
run=function(){timer.enabled=true;var result=group.popup(0,10,20);mark("parent:after:"+result);return result;};
`,
    )
    try {
      const opening = f.open(),
        parent = await f.waitPopup('First popup', 1, opening)
      f.clock.advance(10)
      const child = await f.waitPopup('Next popup', 2, opening)
      assert.notEqual(child.requestId, parent.requestId)
      await succeeded(f.choose(f.menuId('Next item'), child))
      const restored = await f.waitPopup('First popup', 1, opening)
      assert.equal(restored.requestId, parent.requestId)
      await f.until(() => f.logs.includes('next:click'), 'child post-return notification', opening)
      before(f.logs, 'child:after:1', 'next:click')
      assert.ok(!f.logs.includes('parent:after:1'))
      await succeeded(f.choose(f.menuId('Next item'), child))
      f.session.menuDismiss(child)
      assert.equal(f.popup()?.requestId, parent.requestId)
      await succeeded(f.choose(f.menuId('First item'), parent))
      assert.equal(await f.settled(opening), '1')
      before(f.logs, 'next:click', 'parent:after:1')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a child Window cancels its blocked parent's menu UI without ending the child modal frame`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var pulse=new Timer(function(){pulse.enabled=false;mark("window:pulse");},"");pulse.interval=10;
var timer=new Timer(function(){timer.enabled=false;mark("window:before");pulse.enabled=true;
  modal.showModal();mark("window:after");},"");timer.interval=10;
modal.onKeyDown=function(key,shift){if(key==13){modal.respond();mark("window:accepted");}};
run=function(){timer.enabled=true;var result=group.popup(0,10,20);mark("menu:after:"+result);return result;};
`,
    )
    try {
      const opening = f.open(),
        popup = await f.waitPopup('First popup', 1, opening)
      f.clock.advance(10)
      await f.until(
        () =>
          f.session.inspectOwnership().modalScopes === 2 &&
          f.session.inspectOwnership().modalWaits === 1 &&
          f.windowView('menu-modal').view.visible,
        'nested Window modal',
        opening,
      )
      assert.equal(f.popup(), undefined)
      assert.equal(f.windowView('menu-A').view.blocked, true)
      assert.equal(f.windowView('menu-modal').view.blocked, false)
      f.clock.advance(10)
      await f.until(
        () => f.logs.includes('window:pulse'),
        'Timer in surviving child Window',
        opening,
      )
      await succeeded(f.choose(f.menuId('First item'), popup))
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.includes('window:after'))
      assert.ok(!f.logs.includes('menu:after:0'))
      await succeeded(f.key('menu-modal', 13))
      assert.equal(await f.settled(opening), '0')
      before(f.logs, 'window:pulse', 'window:accepted')
      before(f.logs, 'window:accepted', 'window:after')
      before(f.logs, 'window:after', 'menu:after:0')
      assert.ok(!f.logs.includes('item:click'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a modal Window opens its own popup while blocked Window menu input stays disabled`, async () => {
    const f = await fixture(
      binary,
      String.raw`
modal.onKeyDown=function(key,shift){if(key==65){mark("modal:before-popup");
  var result=modalGroup.popup(0,10,20);mark("modal:after-popup:"+result);}};
run=function(){modal.showModal();mark("window:after");return "complete";};
`,
    )
    try {
      const opening = f.open()
      await f.until(
        () =>
          f.session.inspectOwnership().modalScopes === 1 &&
          f.session.inspectOwnership().modalWaits === 1,
        'outer Window wait',
        opening,
      )
      const input = f.key('menu-modal', 65),
        popup = await f.waitPopup('Modal popup', 2, opening)
      const blocked = f.session.acceptMenuClick(f.menuId('First item'))
      assert.equal(blocked.status, 'ignored')
      await succeeded(f.track(blocked.completion))
      assert.equal(input.settled(), false)
      await succeeded(f.choose(f.menuId('Modal item'), popup))
      await succeeded(input, 'input after its popup returns')
      await f.until(() => f.logs.includes('modal:item-click'), 'modal menu notification', opening)
      before(f.logs, 'modal:after-popup:1', 'modal:item-click')
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.includes('item:click'))
      await succeeded(f.track(f.session.closeWindow(f.windowView('menu-modal').id)))
      assert.equal(await f.settled(opening), 'complete')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a selected notification ignores later UI visibility, separator and submenu changes and can run in the caller's next modal`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){var result=group.popup(0,10,20);mark("first:returned:"+result);
  item.visible=false;item.caption="-";item.add(new MenuItem(null,"New child"));
  mark("ui:changed");var second=nextGroup.popup(tpmReturnCmd,30,40);
  mark("second:returned:"+second);return result+","+second;};
`,
    )
    try {
      const item = f.menuId('First item'),
        opening = f.open(),
        first = await f.waitPopup('First popup', 1, opening)
      await succeeded(f.choose(item, first))
      const second = await f.waitPopup('Next popup', 1, opening)
      await f.until(() => f.logs.includes('item:click'), 'post-return native notification', opening)
      before(f.logs, 'first:returned:1', 'ui:changed')
      before(f.logs, 'ui:changed', 'item:click')
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.includes('second:returned:0'))
      f.session.menuDismiss(second)
      assert.equal(await f.settled(opening), '1,0')
      const newClick = f.session.acceptMenuClick(item)
      assert.equal(newClick.status, 'ignored')
      await succeeded(f.track(newClick.completion))
      assert.equal(f.logs.filter((entry) => entry === 'item:click').length, 1)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a selected notification follows current native Parent ancestry while its old DOM request cannot follow the move`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){var result=group.popup(0,10,20);mark("first:returned:"+result);
  nextGroup.add(item);a.visible=false;mark("item:moved");
  var second=nextGroup.popup(tpmReturnCmd,30,40);return result+","+second;};
`,
    )
    try {
      const item = f.menuId('First item'),
        opening = f.open(),
        first = await f.waitPopup('First popup', 1, opening)
      await succeeded(f.choose(item, first))
      const second = await f.waitPopup('Next popup', 1, opening)
      await f.until(
        () => f.logs.includes('item:click'),
        'notification in current owner Window',
        opening,
      )
      before(f.logs, 'first:returned:1', 'item:moved')
      before(f.logs, 'item:moved', 'item:click')
      assert.equal(f.windowView('menu-A').view.visible, false)
      assert.equal(second.windowId, f.windowView('menu-B').id)
      await succeeded(f.choose(item, first))
      assert.equal(f.popup()?.requestId, second.requestId)
      f.session.menuDismiss(second)
      assert.equal(await f.settled(opening), '1,0')
      assert.equal(f.logs.filter((entry) => entry === 'item:click').length, 1)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: pending selected notifications recheck enabled ancestry, native lifetime and current Window visibility at delivery`, async () => {
    for (const mutation of ['group.enabled=false;', 'invalidate item;', 'a.visible=false;']) {
      const f = await fixture(
        binary,
        String.raw`
var timer=new Timer(function(){timer.enabled=false;mark("delivery:barrier");},"");timer.interval=10;
run=function(){var result=group.popup(0,10,20);mark("first:returned:"+result);
  ` +
          mutation +
          String.raw`
  timer.enabled=true;mark("delivery:changed");
  var second=nextGroup.popup(tpmReturnCmd,30,40);return result+","+second;};
`,
      )
      try {
        const opening = f.open(),
          first = await f.waitPopup('First popup', 1, opening)
        await succeeded(f.choose(f.menuId('First item'), first))
        const second = await f.waitPopup('Next popup', 1, opening)
        f.clock.advance(10)
        // A real normal-priority Timer has run after the queued input group;
        // absence of a click is not inferred from a short arbitrary sleep.
        await f.until(
          () => f.logs.includes('delivery:barrier'),
          `delivery barrier after ${mutation}`,
          opening,
        )
        assert.ok(!f.logs.includes('item:click'), mutation)
        f.session.menuDismiss(second)
        assert.equal(await f.settled(opening), '1,0', mutation)
        assert.ok(!f.logs.includes('item:click'), mutation)
      } finally {
        await f.stop()
      }
    }
  })

  test(`${mode}: pause cancels popup availability without resuming TJS and Stop releases nested menu frames and every receipt`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;mark("nested:before-stop");
  nextGroup.popup(tpmRecurse,30,40);mark("nested:after-stop");},"");timer.interval=10;
function runNested(){timer.enabled=true;return group.popup(0,10,20);}
`,
    )
    try {
      const opening = f.open()
      await f.waitPopup('First popup', 1, opening)
      f.session.pause()
      await f.until(
        () => f.session.snapshot().state === 'paused' && !f.popup(),
        'paused popup removal',
      )
      f.clock.advance(50)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.includes('run:after:0'))
      f.session.resume()
      assert.equal(await f.settled(opening), '0')
      assert.ok(!f.logs.includes('item:click'))
      const nested = f.open('runNested()')
      await f.waitPopup('First popup', 1, nested)
      f.clock.advance(10)
      await f.waitPopup('Next popup', 2, nested)
      assert.equal(nested.settled(), false)
      await f.stop()
      assert.equal((await bounded(nested.result, 'cancel nested popup caller')).ok, false)
      assert.ok(!f.logs.includes('nested:after-stop'))
      assert.equal(f.popup(), undefined)
    } finally {
      await f.stop()
    }
  })
}
