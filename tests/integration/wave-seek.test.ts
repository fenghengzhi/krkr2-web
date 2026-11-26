import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveSeekFiles, waveSeekPattern, waveSeekSource } from '../helpers/wave-seek.ts'

for (const binary of [false, true]) for (const looping of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: Wave public seeks preserve integer PCM and ${looping ? 'SLI source traversal' : 'paused/playing invalid-range state'}`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
        left.push(...l); right.push(...r)
      }, 44100), { session } = await headless({ ...waveSeekFiles(), 'seek.tjs': waveSeekSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("seek.tjs","savedata/seek.cjs",false,true,false);Scripts.execStorage("savedata/seek.cjs");'
          : 'Scripts.execStorage("seek.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    const pcm = (from: number, frames = 882) => {
      const expected = Array.from({ length: frames }, (_, i) => waveSeekPattern[(from + i) % 8]!)
      assert.deepEqual(left.splice(0), expected); assert.deepEqual(right.splice(0), expected)
    }
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/seek.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      await session.evaluate(`(global.sw=new SeekWave(),sw.open("${looping ? 'seek-loop.wav' : 'seek.wav'}"),sw.paused=true,sw.play(),0)`)
      if (looping) {
        // Admit the loop destination's third page through a real public seek
        // before advancing the synthetic device clock across that page.
        await session.evaluate('(sw.samplePosition=8196,0)'); await settleAudioPages(audio)
        // 185 ms is exactly 8158 samples after native integer division, not
        // 8158.5. The block crosses an actual streamed page and an SLI link.
        assert.equal(await session.evaluate('(sw.position=185,sw.samplePosition)'), '8158')
        await settleAudioPages(audio)
        await session.evaluate('(waveSeekInvalid(sw,8200),sw.paused=false,0)')
        clock.advance(20); await session.idle(); pcm(8158)
        assert.equal(await session.evaluate('[sw.samplePosition,sw.markers.count].join(",")'), '8200,106')
        assert.equal(await session.evaluate('sw.markers.join(",")'), Array(106).fill('loop').join(','))
      } else {
        assert.equal(await session.evaluate('(sw.position=1,[sw.samplePosition,sw.position].join(","))'), '44,0')
        await session.evaluate('(waveSeekInvalid(sw,88200),0)')
        assert.equal(await session.evaluate('[sw.samplePosition,sw.paused,sw.status,sw.states.join(",")].join("|")'), '44|1|play|stop,play')
        clock.advance(20); await session.idle()
        assert.deepEqual(left, []); assert.deepEqual(right, [])
        await session.evaluate('(sw.paused=false,sw.fade(50000,120),0)')
        await settleAudioPages(audio)
        clock.advance(20); await session.idle(); pcm(44)
        assert.equal(await session.evaluate('[sw.samplePosition,sw.markers.join(","),sw.completed].join("|")'), '926|ms44,sample45|0')
        // Invalid requests while playing must preserve position, label cursor,
        // epoch and the inherited fade rather than stopping or restarting it.
        const epoch = audio.mixer.snapshot(1).epoch
        await session.evaluate('(waveSeekInvalid(sw,88200),0)')
        assert.equal(audio.mixer.snapshot(1).epoch, epoch)
        clock.advance(20); await session.idle(); pcm(926)
        assert.equal(await session.evaluate('[sw.samplePosition,sw.markers.join(","),sw.completed].join("|")'), '1808|ms44,sample45,later|0')
        await session.evaluate('(sw.paused=true,sw.position=4611686018427387904,0)')
        assert.equal(await session.evaluate('sw.samplePosition'), '0', 'uint64 multiplication wraps before millisecond division')
        // Successful public TJS conversion still occurs before range checks.
        await session.evaluate('System.assignMessage("TJSVariantConvertError","seek-conversion")')
        assert.equal(await session.evaluate('(function(){try{sw.samplePosition=%[];}catch(e){return e.message+","+sw.samplePosition;}return "unexpected";})()'), 'seek-conversion,0')
        await session.evaluate('(sw.stopFade(),[sw.volume,sw.completed].join(","))').then((value) => assert.equal(value, '50000,1'))
        // Native Format starts at zero and survives Clear/Open until the
        // secondary buffer is recreated by play; InputFormat alone cannot
        // supply the public millisecond conversion's rate.
        assert.equal(await session.evaluate('(function(){var cold=new SeekWave(),seen=[];cold.open("seek.wav");cold.samplePosition=45;cold.position=1;seen.add(cold.samplePosition);cold.paused=true;cold.play();cold.stop();cold.position=1;seen.add(cold.samplePosition);cold.open("seek-other.wav");cold.position=1;seen.add(cold.samplePosition);cold.paused=true;cold.play();cold.stop();cold.position=1;seen.add(cold.samplePosition);invalidate cold;return seen.join(",");})()'), '0,44,44,48')
      }
      await session.evaluate('(sw.stop(),invalidate sw,0)')
      assert.equal(audio.inspect().voices, 0); assert.equal(audio.mixer.inspectStreams().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave seek or cleanup failed', { cause: failures[0] })
  })
