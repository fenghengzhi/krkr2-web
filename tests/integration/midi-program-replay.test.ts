import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { midiProgramReplayFiles, midiProgramReplaySource } from '../helpers/midi-program-replay.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: a looping game MIDI keeps its chosen instrument through Stop and natural replay`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [], files = midiProgramReplayFiles(),
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { left.push(...l); right.push(...r) }, 44100),
      { session } = await headless({ ...files, 'program.tjs': midiProgramReplaySource,
        'startup.tjs': binary ? 'Scripts.compileStorage("program.tjs","savedata/program.cjs",false,true,false);Scripts.execStorage("savedata/program.cjs");'
          : 'Scripts.execStorage("program.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    const expected = (name: 'program-song.mid' | 'program-reference.mid') => {
      const mixer = new AudioMixer(44100), l = new Float32Array(8820), r = new Float32Array(8820)
      mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(files[name]), settings: defaultSoundSettings() })
      mixer.command({ op: 'play', id: 1 }); mixer.render(l, r); mixer.command({ op: 'shutdown' })
      assert.deepEqual(l, r); return [...l]
    }, piano = expected('program-song.mid'), strings = expected('program-reference.mid'),
      take = async (ms: number, samples: readonly number[]) => {
        left.length = right.length = 0; clock.advance(ms); await session.idle()
        assert.deepEqual(left, samples); assert.deepEqual(right, samples)
      }
    try {
      assert.notDeepEqual(piano, strings)
      await session.start()
      for (const name of ['program-song.mid', 'program-end.mid']) {
        assert.equal(await session.evaluate(`programStart(${JSON.stringify(name)},true)`), 'play')
        await take(200, piano)
        await take(400, [...strings, ...strings])
        assert.equal(await session.evaluate('programMusic.status'), 'play')
        await session.evaluate('(programMusic.states.clear(),programMusic.stop(),0)')
        assert.equal(await session.evaluate('programMusic.states.join(",")'), 'stop')
        await take(20, []) // The stopped headless device has no scheduled render work.
        await session.evaluate('(programMusic.play(),0)')
        assert.equal(await session.evaluate('programMusic.states.join(",")'), 'stop,play')
        await take(200, strings)
      }

      // New-file isolation is deliberately separate from the same-song device
      // program retention. A module reset is likewise an actual MIDI command.
      assert.equal(await session.evaluate('programStart("program-end.mid",false)'), 'play')
      await take(100, piano.slice(0, 4410))
      // Stop before the final tick must not apply its future ProgramChange.
      await session.evaluate('(programMusic.stop(),programMusic.play(),0)')
      await take(200, piano)
      await session.evaluate('(programMusic.states.clear(),0)')
      await take(20, Array(882).fill(0))
      assert.equal(await session.evaluate('[programMusic.status,programMusic.states.join(",")].join("|")'), 'stop|stop')
      await session.evaluate('(programMusic.play(),0)'); await take(200, strings)
      await session.evaluate('(programMusic.stop(),MIDISoundBuffer.midiOut(<% f0 7e 7f 09 01 f7 %>),programMusic.play(),0)')
      await take(200, piano)
      await session.evaluate('invalidate programMusic')
      assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI instrument replay or cleanup failed', { cause: failures[0] })
  })
