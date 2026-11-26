import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { layerOrderCases, layerOrderSource } from '../helpers/layer-order.ts'

for (const binary of [false, true]) {
  test(`${binary ? 'bytecode' : 'source'}: late game layers retain absolute depth across ties, reparenting and relative moves`, async () => {
    const { session } = await headless({
      'order.tjs': layerOrderSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("order.tjs","savedata/order.cjs",false,true,false);Scripts.execStorage("savedata/order.cjs");'
        : 'Scripts.execStorage("order.tjs");',
    })
    try {
      await session.start()
      for (const { id, expected } of layerOrderCases)
        assert.equal(await session.evaluate(`layerOrderRun("${id}")`), expected, id)
      await session.evaluate('layerOrderClose()')
    } finally { await session.stop() }
  })
}
