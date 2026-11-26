import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveSpeakerCases, waveSpeakerFiles, waveSpeakerSource } from '../helpers/wave-speakers.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: ordinary six-channel Wave files route actual streamed PCM through seek, pause and loop without swapping center and right`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { left.push(...l); right.push(...r) }, 1000),
      { session } = await headless({ ...waveSpeakerFiles(), 'speakers.tjs': waveSpeakerSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("speakers.tjs","savedata/speakers.cjs",false,true,false);Scripts.execStorage("savedata/speakers.cjs");'
          : 'Scripts.execStorage("speakers.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    const pcm = (count: number, expected: readonly number[]) => {
      assert.deepEqual(left, Array(count).fill(Math.fround(expected[0]!)))
      assert.deepEqual(right, Array(count).fill(Math.fround(expected[1]!)))
      left.length = right.length = 0
    }
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/speakers.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      for (const row of waveSpeakerCases) for (const layout of ['legacy', 'masked']) {
        const name = `${row.name}-${layout}.wav`
        assert.equal(await session.evaluate(`speakerOpen(${JSON.stringify(name)})`), '6:play')
        assert.equal(await session.evaluate('speakerSound.totalTime+":"+speakerSound.frequency+":"+speakerSound.bits'), '32000:1000:16')
        await session.evaluate('(speakerSound.samplePosition=4094,0)'); await settleAudioPages(audio)
        clock.advance(20); await session.idle(); pcm(20, row.stereo)
        assert.equal(await session.evaluate('speakerSound.samplePosition'), '4114')
        await session.evaluate('(speakerSound.paused=true,0)')
        clock.advance(20); await session.idle(); pcm(0, row.stereo)
        assert.equal(await session.evaluate('speakerSound.samplePosition'), '4114')
        await session.evaluate('(speakerSound.paused=false,0)')
        clock.advance(20); await session.idle(); pcm(20, row.stereo)
        await session.evaluate('(speakerSound.samplePosition=31994,0)'); await settleAudioPages(audio)
        clock.advance(20); await session.idle(); pcm(20, row.stereo)
        assert.equal(await session.evaluate('speakerSound.status+":"+speakerSound.samplePosition'), 'play:14')
        assert.equal(audio.inspect().voices, 1)
      }
      await session.evaluate('invalidate speakerSound')
      assert.equal(audio.inspect().voices, 0); assert.equal(audio.mixer.inspectStreams().voices, 0)
    } catch (error) { failures.push(error) }
    try {
      await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave speaker routing or cleanup failed', { cause: failures[0] })
  })
