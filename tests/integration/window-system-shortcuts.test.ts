import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { WindowSystemShortcuts } from '../../src/engine/input/system-shortcuts.ts'

test('system shortcut options retain ordinary VCL key names and distinguish unknown locale names from missing keys', () => {
  for (const [name, key, shift] of [['Ctrl+Del', 46, 4], ['Shift+PageUp', 33, 1], ['Alt+Page Down', 34, 2],
    ['Ctrl+;', 186, 4], ['Ctrl++', 187, 4], ['Shift+Num +', 107, 1], ['Ctrl+Num 5', 101, 4], ['T', 84, 0]] as const) {
    const shortcuts = new WindowSystemShortcuts(new Map([['-hkconsole', name], ['-hkcontroller', '']]))
    assert.equal(shortcuts.match(key, shift), 'console', name)
    assert.equal(shortcuts.match(key, shift ^ 1), undefined, name)
  }
  const warnings: string[] = [], unknown = new WindowSystemShortcuts(
    new Map([['-hkconsole', 'Ctrl+Unknown localized key'], ['-hkcontroller', '']]), (message) => warnings.push(message))
  assert.equal(unknown.match(115, 1), undefined)
  assert.deepEqual(warnings, ['Unsupported system shortcut -hkconsole=Ctrl+Unknown localized key; command key disabled'])
  assert.throws(() => new WindowSystemShortcuts(new Map([['-hkconsole', 'Ctrl+']])), /Invalid -hkconsole shortcut/)
})

const source = String.raw`
var keyLog=[];
class ShortcutWindow extends Window {
 function ShortcutWindow(){super.Window();}
 function onKeyDown(key,shift){global.keyLog.add(key+":"+shift);}
}
var shortcutWindow=new ShortcutWindow();shortcutWindow.visible=true;
Debug.console.visible=false;Debug.controller.visible=false;
`
for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: physical system shortcuts toggle existing panels while posted and disabled keys reach the game`, async () => {
    const files = { 'keys.tjs': source, 'startup.tjs': binary
      ? 'Scripts.compileStorage("keys.tjs","savedata/keys.cjs",false,true,false);Scripts.execStorage("savedata/keys.cjs");'
      : 'Scripts.execStorage("keys.tjs");' }
    for (const configured of [false, true]) {
      const f = await headless(files, { arguments: configured
        ? new Map([['-hkconsole', ''], ['-hkcontroller', 'Ctrl+K']]) : undefined })
      try {
        await f.session.start()
        const press = (key: number, shift: number) => f.session.input({ type: 'keyDown', key, shift }),
          read = (expression: string) => f.session.evaluate(expression)
        await press(115, 1)
        assert.equal(await read('[int(Debug.console.visible),keyLog.join(",")].join("|")'), configured ? '0|115:1' : '1|')
        await press(112, 1)
        assert.equal(await read('[int(Debug.controller.visible),keyLog.join(",")].join("|")'), configured ? '0|115:1,112:1' : '1|')
        if (configured) {
          await press(75, 4)
          assert.equal(await read('int(Debug.controller.visible)'), '1')
          assert.equal(await read('keyLog.join(",")'), '115:1,112:1')
        } else {
          await press(115, 1)
          assert.equal(await read('int(Debug.console.visible)'), '0')
        }
        await read('shortcutWindow.postInputEvent("onKeyDown",%[key:VK_F4,shift:ssShift])')
        await f.session.idle()
        assert.equal(await read('keyLog.join(",")'), configured ? '115:1,112:1,115:1' : '115:1')
        assert.equal(await read('int(Debug.console.visible)'), '0')
        if (!configured) {
          await read('System.eventDisabled=true')
          await press(115, 1)
          assert.equal(await read('[int(Debug.console.visible),keyLog.count].join("|")'), '1|1')
          await press(115, 1)
          await read('System.eventDisabled=false'); await f.session.idle()
          assert.equal(await read('[int(Debug.console.visible),keyLog.count].join("|")'), '0|1', 'Built-in Form commands do not enqueue a delayed game key')
        }
        await f.session.input({ type: 'keyDown', key: 115, shift: 1, metaKey: true })
        assert.equal(await read('[int(Debug.console.visible),keyLog.count].join("|")'), configured ? '0|4' : '0|2', 'Meta-modified input stays a game key just as in the DOM')
      } finally { await f.session.stop() }
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    }
    const blocked = await headless(files, { arguments: new Map([['-debugwin', 'no']]) })
    try {
      await blocked.session.start()
      await blocked.session.input({ type: 'keyDown', key: 115, shift: 1 })
      assert.equal(await blocked.session.evaluate('[int(Debug.console.visible),keyLog.count].join("|")'), '0|0')
    } finally { await blocked.session.stop() }
    assert(Object.values(blocked.session.inspectOwnership()).every((value) => value === 0))
  })
