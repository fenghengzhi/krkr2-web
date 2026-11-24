import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { wavePrecisionGame } from '../helpers/extensible-wave.ts'
import { headless } from '../helpers/headless.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: WaveSoundBuffer reports valid bits and plays only the physical PCM interval`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      left.push(...l); right.push(...r)
    }), { session, logs } = await headless(wavePrecisionGame(binary), { audio, now: () => clock.now, schedule: clock.schedule })
  try {
    let unrelatedReads = 0
    session.mount([{ name: 'disc-2.bin', size: 1024 * 1024 * 1024,
      async read() { unrelatedReads++; throw new Error('Unrelated disc image read') } }])
    await session.start()
    assert.equal(await session.evaluate('precisionOpen("12-in-16.wav")'), '12,2,48000,133,0,stop')
    assert.equal(await session.evaluate('precisionOpen("20-in-24.wav")'), '20,2,48000,120,0,stop')
    assert.equal(await session.evaluate('precisionPlay()'), 'started')
    await settleAudioPages(audio)
    clock.advance(125)
    await session.idle()
    assert.equal(await session.evaluate('precisionWave.status'), 'stop')
    assert(logs.includes('precision-ended'))
    assert.deepEqual(left, [...Array(4800).fill(0.25), ...Array(1200).fill(0)])
    assert.deepEqual(right, [...Array(4800).fill(-0.5), ...Array(1200).fill(0)])
    assert.equal(await session.evaluate('precisionOpen("24-in-32.wav")'), '24,2,48000,133,0,stop')
    assert.equal(await session.evaluate('(precisionWave.samplePosition=4096,precisionWave.samplePosition)'), '4096')
    await session.evaluate('System.assignMessage("TVPUnknownWaveFormat","wave:<%1>")')
    assert.equal(await session.evaluate('precisionError()'), 'wave:<foreign-guid.wav>')
    assert.equal(await session.evaluate('precisionWave.status'), 'unload')
    assert.equal(await session.evaluate('precisionOpen("20-in-24.wav")'), '20,2,48000,120,0,stop')
    assert.equal(unrelatedReads, 0)
  } catch (error) { failures.push(error) }
  try {
    await session.stop()
    assert.equal(clock.tasks.size, 0)
    assert.equal(audio.mixer.inspectStreams().voices, 0)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'WAVE playback or cleanup failed', { cause: failures[0] })
})
