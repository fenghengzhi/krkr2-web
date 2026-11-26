import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagControlPropertyFiles, kagControlPropertyExpected, kagControlPropertySource } from '../helpers/kag-control-properties.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG evaluates control properties at branch and chapter execution and restores their saved caller in a fresh VM`, { timeout: 60000 }, async () => {
    const files = { ...kagControlPropertyFiles, 'control.tjs': kagControlPropertySource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("control.tjs","savedata/control.cjs",false,true,false);Scripts.execStorage("savedata/control.cjs");'
      : 'Scripts.execStorage("control.tjs");' }, failures: unknown[] = []
    const first = await headless(files)
    let saved: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagControlPropertyExpected))
        assert.equal(await first.session.evaluate(`kagControlPropertyObserve(${JSON.stringify(id)})`), expected, id)
      saved = first.session.exportSaves().find((entry) => entry.path === 'control-property-bookmark.tjs')?.bytes
      assert(saved?.length, 'Real Dictionary.saveStruct must preserve the selected chapter and caller')
      if (binary) assert.equal(Buffer.from(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/control.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert(Object.values(first.session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...files, 'control-property-bookmark.tjs': saved! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagControlPropertyResumeFile("control-property-bookmark.tjs")'), 'at|1|HOME|0')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert(Object.values(second.session.inspectOwnership()).every((value) => value === 0)) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG control properties or cleanup failed', { cause: failures[0] })
  })
