import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { projectIdentity } from '../../src/player/game-identity.ts'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'
import { discBootInput } from '../helpers/disc-boot.ts'
import { headless } from '../helpers/headless.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

const check = async () => {}
const reg = (score: number) => Buffer.from('\ufeffWindows Registry Editor Version 5.00\r\n\r\n' +
  '[HKEY_CURRENT_USER\\Software\\KrkrImport]\r\n"Score"=dword:' + score.toString(16).padStart(8, '0') + '\r\n', 'utf16le')
const query = String.raw`System.readRegValue("HKEY_CURRENT_USER\\Software\\KrkrImport\\Score")`
function input(name: string, value: string | Uint8Array): Resource {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  return { name, size: bytes.length, source: { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) },
    read: async () => bytes }
}

for (const binary of [false, true]) test(`${binary ? 'compiled' : 'source'} games read explicitly selected companion registry files without importing their script namespace`, async () => {
  for (const kind of ['loose', 'settings ZIP', 'settings XP3', 'qualified release', 'installed priority', 'missing installed member']) {
    const observer = `var registryObserved=${query};`, startup = 'System.exitOnNoWindowStartup=false;' + (binary
      ? 'Scripts.compileStorage("observer.tjs",System.dataPath+"observer.cjs",false,true,false);Scripts.execStorage(System.dataPath+"observer.cjs");'
      : 'Scripts.execStorage("observer.tjs");')
    const members = [member('Game/startup.tjs', startup), member('Game/observer.tjs', observer), member('Game/settings.reg', reg(7))]
    let registryFile: string, companions: Resource[]
    if (kind === 'settings ZIP' || kind === 'settings XP3') {
      const name = kind === 'settings ZIP' ? 'Settings.zip' : 'Settings.xp3'
      registryFile = name + '>Prefs/settings.reg'
      companions = [input(name, kind === 'settings ZIP'
        ? distributionZip([member('Prefs/settings.reg', reg(7)), member('private.tjs', '99')])
        : xp3Fixture({ 'Prefs/settings.reg': reg(7), 'private.tjs': '99' }).bytes)]
    } else if (kind === 'qualified release') {
      registryFile = 'Game.zip>Game/settings.reg'
      companions = [input('settings.reg', reg(99))]
    } else if (kind === 'missing installed member') {
      registryFile = 'Settings.zip>Prefs/settings.reg'
      members.push(member('Settings.zip', distributionZip([member('readme.txt', 'The selected installed archive has no settings member.')])))
      companions = [input('Settings.zip', distributionZip([member('Prefs/settings.reg', reg(99))]))]
    } else {
      registryFile = 'settings.reg'
      if (kind === 'installed priority') members.push(member('settings.reg', reg(7)))
      companions = [input('settings.reg', reg(kind === 'installed priority' ? 99 : 7))]
    }
    const files = [input('Game.zip', distributionZip(members)), ...companions, input('outside-only.tjs', '99')],
      reader = createSessionArchiveReader()
    try {
      const prepared = await prepareProject(files, { mode: 'auto', executable: kind === 'settings XP3' ? undefined : 'Game.zip', registryFile }, reader, check)
      assert.equal(prepared.project?.directory, 'Game/'); assert(prepared.discImports)
      const reopened = await prepareProject([...files].reverse(), { mode: 'root', ...prepared.project!, registryFile }, reader, check)
      assert(reopened.discImports)
      assert.equal(await projectIdentity('game-' + 'a'.repeat(64), reopened.project), await projectIdentity('game-' + 'a'.repeat(64), prepared.project))
      const { session } = await headless({}, { project: reopened.project, registryFile,
        discImports: { resources: reopened.discImports, archives: reader } })
      try {
        session.mount(reopened.resources)
        if (kind === 'missing installed member') {
          await assert.rejects(session.start(), /Settings\.zip>Prefs\/settings\.reg/)
        } else {
          await session.start()
          assert.equal(await session.evaluate('registryObserved'), '7')
          assert.equal(await session.evaluate('int(Storages.isExistentStorage("game://./outside-only.tjs"))'), '0')
          if (kind === 'loose') assert.equal(await session.evaluate('int(Storages.isExistentStorage("game://./settings.reg"))'), '0')
          if (kind === 'settings ZIP' || kind === 'settings XP3') assert.equal(await session.evaluate(
            `int(Storages.isExistentStorage("game://./${kind === 'settings ZIP' ? 'Settings.zip' : 'Settings.xp3'}"))`), '0')
          if (binary) assert(session.exportSaves().some((file) => file.path.endsWith('/observer.cjs')))
        }
      } finally { await session.stop() }
    } finally { reader.dispose() }
  }
})

test('a selected registry XP3 keeps native game priority and does not select a non-game ZIP', async () => {
  for (const nativeGame of [false, true]) {
    const entries: Record<string, string | Uint8Array> = { 'Prefs/settings.reg': reg(7) }
    if (nativeGame) entries['startup.tjs'] = 'System.exitOnNoWindowStartup=false;'
    const files = [input('Settings.xp3', xp3Fixture(entries).bytes), input('Game.zip', distributionZip([
      member(nativeGame ? 'Game/startup.tjs' : 'readme.txt', 'System.exitOnNoWindowStartup=false;'),
    ]))], reader = createSessionArchiveReader()
    try {
      const baseline = await prepareProject(files, { mode: 'auto' }, reader, check),
        configured = await prepareProject(files, { mode: 'auto', registryFile: 'Settings.xp3>Prefs/settings.reg' }, reader, check)
      assert.deepEqual(configured.project, baseline.project)
      assert.equal(configured.project?.distribution, undefined)
      assert.equal(configured.resources, files)
    } finally { reader.dispose() }
  }
})

test('a bootable ISO and its explicitly selected loose registry keep automatic disc selection and exact settings reads', async () => {
  const iso = discBootInput(false).files[0]!, reader = createSessionArchiveReader(),
    files = [input(iso.name, iso.buffer), input('settings.reg', reg(7))]
  try {
    const prepared = await prepareProject(files, { mode: 'collection', registryFile: 'settings.reg' }, reader, check)
    assert.equal(prepared.project?.bootDisc, iso.name)
    const { session } = await headless({}, { project: prepared.project, registryFile: 'settings.reg' })
    try {
      session.mount(prepared.resources)
      assert.equal(await session.evaluate(query), '7')
      assert.equal(await session.evaluate('Scripts.evalStorage("D:/Routes/開幕.tjs")'), '42')
      assert.equal(await session.evaluate('System.exePath'), 'file://./d/discgame/')
    } finally { await session.stop() }
  } finally { reader.dispose() }
})
