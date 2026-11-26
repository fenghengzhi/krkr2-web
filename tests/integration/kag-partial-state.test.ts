import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagPartialFiles, kagPartialExpected, kagPartialSource } from '../helpers/kag-partial-state.ts'

for (const compiled of [false, true]) {
  test(`${compiled ? 'bytecode' : 'source'}: KAG chapter bookmarks inherit their callers and resume at the selected label`, async () => {
    const setup = compiled
      ? 'Scripts.compileStorage("partial.tjs","savedata/partial.cjs",false,true,false);Scripts.execStorage("savedata/partial.cjs");'
      : 'Scripts.execStorage("partial.tjs");'
    const { session } = await headless({ ...kagPartialFiles, 'partial.tjs': kagPartialSource,
      'startup.tjs': 'System.exitOnNoWindowStartup=false;' + setup })
    try {
      await session.start()
      for (const [id, expected] of Object.entries(kagPartialExpected))
        assert.equal(await session.evaluate(`kagPartialObserve(${JSON.stringify(id)})`), expected, id)
      if (compiled) assert.equal(Buffer.from(session.exportSaves().find((f) => f.path === 'savedata/partial.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } finally { await session.stop() }
  })
}
