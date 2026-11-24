import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { alphaTransitionChecks, alphaTransitionSessionFiles } from '../helpers/transition-alpha.ts'

for (const binary of [false, true]) {
  test(`${binary ? 'bytecode' : 'source'}: live alpha and PS transitions preserve exact raw RGB, masks and native completion boundaries`, { timeout: 60000 }, async () => {
    const { session, events } = await headless(alphaTransitionSessionFiles(binary)), failures: unknown[] = []
    try {
      await session.start()
      if (binary) {
        const saved = session.exportSaves().find((file) => file.path === 'savedata/alpha-transition.cjs')
        assert(saved)
        assert.equal(new TextDecoder().decode(saved.bytes.subarray(0, 4)), 'TJS2')
      }
      for (const { id, call, expected } of alphaTransitionChecks)
        assert.equal(await session.evaluate(call), expected, id)
      await session.idle()
      assert.deepEqual(events.filter((event) => event.type === 'log' && event.level === 'error'), [])
    } catch (error) { failures.push(error) }
    try {
      await session.stop()
      assert.equal(session.snapshot().handles, 0)
      assert.equal(session.snapshot().bitmapBytes, 0)
      assert.equal(session.snapshot().imageCacheBytes, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Alpha transition bytes or cleanup failed', { cause: failures[0] })
  })
}
