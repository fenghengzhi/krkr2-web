import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { MidiSynth } from '../../src/engine/media/midi-synth.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { midiRhythmFiles, midiRhythmSource } from '../helpers/midi-rhythm.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: game music loads GS rhythm parts, loops their real PCM and restores a saved musical position`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [], files = midiRhythmFiles(),
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (left, right) => { output[0]!.push(...left); output[1]!.push(...right) }, 44100),
      { session } = await headless({ ...files, 'rhythm.tjs': midiRhythmSource,
        'startup.tjs': binary ? 'Scripts.compileStorage("rhythm.tjs","savedata/rhythm.cjs",false,true,false);Scripts.execStorage("savedata/rhythm.cjs");'
          : 'Scripts.execStorage("rhythm.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
      take = async (ms: number, expected: readonly number[]) => {
        output.forEach((plane) => { plane.length = 0 }); clock.advance(ms); await session.idle()
        assert.deepEqual(output, [expected, expected])
      }, reference = (drum: boolean, start = 0, frames = 44100) => {
        const synth = new MidiSynth(decodeMidi(files[drum ? 'rhythm-reference.mid' : 'melodic-reference.mid']))
        if (start) synth.seek(start / 44100)
        return Array.from({ length: frames }, (_, at) => {
          synth.render((start + at) / 44100, 1 / 44100); return Math.fround(synth.left)
        })
      }, drum = reference(true), melody = reference(false)
    try {
      assert.notDeepEqual(drum, melody); await session.start()
      for (const stage of [0, 1, 2, 3]) {
        const expected = stage < 2 ? drum : melody
        assert.equal(await session.evaluate(`rhythmStart(${stage})`), 'play')
        await take(1000, expected); await take(1000, expected)
        await session.evaluate('(rhythmMusic.stop(),rhythmMusic.play(),0)'); await take(1000, expected)
        assert.equal(await session.evaluate('rhythmMusic.status'), 'play')
      }
      await session.evaluate('rhythmStart(1)'); await take(200, drum.slice(0, 8820))
      assert.equal(await session.evaluate('(rhythmSaved=rhythmMusic.samplePosition,rhythmMusic.stop(),rhythmSaved)'), '8820')
      await take(20, [])
      await session.evaluate('(rhythmMusic.samplePosition=rhythmSaved,rhythmMusic.play(),0)')
      await take(200, reference(true, 8820, 8820))
      assert.equal(await session.evaluate('rhythmMusic.position'), '400')
      await session.evaluate('invalidate rhythmMusic'); assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Game GS rhythm assignment or cleanup failed', { cause: failures[0] })
  })
