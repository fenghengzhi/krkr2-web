import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { spatialFiles, spatialRows, spatialSource } from '../helpers/wave-spatial.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: Wave 3D startup controls actual streamed output, public coordinates and native pan without moving the SLI cursor`, { timeout: 120000 }, async () => {
    for (const option of [undefined, 'no', 'yes']) {
      let voiceId = 1
      const active = option === 'yes', clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
        audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left, right) => {
          output[0]!.push(...left); output[1]!.push(...right)
        }, 1000), { session } = await headless({ ...spatialFiles(), 'spatial.tjs': spatialSource,
          'startup.tjs': binary ? 'Scripts.compileStorage("spatial.tjs","savedata/spatial.cjs",false,true,false);Scripts.execStorage("savedata/spatial.cjs");'
            : 'Scripts.execStorage("spatial.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
        hear = async (ms: number, gains: readonly number[], stereo = false, masked = false) => {
          await settleAudioPages(audio)
          const position = audio.mixer.snapshot(voiceId).position
          output.forEach((plane) => { plane.length = 0 }); clock.advance(ms); await session.idle()
          const expected = gains.map((gain, channel) => Array.from({ length: ms }, (_, at) => {
            const row = spatialRows[(position + at) % 4]!, value = masked ? row[channel]!
              : stereo ? (row[0] + row[1]) / 2 : row[0]
            return value && gain ? Math.fround(value * gain) : 0
          }))
          assert.deepEqual(output, expected)
        }
      try {
        await session.start()
        if (option !== undefined) await session.evaluate(`System.setArgument("-wsuse3d",${JSON.stringify(option)})`)
        await session.evaluate('(spatialOpen("spatial-mono.wav"),spatialMusic.setPos(-1,0,0),spatialMusic.samplePosition=8188,spatialMusic.play(),0)')
        assert.equal(await session.evaluate('[spatialMusic.bits,spatialMusic.channels,spatialMusic.status].join("|")'), '16|1|play')
        await hear(40, active ? [1, 0] : [1, 1])
        assert.equal(await session.evaluate('[spatialMusic.samplePosition,spatialMusic.phrases].join("|")'), '8196|3')
        const before = audio.mixer.snapshot(1)
        await session.evaluate('(spatialMusic.posX=1,0)')
        assert.equal(audio.mixer.snapshot(1).epoch, before.epoch)
        assert.equal(audio.mixer.snapshot(1).position, before.position)
        await hear(20, active ? [0, 1] : [1, 1])
        await session.evaluate('(spatialMusic.paused=true,spatialMusic.setPos(0,0,4),0)')
        const paused = audio.mixer.snapshot(1).position
        output.forEach((plane) => { plane.length = 0 }); clock.advance(20); await session.idle()
        assert.deepEqual(output, [[], []]); assert.equal(audio.mixer.snapshot(1).position, paused)
        await session.evaluate('(spatialMusic.paused=false,0)')
        await hear(20, active ? [Math.SQRT1_2 / 4, Math.SQRT1_2 / 4] : [1, 1])
        if (active) {
          await session.evaluate('(spatialMusic.pan=-100000,0)')
          assert.equal(await session.evaluate('int(spatialMusic.posX<0 && spatialMusic.posY>0 && spatialMusic.posZ==0 && spatialMusic.pan==-100000)'), '1')
          // Original float coordinates, independently evaluated from SetPan's
          // x=-.003,y=.001, then the declared Web stereo power interpolation.
          const x = -Math.fround(.003), y = Math.fround(.001), angle = Math.asin(x / Math.hypot(x, y)) / Math.PI
          await hear(20, [Math.sqrt(.5 - angle), Math.sqrt(.5 + angle)])
          await session.evaluate('(spatialMusic.setPos(-1,0,0),0)')
          await hear(20, [1, 0]) // Stored pan does not attenuate a 3D source twice.
        }
        await session.evaluate(`System.setArgument("-wsuse3d",${JSON.stringify(active ? 'no' : 'yes')})`)
        await session.evaluate('(spatialMusic.stop(),invalidate spatialMusic,spatialMusic=void,spatialOpen("spatial-stereo.wav"),spatialMusic.setPos(-1,0,0),spatialMusic.play(),0)')
        voiceId = 2
        assert.equal(await session.evaluate('spatialMusic.channels'), active ? '1' : '2')
        await hear(20, active ? [1, 0] : [1, 1], active, !active)
        await session.evaluate('(spatialOpen("spatial-masked.wav"),spatialMusic.setPos(-4,0,0),spatialMusic.play(),0)')
        assert.equal(await session.evaluate('spatialMusic.channels'), '2')
        // New instance resets the old pan; an explicit WAVE layout never
        // inherits positional attenuation even though the startup flag is on.
        await hear(20, [1, 1], false, true)
      } catch (error) { failures.push(error) }
      try { await session.stop(); assert.equal(clock.tasks.size, 0)
        assert.equal(audio.mixer.inspectStreams().voices, 0)
        assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
      catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, `Spatial Wave ${option} or cleanup failed`, { cause: failures[0] })
    }
  })
