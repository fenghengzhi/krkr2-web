import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagRewindExpected, kagRewindFiles, kagRewindSource } from '../helpers/kag-rewind.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: virtual scenario loading rewinds callback state while retaining the real caller's arguments`, { timeout: 60000 }, async () => {
    const { session } = await headless({ ...kagRewindFiles, 'rewind.tjs': kagRewindSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("rewind.tjs","savedata/rewind.cjs",false,true,false);Scripts.execStorage("savedata/rewind.cjs");'
        : 'Scripts.execStorage("rewind.tjs");' }), failures: unknown[] = []
    try {
      await session.start()
      for (const [name, expected] of Object.entries(kagRewindExpected))
        assert.equal(await session.evaluate(`kagRewindObserve(${JSON.stringify(name)})`), expected, name)
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/rewind.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG scenario rewind or cleanup failed', { cause: failures[0] })
  })
