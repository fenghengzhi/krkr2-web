import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { projectIdentity } from '../../src/player/game-identity.ts'
import { AudioClock, wave } from '../helpers/audio.ts'
import { member, distributionZip } from '../helpers/deflated-distribution.ts'
import { discStoryImage } from '../helpers/disc-story.ts'
import { headless } from '../helpers/headless.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

function input(name: string, bytes: Uint8Array): Resource {
  return { name, size: bytes.length, source: { size: bytes.length, read: async (at, n) => bytes.subarray(at, at + n) },
    read: async () => bytes }
}
const check = async () => {}
const cue = 'FILE "Story.iso" BINARY\nTRACK 01 MODE1/2048\nINDEX 01 00:00:00\n' +
  'FILE "Theme.wav" WAVE\nTRACK 02 AUDIO\nINDEX 01 00:00:00\n'

for (const format of ['loose CUE', 'automatic ZIP', 'mapped ZIP']) test(`an installed game reads both data and CD music from a separately imported ${format}`, { timeout: 90000 }, async (t) => {
  const story = discStoryImage(), encode = (value: string) => new TextEncoder().encode(value)
  const external = [
    input('Media/Pressing.cue', encode(cue)), input('Media/Story.iso', story),
    input('Media/Theme.wav', wave(Array.from({ length: 4410 * 2 }, (_, i) => i % 2 ? -.25 : .5), 44100, 2)),
  ]
  const script = 'System.exitOnNoWindowStartup=false; var drive=Storages.searchCD("KRKR_STORY");' +
    'var bonus=Scripts.evalStorage(drive+":/Books/Scenes.zip>Bonus.tjs");' +
    'var cd=new CDDASoundBuffer(null);cd.open(drive+":2");cd.play();'
  const game = input('Novel.zip', distributionZip([
    member('Game/data.xp3', xp3Fixture({ 'startup.tjs': script }).bytes),
    // The file backing an external sheet always belongs to that sheet's source.
    member('Media/Theme.wav', wave(Array(8820).fill(.125), 44100, 2)),
  ]))
  const companion = format === 'loose CUE' ? external : [input('Extra.zip', distributionZip(
    await Promise.all(external.map(async (file) => member(file.name, await file.read())))))]
  const inputs = [game, ...companion, input('outside-only.txt', encode('release notes'))]
  const drives = format === 'mapped ZIP' ? [{ drive: 'H', cue: 'Extra.zip>Media/Pressing.cue' }] : undefined
  const reader = createSessionArchiveReader()
  t.after(() => reader.dispose())
  const mount = await prepareProject(inputs, { mode: 'auto', executable: 'Novel.zip' }, reader, check, 'startup.tjs', drives)
  assert.equal(mount.project?.directory, 'Game/data.xp3>'); assert(mount.discImports)
  const replay = await prepareProject([...inputs].reverse(), { mode: 'root', ...mount.project! }, reader, check, 'startup.tjs', drives)
  const base = 'game-' + '3'.repeat(64)
  assert.equal(await projectIdentity(base, replay.project), await projectIdentity(base, mount.project))
  const clock = new AudioClock(), left: number[] = [], right: number[] = []
  const audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
    (l, r) => { left.push(...l); right.push(...r) }, 44100)
  const { session } = await headless({}, { project: mount.project, audio, cddaDiscs: drives,
    now: () => clock.now, schedule: clock.schedule, discImports: { resources: mount.discImports, archives: reader } })
  try {
    session.mount(mount.resources)
    await session.start()
    assert.equal(await session.evaluate('[drive,bonus,cd.channels,cd.totalTime,int(Storages.isExistentStorage("game://./outside-only.txt"))].join("|")'),
      (drives ? 'H' : 'D') + '|81|2|100|0')
    clock.advance(20); await session.idle()
    assert(left.includes(.5)); assert(right.includes(-.25)); assert(!left.includes(.125))
    assert.equal(await session.evaluate('Scripts.evalStorage(drive+":/Routes/開幕.tjs")'), '42')
  } finally { await session.stop() }
})
