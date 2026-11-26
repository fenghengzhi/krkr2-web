import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagModeExpected, kagModeFiles, kagModeSource } from '../helpers/kag-modes.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG boolean modes preserve native truth conversion and actual script routing`, { timeout: 60000 }, async () => {
    const { session } = await headless({ ...kagModeFiles, 'modes.tjs': kagModeSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("modes.tjs","savedata/modes.cjs",false,true,false);Scripts.execStorage("savedata/modes.cjs");'
        : 'Scripts.execStorage("modes.tjs");' }), failures: unknown[] = []
    try {
      await session.start()
      for (const [name, expected] of Object.entries(kagModeExpected))
        assert.equal(await session.evaluate(`kagModeObserve(${JSON.stringify(name)})`), expected, name)
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/modes.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG mode controls or cleanup failed', { cause: failures[0] })
  })
