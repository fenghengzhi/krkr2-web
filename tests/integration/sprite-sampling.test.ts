import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { spriteSamplingCases, spriteSamplingSource } from '../helpers/sprite-sampling.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: scaled and turned sprites select native samples and masks`, async () => {
  const { session } = await headless({ 'sprites.tjs': spriteSamplingSource, 'startup.tjs': binary
    ? 'Scripts.compileStorage("sprites.tjs","savedata/sprites.cjs",false,true,false);Scripts.execStorage("savedata/sprites.cjs");'
    : 'Scripts.execStorage("sprites.tjs");' })
  try {
    await session.start()
    for (const { id, expected } of spriteSamplingCases)
      assert.equal(await session.evaluate(`spriteSamplingRun("${id}")`), expected, id)
    await session.evaluate('spriteSamplingClose()')
  } finally { await session.stop() }
})
