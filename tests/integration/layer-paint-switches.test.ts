import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { layerPaintCases, layerPaintFrame, layerPaintPixels, layerPaintSource, layerPaintStates } from '../helpers/layer-paint-switches.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: native paint booleans preserve cached group pixels and suppress then restore actual callbacks`, { timeout: 60000 }, async () => {
    let frame: FrameLayer[] = []
    const failures: unknown[] = [], { session } = await headless({ 'paint.tjs': layerPaintSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("paint.tjs","savedata/paint.cjs",false,true,false);Scripts.execStorage("savedata/paint.cjs");'
        : 'Scripts.execStorage("paint.tjs");' }, {
      renderer: { present(layers, width, height) {
        if (width === 240 && height === 160) frame = layers.map((layer) => ({ ...layer,
          pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
      }, dispose() {} },
    })
    try {
      await session.start()
      for (const { id, expected } of layerPaintCases)
        assert.equal(await session.evaluate(`layerPaintObserve(${JSON.stringify(id)})`), expected, id)
      assert.equal(await session.evaluate('paintSwitchMenu()'), layerPaintStates[0] + '|' + layerPaintPixels[0])
      const windowId = Number(await session.evaluate('paintSwitchWindow.__windowId'))
      for (let phase = 0; phase < 4; phase++) {
        if (phase) {
          await session.input({ type: 'down', x: 40, y: 130, button: 0, shift: 8, clicks: 0, windowId })
          await session.input({ type: 'up', x: 40, y: 130, button: 0, shift: 0, clicks: 1, windowId })
        }
        await session.idle()
        assert.equal(await session.evaluate('paintSwitchState()+"|"+paintSwitchPixels()'), layerPaintStates[phase] + '|' + layerPaintPixels[phase])
        assert.equal(frame.length, 1)
        assert.equal(frame[0]!.pixels.width, 240); assert.equal(frame[0]!.pixels.height, 160)
        assert.deepEqual(frame[0]!.pixels.data, layerPaintFrame(phase))
      }
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/paint.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert(Object.values(session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Layer paint switches or cleanup failed', { cause: failures[0] })
  })
