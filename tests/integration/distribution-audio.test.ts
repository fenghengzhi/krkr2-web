import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { headless } from '../helpers/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { musicDistribution } from '../helpers/deflated-distribution.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: a ZIP release opens its game and patch then streams exact large music samples`, { timeout: 90000 }, async () => {
  const fixture = await musicDistribution(binary), outer = createSessionArchiveReader(), reads: number[] = []
  const mount = await prepareProject([{ name: 'Story.zip', size: fixture.bytes.length,
    source: { size: fixture.bytes.length, async read(at, n) { reads.push(n); return fixture.bytes.subarray(at, at + n) } },
    read: async () => { throw new Error('Requested the whole release') } }], { mode: 'auto' }, outer, async () => {})
  const clock = new AudioClock(), left: number[] = [], right: number[] = [], audio = new HeadlessAudioBackend({
    now: () => clock.now, schedule: clock.schedule,
  }, (l, r) => { left.push(...l); right.push(...r) }, fixture.wave.rate)
  const { session } = await headless({}, { audio, project: mount.project, now: () => clock.now, schedule: clock.schedule })
  try {
    session.mount(mount.resources); await session.start()
    assert.equal(await session.evaluate('patchValue'), 'updated')
    assert.equal(await session.evaluate('Storages.getPlacedPath("chapter.tjs")'), 'game://./Release/patch.xp3>chapter.tjs')
    assert.equal(await session.evaluate('System.dataPath'), 'game://./Release/savedata/')
    if (binary) assert.equal(Buffer.from(session.exportSaves().find((f) => f.path === 'Release/savedata/music.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    const wav = mount.resources.find((r) => r.name.endsWith('/music.wav'))!
    assert(wav.size > 64 * 1024 * 1024); assert(wav.source); await assert.rejects(wav.read(), /decode budget/)
    for (const start of [0, fixture.far + 5, fixture.back + 17]) {
      await session.evaluate(`(playFrom(${start}),0)`); await settleAudioPages(audio)
      clock.advance(20); await session.idle()
      const count = fixture.wave.rate / 50, samples = fixture.wave.read(44 + start * 2, count * 2)
      const expected = Array.from({ length: count }, (_, i) => samples.readInt16LE(i * 2) / 32768)
      assert.deepEqual(left.splice(0), expected); assert.deepEqual(right.splice(0), expected)
      assert.equal(await session.evaluate('music.samplePosition'), String(start + count))
    }
    assert(reads.length > 0 && reads.every((n) => n <= 65557))
  } finally { await session.stop(); outer.dispose() }
})
