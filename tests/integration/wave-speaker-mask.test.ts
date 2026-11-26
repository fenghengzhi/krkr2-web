import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveMaskCases, waveMaskFiles, waveMaskSource } from '../helpers/wave-speaker-mask.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: declared Wave speakers survive actual streaming, distant seek, pause, SLI and whole-song replay`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (l, r) => { left.push(...l); right.push(...r) }, 8000),
      { session } = await headless({ ...waveMaskFiles(), 'mask-music.tjs': waveMaskSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("mask-music.tjs","savedata/mask-music.cjs",false,true,false);Scripts.execStorage("savedata/mask-music.cjs");'
          : 'Scripts.execStorage("mask-music.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
      pcm = (at: number, entry: typeof waveMaskCases[number], frames = 160) => {
        for (const [channel, actual] of [left, right].entries()) {
          const amplitude = entry.stereo[channel]!
          assert.deepEqual(actual, Array.from({ length: frames }, (_, frame) => amplitude === 0 ? 0
            : Math.fround((at + frame) % 8 < 4 ? amplitude : -amplitude)), entry.name)
        }
        left.length = right.length = 0
      }
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/mask-music.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      for (const [index, entry] of waveMaskCases.entries()) {
        assert.equal(await session.evaluate(`maskOpen(${index})`), `${entry.row.length}|play`)
        assert.equal(await session.evaluate('maskMusic.totalTime+"|"+maskMusic.frequency+"|"+maskMusic.bits'), '4000|8000|16')
        await session.evaluate('(maskMusic.samplePosition=4094,0)'); await settleAudioPages(audio)
        clock.advance(20); await session.idle(); pcm(4094, entry)
        assert.equal(await session.evaluate('maskMusic.samplePosition'), '4254')
        await session.evaluate('(maskMusic.paused=true,0)'); clock.advance(20); await session.idle()
        pcm(0, entry, 0); assert.equal(await session.evaluate('maskMusic.samplePosition'), '4254')
        await session.evaluate('(maskMusic.paused=false,0)'); clock.advance(20); await session.idle(); pcm(4254, entry)
        await session.evaluate('(maskMusic.samplePosition=31994,0)'); await settleAudioPages(audio)
        clock.advance(20); await session.idle(); pcm(31994, entry)
        assert.equal(await session.evaluate('maskMusic.status+"|"+maskMusic.samplePosition'), 'play|154')
        if (index === 0) {
          await session.evaluate('(maskMusic.samplePosition=8188,maskLabels=0,0)'); await settleAudioPages(audio)
          clock.advance(20); await session.idle(); pcm(8188, entry)
          assert.equal(await session.evaluate('maskMusic.samplePosition+"|"+maskLabels'), '8188|10')
        }
        assert.equal(audio.inspect().voices, 1)
      }
      await session.evaluate('maskMusic.stop()'); clock.advance(20); await session.idle()
      assert(left.every((sample) => sample === 0) && right.every((sample) => sample === 0))
      await session.evaluate('invalidate maskMusic')
      assert.equal(audio.inspect().voices, 0); assert.equal(audio.mixer.inspectStreams().voices, 0)
    } catch (error) { failures.push(error) }
    try {
      await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave mask playback or cleanup failed', { cause: failures[0] })
  })
