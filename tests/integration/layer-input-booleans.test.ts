import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { layerInputBooleanCases, layerInputBooleanSource, layerInputFrame, layerInputStates } from '../helpers/layer-input-booleans.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: native boolean Layer settings preserve selectable, visible and keyboard-reachable choices`, { timeout: 60000 }, async () => {
    let frame: FrameLayer[] = []
    const failures: unknown[] = [], { session } = await headless({ 'booleans.tjs': layerInputBooleanSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("booleans.tjs","savedata/booleans.cjs",false,true,false);Scripts.execStorage("savedata/booleans.cjs");'
        : 'Scripts.execStorage("booleans.tjs");' }, {
      renderer: { present(layers, width, height) {
        if (width === 240 && height === 120) frame = layers.map((layer) => ({ ...layer,
          pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
      }, dispose() {} },
    })
    try {
      await session.start()
      for (const { id, expected } of layerInputBooleanCases)
        assert.equal(await session.evaluate(`layerInputBooleanObserve(${JSON.stringify(id)})`), expected, id)
      await session.evaluate('layerInputMenu()')
      const windowId = Number(await session.evaluate('layerInputWindow.__windowId'))
      const check = async (state: string, phase: number) => {
        await session.idle()
        assert.equal(await session.evaluate('layerInputState()'), state)
        assert.equal(frame.length, 1)
        assert.equal(frame[0]!.pixels.width, 240); assert.equal(frame[0]!.pixels.height, 120)
        assert.deepEqual(frame[0]!.pixels.data, layerInputFrame(phase))
      }
      const key = async (value: number) => {
        await session.input({ type: 'keyDown', key: value, shift: 0, windowId })
        await session.input({ type: 'keyUp', key: value, shift: 0, windowId })
      }
      const click = async () => {
        await session.input({ type: 'down', x: 40, y: 30, button: 0, shift: 8, clicks: 0, windowId })
        await session.input({ type: 'up', x: 40, y: 30, button: 0, shift: 0, clicks: 1, windowId })
      }
      await check(layerInputStates[0], 0)
      await key(9); await check(layerInputStates[0], 0) // Numeric string "0.5" does not join the chain.
      await click(); await check(layerInputStates[1], 1)
      await click(); await check(layerInputStates[1], 1) // Disabled choice cannot receive another click.
      await key(13); await check(layerInputStates[2], 2)
      await key(9); await check(layerInputStates[2], 2) // Hidden choice cannot be reached by Tab.
      await key(13); await check(layerInputStates[3], 3)
      await key(9); await check(layerInputStates[4], 3)
      await key(13); await check(layerInputStates[5], 4)
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/booleans.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert(Object.values(session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Layer boolean selection or cleanup failed', { cause: failures[0] })
  })
