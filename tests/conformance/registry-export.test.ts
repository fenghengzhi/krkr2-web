import assert from 'node:assert/strict'
import test from 'node:test'
import { readText } from '../../src/backends/files/text-codecs.ts'
import { MAX_RESOURCE_BYTES } from '../../src/engine/ports/storage.ts'
import { readRegistryExport } from '../../src/engine/system/registry.ts'

const decode = (bytes: Uint8Array, encoding?: string) => readText(bytes, '', encoding, 'plain')
const v5 = 'Windows Registry Editor Version 5.00'
function load(text: string, check = async () => {}, decoder = decode) {
  const bytes = Buffer.from('\ufeff' + text, 'utf16le')
  return readRegistryExport({ name: 'game.reg', size: bytes.length, read: async () => bytes }, decoder, check)
}

test('registry imports respect unnamed values, HKCU-relative queries, registry roots, replacing types and deleting trees', async () => {
  const rows = [v5, '; installer settings', '[HKEY_CURRENT_USER\\Game]', '@=""', '"track"=dword:ffffffff',
    '"folder"="C:\\\\Games\\\\Story"', '"Quoted\\"Name"="first\\r\\nsecond"', '"track"=hex:ff', '"ß"="sharp"',
    '"SS"="double"', '[HKEY_LOCAL_MACHINE\\Game]', '@="machine"', '"score"=hex(4):ff,ff,ff,80',
    '"label"=hex(1):2a,00,00,00,21,00', '"withbom"=hex(1):ff,fe,41,00,00,00', '"q"=hex(b):01,00,00,00,00,00,00,00',
    '[HKEY_CURRENT_USER\\Tree\\Leaf]', '"a"=dword:1', '[-HKEY_CURRENT_USER\\Tree]', '[HKEY_CURRENT_USER\\Tree]',
    '"b"="old"', '"b"=-', '"c"="new"']
  const hive = await load(rows.join('\r\n'))
  assert.equal(hive.read('Game\\'), '')
  assert.equal(hive.read('Game\\FOLDER'), 'C:\\Games\\Story')
  assert.equal(hive.read('Game\\Quoted"Name'), 'first\r\nsecond')
  assert.equal(hive.read('Game\\track'), undefined)
  assert.equal(hive.read('Game\\ss'), 'double')
  assert.equal(hive.read('Game\\ß'), 'sharp')
  assert.equal(hive.read('HKEY_LOCAL_MACHINE\\game\\'), 'machine')
  assert.equal(hive.read('HKEY_LOCAL_MACHINE\\game\\score'), 0x80ffffffn)
  assert.equal(hive.read('HKEY_LOCAL_MACHINE\\game\\label'), '*')
  assert.equal(hive.read('HKEY_LOCAL_MACHINE\\game\\withbom'), '\ufeffA')
  assert.equal(hive.read('hkey_local_machine\\game\\score'), undefined)
  assert.equal(hive.read('HKEY_LOCAL_MACHINE\\game\\q'), undefined)
  assert.equal(hive.read('Tree\\leaf\\a'), undefined)
  assert.equal(hive.read('Tree\\b'), undefined)
  assert.equal(hive.read('Tree\\C'), 'new')
})

test('REGEDIT4 decodes legacy strings using the selected game code page and leaves expandable strings literal', async () => {
  const source = Buffer.concat([Buffer.from('REGEDIT4\r\n[HKEY_CURRENT_USER\\Novel]\r\n"Route"="'),
    Buffer.from([0x8a, 0x4a]), Buffer.from('"\r\n"Folder"=hex(2):25,58,25,5c,8a,4a,00\r\n')])
  const hive = await readRegistryExport({ name: 'settings.reg', size: source.length, read: async () => source },
    (bytes) => decode(bytes, 'shift_jis'), async () => {})
  assert.equal(hive.read('Novel\\Route'), '開')
  assert.equal(hive.read('Novel\\Folder'), '%X%\\開')
})

test('unreadable, truncated or cancelled registry imports cannot publish partial preferences', async () => {
  await assert.rejects(load('[HKEY_CURRENT_USER\\Game]'), /header/)
  for (const value of ['hex(4):00,00', 'hex(2):ab', 'hex(1):qq,00', 'hex(1):ab,\\']) {
    await assert.rejects(load(v5 + '\n[HKEY_CURRENT_USER\\Game]\n"x"="old"\n"x"=' + value), /registry/i)
  }
  const stopped = new Error('Stopped during game import')
  let checks = 0
  await assert.rejects(load([v5, '[HKEY_CURRENT_USER\\Game]', ...Array(1024).fill('"x"="story"')].join('\n'),
    async () => { if (++checks === 2) throw stopped }), (error) => error === stopped)
  await assert.rejects(readRegistryExport({ name: 'oversize.reg', size: MAX_RESOURCE_BYTES + 1,
    read: async () => assert.fail('Over-budget file was read') }, decode, async () => {}), /64 MiB/)
})
