import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveFadeExpected, waveFadeDelayedExpected, waveFadeFiles, waveFadeSource } from '../helpers/wave-fade.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: native fade validation, reentry and delayed zero-count fades preserve real PCM and callbacks`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      left.push(...l); right.push(...r)
    }, 1000), { session } = await headless({ ...waveFadeFiles(), 'fade-control.tjs': waveFadeSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("fade-control.tjs","savedata/fade-control.cjs",false,true,false);Scripts.execStorage("savedata/fade-control.cjs");'
        : 'Scripts.execStorage("fade-control.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  try {
    await session.start()
    for (const [id, expected] of Object.entries(waveFadeExpected))
      assert.equal(await session.evaluate(`waveFadeObserve("${id}")`), expected, id)
    assert.equal(audio.mixer.inspect().voices, 0)
    await session.evaluate('(function(){global.faded=new FadeControl();faded.open("fade.wav");faded.volume=25000;faded.play();faded.fade(200000,120);return 0;})()')
    await settleAudioPages(audio)
    clock.advance(120); await session.idle()
    // The un-clamped target makes the first 60ms update overshoot to 100000.
    // Clamping the target first would wrongly produce a 62500 intermediate.
    assert.deepEqual(left, [...Array(59).fill(0.125), ...Array(61).fill(0.5)])
    assert.deepEqual(right, left)
    assert.equal(await session.evaluate('faded.observations.join(",")'), '100000')
    assert.equal(await session.evaluate('faded.samplePosition'), '120')
    await session.evaluate('(function(){invalidate faded;return 0;})()')
    assert.equal(await session.evaluate('fadeDelayedStart()'), 'waiting')
    clock.advance(240); await session.idle()
    assert.equal(await session.evaluate('fadeDelayedResult'), waveFadeDelayedExpected)
    assert.equal(audio.mixer.inspect().voices, 0)
    assert.equal(audio.mixer.hasClockWork, false)
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0); assert.equal(session.snapshot().handles, 0) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Native fade or cleanup failed', { cause: failures[0] })
})
