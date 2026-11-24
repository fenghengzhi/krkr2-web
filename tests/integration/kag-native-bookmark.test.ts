import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagControlSource, kagExpected, kagFiles } from '../helpers/kag-scenarios.ts'

for (const mode of ['source', 'bytecode']) {
  test(`${mode}: scenario cache, assign, macro bookmarks and assignable KAG messages reach game scripts`, { timeout: 90000 }, async () => {
    const { session } = await headless({ ...kagFiles, 'controls.tjs': kagControlSource, 'startup.tjs': mode === 'source'
      ? 'Scripts.execStorage("controls.tjs");'
      : 'Scripts.compileStorage("controls.tjs","savedata/controls.cjs",false,true,false);Scripts.execStorage("savedata/controls.cjs");' })
    const failures: unknown[] = []
    try {
      await session.start()
      for (const [id, expected] of Object.entries(kagExpected))
        assert.equal(await session.evaluate(`kagObserve("${id}")`), expected, id)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG scenario and session cleanup failed', { cause: failures[0] })
  })
}
