import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { decodePortableAudio } from '../../src/backends/audio/decode.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { longVorbisBytes, longVorbisFiles, longVorbisSource, longVorbisRate as rate,
  longVorbisLoopStart as loopStart, longVorbisLoopEnd as loopEnd } from '../helpers/long-vorbis.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: long Ogg music seeks, pauses and repeats a distant SLI phrase with the exact sequential PCM and audible labels`, { timeout: 120000 }, async () => {
  const expected = await decodePortableAudio(longVorbisBytes(), 'wave'); assert(expected?.kind === 'pcm')
  const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      output[0]!.push(...l); output[1]!.push(...r)
    }, rate), { session } = await headless({ ...longVorbisFiles(), 'music.tjs': longVorbisSource,
      'startup.tjs': binary ? 'Scripts.compileStorage("music.tjs","savedata/music.cjs",false,true,false);Scripts.execStorage("savedata/music.cjs");'
        : 'Scripts.execStorage("music.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  const take = async (at: number, blocks: number, loop = false) => {
    for (let block = 0; block < blocks; block++) {
      await settleAudioPages(audio); output.forEach((channel) => { channel.length = 0 })
      clock.advance(20); await session.idle()
      for (let channel = 0; channel < 2; channel++) {
        const reference: number[] = []
        for (let i = 0; i < 960; i++) {
          let position = at + block * 960 + i
          if (loop && position >= loopEnd) position = loopStart + (position - loopStart) % (loopEnd - loopStart)
          reference.push(0 + expected.data[channel]![position]!)
        }
        assert.deepEqual(output[channel], reference, `PCM channel ${channel}, seek ${at}, block ${block}, loop ${loop}`)
      }
    }
  }
  try {
    await session.start(); assert.equal(await session.evaluate('longStart()'), 'play')
    assert.equal(await session.evaluate('longMusic.totalTime'), '96000')
    for (const frame of [85 * rate + 17, 48 * rate + 31, 4 * rate + 7]) {
      assert.equal(await session.evaluate(`longSeek(${frame})`), String(frame)); await take(frame, 4)
      assert.equal(await session.evaluate('longMusic.samplePosition'), String(frame + 3840))
    }
    await session.evaluate('(longMusic.paused=true,0)'); output.forEach((channel) => { channel.length = 0 })
    clock.advance(100); await session.idle(); assert.deepEqual(output, [[], []])
    await session.evaluate('(longSeek(4080000),longMusic.paused=false,0)'); await take(85 * rate, 4)
    await session.evaluate('(longStart(true),longMusic.labels.clear(),longSeek(4032000),0)')
    await take(loopStart, 210, true)
    assert.equal(await session.evaluate('longMusic.status+":"+longMusic.looping'), 'play:0')
    assert.equal(await session.evaluate('longMusic.labels.join(",")'), 'late,late,late')
    await session.evaluate('(longMusic.stop(),longMusic.play(),longSeek(2304000),0)'); await take(48 * rate, 4)
    await session.evaluate('invalidate longMusic')
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0); assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Long Ogg game playback or cleanup failed', { cause: failures[0] })
})
