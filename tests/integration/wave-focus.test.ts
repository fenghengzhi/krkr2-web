import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import type { AudioCommand, AudioResult } from '../../src/engine/ports/audio.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveFocusAttenuation, waveFocusFiles, waveFocusSource } from '../helpers/wave-focus.ts'

class FocusAudio extends HeadlessAudioBackend {
  readonly focusCommands: Extract<AudioCommand, { op: 'focusMode' }>[] = []
  override async command(command: AudioCommand): Promise<AudioResult> {
    if (command.op === 'focusMode') this.focusCommands.push({ ...command })
    return super.command(command)
  }
}
for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: Wave release focus options freeze at first construction and continue real PCM and labels`, { timeout: 60000 }, async () => {
    for (const row of [
      { mode: 'yes', volume: '25', script: 0, effective: 2, muteVolume: 25000 },
      { mode: 'minimize', volume: '0x19', script: 2, effective: 2, muteVolume: 25000 },
      { mode: 'never', volume: '4294967321', script: 2, effective: 2, muteVolume: 25000 },
      { mode: 'unknown', volume: '101', script: 0, effective: 0, muteVolume: 0 },
    ]) {
      const clock = new AudioClock(), samples: number[][] = [[], []], failures: unknown[] = [],
        audio = new FocusAudio({ now: () => clock.now, schedule: clock.schedule }, (left, right) => {
          samples[0]!.push(...left); samples[1]!.push(...right)
        }, 1000),
        { session } = await headless({ ...waveFocusFiles(), 'focus.tjs': waveFocusSource,
          'startup.tjs': binary
            ? 'Scripts.compileStorage("focus.tjs","savedata/focus.cjs",false,true,false);Scripts.execStorage("savedata/focus.cjs");'
            : 'Scripts.execStorage("focus.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
        take = async (gain: number) => {
          samples.forEach((plane) => { plane.length = 0 })
          await settleAudioPages(audio); clock.advance(20); await session.idle()
          await session.evaluate('focusSound.status')
          assert.deepEqual(samples, [Array(20).fill(Math.fround(.5 * gain)), Array(20).fill(Math.fround(-.25 * gain))])
        }
      try {
        await session.start()
        await session.evaluate(`(System.setArgument("-wsmute",${JSON.stringify(row.mode)}),System.setArgument("-wsmutevol",${JSON.stringify(row.volume)}),WaveSoundBuffer.globalFocusMode=${row.script},0)`)
        assert.equal(await session.evaluate('focusOpen()'), `play:${row.script}`)
        assert.deepEqual(audio.focusCommands.at(-1), { op: 'focusMode', mode: row.effective, muteVolume: row.muteVolume })
        await session.evaluate('(focusSound.samplePosition=4088,focusLabels=0,0)')
        // Inject only the host's environmental fact; real TJS supplies the
        // option policy and the backend decodes/renders the real WAVE stream.
        await audio.command({ op: 'waveMuted', muted: row.effective > 0, volume: row.muteVolume })
        await take(row.effective === 0 ? 1 : row.muteVolume ? 10 ** (waveFocusAttenuation / 2000) : 0)
        assert.equal(await session.evaluate('focusLabels+":"+focusSound.samplePosition+":"+focusSound.status'), '1:4108:play')
        await audio.command({ op: 'waveMuted', muted: false, volume: row.muteVolume }); await take(1)
        assert.equal(await session.evaluate('focusSound.samplePosition'), '4128')

        await session.evaluate('focusReplace()')
        const effectiveAfter = row.mode === 'yes' ? 2 : row.mode === 'minimize' ? 1 : 0
        assert.equal(await session.evaluate('WaveSoundBuffer.globalFocusMode'), '0')
        assert.equal(await session.evaluate('System.getArgument("-wsmute")+":"+System.getArgument("-wsmutevol")'), 'never:100')
        assert.deepEqual(audio.focusCommands.at(-1), { op: 'focusMode', mode: effectiveAfter, muteVolume: row.muteVolume })
        await audio.command({ op: 'waveMuted', muted: effectiveAfter > 0, volume: row.muteVolume })
        await take(effectiveAfter === 0 ? 1 : row.muteVolume ? 10 ** (waveFocusAttenuation / 2000) : 0)
        await session.evaluate('invalidate focusSound')
        assert.equal(audio.inspect().voices, 0)
      } catch (error) { failures.push(error) }
      try {
        await session.stop(); assert.equal(clock.tasks.size, 0)
        assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
      } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'Wave focus policy or cleanup failed', { cause: failures[0] })
    }
  })
