import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { EngineEvent } from '../../src/engine/session.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
function settings(events: EngineEvent[]) {
  const values = events.flatMap((event) => (event.type === 'input' || event.type === 'window-input') && event.input.gamepad
    ? [{ ...event.input.gamepad }] : [])
  assert(values.length > 0, 'No actual Session input settings were published')
  return values.at(-1)!
}
async function fixture(binary: boolean, script: string, args: [string, string][] = []) {
  const f = await headless({ 'startup.tjs': '', 'pad-settings.tjs': script }, { arguments: new Map(args) })
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("pad-settings.tjs","savedata/pad-settings.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/pad-settings.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("pad-settings.tjs")')
    await f.session.idle()
    return f
  } catch (error) { await f.session.stop(); throw error }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: first Window publishes default Gamepad options and later timing arguments use TJS integer conversion`, async () => {
    const f = await fixture(binary, String.raw`
System.exitOnWindowClose=false;
var padSettingsWindow=new Window();padSettingsWindow.visible=true;
function updateRepeat(){System.setArgument("-paddelay","0x20");System.setArgument("-padinterval","4294967326");}
function disableRepeat(){System.setArgument("-paddelay","-1");System.setArgument("-padinterval","0");}
`)
    try {
      assert.deepEqual(settings(f.events), { enabled: true, delay: 500, interval: 30 })
      await f.session.evaluate('updateRepeat()')
      assert.deepEqual(settings(f.events), { enabled: true, delay: 32, interval: 30 })
      assert.equal(await f.session.evaluate('System.getArgument("-padinterval")'), '4294967326')
      await f.session.evaluate('disableRepeat()')
      assert.deepEqual(settings(f.events), { enabled: true, delay: -1, interval: 0 })
      await f.session.evaluate('System.setArgument("unrelated","42")')
      assert.deepEqual(settings(f.events), { enabled: true, delay: -1, interval: 0 })
    } finally { await f.session.stop() }
  })

  test(`${mode}: joypad mode is fixed at the first Window while early and late repeat settings retain their distinct timing`, async () => {
    const f = await fixture(binary, String.raw`
System.exitOnWindowClose=false;
System.setArgument("-joypad","none");System.setArgument("-paddelay","42");
var padSettingsWindow=new Window();padSettingsWindow.visible=true;
function createAnother(){
  System.setArgument("-joypad","dinput");System.setArgument("-padinterval","15");
  global.secondPadSettingsWindow=new Window();secondPadSettingsWindow.visible=true;
}
`)
    try {
      assert.deepEqual(settings(f.events), { enabled: false, delay: 42, interval: 30 })
      await f.session.evaluate('createAnother()')
      assert.deepEqual(settings(f.events), { enabled: false, delay: 42, interval: 15 })
      assert.equal(await f.session.evaluate('System.getArgument("-joypad")'), 'dinput')
      const perWindow = f.events.filter((event) => event.type === 'window-input' && event.input.gamepad)
      assert(perWindow.length >= 2)
      assert(perWindow.every((event) => event.type === 'window-input' && event.input.gamepad!.enabled === false))
    } finally { await f.session.stop() }
  })

  test(`${mode}: dependency arguments configure the first pad with exact enable string and signed integer narrowing`, async () => {
    for (const [choice, enabled] of [['dinput', true], ['DINPUT', false], ['unknown', false]] as const) {
      const f = await fixture(binary, 'var padSettingsWindow=new Window();padSettingsWindow.visible=true;',
        [['-joypad', choice], ['-paddelay', '4294967295'], ['-padinterval', '0x20']])
      try {
        assert.deepEqual(settings(f.events), { enabled, delay: -1, interval: 32 })
      } finally { await f.session.stop() }
    }
  })
}
