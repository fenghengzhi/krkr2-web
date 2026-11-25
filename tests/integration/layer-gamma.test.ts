import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { layerGammaCases, layerGammaExpected, layerGammaSource } from '../helpers/layer-gamma.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: Layer contrast ramps clamp output while preserving transparent RGB, clipping and province`, async () => {
    const { session } = await headless({
      'startup.tjs': binary
        ? 'Scripts.compileStorage("gamma-contract.tjs","savedata/gamma-contract.cjs",false,true,false);Scripts.execStorage("savedata/gamma-contract.cjs");'
        : 'Scripts.execStorage("gamma-contract.tjs");',
      'gamma-contract.tjs': layerGammaSource,
    })
    try {
      await session.start()
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((entry) => entry.path === 'savedata/gamma-contract.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
      for (const row of layerGammaCases)
        assert.equal(await session.evaluate(`layerGammaRun("${row.id}")`), layerGammaExpected(row), row.id)
      assert.equal(await session.evaluate('layerGammaClose()'), 'closed')
    } finally {
      await session.stop()
      assert.equal(session.snapshot().handles, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
    }
  })
