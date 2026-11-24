import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { AudioClock } from '../helpers/audio.ts'
import { scrollPhaseFiles, scrollPhasePixels, scrollPhaseSource } from '../helpers/scroll-phase.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: integer scroll elapsed 29 of 100 copies exactly 29 of 100 columns or rows`, { timeout: 60000 }, async () => {
  const failures: unknown[] = [], clock = new AudioClock()
  let frames: { id: number; width: number; height: number; pixels: number[] }[] = []
  const { session } = await headless({ ...scrollPhaseFiles(), 'phase.tjs': scrollPhaseSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("phase.tjs","savedata/phase.cjs",false,true,false);Scripts.execStorage("savedata/phase.cjs");'
      : 'Scripts.execStorage("phase.tjs");' }, {
    now: () => clock.now, schedule: clock.schedule,
    renderer: { present(layers) {
      frames = layers.map((layer) => ({ id: layer.id, width: layer.pixels.width,
        height: layer.pixels.height, pixels: [...layer.pixels.data] }))
    }, dispose() {} },
  })
  try {
    await session.start()
    for (const from of [0, 1, 2, 3]) {
      assert.equal(await session.evaluate(`scrollPhaseStart(${from})`), '0')
      const fore = Number(await session.evaluate('phaseFore.__id')), back = Number(await session.evaluate('phaseBack.__id'))
      for (const tick of [0, 28, 29, 30, 100] as const) {
        assert.equal(await session.evaluate(`scrollPhaseAt(${tick})`), tick === 100 ? '1' : '0')
        const frame = frames.find((entry) => entry.id === (tick === 100 ? back : -fore))
        assert(frame, `Renderer must receive actual ${from}/${tick} transition pixels`)
        assert.deepEqual([frame.width, frame.height], [100, 100])
        assert.deepEqual(frame.pixels, scrollPhasePixels(from, tick), `${from}/${tick}: every copied channel`)
      }
      assert.equal(await session.evaluate('phaseDone'), '1')
    }
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0); assert.equal(session.snapshot().handles, 0) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Integer scroll phase or cleanup failed', { cause: failures[0] })
})
