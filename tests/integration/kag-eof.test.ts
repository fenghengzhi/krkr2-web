import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagEofFiles, kagEofExpected, kagEofSource } from '../helpers/kag-eof.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG entry EOF preserves a live last option while parsing and errors still clear it`, { timeout: 60000 }, async () => {
    const { session } = await headless({ ...kagEofFiles, 'eof.tjs': kagEofSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("eof.tjs","savedata/eof.cjs",false,true,false);Scripts.execStorage("savedata/eof.cjs");'
        : 'Scripts.execStorage("eof.tjs");' }), failures: unknown[] = []
    try {
      await session.start()
      for (const [id, expected] of Object.entries(kagEofExpected))
        assert.equal(await session.evaluate(`kagEofObserve(${JSON.stringify(id)})`), expected, id)
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/eof.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG EOF controls or cleanup failed', { cause: failures[0] })
  })
