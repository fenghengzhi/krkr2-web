import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { midiControllerFiles, midiControllerSource } from '../helpers/midi-controller-reset.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: game MIDI resets preserve stereo placement and separate raw device volume from the SMF owner`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [], files = midiControllerFiles(),
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
        output[0]!.push(...l); output[1]!.push(...r)
      }, 44100),
      { session } = await headless({ ...files, 'controller.tjs': midiControllerSource, 'startup.tjs': binary
        ? 'Scripts.compileStorage("controller.tjs","savedata/controller.cjs",false,true,false);Scripts.execStorage("savedata/controller.cjs");'
        : 'Scripts.execStorage("controller.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
      reference = new AudioMixer(44100), openReference = (name: keyof typeof files) => {
        reference.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(files[name]), settings: defaultSoundSettings() })
        reference.command({ op: 'play', id: 1 })
      }, renderReference = (frames: number) => {
        const l = new Float32Array(frames), r = new Float32Array(frames)
        const events = reference.render(l, r); assert(!events.some((event) => event.type === 'error'))
        return [[...l], [...r]]
      }, take = async (ms: number, expected: readonly number[][]) => {
        output.forEach((plane) => { plane.length = 0 }); clock.advance(ms); await session.idle()
        assert.deepEqual(output, expected)
      }, referenceRaw = (...data: number[]) => reference.command({ op: 'midiOut', data: new Uint8Array(data) })
    try {
      await session.start()
      for (const value of ['zero', 'one'] as const) {
        openReference(`reset-${value}-explicit.mid`)
        assert.equal(await session.evaluate(`controllerStart("reset-${value}.mid",false)`), 'play')
        await take(200, renderReference(8820))
      }
      openReference('reset-long.mid'); await session.evaluate('controllerStart("reset-long.mid",false)')
      await take(100, renderReference(4410))
      await session.evaluate('controllerZero()'); referenceRaw(0xb0, 11, 127)
      await take(100, renderReference(4410)); assert(output[1]!.every((sample) => sample === 0))
      await session.evaluate('controllerOne()'); referenceRaw(0xb0, 7, 100, 0xb0, 10, 64, 0xb0, 11, 127)
      await take(100, renderReference(4410)); assert.deepEqual(output[0], output[1])

      openReference('reset-long.mid'); await session.evaluate('controllerStart("reset-long.mid",false)')
      await take(100, renderReference(4410))
      await session.evaluate('(controllerZero(),controllerMusic.volume=50000,0)')
      // Owner CC32 survives raw reset. The next real volume change uses
      // BufferVolume63 -> floor(32*63/127)=15, independently authored here.
      referenceRaw(0xb0, 11, 127, 0xb0, 7, 15)
      await take(100, renderReference(4410)); assert(output[0]!.some((sample) => sample !== 0))

      await session.evaluate('(controllerMusic.volume=100000,controllerStart("pan-late.mid",true))')
      openReference('pan-late.mid'); const center = renderReference(8820)
      await take(200, center)
      openReference('pan-explicit.mid'); const left = renderReference(8820)
      await take(400, left.map((plane) => [...plane, ...plane]))
      await session.evaluate('controllerStop()'); await take(20, [[], []])
      await session.evaluate('controllerPlay()'); await take(200, left)
      await session.evaluate('controllerStart("pan-late.mid",false)'); await take(200, center)
      await session.evaluate('invalidate controllerMusic'); assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { reference.command({ op: 'shutdown' }); await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'MIDI controller game or cleanup failed', { cause: failures[0] })
  })
