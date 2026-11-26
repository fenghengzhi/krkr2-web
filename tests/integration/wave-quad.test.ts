import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { quadFiles, quadSource, quadRows, quadGain } from '../helpers/wave-quad.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: first-Wave quad configuration survives reopen and preserves streamed SLI, seek and pause`, { timeout: 120000 }, async () => {
    const cases = [
      { option: undefined, use3d: undefined, mono: false, expanded: false },
      { option: 'yes', use3d: undefined, mono: false, expanded: true },
      { option: 'yes', use3d: 'no', mono: false, expanded: true },
      { option: 'yes', use3d: 'yes', mono: false, expanded: false },
      { option: 'YES', use3d: undefined, mono: false, expanded: false },
      { option: 'yes', use3d: undefined, mono: true, expanded: true },
    ]
    for (const entry of cases) {
      const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
        audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left, right) => {
          output[0]!.push(...left); output[1]!.push(...right)
        }, 1000), { session } = await headless({ ...quadFiles(), 'quad.tjs': quadSource,
          'startup.tjs': binary ? 'Scripts.compileStorage("quad.tjs","savedata/quad.cjs",false,true,false);Scripts.execStorage("savedata/quad.cjs");'
            : 'Scripts.execStorage("quad.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
        spatial = entry.use3d !== undefined && entry.use3d !== 'no',
        channels = entry.mono || spatial ? 1 : entry.expanded ? 4 : 2,
        expected = (frames: number, start: number, masked = false) => [0, 1].map((channel) => Array.from({ length: frames }, (_, at) => {
          const row = quadRows[(start + at) % 8]!, value = entry.mono || (spatial && !masked) ? (row[0] + row[1]) / 2 : row[channel]!,
            gain = spatial && !masked ? Math.SQRT1_2 : entry.expanded && !entry.mono && !masked ? quadGain : 1
          return value === 0 ? 0 : Math.fround(value * gain)
        })), take = async (ms: number, wanted: number[][]) => {
          await settleAudioPages(audio); output.forEach((plane) => { plane.length = 0 })
          clock.advance(ms); await session.idle(); assert.deepEqual(output, wanted)
        }
      try {
        await session.start()
        if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
          .find((file) => file.path === 'savedata/quad.cjs')!.bytes.subarray(0, 4)), 'TJS2')
        await session.evaluate('(global.quadMidi=new MIDISoundBuffer(null),0)')
        if (entry.option !== undefined) await session.evaluate(`System.setArgument("-wsexpandquad",${JSON.stringify(entry.option)})`)
        if (entry.use3d !== undefined) await session.evaluate(`System.setArgument("-wsuse3d",${JSON.stringify(entry.use3d)})`)
        if (entry.mono) await session.evaluate('System.setArgument("-wsforcecnv","i16m")')
        assert.equal(await session.evaluate('quadOpen("quad-stereo.wav")'), entry.expanded || entry.mono || spatial ? '0,0' : '16,2')
        await session.evaluate('(quadMusic.samplePosition=8188,0)')
        assert.equal(await session.evaluate('quadPlay()'), `play,16,${channels}`)
        await take(40, expected(40, 8188))
        assert.equal(await session.evaluate('[quadMusic.samplePosition,quadMusic.phrases].join(",")'), '8196,3')
        await session.evaluate('(quadMusic.paused=true,0)'); await take(20, [[], []])
        assert.equal(await session.evaluate('quadMusic.samplePosition'), '8196')
        await session.evaluate('(quadMusic.samplePosition=8204,quadMusic.paused=false,0)')
        await take(20, expected(4, 8204).map((plane) => [...plane, ...Array(16).fill(0)]))
        assert.equal(await session.evaluate('[quadMusic.status,quadMusic.samplePosition].join(",")'), 'stop,0')
        await session.evaluate(`System.setArgument("-wsexpandquad",${JSON.stringify(entry.expanded ? 'no' : 'yes')})`)
        await session.evaluate('quadOpen("quad-masked.wav",true)')
        assert.equal(await session.evaluate('quadPlay()'), `play,16,${entry.mono ? 1 : 2}`)
        await take(20, expected(20, 0, true))
        await session.evaluate('quadOpen("quad-stereo.wav",true)')
        assert.equal(await session.evaluate('quadPlay()'), `play,16,${channels}`)
        await take(20, expected(20, 0))
      } catch (error) { failures.push(error) }
      try { await session.stop(); assert.equal(clock.tasks.size, 0)
        assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
      catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, `Wave quad ${JSON.stringify(entry)} or cleanup failed`, { cause: failures[0] })
    }
  })
