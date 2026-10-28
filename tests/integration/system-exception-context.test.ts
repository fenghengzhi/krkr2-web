import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { exceptionContextInitial, exceptionContextAnonymous, exceptionContextBound,
  exceptionContextRecovered, systemExceptionContextSource } from '../helpers/system-exception-context.ts'

for (const binary of [false, true]) {
  test(`${binary ? 'bytecode' : 'source'}: exception callbacks retain native function-object and bound receiver context with one getter read`, { timeout: 60000 }, async () => {
    const f = await headless({
      'exception-context.tjs': systemExceptionContextSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("exception-context.tjs","savedata/exception-context.cjs",false,true,false);Scripts.execStorage("savedata/exception-context.cjs");'
        : 'Scripts.execStorage("exception-context.tjs");',
    }), failures: unknown[] = []
    try {
      await f.session.start()
      if (binary) {
        const compiled = f.session.exportSaves().find((file) => file.path === 'savedata/exception-context.cjs')
        assert(compiled)
        assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
      }
      assert.equal(await f.session.evaluate('exceptionContextSnapshot()'), exceptionContextInitial)
      const windowId = Number(await f.session.evaluate('contextWindow.__windowId'))
      for (const [bound, expected] of [[0, exceptionContextAnonymous], [1, exceptionContextBound], [0, exceptionContextRecovered]] as const) {
        assert.equal(await f.session.evaluate(`armExceptionContext(${bound})`), '1')
        await f.session.input({ type: 'down', windowId, x: 8, y: 8, button: 0, shift: 8, clicks: 0 })
        await f.session.input({ type: 'up', windowId, x: 8, y: 8, button: 0, shift: 0, clicks: 1 })
        await f.session.idle()
        assert.equal(await f.session.evaluate('exceptionContextSnapshot()'), expected)
        assert.equal(f.session.snapshot().eventDisabled, false)
      }
      assert.deepEqual([...f.logs], [])
    } catch (error) { failures.push(error) }
    try {
      await f.session.stop()
      assert.equal(f.session.snapshot().handles, 0)
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Exception context scenario or cleanup failed', { cause: failures[0] })
  })
}
