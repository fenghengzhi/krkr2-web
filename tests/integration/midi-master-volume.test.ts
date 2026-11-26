import assert from 'node:assert/strict'
import test from 'node:test'
import { MidiSynth } from '../../src/engine/media/midi-synth.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { masterPlain, midiMasterFiles, midiMasterSource } from '../helpers/midi-master-volume.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: ordinary game music honors score and raw master fades without stopping its transport`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (l, r) => { output[0]!.push(...l); output[1]!.push(...r) }, 44100),
      { session } = await headless({ ...midiMasterFiles(), 'master.tjs': midiMasterSource,
        'startup.tjs': binary ? 'Scripts.compileStorage("master.tjs","savedata/master.cjs",false,true,false);Scripts.execStorage("savedata/master.cjs");'
          : 'Scripts.execStorage("master.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
      take = async (ms: number, expected: number[]) => {
        output.forEach((plane) => { plane.length = 0 }); clock.advance(ms); await session.idle()
        assert.deepEqual(output, [expected, expected])
      }
    let reference = new MidiSynth(decodeMidi(masterPlain())), at = 0
    const samples = (frames: number, gain: (frame: number) => number) => Array.from({ length: frames }, () => {
      reference.render(at / 44100, 1 / 44100)
      return Math.fround(reference.left * gain(at++))
    })
    try {
      await session.start()
      for (const split of [false, true]) {
        reference = new MidiSynth(decodeMidi(masterPlain())); at = 0
        assert.equal(await session.evaluate(`masterStart("master-${split ? 'split' : 'score'}.mid")`), 'play')
        await take(500, samples(22050, (frame) => frame < (split ? 6615 : 4410) ? 1
          : frame < 8820 ? (8192 / 16383) ** 2 : frame < 13230 ? 0 : frame < 17640 ? (8193 / 16383) ** 2 : 1))
      }
      reference = new MidiSynth(decodeMidi(masterPlain())); at = 0
      await session.evaluate('masterStart("master-long.mid")')
      await take(100, samples(4410, () => 1))
      await session.evaluate('masterQuiet()'); await take(100, samples(4410, () => (8192 / 16383) ** 2))
      await session.evaluate('masterMute()'); await take(100, samples(4410, () => 0))
      assert.equal(await session.evaluate('masterMusic.status+":"+masterMusic.position'), 'play:300')
      await session.evaluate('masterFine()'); await take(100, samples(4410, () => (8193 / 16383) ** 2))
      // Saving/restoring a public source position rebuilds the score. The raw
      // module message is not a serialized script setting of the sound object.
      await session.evaluate('(masterSaved=masterMusic.samplePosition,masterMusic.stop(),masterMusic.samplePosition=masterSaved,masterMusic.play(),0)')
      reference.seek(.4); at = 17640
      await take(100, samples(4410, () => 1))
      assert.equal(await session.evaluate('masterMusic.status'), 'play')
      await session.evaluate('masterMusic.stop()'); await take(20, [])
      await session.evaluate('invalidate masterMusic'); assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Game MIDI master volume or cleanup failed', { cause: failures[0] })
  })
