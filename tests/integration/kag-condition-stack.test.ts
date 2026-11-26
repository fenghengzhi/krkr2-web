import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagConditionFiles, kagConditionExpected, kagConditionSource } from '../helpers/kag-condition-stack.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: native conditional bookmarks restore their original branch and survive a file round trip in a fresh VM`, { timeout: 60000 }, async () => {
    const files = { ...kagConditionFiles, 'condition.tjs': kagConditionSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("condition.tjs","savedata/condition.cjs",false,true,false);Scripts.execStorage("savedata/condition.cjs");'
      : 'Scripts.execStorage("condition.tjs");' }, failures: unknown[] = []
    const first = await headless(files)
    let saved: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagConditionExpected))
        assert.equal(await first.session.evaluate(`kagConditionObserve(${JSON.stringify(id)})`), expected, id)
      saved = first.session.exportSaves().find((entry) => entry.path === 'condition-bookmark.tjs')?.bytes
      assert(saved?.length)
      assert(Buffer.from(saved).toString('utf16le').includes('ffffffff00000001'))
      if (binary) assert.equal(Buffer.from(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/condition.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
      // The native indexing rule only applies to accepted complete words.
      assert.equal(await first.session.evaluate(`(function(){var p=new ConditionStoryParser(),d=Scripts.evalStorage("condition-bookmark.tjs"),result="missing-error";
        d.ExcludeLevelStack="ffffffff1";try{p.restore(d);}catch(e){result=e.message;}invalidate p;return result;})()`), 'condition-two.ks:2:1: Malformed KAG condition stack')
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert.equal(first.session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...files, 'condition-bookmark.tjs': saved! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagConditionResumeFile("condition-bookmark.tjs")'), '1/2/fffffffffffffff0/00|restored|done|0')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert.equal(second.session.snapshot().handles, 0) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG conditional bookmark or cleanup failed', { cause: failures[0] })
  })
