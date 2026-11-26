import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

const observe = readFileSync(new URL('../fixtures/registry/observe.tjs', import.meta.url), 'utf8')
const key = 'Software\\KrkrRegistryFixture'
const wide = (s: string) => Buffer.from('\ufeff' + s, 'utf16le')
const registryText = [
  'Windows Registry Editor Version 5.00', '', '[HKEY_CURRENT_USER\\' + key + ']',
  '@="Default"', '"Caption"="月の章"', '"Score"=dword:ffffffff',
  '"Target"=hex(2):25,00,47,00,41,00,4d,00,45,00,25,00,\\', '  00,00',
  '"Big"=hex(5):80,00,00,01', '"Binary"=hex:77,88', '"List"=hex(7):aa,00,00,00', '',
].join('\r\n')
const expected = 'Default|月の章|Integer|4294967295|%GAME%|2147483649|4294967295|月の章|1|1|1|1|2|1|2'

for (const binary of [false, true]) test('registry-selected settings reach ' + (binary ? 'compiled TJS' : 'source TJS') + ' and a saved chapter', async (t) => {
  const { session } = await headless({
    'settings.xp3': xp3Fixture({ 'config/preferences.reg': wide(registryText) }, { compressed: true }).bytes,
    'observe.tjs': observe,
    'startup.tjs': 'System.exitOnNoWindowStartup=false;' + (binary
      ? 'Scripts.compileStorage("observe.tjs","savedata/observe.cjs",false,true,false);Scripts.execStorage("savedata/observe.cjs");'
      : 'Scripts.execStorage("observe.tjs");') +
      'var outcome=observeRegistry("Software\\\\KrkrRegistryFixture");[outcome].save(System.dataPath+"chapter.txt");',
  }, { registryFile: 'settings.xp3>config/preferences.reg' })
  t.after(() => session.stop())
  await session.start()
  assert.equal(await session.evaluate('outcome'), expected)
  assert.equal(await session.evaluate('[].load(System.dataPath+"chapter.txt")[0]'), expected)
  assert(session.exportSaves().some((file) => file.path === 'savedata/chapter.txt'))
})

test('the registry is lazy and isolated from other sessions and remounted game files', async (t) => {
  const none = await headless({ 'unused.reg': wide(registryText) })
  t.after(() => none.session.stop())
  const read = 'System.readRegValue("Software\\\\KrkrRegistryFixture\\\\Score")'
  assert.equal(await none.session.evaluate('int(' + read + '===void)'), '1')
  const { session } = await headless({}, { registryFile: 'prefs.reg' })
  t.after(() => session.stop())
  let reads = 0
  function mount(source: string) {
    const bytes = wide(source)
    session.mount([{ name: 'prefs.reg', size: bytes.length, read: async () => { reads++; return bytes } }])
  }
  mount(registryText)
  await session.evaluate('(function(){' + read + ';return 1;})()')
  assert.equal(reads, 0)
  assert.equal(await session.evaluate(read), '4294967295')
  assert.equal(await session.evaluate(read), '4294967295')
  assert.equal(reads, 1)
  mount(registryText.replace('ffffffff', '00000011'))
  assert.equal(await session.evaluate(read), '17')
  assert.equal(reads, 2)
  const other = wide(registryText)
  session.mount([{ name: 'Other/prefs.reg', size: other.length, read: async () => { reads++; return other } }])
  assert.equal(await session.evaluate('(function(){Storages.addAutoPath("Other/");try{var value=' + read +
    ';return "unexpected";}catch(e){return "missing";}})()'), 'missing')
  assert.equal(reads, 2)
})
