import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { headless } from '../helpers/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { waveBooleanExpected, waveBooleanFiles, waveBooleanSource } from '../helpers/wave-booleans.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: native Wave boolean controls pause real stereo PCM and loop fractional-real requests without changing integer properties`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { left.push(...l); right.push(...r) }, 1000),
    { session } = await headless({ ...waveBooleanFiles(), 'wave-bool.tjs': waveBooleanSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("wave-bool.tjs","savedata/wave-bool.cjs",false,true,false);Scripts.execStorage("savedata/wave-bool.cjs");'
        : 'Scripts.execStorage("wave-bool.tjs");',
    }, { audio, now: () => clock.now, schedule: clock.schedule })
  const l = [0.125, 0.25, 0.375, 0.5, -0.125, -0.25, -0.375, -0.5],
    r = [-0.5, -0.375, -0.25, -0.125, 0.5, 0.375, 0.25, 0.125],
    sample = async (start: number, real: number, silence = 0) => {
      await settleAudioPages(audio); clock.advance(20); await session.idle()
      assert.deepEqual(left.splice(0), [...Array.from({ length: real }, (_, i) => l[(start + i) % 8]!), ...Array(silence).fill(0)])
      assert.deepEqual(right.splice(0), [...Array.from({ length: real }, (_, i) => r[(start + i) % 8]!), ...Array(silence).fill(0)])
    }
  try {
    await session.start()
    if (binary) assert.equal(new TextDecoder().decode(session.exportSaves().find((entry) => entry.path === 'savedata/wave-bool.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    for (const [name, expected] of Object.entries(waveBooleanExpected))
      assert.equal(await session.evaluate(`waveBooleanObserve("${name}")`), expected, name)
    assert.equal(audio.inspect().voices, 0)
    assert.equal(await session.evaluate('waveBooleanStart("bool-phrase.wav")'), 'play,1,1,0,0')
    await sample(0, 0)
    assert.equal(await session.evaluate('waveBooleanState()'), 'play,1,1,0,0')
    await session.evaluate('(boolMusic.paused=0,0)')
    await sample(0, 20)
    assert.equal(await session.evaluate('waveBooleanState()'), 'play,0,1,20,1')
    await sample(20, 20)
    assert.equal(await session.evaluate('waveBooleanState()'), 'play,0,1,16,2')
    assert.equal(await session.evaluate('(boolMusic.paused=0.5,boolMusic.play(),waveBooleanState())'), 'play,1,1,16,2')
    await sample(0, 0)
    assert.equal(await session.evaluate('waveBooleanState()'), 'play,1,1,16,2')
    await session.evaluate('(boolMusic.paused=null,0)')
    await sample(16, 20)
    assert.equal(await session.evaluate('waveBooleanState()'), 'play,0,1,12,3')
    assert.equal(await session.evaluate('(boolMusic.looping="0.5",boolMusic.looping)'), '0')
    await sample(12, 12, 8)
    assert.equal(await session.evaluate('waveBooleanState()'), 'stop,0,0,24,3')
    assert.equal(await session.evaluate('(boolMusic.paused=%[],boolMusic.looping=<%00%>,boolMusic.play(),waveBooleanState())'), 'play,1,1,0,3')
    await sample(0, 0)
    await session.evaluate('(boolMusic.paused=0,0)'); await sample(0, 20)
    assert.equal(await session.evaluate('(boolMusic.stop(),boolMusic.states.join(","))'), 'stop,play,stop,play,stop')
    assert.equal(await session.evaluate('waveBooleanState()'), 'stop,0,1,0,4')
    assert.equal(await session.evaluate('waveBooleanClose()'), 'closed')
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0); assert.equal(session.snapshot().handles, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Wave boolean control or cleanup failed', { cause: failures[0] })
})
