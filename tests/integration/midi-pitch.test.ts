import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { midiPitchCases, midiPitchFiles, midiPitchLong, midiPitchReference, midiPitchSource } from '../helpers/midi-pitch.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: game MIDI files and raw controls apply GS melodic tuning at the correct note boundary`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { left.push(...l); right.push(...r) }, 44100),
      { session } = await headless({ ...midiPitchFiles(), 'pitch.tjs': midiPitchSource,
        'startup.tjs': binary ? 'Scripts.compileStorage("pitch.tjs","savedata/pitch.cjs",false,true,false);Scripts.execStorage("savedata/pitch.cjs");'
          : 'Scripts.execStorage("pitch.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    const expected = (bytes: Uint8Array, count = 4410) => {
      const mixer = new AudioMixer(44100), l = new Float32Array(count), r = new Float32Array(count)
      try {
        mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(bytes), settings: defaultSoundSettings() })
        mixer.command({ op: 'play', id: 1 }); mixer.render(l, r)
        assert.deepEqual(r, l); assert(l.some((sample) => sample !== 0))
        return [...l]
      } finally { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
    }, take = async (samples: readonly number[], ms = 100) => {
      left.length = right.length = 0; clock.advance(ms); await session.idle()
      assert.deepEqual(left, samples); assert.deepEqual(right, samples)
    }
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/pitch.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      for (const entry of midiPitchCases) {
        assert.equal(await session.evaluate(`pitchStart("pitch-${entry.name}.mid")`), 'play')
        await take(expected(midiPitchReference(entry.key, entry.bend)))
        assert.equal(await session.evaluate('pitchMusic.status'), 'play')
      }
      const ordinary = expected(midiPitchLong(), 8820), octave = expected(midiPitchLong(81)),
        lower = expected(midiPitchLong(57)), fine = expected(midiPitchLong(68))
      assert.notDeepEqual(ordinary.slice(0, 4410), octave)
      assert.equal(await session.evaluate('pitchStart("pitch-base.mid")'), 'play')
      await take(ordinary.slice(0, 4410))
      await session.evaluate('pitchUp()')
      await take(ordinary.slice(4410), 100) // Held note must not retune to the newly configured octave.
      await session.evaluate('pitchReplay()'); await take(octave)
      await session.evaluate('(pitchMusic.paused=true,0)')
      const position = await session.evaluate('pitchMusic.samplePosition')
      await take([], 40)
      assert.equal(await session.evaluate('pitchMusic.samplePosition'), position)
      await session.evaluate('(pitchMusic.paused=false,pitchDown(),pitchReplay(),0)'); await take(lower)
      await session.evaluate('(pitchFine(),pitchReplay(),0)'); await take(fine)
      await session.evaluate('pitchModule()'); await take(ordinary.slice(0, 4410))
      // A new file and an explicit seek are score reconstruction, rather
      // than the parameter-preserving Stop/Play transport rewind above.
      await session.evaluate('(pitchUp(),pitchMusic.position=0,0)'); await take(ordinary.slice(0, 4410))
      assert.equal(await session.evaluate('pitchStart("pitch-default.mid")'), 'play')
      await take(ordinary.slice(0, 4410))
      await session.evaluate('(pitchMusic.stop(),invalidate pitchMusic,0)')
      assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try {
      await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI pitch controls or cleanup failed', { cause: failures[0] })
  })
