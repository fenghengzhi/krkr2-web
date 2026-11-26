import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { midiResetDelayFiles, midiResetDelaySource } from '../helpers/midi-reset-delay.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: actual SMF initialization emits silence before first notes and each loop without changing the score EOF`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[] = [], right: number[] = [], failures: unknown[] = [], files = midiResetDelayFiles(),
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { output.push(...l); right.push(...r) }, 44100),
      { session } = await headless({ ...files, 'reset.tjs': midiResetDelaySource,
        'startup.tjs': binary ? 'Scripts.compileStorage("reset.tjs","savedata/reset.cjs",false,true,false);Scripts.execStorage("savedata/reset.cjs");'
          : 'Scripts.execStorage("reset.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    try {
      await session.start()
      for (const name of ['one', 'two'] as const) {
        const reference = new AudioMixer(44100), expectedL = new Float32Array(17640), expectedR = new Float32Array(17640)
        reference.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(files[`reference-${name}.mid`]),
          settings: { ...defaultSoundSettings(), looping: true } })
        reference.command({ op: 'play', id: 1 }); reference.render(expectedL, expectedR)
        reference.command({ op: 'shutdown' })
        output.length = right.length = 0
        assert.equal(await session.evaluate(`resetPlay("reset-${name}.mid")`), 'play')
        clock.advance(40); await session.idle()
        assert.deepEqual(output, Array(1764).fill(0), 'The real app renderer must not publish the nominal time-zero note early')
        clock.advance(360); await session.idle()
        assert.deepEqual(output, [...expectedL]); assert.deepEqual(right, [...expectedR])
        assert(output.some((value) => value !== 0))
        assert.equal(await session.evaluate('resetMusic.status'), 'play')
        await session.evaluate('(resetMusic.stop(),0)')
        output.length = right.length = 0
        await session.evaluate('(resetMusic.play(),0)'); clock.advance(40); await session.idle()
        assert.deepEqual(output, Array(1764).fill(0), 'Manual stop/play starts another actual initialization')
      }
      await session.evaluate('invalidate resetMusic')
      assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI initialization or cleanup failed', { cause: failures[0] })
  })
