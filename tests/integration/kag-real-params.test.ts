import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagRealFiles, kagRealExpected, kagRealSource } from '../helpers/kag-real-params.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG preserves native real variants through nested parameters, errors and a fresh bookmark VM`, { timeout: 60000 }, async () => {
    const scripts = { ...kagRealFiles, 'reals.tjs': kagRealSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("reals.tjs","savedata/reals.cjs",false,true,false);Scripts.execStorage("savedata/reals.cjs");'
      : 'Scripts.execStorage("reals.tjs");' }, failures: unknown[] = [], first = await headless(scripts)
    let bookmark: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagRealExpected))
        assert.equal(await first.session.evaluate(`kagRealObserve(${JSON.stringify(id)})`), expected, id)
      bookmark = first.session.exportSaves().find((entry) => entry.path === 'real-bookmark.tjs')?.bytes.slice()
      assert(bookmark?.length, 'The real native Dictionary writer must persist the macro variants')
      if (binary) assert.equal(new TextDecoder().decode(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/reals.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try {
      await first.session.stop(); assert.equal(first.session.snapshot().handles, 0)
      assert(Object.values(first.session.inspectOwnership()).every((count) => count === 0))
    } catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...scripts, 'real-bookmark.tjs': bookmark! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagRealResume("real-bookmark.tjs")'), kagRealExpected['reals-bookmark'])
      } catch (error) { failures.push(error) }
      try {
        await second.session.stop(); assert.equal(second.session.snapshot().handles, 0)
        assert(Object.values(second.session.inspectOwnership()).every((count) => count === 0))
      } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG real parameters or cleanup failed', { cause: failures[0] })
  })
