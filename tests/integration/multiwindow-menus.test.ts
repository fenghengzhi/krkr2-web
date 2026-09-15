import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import type { MenuPopup, WindowMenus } from '../../src/engine/scene/menus.ts'

const script = String.raw`
System.exitOnWindowClose=false;
var a=new Window(),b=new Window(),aClicks=0,bClicks=0;
a.visible=b.visible=true;
var aGroup=new MenuItem(null,"A"),bGroup=new MenuItem(null,"B");
a.menu.add(aGroup);b.menu.add(bGroup);
// Both action owners deliberately differ from the menu's display Window.
var aItem=new MenuItem(b,"A item"),bItem=new MenuItem(a,"B item");
aGroup.add(aItem);bGroup.add(bItem);
aItem.onClick=function(){global.aClicks++;};
bItem.onClick=function(){global.bClicks++;};
`

async function fixture(binary: boolean, overrides: Partial<SessionDependencies> = {}) {
  const harness = await headless(
    { 'startup.tjs': '', 'multiwindow-menus.tjs': script, 'gate.tjs': 'multiwindow-menu-gate' },
    overrides,
  )
  const { session } = harness
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("multiwindow-menus.tjs","savedata/multiwindow-menus.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/multiwindow-menus.cjs")')
    } else await session.evaluate('Scripts.execStorage("multiwindow-menus.tjs")')
    return {
      ...harness,
      execute,
      aItem: Number(await session.evaluate('aItem.__menuId')),
      bItem: Number(await session.evaluate('bItem.__menuId')),
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(
    `${mode}: menu input uses its display Window independently of action owner and active Window`,
    { timeout: 60000 },
    async () => {
      const f = await fixture(binary)
      try {
        await f.session.menuClick(f.aItem)
        await f.session.menuClick(f.bItem)
        assert.equal(await f.session.evaluate('aClicks+","+bClicks'), '1,1')
        await f.execute('a.visible=false;')
        await f.session.menuClick(f.aItem)
        await f.session.menuClick(f.bItem)
        assert.equal(await f.session.evaluate('aClicks+","+bClicks'), '1,2')
        await f.execute('a.visible=true;b.visible=false;')
        await f.session.menuClick(f.aItem)
        await f.session.menuClick(f.bItem)
        assert.equal(await f.session.evaluate('aClicks+","+bClicks'), '2,2')
        assert.equal(
          await f.session.evaluate('(aItem.window===null)+","+(bItem.window===null)'),
          '1,1',
        )
      } finally {
        await f.session.stop()
      }
    },
  )

  test(
    `${mode}: moving a menu across windows survives invalidation of its former display Window`,
    { timeout: 60000 },
    async () => {
      const f = await fixture(binary)
      try {
        await f.execute('b.menu.add(aGroup);a.visible=false;')
        await f.session.menuClick(f.aItem)
        assert.equal(await f.session.evaluate('aClicks'), '1')
        assert.equal(
          await f.session.evaluate('(aGroup.parent===b.menu)+","+(aGroup.root===b.menu)'),
          '1,1',
        )
        await f.execute('invalidate a;')
        await f.session.menuClick(f.aItem)
        await f.session.menuClick(f.bItem)
        assert.equal(await f.session.evaluate('aClicks+","+bClicks'), '2,1')
        assert.equal(
          await f.session.evaluate('(isvalid aItem)+","+(isvalid bItem)+","+(isvalid b)'),
          '1,1,1',
        )
      } finally {
        await f.session.stop()
      }
    },
  )

  test(
    `${mode}: Session publishes per-window menus and popup responses cannot cross their owner Window`,
    { timeout: 60000 },
    async () => {
      let snapshots: WindowMenus[] = [],
        open: ((popup: MenuPopup) => void) | undefined
      const f = await fixture(binary, {
        event(event) {
          if (event.type !== 'window-menus') return
          snapshots = event.windows
          const popup = snapshots.find((entry) => entry.menus.popup)?.menus.popup
          if (popup) open?.(popup)
        },
      })
      try {
        const aId = Number(await f.session.evaluate('a.__windowId')),
          bId = Number(await f.session.evaluate('b.__windowId'))
        assert.deepEqual(
          snapshots.map((entry) => entry.windowId),
          [aId, bId],
        )
        assert.deepEqual(
          snapshots.map((entry) => entry.menus.root?.children[0]?.caption),
          ['A', 'B'],
        )
        const ready = new Promise<MenuPopup>((resolve) => {
            open = resolve
          }),
          result = f.session.evaluate('bGroup.popup(0,20,30)'),
          popup = await ready
        void result.catch(() => {})
        assert.equal(popup.windowId, bId)
        assert.equal(snapshots.find((entry) => entry.windowId === aId)?.menus.popup, undefined)
        f.session.menuDismiss({ windowId: aId, requestId: popup.requestId })
        await f.session.menuClick(f.aItem, popup)
        assert.equal(
          snapshots.find((entry) => entry.windowId === bId)?.menus.popup?.requestId,
          popup.requestId,
        )
        await f.session.menuClick(f.bItem, popup)
        assert.equal(await result, String(f.bItem))
        assert.equal(await f.session.evaluate('aClicks+","+bClicks'), '0,1')
      } finally {
        f.session.menuDismiss()
        await f.session.stop()
      }
    },
  )

  test(
    `${mode}: Session rejects old popup request identities after reopening the same menu`,
    { timeout: 60000 },
    async () => {
      let open: ((popup: MenuPopup) => void) | undefined
      const state: { popup?: MenuPopup } = {}
      const f = await fixture(binary, {
        event(event) {
          if (event.type !== 'window-menus') return
          state.popup = event.windows.find((entry) => entry.menus.popup)?.menus.popup
          if (state.popup) open?.(state.popup)
        },
      })
      const show = async () => {
        const ready = new Promise<MenuPopup>((resolve) => {
            open = resolve
          }),
          result = f.session.evaluate('aGroup.popup(0,20,30)')
        void result.catch(() => {})
        return { result, popup: await ready }
      }
      try {
        const first = await show()
        f.session.menuDismiss(first.popup)
        assert.equal(await first.result, '0')
        const second = await show()
        assert.notEqual(first.popup.requestId, second.popup.requestId)
        f.session.menuDismiss(first.popup)
        await f.session.menuClick(f.aItem, first.popup)
        assert.equal(state.popup?.requestId, second.popup.requestId)
        await f.session.menuClick(f.aItem, second.popup)
        assert.equal(await second.result, String(f.aItem))
        assert.equal(await f.session.evaluate('aClicks'), '1')
        // The same reply must not become an ordinary menu click after the wait ends.
        await f.session.menuClick(f.aItem, second.popup)
        assert.equal(await f.session.evaluate('aClicks'), '1')
      } finally {
        f.session.menuDismiss()
        await f.session.stop()
      }
    },
  )

  for (const reparent of [false, true]) {
    test(
      `${mode}: a queued menu click cannot follow ${reparent ? 'a reparented item into another Window' : 'a retired Window'}, and the surviving Window keeps accepting clicks`,
      { timeout: 60000 },
      async () => {
        let entered!: () => void, finish!: (source: string) => void
        const ready = new Promise<void>((resolve) => {
            entered = resolve
          }),
          gate = new Promise<string>((resolve) => {
            finish = resolve
          })
        const f = await fixture(binary, {
          decodeScript(bytes, mode, encoding) {
            if (new TextDecoder().decode(bytes) === 'multiwindow-menu-gate') {
              entered()
              return gate
            }
            return readScript(bytes, mode, encoding)
          },
        })
        try {
          const reading = f.session.evaluate('Scripts.execStorage("gate.tjs")')
          await ready
          const click = f.session.menuClick(f.aItem)
          finish(reparent ? 'b.menu.add(aGroup);' : 'invalidate a;')
          await Promise.all([reading, click])
          assert.equal(await f.session.evaluate('aClicks+","+bClicks'), '0,0')
          await f.session.menuClick(f.bItem)
          assert.equal(await f.session.evaluate('bClicks'), '1')
          await f.session.menuClick(f.aItem)
          assert.equal(await f.session.evaluate('aClicks'), reparent ? '1' : '0')
        } finally {
          finish('0;')
          await f.session.stop()
          assert.equal(f.session.snapshot().handles, 0)
        }
      },
    )
  }
}
