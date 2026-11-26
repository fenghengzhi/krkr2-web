import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { cloneCdDiscInput, scrambledCloneCdDiscInput } from '../helpers/clone-cd-game.ts'
import { headless } from '../helpers/headless.ts'
import { legacyZip } from '../helpers/legacy-zip-names.ts'

for (const scrambled of [false, true])
test(`a ${scrambled ? 'scrambled ' : ''}CloneCD game disc supplies both its chapter and the actual stereo samples on track one`, { timeout: 60000 }, async (t) => {
  const { files } = scrambled ? scrambledCloneCdDiscInput() : cloneCdDiscInput()
  const clock = new AudioClock(), output: number[][] = [[], []],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left, right) => {
      output[0]!.push(...left); output[1]!.push(...right)
    }, 44100)
  const resources = files.map(({ name, buffer }) => ({
    name: 'Media/' + name, size: buffer.length,
    source: { size: buffer.length, async read(at: number, length: number) {
      assert(length <= 65536); return buffer.subarray(at, at + length)
    } },
    async read() {
      assert(name.toLowerCase().endsWith('.ccd'), 'game and audio must use sector ranges')
      return buffer
    },
  }))
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const mounted = await prepareProject(resources, { mode: 'collection' }, reader, async () => {})
  assert(mounted.project); assert.equal(mounted.project.bootDisc, 'Media/boot-clonecd-source.ccd')
  const zip = legacyZip(files.map(({ name, buffer }) => ({ name: 'Media/' + name, bytes: buffer })))
  const archive = { name: 'Release.zip', size: zip.length, read: async () => zip }
  const release = await prepareProject([archive], { mode: 'auto', executable: 'Release.zip>Media/boot-clonecd-source.ccd' }, reader, async () => {})
  assert.equal(release.project?.distribution, 'Release.zip')
  assert.equal(release.project?.bootDisc, mounted.project.bootDisc)
  assert.equal(release.project?.directory, mounted.project.directory)
  const { session } = await headless({ 'startup.tjs': 'System.exitOnNoWindowStartup=false;var music=new CDDASoundBuffer(null);' },
    { audio, now: () => clock.now, schedule: clock.schedule })
  session.mount(resources)
  try {
    await session.start()
    assert.equal(await session.evaluate('Storages.searchCD("KRKR_STORY")+"|"+Scripts.evalStorage("D:/Routes/開幕.tjs")'), 'D|42')
    assert.equal(await session.evaluate('(music.open("D:1"),music.totalTime+"|"+music.channels+"|"+music.bits)'), '4000|2|16')
    await session.evaluate('(music.play(),0)')
    for (const start of [0, 88200]) {
      if (start) {
        await session.evaluate('music.samplePosition=88200')
        clock.advance(20); await session.idle(); await settleAudioPages(audio)
        await session.evaluate('music.samplePosition=88200')
      }
      await settleAudioPages(audio)
      output.forEach((channel) => { channel.length = 0 })
      clock.advance(20); await session.idle()
      assert.deepEqual(output[0], Array.from({ length: 882 }, (_, i) => (start + i) % 100 < 50 ? .25 : -.25))
      assert.deepEqual(output[1], Array.from({ length: 882 }, (_, i) => (start + i) % 50 < 25 ? -.5 : .5))
    }
    await session.evaluate('music.stop()')
    const replacement = { kind: 'insert', drive: 'D', cue: 'Media/boot-clonecd-source.ccd' } as const
    await assert.rejects(session.changeDisc(replacement, async () => resources.filter((file) => file.name.endsWith('.ccd'))))
    assert.equal(await session.evaluate('Storages.searchCD("KRKR_STORY")'), 'D')
    await session.changeDisc({ kind: 'eject', drive: 'D' })
    assert.equal(await session.evaluate('Storages.searchCD("KRKR_STORY")'), '')
    await session.changeDisc(replacement, async () => resources)
    assert.equal(await session.evaluate('Storages.searchCD("KRKR_STORY")+"|"+Scripts.evalStorage("D:/Routes/開幕.tjs")'), 'D|42')
  } finally {
    await session.stop()
    assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
  }
})
