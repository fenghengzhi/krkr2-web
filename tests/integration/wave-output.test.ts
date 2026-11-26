import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { outputFrames, outputMono, waveOutputFiles, waveOutputSource } from '../helpers/wave-output.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: the first Wave freezes forced output while streamed music keeps SLI labels, pause and reopen`, { timeout: 60000 }, async () => {
    for (const option of [undefined, 'i16', 'i16m', 'I16M']) {
      const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
        audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
          (l, r) => { output[0]!.push(...l); output[1]!.push(...r) }, 1000),
        { session } = await headless({ ...waveOutputFiles(), 'output.tjs': waveOutputSource,
          'startup.tjs': binary
            ? 'Scripts.compileStorage("output.tjs","savedata/output.cjs",false,true,false);Scripts.execStorage("savedata/output.cjs");'
            : 'Scripts.execStorage("output.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
        forced = option === 'i16' || option === 'i16m', channels = option === 'i16m' ? 1 : 2,
        expected = (frames: number) => [0, 1].map((channel) => Array.from({ length: frames }, (_, at) =>
          (channels === 1 ? outputMono[at % 4]! : outputFrames[at % 4]![channel]!) / 32768)),
        take = async (ms: number, samples: number[][]) => {
          output.forEach((plane) => { plane.length = 0 })
          await settleAudioPages(audio); clock.advance(ms); await session.idle()
          await session.evaluate('outputSound.status')
          assert.deepEqual(output, samples)
        }
      try {
        await session.start()
        // MIDI construction must not initialize the unrelated Wave options.
        await session.evaluate('(outputMidi=new MIDISoundBuffer(null),0)')
        if (option !== undefined) await session.evaluate(`System.setArgument("-wsforcecnv",${JSON.stringify(option)})`)
        assert.equal(await session.evaluate('outputOpen("output.wav")'), forced ? '0,0' : '16,2')
        await session.evaluate('(outputSound.samplePosition=4088,outputLabels.clear(),0)')
        assert.equal(await session.evaluate('outputPlay()'), `play,16,${channels}`)
        await take(40, expected(40))
        assert.equal(await session.evaluate('outputLabels.join(",")'), 'loop,loop')
        const stoppedAt = await session.evaluate('outputSound.samplePosition')
        await session.evaluate('(outputSound.paused=true,0)'); await take(20, [[], []])
        assert.equal(await session.evaluate('outputSound.samplePosition'), stoppedAt)
        await session.evaluate('(outputSound.samplePosition=8200,outputSound.paused=false,0)')
        await take(20, expected(8).map((plane) => [...plane, ...Array<number>(12).fill(0)]))
        assert.equal(await session.evaluate('outputSound.status'), 'stop')

        // Changing the public argument is observable, but cannot change the
        // one-time output policy even after destroying the first Wave object.
        const replacement = option === 'i16m' ? 'i16' : 'i16m'
        await session.evaluate(`System.setArgument("-wsforcecnv",${JSON.stringify(replacement)})`)
        assert.equal(await session.evaluate('System.getArgument("-wsforcecnv")'), replacement)
        assert.equal(await session.evaluate('outputOpen("output-plain.wav")'), forced ? '0,0' : '16,2')
        assert.equal(await session.evaluate('outputPlay()'), `play,16,${channels}`)
        await take(20, expected(20))
        await session.evaluate('invalidate outputSound')
        await session.evaluate('invalidate outputMidi')
        assert.equal(audio.inspect().voices, 0)
        assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
      } catch (error) { failures.push(error) }
      try {
        await session.stop(); assert.equal(clock.tasks.size, 0)
        assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
      } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, `Wave output ${String(option)} or cleanup failed`, { cause: failures[0] })
    }
  })
