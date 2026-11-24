import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { sessionTransitionChecks, sessionTransitionFiles } from '../helpers/session-transition-options.ts'

for (const binary of [false, true]) {
  test(`${binary ? 'bytecode' : 'source'}: Layer transition options preserve getter order, native errors and the active owner`, { timeout: 60000 }, async () => {
    const { session, events } = await headless(sessionTransitionFiles(binary))
    const failures: unknown[] = []
    try {
      await session.start()
      for (const { call, expected } of sessionTransitionChecks) assert.equal(await session.evaluate(call), expected, call)
      await session.evaluate('transitionOptionClose()')
      await session.idle()
      assert.deepEqual(events.filter((event) => event.type === 'log' && event.level === 'error'), [])
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Transition options and cleanup failed', { cause: failures[0] })
  })
}
