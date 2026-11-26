import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { joinArchiveVolumes } from '../../src/backends/files/archive-volumes.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { projectIdentity } from '../../src/player/game-identity.ts'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'
import { discBootInput, discReleaseInput } from '../helpers/disc-boot.ts'

const checkpoint = async () => {}
const base = 'game-' + '1'.repeat(64)
function resource(name: string, bytes: Buffer): Resource {
  return { name, size: bytes.length, source: { size: bytes.length, read: async (at, n) => bytes.subarray(at, at + n) },
    read: async () => { throw new Error('Requested entire release: ' + name) } }
}

for (const binary of [false, true]) test(`a packaged ${binary ? 'CUE in a split ZIP' : 'ISO'} keeps its original configuration and can reopen on a different drive`, async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const { files, release } = discReleaseInput(binary)
  const media = await joinArchiveVolumes(files.map(({ name, buffer }) => resource(name, buffer)), checkpoint)
  const outer = release.outer, disc = binary ? 'Media/boot.cue' : release.image
  const bindings = [{ drive: 'G', cue: outer + '>' + disc }]
  const mount = await prepareProject(media, { mode: 'auto' }, reader, checkpoint, 'startup.tjs', bindings)
  assert.deepEqual(mount.project, { directory: 'file://./g/discgame/data.xp3>', executableDirectory: 'file://./g/discgame/',
    bootDisc: disc, distribution: outer })
  const config = mount.configFiles?.find((file) => file.name === 'file://./g/discgame/story.cf')
  assert(config)
  assert.equal(Buffer.from(await config.read()).toString(), 'disc-edition=pressing\r\n')
  const named = await prepareProject(media, { mode: 'auto', executable: (outer + '>' + disc).toUpperCase() },
    reader, checkpoint, 'startup.tjs', bindings)
  assert.deepEqual(named.project, mount.project)
  assert.deepEqual((await prepareProject(media, { mode: 'auto', executable: disc },
    reader, checkpoint, 'startup.tjs', bindings)).project, mount.project)
  const explicitRoot = await prepareProject(media, { mode: 'root', executableDirectory: 'G:/DiscGame/', directory: 'G:/DiscGame/data.xp3>' },
    reader, checkpoint, 'startup.tjs', bindings)
  assert.deepEqual(explicitRoot.project, mount.project)
  const moved = await prepareProject(media, { mode: 'root', ...mount.project! }, reader, checkpoint, 'startup.tjs', [{ drive: 'H', cue: disc }])
  assert.equal(moved.project?.directory, 'file://./h/discgame/data.xp3>')
  assert.equal(await projectIdentity(base, moved.project), await projectIdentity(base, mount.project))
  await assert.rejects(prepareProject([], { mode: 'root', ...mount.project! }, reader, checkpoint), /distribution ZIP is missing/)
  await assert.rejects(prepareProject(media, { mode: 'auto', executable: outer + '>Missing.iso' }, reader, checkpoint), /找不到启动光盘/)
  const unbound = await prepareProject(media, { mode: 'collection' }, reader, checkpoint)
  assert.equal(unbound.project, undefined)
  if (binary) await assert.rejects(joinArchiveVolumes(files.filter((file) => !file.name.endsWith('.002'))
    .map(({ name, buffer }) => resource(name, buffer)), checkpoint), /缺少分卷 2/)
})

test('an installed project takes priority inside a release while a named image selects its own game', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const image = discBootInput(false).files[0]!.buffer
  const raw = distributionZip([member('Installed/startup.tjs', '42'), member('Discs/Game.iso', image)])
  const release = resource('Release.zip', raw)
  const loose = await prepareProject([release], { mode: 'auto' }, reader, checkpoint)
  assert.deepEqual(loose.project, { directory: 'Installed/', executableDirectory: 'Installed/', distribution: release.name })
  const disc = await prepareProject([release], { mode: 'auto', executable: 'Release.zip>Discs/Game.iso' }, reader, checkpoint)
  assert.equal(disc.project?.bootDisc, 'Discs/Game.iso')
  const sfx = resource('Other.exe', Buffer.concat([Buffer.from('MZ inert prefix'), raw]))
  const alternate = await prepareProject([sfx], { mode: 'auto', executable: 'Other.exe>Discs/Game.iso' }, reader, checkpoint)
  assert.equal(alternate.project?.directory, disc.project?.directory)
  assert.notEqual(await projectIdentity(base, alternate.project), await projectIdentity(base, disc.project))
  assert.deepEqual((await prepareProject([sfx], { mode: 'root', ...alternate.project! }, reader, checkpoint)).project, alternate.project)
})

test('two playable images in the same ZIP report both full choices', async (t) => {
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const image = discBootInput(false).files[0]!.buffer
  const release = resource('Two.zip', distributionZip([member('First.iso', image), member('Second.iso', image)]))
  await assert.rejects(prepareProject([release], { mode: 'auto' }, reader, checkpoint), /Two\.zip>First\.iso.*Two\.zip>Second\.iso/)
})
