import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { kagMacroDirectoryFiles, kagMacroDirectoryExpected, kagMacroDirectorySource } from '../helpers/kag-macro-directory.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: KAG reads the live macro directory before built-in branches and chapter calls, preserving the saved caller`, { timeout: 60000 }, async () => {
    const files = { ...kagMacroDirectoryFiles, 'directory.tjs': kagMacroDirectorySource, 'startup.tjs': 'System.exitOnNoWindowStartup=false;' + (binary
      ? 'Scripts.compileStorage("directory.tjs","savedata/directory.cjs",false,true,false);Scripts.execStorage("savedata/directory.cjs");'
      : 'Scripts.execStorage("directory.tjs");') }, failures: unknown[] = []
    const first = await headless(files)
    let saved: Uint8Array | undefined
    try {
      await first.session.start()
      for (const [id, expected] of Object.entries(kagMacroDirectoryExpected))
        assert.equal(await first.session.evaluate(`kagMacroDirectoryObserve(${JSON.stringify(id)})`), expected, id)
      saved = first.session.exportSaves().find((entry) => entry.path === 'directory-bookmark.tjs')?.bytes
      assert(saved?.length, 'Dictionary.saveStruct must export the selected route and its real caller')
      if (binary) assert.equal(Buffer.from(first.session.exportSaves()
        .find((entry) => entry.path === 'savedata/directory.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await first.session.stop(); assert(Object.values(first.session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (!failures.length) {
      const second = await headless({ ...files, 'directory-bookmark.tjs': saved! })
      try {
        await second.session.start()
        assert.equal(await second.session.evaluate('kagMacroDirectoryResumeFile("directory-bookmark.tjs")'), 'at|1|HOME|0')
        assert.equal(await second.session.evaluate('directoryEvents.join(",")'), 'return,after')
      } catch (error) { failures.push(error) }
      try { await second.session.stop(); assert(Object.values(second.session.inspectOwnership()).every((value) => value === 0)) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'KAG macro directory or cleanup failed', { cause: failures[0] })
  })
