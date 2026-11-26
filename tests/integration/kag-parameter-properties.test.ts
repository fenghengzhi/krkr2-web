import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagParameterFiles, kagParameterExpected, kagParameterSource } from '../helpers/kag-parameter-properties.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG reads dynamic macro properties and exports the evaluated chapter choice to a fresh VM`, { timeout: 60000 }, async () => {
    const files = { ...kagParameterFiles, 'parameter.tjs': kagParameterSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("parameter.tjs","savedata/parameter.cjs",false,true,false);Scripts.execStorage("savedata/parameter.cjs");'
      : 'Scripts.execStorage("parameter.tjs");' }, failures: unknown[] = []
    const first = await headless(files)
    let saved: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagParameterExpected))
        assert.equal(await first.session.evaluate(`kagParameterObserve(${JSON.stringify(id)})`), expected, id)
      saved = first.session.exportSaves().find((entry) => entry.path === 'parameter-bookmark.tjs')?.bytes
      assert(saved?.length, 'Real Dictionary.saveStruct must write the evaluated macro bookmark')
      if (binary) assert.equal(Buffer.from(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/parameter.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert(Object.values(first.session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...files, 'parameter-bookmark.tjs': saved! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagParameterResumeFile("parameter-bookmark.tjs")'), 'ROUTE 7|7|1|AFTER|0')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert(Object.values(second.session.inspectOwnership()).every((value) => value === 0)) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG parameter properties or cleanup failed', { cause: failures[0] })
  })
