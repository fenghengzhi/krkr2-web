import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveFrequencyExpected, waveFrequencyFiles, waveFrequencySource } from '../helpers/wave-frequency.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: Wave original-frequency zero restores actual streamed PCM, pages and SLI source positions`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      left.push(...l); right.push(...r)
    }, 8000), { session } = await headless({ ...waveFrequencyFiles(), 'frequency.tjs': waveFrequencySource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("frequency.tjs","savedata/frequency.cjs",false,true,false);Scripts.execStorage("savedata/frequency.cjs");'
        : 'Scripts.execStorage("frequency.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  const pcm = (expected: number[]) => {
    assert.deepEqual(left.splice(0), expected); assert.deepEqual(right.splice(0), expected)
  }, pattern = [0.125, -0.25, 0.375, -0.5, 0.625, -0.75, 0.875, -1]
  try {
    await session.start()
    if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
      .find((entry) => entry.path === 'savedata/frequency.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    assert.equal(await session.evaluate('waveFrequencyObserve()'), waveFrequencyExpected)
    assert.equal(audio.inspect().voices, 0)
    await session.evaluate('(function(){global.fq=new FrequencySound();fq.open("frequency.wav");fq.frequency=16000;fq.play();return 0;})()')
    await settleAudioPages(audio)
    clock.advance(20); await session.idle()
    pcm(Array.from({ length: 160 }, (_, i) => pattern[(i * 2) % 8]!))
    assert.equal(await session.evaluate('fq.samplePosition'), '320')
    assert.equal(await session.evaluate('(fq.frequency=0,fq.frequency)'), '0')
    clock.advance(20); await session.idle()
    pcm(Array.from({ length: 160 }, (_, i) => pattern[i % 8]!))
    assert.equal(await session.evaluate('fq.samplePosition'), '480')
    // Native int32 narrowing must preserve the sentinel and must not modify
    // a paused source clock.
    await session.evaluate('(fq.paused=true,fq.frequency=16000,fq.frequency=4294967296,0)')
    clock.advance(20); await session.idle(); pcm([])
    assert.equal(await session.evaluate('[fq.frequency,fq.samplePosition].join(",")'), '0,480')
    await session.evaluate('(fq.samplePosition=4092,fq.paused=false,0)')
    await settleAudioPages(audio)
    clock.advance(20); await session.idle()
    pcm(Array.from({ length: 160 }, (_, i) => pattern[(i + 4) % 8]!))
    assert.equal(await session.evaluate('fq.samplePosition'), '4252')
    // Reopening adopts the new input format before zero selects that format.
    assert.equal(await session.evaluate('(fq.open("frequency-other.wav"),fq.frequency)'), '16000')
    await session.evaluate('(fq.frequency=0,fq.play(),0)')
    await settleAudioPages(audio)
    clock.advance(20); await session.idle()
    pcm(Array.from({ length: 160 }, (_, i) => pattern[(i * 2) % 8]!))
    assert.equal(await session.evaluate('[fq.frequency,fq.samplePosition].join(",")'), '0,320')
    // SLI runs in actual source samples at the resolved playback rate. This
    // Web output check does not execute native zero-frequency label arithmetic.
    await session.evaluate('(fq.open("frequency-loop.wav"),fq.frequency=0,fq.samplePosition=8196,fq.play(),0)')
    await settleAudioPages(audio)
    clock.advance(20); await session.idle()
    pcm(Array.from({ length: 160 }, (_, i) => pattern[(i + 4) % 8]!))
    assert.equal(await session.evaluate('[fq.frequency,fq.samplePosition,fq.markers.count].join(",")'), '0,8196,20')
    assert.equal(await session.evaluate('fq.markers.join(",")'), Array(20).fill('loop-mark').join(','))
    await session.evaluate('(fq.stop(),fq.play(),0)')
    await settleAudioPages(audio)
    clock.advance(20); await session.idle()
    pcm(Array.from({ length: 160 }, (_, i) => pattern[i % 8]!))
    assert.equal(await session.evaluate('[fq.frequency,fq.samplePosition].join(",")'), '0,160')
    await session.evaluate('(invalidate fq,0)')
    assert.equal(audio.inspect().voices, 0); assert.equal(audio.mixer.inspectStreams().voices, 0)
    assert.equal(audio.mixer.inspectStreams().pending, 0)
  } catch (error) { failures.push(error) }
  try {
    await session.stop(); assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Wave frequency or cleanup failed', { cause: failures[0] })
})
