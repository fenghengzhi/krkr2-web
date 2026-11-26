import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagSetterFiles, kagSetterExpected, kagSetterSource } from '../helpers/kag-parameter-setters.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG attribute writes invoke forwarded setters and export the evaluated choice to a fresh VM`, { timeout: 60000 }, async () => {
    const files = { ...kagSetterFiles, 'setter.tjs': kagSetterSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("setter.tjs","savedata/setter.cjs",false,true,false);Scripts.execStorage("savedata/setter.cjs");'
      : 'Scripts.execStorage("setter.tjs");' }, failures: unknown[] = []
    const first = await headless(files)
    let saved: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagSetterExpected))
        assert.equal(await first.session.evaluate(`kagSetterObserve(${JSON.stringify(id)})`), expected, id)
      saved = first.session.exportSaves().find((entry) => entry.path === 'setter-bookmark.tjs')?.bytes
      assert(saved?.length, 'Real Dictionary.saveStruct must write the evaluated macro bookmark')
      if (binary) assert.equal(Buffer.from(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/setter.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert(Object.values(first.session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...files, 'setter-bookmark.tjs': saved! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagSetterResumeFile("setter-bookmark.tjs")'), '7|ROUTE 7|1|AFTER|0')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert(Object.values(second.session.inspectOwnership()).every((value) => value === 0)) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG setter properties or cleanup failed', { cause: failures[0] })
  })
