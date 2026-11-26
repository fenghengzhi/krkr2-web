import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { layerFocusCases, layerFocusSource } from '../helpers/layer-focus-result.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: Layer.focus reports successful changes, rejected targets and ordinary redirection`, { timeout: 60000 }, async () => {
    const failures: unknown[] = [], { session } = await headless({
      'focus.tjs': layerFocusSource,
      'startup.tjs': 'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;' + (binary
        ? 'Scripts.compileStorage("focus.tjs","savedata/focus.cjs",false,true,false);Scripts.execStorage("savedata/focus.cjs");'
        : 'Scripts.execStorage("focus.tjs");'),
    })
    try {
      await session.start()
      for (const { id, expected } of layerFocusCases)
        assert.equal(await session.evaluate(`layerFocusObserve(${JSON.stringify(id)})`), expected, id)
      if (binary) assert.deepEqual([...session.exportSaves().find(file => file.path === 'savedata/focus.cjs')!.bytes.subarray(0, 4)], [84, 74, 83, 50])
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert(Object.values(session.inspectOwnership()).every(value => value === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Layer focus result or cleanup failed', { cause: failures[0] })
  })
