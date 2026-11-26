import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveGainCases, waveGainFiles, waveGainPublicExpected, waveGainReadback, waveGainSamples,
  waveGainSource } from '../helpers/wave-gain.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: public Wave volume, volume2 and pan select native attenuation for every real stereo PCM sample`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
        left.push(...l); right.push(...r)
      }, 1000), { session } = await headless({ ...waveGainFiles(), 'gain.tjs': waveGainSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("gain.tjs","savedata/gain.cjs",false,true,false);Scripts.execStorage("savedata/gain.cjs");'
          : 'Scripts.execStorage("gain.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/gain.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      assert.equal(await session.evaluate('waveGainPublicControls()'), waveGainPublicExpected)
      assert.equal(audio.inspect().voices, 0)
      assert.equal(await session.evaluate('waveGainStart()'), 'play')
      await settleAudioPages(audio)
      for (const row of waveGainCases) {
        assert.equal(await session.evaluate(`waveGainSet(${row.volume},${row.volume2},${row.globalVolume},${row.pan})`), waveGainReadback(row), row.name)
        left.length = right.length = 0
        clock.advance(20); await session.idle()
        const expected = waveGainSamples(row)
        assert.deepEqual(left, Array(20).fill(expected[0]), row.name)
        assert.deepEqual(right, Array(20).fill(expected[1]), row.name)
      }
      const position = String(waveGainCases.length * 20)
      assert.equal(await session.evaluate('gainSound.samplePosition'), position)
      await session.evaluate('(gainSound.paused=true,0)')
      const paused = waveGainCases[4]!
      assert.equal(await session.evaluate(`waveGainSet(${paused.volume},${paused.volume2},${paused.globalVolume},${paused.pan})`), waveGainReadback(paused))
      left.length = right.length = 0; clock.advance(20); await session.idle()
      assert.deepEqual(left, []); assert.deepEqual(right, [])
      assert.equal(await session.evaluate('gainSound.samplePosition'), position)
      await session.evaluate('(gainSound.paused=false,0)')
      clock.advance(20); await session.idle()
      assert.deepEqual(left, Array(20).fill(waveGainSamples(paused)[0]))
      assert.deepEqual(right, Array(20).fill(waveGainSamples(paused)[1]))
      assert.equal(await session.evaluate('waveGainClose()'), 'closed')
      assert.equal(audio.inspect().voices, 0); assert.equal(audio.mixer.inspectStreams().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave attenuation or cleanup failed', { cause: failures[0] })
  })
