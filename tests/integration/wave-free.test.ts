import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveFreeExpected, waveFreeFiles, waveFreeSource } from '../helpers/wave-free.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: freeDirectSound stops all Wave voices, retains their fade and SLI, and leaves MIDI/CDDA playing`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
        left.push(...l); right.push(...r)
      }, 1000), { session } = await headless({ ...waveFreeFiles(), 'free.tjs': waveFreeSource,
        'startup.tjs': binary ? 'Scripts.compileStorage("free.tjs","savedata/free.cjs",false,true,false);Scripts.execStorage("savedata/free.cjs");'
          : 'Scripts.execStorage("free.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    const pcm = async (milliseconds: number, expected: number[]) => {
      await settleAudioPages(audio); left.length = right.length = 0
      clock.advance(milliseconds); await session.idle()
      assert.deepEqual(left, expected); assert.deepEqual(right, expected)
    }
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/free.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      for (const [name, expected] of Object.entries(waveFreeExpected))
        assert.equal(await session.evaluate(`waveFreeObserve("${name}")`), expected, name)
      await session.evaluate('(waveFreeStart(),freeA.fade(0,120),0)')
      await pcm(20, Array(20).fill(0.4375))
      const cached = audio.mixer.inspectStreams().bytes
      assert.equal(await session.evaluate('(global.freeLabels=freeA.labels,freeOrder.clear(),freeRecording=true,WaveSoundBuffer.freeDirectSound(),freeRecording=false,waveFreeState())'), 'stop,stop,play,play')
      assert.equal(await session.evaluate('[freeA.samplePosition,freeB.samplePosition,freeCd.samplePosition,freeMidi.samplePosition].join(",")'), '0,0,20,882')
      assert.equal(await session.evaluate('freeOrder.join(";")'), 'a:stop,play;b:stop,stop')
      assert.equal(await session.evaluate('int(freeLabels===freeA.labels)'), '1')
      assert(audio.mixer.inspectStreams().bytes < cached, 'Wave pages are actually released while the CDDA pages survive')
      assert.equal(audio.mixer.inspectStreams().voices, 3, 'Open streaming decoders remain available')
      await pcm(60, Array(60).fill(0.0625))
      assert.equal(await session.evaluate('[freeA.volume,freeA.done,freeA.samplePosition,freeB.samplePosition].join(",")'), '50000,0,0,0')
      await session.evaluate('(freeA.play(),freeB.play(),0)')
      await pcm(40, [...Array(39).fill(Math.fround(Math.fround(Math.fround(0.25 * 10 ** (-1505 / 2000)) + 0.125) + 0.0625)), 0.1875])
      assert.equal(await session.evaluate('[freeA.volume,freeA.done,freeA.marks.join(","),freeB.marks.join(",")].join("|")'), '0|1|a,a|b,b')
      assert.equal(await session.evaluate('waveFreeState()'), 'play,play,play,play')
      // Native calls the real Stop even if the script subclass shadows it.
      await session.evaluate('(freeA.stop=function(){throw new Exception("shadow stop");},freeA.volume=100000,freeA.restart=true,freeRecording=true,WaveSoundBuffer.freeDirectSound(),freeRecording=false,0)')
      assert.equal(await session.evaluate('waveFreeState()'), 'play,stop,play,play')
      await pcm(20, Array(20).fill(0.0625))
      assert.equal(await session.evaluate('waveFreeState()'), 'stop,stop,play,play')
      await session.evaluate('(freeA.play(),freeB.play(),0)')
      await pcm(20, Array(20).fill(0.4375))
      await session.evaluate('(freeB.freeDirectSound(),freeCd.stop(),freeMidi.stop(),0)')
      assert.equal(await session.evaluate('waveFreeState()'), 'stop,stop,stop,stop')
      // A stopped mixer has no clock work; issue one real render quantum to
      // confirm the device output is silent without inventing VM time.
      const silent = new Float32Array(20), silentRight = new Float32Array(20)
      assert.deepEqual(audio.mixer.render(silent, silentRight), [])
      assert.deepEqual(silent, new Float32Array(20)); assert.deepEqual(silentRight, silent)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave release or cleanup failed', { cause: failures[0] })
  })
