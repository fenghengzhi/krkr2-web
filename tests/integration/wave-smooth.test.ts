import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { smoothCycle, smoothShortCycle, smoothSamples, waveSmoothFiles, waveSmoothSource } from '../helpers/wave-smooth.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: ordinary streamed Smooth music preserves both ramps, audible labels, pause, replay and reopen`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      left.push(...l); right.push(...r)
    }, 1000), { session } = await headless({ ...waveSmoothFiles(), 'smooth.tjs': waveSmoothSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("smooth.tjs","savedata/smooth.cjs",false,true,false);Scripts.execStorage("savedata/smooth.cjs");'
        : 'Scripts.execStorage("smooth.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  const pcm = (values: readonly number[]) => {
    assert.deepEqual(left.splice(0), smoothSamples(values)); assert.deepEqual(right.splice(0), smoothSamples(values))
  }
  try {
    await session.start()
    if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
      .find((entry) => entry.path === 'savedata/smooth.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    await session.evaluate('(global.music=new SmoothSound(),music.open("smooth.wav"),music.samplePosition=72,music.play(),0)')
    await settleAudioPages(audio); clock.advance(20); await session.idle(); pcm(smoothCycle.slice(0, 20))
    assert.equal(await session.evaluate('[music.samplePosition,music.labelsSeen.join(","),music.filters.count].join("|" )'), '20|before,jump,after|0')
    await session.evaluate('(music.paused=true,0)'); clock.advance(40); await session.idle()
    assert.deepEqual(left, []); assert.deepEqual(right, []); assert.equal(await session.evaluate('music.samplePosition'), '20')
    await session.evaluate('(music.paused=false,0)'); clock.advance(20); await session.idle(); pcm(smoothCycle.slice(20, 40))
    assert.equal(await session.evaluate('music.samplePosition'), '40')
    await session.evaluate('(music.stop(),music.labelsSeen.clear(),music.play(),0)')
    await settleAudioPages(audio); clock.advance(20); await session.idle(); pcm(Array(20).fill(-8192))
    assert.equal(await session.evaluate('[music.samplePosition,music.labelsSeen.join(",")].join("|" )'), '20|jump,after')
    await session.evaluate('(music.open("smooth-short.wav"),music.labelsSeen.clear(),music.samplePosition=72,music.play(),0)')
    await settleAudioPages(audio); clock.advance(20); await session.idle(); pcm(smoothShortCycle.slice(0, 20))
    assert.equal(await session.evaluate('[music.samplePosition,music.flags[1],music.labelsSeen.join(",")].join("|" )'), '20|0|before,jump,after')
    await session.evaluate('(invalidate music,0)')
    assert.equal(audio.inspect().voices, 0)
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Smooth Wave playback or cleanup failed', { cause: failures[0] })
})
