import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { thumbnailStretchCases, thumbnailStretchSource } from '../helpers/thumbnail-stretch.ts'

for (const binary of [false, true]) {
  test(`${binary ? 'bytecode' : 'source'}: full-copy stretch uses stock thumbnail samples and draw-face ordering`, async () => {
    const { session } = await headless({
      'thumbnail.tjs': thumbnailStretchSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("thumbnail.tjs","savedata/thumbnail.cjs",false,true,false);Scripts.execStorage("savedata/thumbnail.cjs");'
        : 'Scripts.execStorage("thumbnail.tjs");',
    })
    try {
      await session.start()
      for (const { id, expected } of thumbnailStretchCases)
        assert.equal(await session.evaluate(`thumbnailStretchRun("${id}")`), expected, id)
      await session.evaluate('thumbnailStretchClose()')
    } finally { await session.stop() }
  })
}
