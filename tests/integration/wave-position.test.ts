import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { wavePositionExpected, wavePositionFiles, wavePositionSource } from '../helpers/wave-position.ts'

for (const binary of [false, true]) {
  const files = { ...wavePositionFiles(), 'position.tjs': wavePositionSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("position.tjs","savedata/position.cjs",false,true,false);Scripts.execStorage("savedata/position.cjs");'
      : 'Scripts.execStorage("position.tjs");' }
  test(`${binary ? 'bytecode' : 'source'}: Wave position uses real conversions, float storage, atomic setPos and the native pan lifecycle`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }),
      { session } = await headless(files, { audio, now: () => clock.now, schedule: clock.schedule })
    try {
      await session.start()
      for (const [name, expected] of Object.entries(wavePositionExpected)) {
        assert.equal(await session.evaluate(`wavePositionObserve("${name}")`), expected, name)
        await session.idle()
        assert.equal(audio.mixer.inspectStreams().voices, 0, name + ' retires its actual sound owner')
      }
      await session.evaluate('System.assignMessage("TJSBadParamCount","later-position-count")')
      assert.equal(await session.evaluate('(function(){var w=new WaveSoundBuffer(null);try{w.setPos(1,2);}catch(e){invalidate w;return e.message;}})()'), 'later-position-count')
      assert.equal(await session.evaluate('(function(){var m=new MIDISoundBuffer(null),c=new CDDASoundBuffer(null);var result=typeof m.setPos=="undefined" && typeof c.posX=="undefined";invalidate m;invalidate c;return result;})()'), '1')
    } catch (error) { failures.push(error) }
    try {
      await session.stop()
      assert.equal(clock.tasks.size, 0); assert.equal(session.snapshot().handles, 0)
      assert.equal(audio.mixer.inspectStreams().voices, 0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave position contract or cleanup failed', { cause: failures[0] })
  })

  test(`${binary ? 'bytecode' : 'source'}: ordinary Wave coordinates leave every stereo PCM sample unchanged while real pan remains independent`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
        left.push(...l); right.push(...r)
      }), { session } = await headless(files, { audio, now: () => clock.now, schedule: clock.schedule })
    try {
      await session.start()
      await session.evaluate('(function(){global.positionSound=new WaveSoundBuffer(null);positionSound.setPos(1,2,3);positionSound.open("position.wav");positionSound.play();return 0;})()')
      const sample = async (expectedLeft: number) => {
        left.length = 0; right.length = 0
        await settleAudioPages(audio)
        clock.advance(20); await session.idle()
        assert.deepEqual(left, Array(960).fill(expectedLeft))
        assert.deepEqual(right, Array(960).fill(-0.5))
      }
      await sample(0.25)
      assert.equal(await session.evaluate('(positionSound.setPos(-100000,1e100,-1e100),positionSound.pan)'), '0')
      await sample(0.25)
      assert.equal(await session.evaluate('(positionSound.setPos(7,8,9),positionSound.pan=50000,wavePositionText(positionSound))'), '7,8,9')
      await sample(Math.fround(0.25 * 10 ** (-1505 / 2000)))
      assert.equal(await session.evaluate('(positionSound.posY=-0.2,positionSound.pan)'), '50000')
      await sample(Math.fround(0.25 * 10 ** (-1505 / 2000)))
      assert.equal(await session.evaluate('positionSound.samplePosition'), '3840')
      await session.evaluate('(function(){invalidate positionSound;return 0;})()')
      await session.idle()
      assert.equal(audio.mixer.inspectStreams().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0); assert.equal(session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave position PCM or cleanup failed', { cause: failures[0] })
  })
}
