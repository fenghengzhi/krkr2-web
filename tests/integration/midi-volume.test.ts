import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { midiVolumeCases, midiVolumeFiles, midiVolumePublicExpected, midiVolumeSource } from '../helpers/midi-volume.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: real MIDI music uses integer channel volume through open, setters, pause, fade and cleanup`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [], files = midiVolumeFiles(),
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
        left.push(...l); right.push(...r)
      }, 1000), { session } = await headless({ ...files, 'volume.tjs': midiVolumeSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("volume.tjs","savedata/volume.cjs",false,true,false);Scripts.execStorage("savedata/volume.cjs");'
          : 'Scripts.execStorage("volume.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/volume.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      assert.equal(await session.evaluate('midiVolumePublicControls()'), midiVolumePublicExpected)
      for (const entry of midiVolumeCases) {
        await session.evaluate(`(global.music=new VolumeMidi(),music.open("midi-volume-${entry.name}.mid"),music.volume=${entry.volume},music.volume2=${entry.volume2},music.play(),0)`)
        const reference = new AudioMixer(1000), expectedL = new Float32Array(20), expectedR = new Float32Array(20)
        reference.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(files[`midi-reference-${entry.name}.mid`]!), settings: defaultSoundSettings() })
        reference.command({ op: 'play', id: 1 }); reference.render(expectedL, expectedR)
        clock.advance(20); await session.idle()
        assert.deepEqual(left.splice(0), Array.from(expectedL), entry.name)
        assert.deepEqual(right.splice(0), Array.from(expectedR), entry.name)
        assert.equal(await session.evaluate('[music.status,music.volume,music.volume2].join(",")'), `play,${entry.volume},${entry.volume2}`)
        await session.evaluate('(music.paused=true,0)')
        const position = await session.evaluate('music.samplePosition')
        clock.advance(40); await session.idle()
        assert.deepEqual(left, []); assert.deepEqual(right, [])
        assert.equal(await session.evaluate('music.samplePosition'), position)
        await session.evaluate('(music.paused=false,music.volume=790,music.volume2=100000,0)')
        // CC100 maps to zero at this native bucket, while CC127 maps to one.
        if (entry.channel === 100) {
          clock.advance(20); await session.idle()
          assert.deepEqual(left.splice(0), Array(20).fill(0)); assert.deepEqual(right.splice(0), Array(20).fill(0))
        }
        await session.evaluate('(music.stop(),invalidate music,0)')
        reference.command({ op: 'shutdown' }); assert.equal(audio.inspect().voices, 0)
      }
      await session.evaluate('(global.music=new VolumeMidi(),music.open("midi-volume.mid"),music.play(),music.fade(0,120),0)')
      clock.advance(120); await session.idle()
      assert(left.some((sample) => sample !== 0)); assert.equal(left.at(-1), 0); assert.equal(right.at(-1), 0)
      assert.equal(await session.evaluate('[music.volume,music.completed,music.status].join(",")'), '0,1,play')
      left.length = right.length = 0
      await session.evaluate('(music.open("midi-volume.mid"),music.play(),0)')
      clock.advance(20); await session.idle()
      assert.deepEqual(left.splice(0), Array(20).fill(0)); assert.deepEqual(right.splice(0), Array(20).fill(0))
      await session.evaluate('(music.volume=100000,0)')
      clock.advance(20); await session.idle(); assert(left.some((sample) => sample !== 0))
      await session.evaluate('(invalidate music,0)'); assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI volume or cleanup failed', { cause: failures[0] })
  })
