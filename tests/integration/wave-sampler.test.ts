import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { samplerSmallChannels, waveSamplerFiles, waveSamplerSource } from '../helpers/wave-sampler.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: ordinary game Wave loops ignore sampler hints, then finish or follow a real SLI file`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { output[0]!.push(...l); output[1]!.push(...r) }, 1000),
      { session } = await headless({ ...waveSamplerFiles(), 'sampler.tjs': waveSamplerSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("sampler.tjs","savedata/sampler.cjs",false,true,false);Scripts.execStorage("savedata/sampler.cjs");'
          : 'Scripts.execStorage("sampler.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    const take = async (ms: number, expected: readonly number[][]) => {
      output.forEach((channel) => { channel.length = 0 })
      await settleAudioPages(audio); clock.advance(ms); await session.idle()
      assert.deepEqual(output, expected)
    }
    try {
      await session.start()
      for (const name of ['sampler-before.wav', 'sampler-after.wav', 'sampler-ignored.wav', 'sampler-empty.wav']) {
        assert.equal(await session.evaluate(`samplerStart(${JSON.stringify(name)})`), 'play')
        assert.equal(await session.evaluate('samplerSound.totalTime+":"+samplerSound.frequency'), '60:1000')
        await take(80, samplerSmallChannels.map((channel) => [...channel, ...channel.slice(0, 20)]))
        assert.equal(await session.evaluate('samplerSound.status+":"+samplerSound.samplePosition'), 'play:20')
        await session.evaluate('(samplerSound.paused=true,0)'); await take(20, [[], []])
        assert.equal(await session.evaluate('samplerSound.samplePosition'), '20')
        await session.evaluate('(samplerSound.states.clear(),samplerSound.looping=false,samplerSound.paused=false,0)')
        await take(60, samplerSmallChannels.map((channel) => [...channel.slice(20), ...Array<number>(20).fill(0)]))
        assert.equal(await session.evaluate('[samplerSound.status,samplerSound.samplePosition,samplerSound.states.join(",")].join("|")'), 'stop|60|stop')
      }
      assert.equal(await session.evaluate('samplerStart("sampler-sli.wav",false)'), 'play')
      await take(100, samplerSmallChannels.map((channel) => [...channel, ...channel.slice(40), ...channel.slice(40)]))
      assert.equal(await session.evaluate('samplerSound.status+":"+samplerSound.looping'), 'play:0')
      await session.evaluate('(samplerSound.stop(),0)'); await take(20, [[], []])
      await session.evaluate('invalidate samplerSound')
      assert.equal(audio.inspect().voices, 0)
      assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave sampler compatibility or cleanup failed', { cause: failures[0] })
  })
