import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { menuLifetimeScript } from '../helpers/menu-lifetime-script.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'

async function fixture(binary: boolean, extra = '', overrides: Partial<SessionDependencies> = {}) {
  const harness = await headless(
    {
      'startup.tjs': '',
      'menu-lifetime.tjs': menuLifetimeScript + '\n' + extra,
      'gate.tjs': 'menu-lifetime-gate',
    },
    overrides,
  )
  const { session } = harness
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("menu-lifetime.tjs","savedata/menu-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/menu-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("menu-lifetime.tjs")')
    await execute(
      'var warm=new OwnedMenu();warm.children;invalidate warm;delete global.warm;menuItemDeaths=0;try{throw new Exception("warm");}catch(e){}',
    )
    const baseline = session.inspectOwnership(),
      handles = session.snapshot().handles
    return {
      ...harness,
      execute,
      baseline,
      async restored() {
        await session.idle()
        assert.deepEqual(session.inspectOwnership(), baseline)
        assert.equal(session.snapshot().handles, handles)
      },
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(
    `${mode}: an unreferenced MenuItem releases native state and its action owner`,
    { timeout: 60000 },
    async () => {
      const f = await fixture(binary)
      try {
        await f.execute(
          'var owner=new MenuActionOwner(),item=new OwnedMenu(owner);delete global.owner;',
        )
        assert.equal(await f.session.evaluate('menuOwnerDeaths'), '0')
        assert.equal(f.session.inspectOwnership().menuSources, 1)
        await f.execute('delete global.item;')
        assert.equal(await f.session.evaluate('menuOwnerDeaths+","+menuItemDeaths'), '1,1')
        await f.restored()
      } finally {
        await f.session.stop()
      }
    },
  )
  test(
    `${mode}: Menu children retain items independently of the mutable cached Array`,
    { timeout: 60000 },
    async () => {
      const f = await fixture(binary)
      try {
        await f.execute(
          'var parent=new MenuItem(null);parent.add(new OwnedMenu());var cache=parent.children;cache.clear();',
        )
        assert.equal(await f.session.evaluate('menuItemDeaths+","+parent.children.count'), '0,0')
        await f.execute('delete global.parent;')
        assert.equal(await f.session.evaluate('menuItemDeaths+","+(isvalid cache)'), '1,1')
        await f.execute('delete global.cache;')
        await f.restored()
      } finally {
        await f.session.stop()
      }
    },
  )
  test(
    `${mode}: removing a later child during Menu invalidation removes its pending visit`,
    { timeout: 60000 },
    async () => {
      const f = await fixture(
        binary,
        `
class RemovingMenu extends MenuItem {
  function RemovingMenu(){super.MenuItem(null);}
  function finalize(){global.parent.remove(global.second);}
}
`,
      )
      try {
        await f.execute(
          'var parent=new MenuItem(null),first=new RemovingMenu(),second=new OwnedMenu();parent.add(first);parent.add(second);invalidate parent;',
        )
        assert.equal(
          await f.session.evaluate(
            '(isvalid first)+","+(isvalid second)+","+menuItemDeaths+","+(second.parent===null)',
          ),
          '0,1,0,1',
        )
        await f.execute('delete global.parent;delete global.first;delete global.second;')
        assert.equal(await f.session.evaluate('menuItemDeaths'), '1')
        await f.restored()
      } finally {
        await f.session.stop()
      }
    },
  )
  test(
    `${mode}: reparenting transfers Menu ownership and invalid cached children keep their identity`,
    { timeout: 60000 },
    async () => {
      const f = await fixture(binary)
      try {
        await f.execute(
          'var a=new MenuItem(null),b=new MenuItem(null),child=new OwnedMenu();a.add(child);b.add(child);invalidate a;var cache=b.children;invalidate cache;b.add(new OwnedMenu());',
        )
        assert.equal(
          await f.session.evaluate(
            '(child.parent===b)+","+(isvalid child)+","+(b.children===cache)+","+(isvalid b.children)',
          ),
          '1,1,1,0',
        )
        await f.execute(
          'invalidate b;delete global.a;delete global.b;delete global.child;delete global.cache;',
        )
        assert.equal(await f.session.evaluate('menuItemDeaths'), '2')
        await f.restored()
      } finally {
        await f.session.stop()
      }
    },
  )
  test(
    `${mode}: Menu input ignores a modified children cache and drops an invalidated queued target`,
    { timeout: 60000 },
    async () => {
      let entered!: () => void, finish!: (source: string) => void
      const ready = new Promise<void>((resolve) => {
          entered = resolve
        }),
        gate = new Promise<string>((resolve) => {
          finish = resolve
        })
      const f = await fixture(
        binary,
        'var clicks=0;class ClickMenu extends MenuItem {function ClickMenu(){super.MenuItem(null,"click");}function onClick(){clicks++;}}',
        {
          decodeScript(bytes, mode, encoding) {
            const source = new TextDecoder().decode(bytes)
            if (source === 'menu-lifetime-gate') {
              entered()
              return gate
            }
            return readScript(bytes, mode, encoding)
          },
        },
      )
      try {
        await f.execute(
          'var win=new Window();win.visible=true;var item=new ClickMenu();win.menu.add(item);win.menu.children.clear();',
        )
        const id = Number(await f.session.evaluate('item.__menuId'))
        await f.session.menuClick(id)
        assert.equal(await f.session.evaluate('clicks'), '1')
        const reading = f.session.evaluate('Scripts.execStorage("gate.tjs")')
        await ready
        const click = f.session.menuClick(id)
        finish('invalidate item;delete global.item;')
        await Promise.all([reading, click])
        assert.equal(await f.session.evaluate('clicks'), '1')
        await f.execute('invalidate win;delete global.win;')
        await f.restored()
      } finally {
        finish('0;')
        await f.session.stop()
      }
    },
  )
  test(
    `${mode}: an in-flight Menu callback owns its target through host suspension`,
    { timeout: 60000 },
    async () => {
      let entered!: () => void, finish!: (source: string) => void
      const ready = new Promise<void>((resolve) => {
          entered = resolve
        }),
        gate = new Promise<string>((resolve) => {
          finish = resolve
        })
      const f = await fixture(
        binary,
        `
var clicks=0;
class SuspendingMenu extends OwnedMenu {
  function SuspendingMenu(){super.OwnedMenu(null,"click");}
  function onClick(){win.menu.remove(this);delete global.item;Scripts.execStorage("gate.tjs");clicks++;}
}`,
        {
          decodeScript(bytes, mode, encoding) {
            const source = new TextDecoder().decode(bytes)
            if (source === 'menu-lifetime-gate') {
              entered()
              return gate
            }
            return readScript(bytes, mode, encoding)
          },
        },
      )
      try {
        await f.execute(
          'var win=new Window();win.visible=true;var item=new SuspendingMenu();win.menu.add(item);',
        )
        const id = Number(await f.session.evaluate('item.__menuId')),
          before = f.session.inspectOwnership().menuSources
        const click = f.session.menuClick(id)
        await ready
        assert.equal(f.session.inspectOwnership().menuSources, before)
        finish('0;')
        await click
        assert.equal(
          await f.session.evaluate('clicks+","+menuItemDeaths'),
          '1,1',
          f.logs.join('\n'),
        )
        assert.equal(f.session.inspectOwnership().menuSources, before - 1)
        await f.execute('invalidate win;delete global.win;')
        await f.restored()
      } finally {
        finish('0;')
        await f.session.stop()
      }
    },
  )
}
