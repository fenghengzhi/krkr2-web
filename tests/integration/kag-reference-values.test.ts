import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagReferenceExpected, kagReferenceFiles, kagReferenceSource } from '../helpers/kag-reference-values.ts'

for (const binary of [false, true]) {
  const files = { ...kagReferenceFiles, 'references.tjs': kagReferenceSource, 'startup.tjs': binary
    ? 'Scripts.compileStorage("references.tjs","savedata/references.cjs",false,true,false);Scripts.execStorage("savedata/references.cjs");'
    : 'Scripts.execStorage("references.tjs");' }
  test(`${binary ? 'bytecode' : 'source'}: KAG live reference parameters survive forwarding, callbacks, shallow bookmarks and failure`, { timeout: 60000 }, async () => {
    const { session } = await headless(files), failures: unknown[] = []
    try {
      await session.start()
      for (const [name, expected] of Object.entries(kagReferenceExpected))
        assert.equal(await session.evaluate(`kagReferenceObserve(${JSON.stringify(name)})`), expected, name)
      assert.equal(await session.evaluate('referenceTaglistExtension()'), '1|1|1')
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/references.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG reference controls or cleanup failed', { cause: failures[0] })
  })
  test(`${binary ? 'bytecode' : 'source'}: a serialized macro object and Octet restore in a fresh VM and return to the caller`, { timeout: 60000 }, async () => {
    const first = await headless(files), failures: unknown[] = []
    let bytes: Uint8Array | undefined
    try {
      await first.session.start()
      assert.equal(await first.session.evaluate('referenceCreateFile("savedata/reference-bookmark.tjs")'), '1')
      bytes = first.session.exportSaves().find((entry) => entry.path === 'savedata/reference-bookmark.tjs')!.bytes.slice()
      assert(bytes.length > 0)
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert.equal(first.session.snapshot().handles, 0) }
    catch (error) { failures.push(error) }
    if (!failures.length && bytes) {
      const second = await headless({ ...files, 'original-reference-bookmark.tjs': bytes })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('referenceReadFile("original-reference-bookmark.tjs")'), '7|1|1|1|0|1')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert.equal(second.session.snapshot().handles, 0) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG fresh-VM bookmark or cleanup failed', { cause: failures[0] })
  })
}
