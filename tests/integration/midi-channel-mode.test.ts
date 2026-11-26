import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { midiChannelModeFiles, midiChannelModeSource } from '../helpers/midi-channel-mode.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: real game music loads mono and poly scores with independent note-off PCM references and cancellation`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [], files = midiChannelModeFiles(),
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
        output[0]!.push(...l); output[1]!.push(...r)
      }, 44100),
      { session } = await headless({ ...files, 'mode.tjs': midiChannelModeSource, 'startup.tjs': binary
        ? 'Scripts.compileStorage("mode.tjs","savedata/mode.cjs",false,true,false);Scripts.execStorage("savedata/mode.cjs");'
        : 'Scripts.execStorage("mode.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
      reference = new AudioMixer(44100), renderReference = (frames: number) => {
        const l = new Float32Array(frames), r = new Float32Array(frames)
        const events = reference.render(l, r); assert(!events.some((event) => event.type === 'error'))
        return [[...l], [...r]]
      }, take = async (ms: number, expected: readonly number[][]) => {
        output.forEach((plane) => { plane.length = 0 }); clock.advance(ms); await session.idle()
        assert.deepEqual(output, expected)
      }
    try {
      await session.start()
      for (const mode of ['poly', 'mono', 'sustain', 'restored']) {
        reference.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(files[`${mode}-reference.mid`]!), settings: defaultSoundSettings() })
        reference.command({ op: 'play', id: 1 })
        assert.equal(await session.evaluate(`modeStart("${mode}.mid",false)`), 'play')
        await take(100, renderReference(4410))
        await take(800, renderReference(35280))
        assert(output[0]!.some((sample) => sample !== 0))
        assert.deepEqual(output[0], output[1])
        // Real stop/replay clears owned notes and starts the score's mode
        // controls again at its next first tick.
        await session.evaluate('modeMusic.stop()'); reference.command({ op: 'stop', id: 1 })
        await take(20, [[], []])
        await session.evaluate('modeMusic.play()'); reference.command({ op: 'play', id: 1 })
        await take(100, renderReference(4410))
      }
      await session.evaluate('modeStart("mono-long.mid",false)')
      reference.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(files['mono-reference.mid']!), settings: defaultSoundSettings() })
      reference.command({ op: 'play', id: 1 }); await take(20, renderReference(882))
      await session.evaluate('invalidate modeMusic'); assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { reference.command({ op: 'shutdown' }); await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'MIDI channel-mode game or cleanup failed', { cause: failures[0] })
  })
