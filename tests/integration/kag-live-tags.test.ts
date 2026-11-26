import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagLiveFiles, kagLiveExpected, kagLiveSource } from '../helpers/kag-live-tags.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG expressions see and edit the live choice dictionary through a fresh-VM chapter bookmark`, { timeout: 60000 }, async () => {
    const files = { ...kagLiveFiles, 'live.tjs': kagLiveSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("live.tjs","savedata/live.cjs",false,true,false);Scripts.execStorage("savedata/live.cjs");'
      : 'Scripts.execStorage("live.tjs");' }, failures: unknown[] = []
    const first = await headless(files)
    let saved: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagLiveExpected))
        assert.equal(await first.session.evaluate(`kagLiveObserve(${JSON.stringify(id)})`), expected, id)
      saved = first.session.exportSaves().find((entry) => entry.path === 'live-bookmark.tjs')?.bytes
      assert(saved?.length, 'The real Dictionary.saveStruct must write the chapter bookmark')
      if (binary) assert.equal(new TextDecoder().decode(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/live.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert.equal(first.session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...files, 'live-bookmark.tjs': saved! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagLiveResumeFile("live-bookmark.tjs")'), 'RESUME 7|1|AFTER|0')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert.equal(second.session.snapshot().handles, 0) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG live choice dictionaries or cleanup failed', { cause: failures[0] })
  })
