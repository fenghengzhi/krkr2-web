import assert from 'node:assert/strict'
import test from 'node:test'
import type { AudioCommand, AudioResult } from '../../src/engine/ports/audio.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveResetExpected, waveResetFiles, waveResetSource } from '../helpers/wave-flags-reset.ts'

class RunningAudio extends HeadlessAudioBackend {
  armed = false
  controls: AudioCommand[] = []
  constructor(private readonly deviceClock: AudioClock, output: (left: Float32Array, right: Float32Array) => void) {
    super({ now: () => deviceClock.now, schedule: deviceClock.schedule }, output, 1000)
  }
  override async command(command: AudioCommand): Promise<AudioResult> {
    const result = await super.command(command)
    if (this.armed && (command.op === 'flag' || command.op === 'resetFlags')) {
      this.controls.push(command)
      // A real device keeps consuming PCM while a Worker awaits a reply.
      // Admit one normal audio tick at every control-message boundary.
      await settleAudioPages(this); this.deviceClock.advance(20)
    }
    return result
  }
}
for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: a playing game atomically resets Wave routing flags across an audio-reply boundary`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
    audio = new RunningAudio(clock, (l, r) => { output[0]!.push(...l); output[1]!.push(...r) }),
    { session } = await headless({ ...waveResetFiles(), 'reset.tjs': waveResetSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("reset.tjs","savedata/reset.cjs",false,true,false);Scripts.execStorage("savedata/reset.cjs");'
      : 'Scripts.execStorage("reset.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  try {
    await session.start()
    for (const [name, expected] of Object.entries(waveResetExpected))
      assert.equal(await session.evaluate(`resetSdk(${name === 'wave-flags-paused'})`), expected)
    assert.equal(await session.evaluate('resetStart()'), 'play')
    await settleAudioPages(audio); clock.advance(20); await session.idle()
    assert.deepEqual(output[0]!.splice(0), Array(20).fill(.25)); output[1]!.length = 0
    audio.armed = true
    assert.equal(await session.evaluate('resetMusicFlags()'), Array(16).fill(0).join(','))
    audio.armed = false
    assert.deepEqual(audio.controls.map((command) => command.op), ['resetFlags'])
    await settleAudioPages(audio); clock.advance(40); await session.idle()
    assert.deepEqual(output[0], [...Array(20).fill(.25), ...Array(40).fill(.5)])
    assert.deepEqual(output[1], [...Array(20).fill(-.25), ...Array(40).fill(-.5)])
    assert.equal(await session.evaluate('resetMusic.status+":"+resetMusic.seen.join(",")'), 'play:next')
    await session.evaluate('(resetMusic.paused=true,resetMusic.flags.reset(),0)')
    output.forEach((plane) => { plane.length = 0 }); clock.advance(20); await session.idle()
    assert.deepEqual(output, [[], []])
    await session.evaluate('invalidate resetMusic')
    assert.equal(audio.inspect().voices, 0)
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0); assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Wave reset music or cleanup failed', { cause: failures[0] })
})
