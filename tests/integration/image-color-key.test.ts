import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import {
  imageKeyExpected,
  imageKeyFiles,
  imageKeyScenarios,
  imageKeySource,
} from '../helpers/image-color-key.ts'

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  for (const scenario of imageKeyScenarios) {
    test(`${mode}: loadImages ${scenario.name}`, { timeout: 60000 }, async () => {
      const { session, logs } = await headless({
        ...imageKeyFiles(),
        'startup.tjs': '',
        'image-color-key.tjs': imageKeySource(scenario),
      })
      try {
        await session.start()
        if (binary) {
          await session.evaluate(
            'Scripts.compileStorage("image-color-key.tjs","savedata/image-color-key.cjs",false,true,false)',
          )
          await session.evaluate('Scripts.execStorage("savedata/image-color-key.cjs")')
        } else await session.evaluate('Scripts.execStorage("image-color-key.tjs")')
        assert(logs.includes('image-key-ready'))
        assert.equal(await session.evaluate('imageKeyRows.join("|")'), imageKeyExpected(scenario))
        assert.equal(
          await session.evaluate('imageKeyMetadata.join("")'),
          scenario.rows
            .filter((row) => row.file === 'plain.png' || row.file === 'hero.png')
            .map(() => '1')
            .join(''),
        )
      } finally {
        await session.stop()
        assert.equal(session.snapshot().handles, 0)
        assert.equal(session.snapshot().bitmapBytes, 0)
        assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      }
    })
  }
}
