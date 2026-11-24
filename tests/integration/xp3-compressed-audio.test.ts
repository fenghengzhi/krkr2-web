import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { headless } from '../helpers/headless.ts'
import { createLongCompressedXp3 } from '../helpers/xp3-segment-fixtures.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: a game streams and seeks exact PCM from a compressed 72 MiB XP3 member`,
  { timeout: 90000 }, async () => {
    const fixture = await createLongCompressedXp3({
      startup: binary ? 'Scripts.compileStorage("compressed-audio.tjs",System.dataPath+"game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"game.cjs");'
        : 'Scripts.execStorage("compressed-audio.tjs");',
      program: 'System.exitOnNoWindowStartup=false;var music=new WaveSoundBuffer(null);music.open("compressed-long.wav");',
    })
    const clock = new AudioClock(), left: number[] = [], right: number[] = []
    const audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      left.push(...l); right.push(...r)
    }, fixture.wave.rate)
    const { session } = await headless({}, { audio, project: { directory: 'game.xp3>', executableDirectory: '' },
      now: () => clock.now, schedule: clock.schedule })
    try {
      session.mount([{ name: 'game.xp3', size: fixture.bytes.length, source: { size: fixture.bytes.length,
        async read(start, length) { return fixture.bytes.subarray(start, start + length) } },
        async read() { throw new Error('Attempted to load entire container') } }])
      const damaged = xp3Fixture({ 'scene.tjs': 'var fromPackedScene=1;' }, { compressed: true })
      damaged.bytes[damaged.indexOffsets[0]! - 1]! ^= 0xff
      session.mount([{ name: 'bad.xp3', size: damaged.bytes.length, async read() { return damaged.bytes } }])
      await session.start()
      assert.equal(await session.evaluate(`(function(){System.assignMessage("TVPUncompressionFailed","xp3-decode");
        try{Scripts.execStorage("game://./bad.xp3>scene.tjs");}catch(e){return e.message;}return "unexpected success";})()`), 'xp3-decode')
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((entry) => entry.path === 'savedata/game.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
      assert.equal(await session.evaluate('music.frequency'), String(fixture.wave.rate))
      await session.evaluate('(music.play(),0)')
      for (const sample of [0, fixture.farSample + 5, fixture.backSample + 17]) {
        if (sample) await session.evaluate(`(music.paused=true,music.samplePosition=${sample},music.paused=false,0)`)
        await settleAudioPages(audio)
        clock.advance(20); await session.idle()
        const count = fixture.wave.rate / 50, bytes = fixture.wave.read(44 + sample * 2, count * 2)
        const expected = Array.from({ length: count }, (_, i) => bytes.readInt16LE(i * 2) / 32768)
        assert.deepEqual(left.splice(0), expected); assert.deepEqual(right.splice(0), expected)
        assert.equal(await session.evaluate('music.samplePosition'), String(sample + count))
      }
      await session.evaluate('(invalidate music,0)')
      assert.equal(audio.mixer.inspectStreams().voices, 0)
    } finally {
      await session.stop()
      assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
    }
  })
