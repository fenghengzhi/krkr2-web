import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { loopHalfRate, waveLoopResamplingFiles, waveLoopResamplingSource } from '../helpers/wave-loop-resampling.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: normal game music joins whole-song and streamed SLI phrases before device resampling`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (l, r) => { output[0]!.push(...l); output[1]!.push(...r) }, 2000),
      { session } = await headless({ ...waveLoopResamplingFiles(), 'resample.tjs': waveLoopResamplingSource,
        'startup.tjs': binary ? 'Scripts.compileStorage("resample.tjs","savedata/resample.cjs",false,true,false);Scripts.execStorage("savedata/resample.cjs");'
          : 'Scripts.execStorage("resample.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
      expected = Array.from({ length: 80 }, (_, frame) => loopHalfRate[frame % 8]!),
      take = async (ms: number, left: number[]) => {
        await settleAudioPages(audio); output.forEach((plane) => { plane.length = 0 })
        clock.advance(ms); await session.idle()
        assert.deepEqual(output, [left, left.map((value) => value ? -value / 2 : 0)])
      }
    try {
      await session.start()
      for (const whole of [true, false]) {
        assert.equal(await session.evaluate(`resampleStart(${whole})`), 'play')
        await take(40, expected)
        assert.equal(await session.evaluate('resampleMusic.status'), 'play')
        if (!whole) assert.equal(await session.evaluate('resampleMusic.marks'), '10')
        await session.evaluate('(resampleMusic.paused=true,0)')
        const position = await session.evaluate('resampleMusic.samplePosition'), labels = await session.evaluate('resampleMusic.marks')
        await take(20, [])
        assert.equal(await session.evaluate('resampleMusic.samplePosition'), position)
        assert.equal(await session.evaluate('resampleMusic.marks'), labels)
        await session.evaluate('(resampleMusic.paused=false,0)'); await take(40, expected)
        if (!whole) assert.equal(await session.evaluate('resampleMusic.marks'), '20')
        await session.evaluate('resampleMusic.stop()'); await take(20, [])
        assert.equal(await session.evaluate('resampleMusic.status'), 'stop')
      }
      await session.evaluate('resampleStart(true)'); await take(40, expected)
      await session.evaluate('(resampleMusic.looping=false,0)'); await take(20, Array<number>(40).fill(0))
      assert.equal(await session.evaluate('resampleMusic.status+":"+resampleMusic.samplePosition'), 'stop:0')
      await session.evaluate('invalidate resampleMusic'); assert.equal(audio.inspect().voices, 0)
      assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'WAVE loop resampling or cleanup failed', { cause: failures[0] })
  })
