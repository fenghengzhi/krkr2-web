import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { layerAlphaRows, layerAlphaSource } from '../helpers/layer-alpha-rows.ts'

for (const binary of [false, true]) {
  test(`${binary ? 'bytecode' : 'source'}: captured layers and direct rectangle blits retain stock alpha-row colors and masks`, async () => {
    const { session } = await headless({
      'alpha.tjs': layerAlphaSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("alpha.tjs","savedata/alpha.cjs",false,true,false);Scripts.execStorage("savedata/alpha.cjs");'
        : 'Scripts.execStorage("alpha.tjs");',
    })
    try {
      await session.start()
      for (const { id, expected } of layerAlphaRows)
        assert.equal(await session.evaluate(`layerAlphaRun("${id}")`), expected, id)
      await session.evaluate('layerAlphaClose()')
    } finally { await session.stop() }
  })
}
