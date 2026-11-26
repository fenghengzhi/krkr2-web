import assert from 'node:assert/strict'
import test from 'node:test'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { headless } from '../helpers/headless.ts'
import { selectSoftwareFrame } from '../helpers/software-frame.ts'
import { layerColorOpacityCases, layerColorOpacityFrame, layerColorOpacitySource, layerColorOpacityStates } from '../helpers/layer-color-opacity.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: an opaque chapter fade can cross zero and continue through the actual Layer button`, { timeout: 60000 }, async () => {
    let frame: FrameLayer[] = []
    const failures: unknown[] = [], { session } = await headless({
      'opacity.tjs': layerColorOpacitySource,
      'startup.tjs': 'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;' + (binary
        ? 'Scripts.compileStorage("opacity.tjs","savedata/opacity.cjs",false,true,false);Scripts.execStorage("savedata/opacity.cjs");'
        : 'Scripts.execStorage("opacity.tjs");'),
    }, { renderer: { present(layers, width, height) {
      if (width === 320 && height === 160) frame = layers.map((layer) => ({ ...layer,
        pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
    }, dispose() {} } })
    try {
      await session.start()
      for (const { id, expected } of layerColorOpacityCases)
        assert.equal(await session.evaluate(`layerColorOpacityObserve(${JSON.stringify(id)})`), expected, id)
      assert.equal(await session.evaluate('colorOpacityMenu()'), layerColorOpacityStates[0])
      await selectSoftwareFrame(session, 'colorOpacityWindow')
      const windowId = Number(await session.evaluate('colorOpacityWindow.__windowId'))
      for (let phase = 0; phase < 3; phase++) {
        if (phase) {
          await session.input({ type: 'down', x: 40, y: 130, button: 0, shift: 8, clicks: 0, windowId })
          await session.input({ type: 'up', x: 40, y: 130, button: 0, shift: 0, clicks: 1, windowId })
        }
        await session.idle()
        assert.equal(await session.evaluate('colorOpacityState()'), layerColorOpacityStates[phase])
        assert.equal(frame.length, 1)
        assert.equal(frame[0]!.pixels.width, 320); assert.equal(frame[0]!.pixels.height, 160)
        assert.deepEqual(frame[0]!.pixels.data.slice(0, 320 * 100 * 4), layerColorOpacityFrame(phase))
      }
      if (binary) assert.equal(Buffer.from(session.exportSaves()
        .find((entry) => entry.path === 'savedata/opacity.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert(Object.values(session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Layer opacity or cleanup failed', { cause: failures[0] })
  })
