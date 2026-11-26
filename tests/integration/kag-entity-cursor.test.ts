import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagEntityFiles, kagEntityExpected, kagEntitySource } from '../helpers/kag-entity-cursor.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: a nested KAG route read resumes attributes on its actual line and survives a real bookmark file`, { timeout: 60000 }, async () => {
    const files = { ...kagEntityFiles, 'entity.tjs': kagEntitySource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("entity.tjs","savedata/entity.cjs",false,true,false);Scripts.execStorage("savedata/entity.cjs");'
      : 'Scripts.execStorage("entity.tjs");' }, failures: unknown[] = []
    const first = await headless(files)
    let saved: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagEntityExpected))
        assert.equal(await first.session.evaluate(`kagEntityObserve(${JSON.stringify(id)})`), expected, id)
      saved = first.session.exportSaves().find((entry) => entry.path === 'entity-bookmark.tjs')?.bytes
      assert(saved?.length, 'The native Dictionary.saveStruct must create the chapter bookmark')
      if (binary) assert.equal(new TextDecoder().decode(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/entity.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert.equal(first.session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...files, 'entity-bookmark.tjs': saved! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagEntityResumeFile("entity-bookmark.tjs")'), 'Continue 7|1|AFTER|0')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert.equal(second.session.snapshot().handles, 0) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG entity cursor or cleanup failed', { cause: failures[0] })
  })
