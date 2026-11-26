import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveRiffFiles, waveRiffNames, waveRiffPcm, waveRiffSource } from '../helpers/wave-riff-layout.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: original WAVE chunk discovery plays, loops and seeks the first real music payload through the game API`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      output[0]!.push(...l); output[1]!.push(...r)
    }, 1000), { session } = await headless({ ...waveRiffFiles(), 'riff.tjs': waveRiffSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("riff.tjs","savedata/riff.cjs",false,true,false);Scripts.execStorage("savedata/riff.cjs");'
      : 'Scripts.execStorage("riff.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  const take = async (ms: number, expected: number[]) => {
    await settleAudioPages(audio); output.forEach((plane) => { plane.length = 0 })
    clock.advance(ms); await session.idle()
    assert.deepEqual(output, [expected, expected.map((value) => value === 0 ? 0 : -value)])
  }
  try {
    await session.start()
    for (const name of waveRiffNames) {
      assert.equal(await session.evaluate(`riffStart(${JSON.stringify(name)})`), 'play')
      assert.equal(await session.evaluate('[riffMusic.frequency,riffMusic.totalTime,riffMusic.bits, riffMusic.channels].join(":")'), '1000:60:16:2')
      await take(80, [...waveRiffPcm, ...waveRiffPcm.slice(20, 40)])
      assert.equal(await session.evaluate('riffMusic.seen.join(",")'), 'head,loop,loop')
      assert.equal(await session.evaluate('riffMusic.samplePosition'), '40')
      await session.evaluate('(riffMusic.paused=true,0)'); await take(20, [])
      await session.evaluate('(riffMusic.samplePosition=20,riffMusic.paused=false,0)'); await take(20, waveRiffPcm.slice(20, 40))
      await session.evaluate('(riffMusic.flags[0]=1,0)')
      await take(40, [...waveRiffPcm.slice(40), ...Array<number>(20).fill(0)])
      assert.equal(await session.evaluate('riffMusic.status+":"+riffMusic.samplePosition'), 'stop:0')
      await session.evaluate('(riffMusic.play(),0)'); await take(20, waveRiffPcm.slice(0, 20))
    }
    await session.evaluate('invalidate riffMusic')
    assert.equal(audio.inspect().voices, 0)
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0); assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Original WAVE game playback or cleanup failed', { cause: failures[0] })
})
