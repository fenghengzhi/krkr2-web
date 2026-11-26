import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagNameFiles, kagNameExpected, kagNameSource } from '../helpers/kag-names.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG keeps localized names distinct through tags, macros and a fresh-VM bookmark`, { timeout: 60000 }, async () => {
    const scripts = { ...kagNameFiles, 'names.tjs': kagNameSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("names.tjs","savedata/names.cjs",false,true,false);Scripts.execStorage("savedata/names.cjs");'
      : 'Scripts.execStorage("names.tjs");' }, failures: unknown[] = []
    const first = await headless(scripts)
    let bookmark: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagNameExpected))
        assert.equal(await first.session.evaluate(`kagNameObserve(${JSON.stringify(id)})`), expected, id)
      bookmark = first.session.exportSaves().find((entry) => entry.path === 'name-bookmark.tjs')?.bytes
      assert(bookmark?.length, 'The real Dictionary.saveStruct must create the file')
      if (binary) assert.equal(new TextDecoder().decode(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/names.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert.equal(first.session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...scripts, 'name-bookmark.tjs': bookmark! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagNameResumeFile("name-bookmark.tjs")'), '7|2|AFTERlower|0|1')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert.equal(second.session.snapshot().handles, 0) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG localized names or cleanup failed', { cause: failures[0] })
  })
