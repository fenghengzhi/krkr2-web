import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { headless } from '../helpers/headless.ts'
import { startupScriptModesSource } from '../helpers/startup-script-modes.ts'

type Fixture = Awaited<ReturnType<typeof headless>>
const keepAlive = 'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;'
const compiledPath = 'savedata/modes.cjs'
const loadCompiled = 'Scripts.execStorage(System.dataPath+"modes.cjs")'
const enabled = new Map([['-evalcontext', 'global'], ['-unaryaster', 'compat'], ['-holdalpha', 'yes']])
const disabled = new Map([['-evalcontext', 'instance'], ['-unaryaster', 'amp'], ['-holdalpha', 'no']])
const argumentsExpression = '[System.getArgument("-evalcontext"),System.getArgument("-unaryaster"),System.getArgument("-holdalpha")].join("|")'
const changedArguments = (active: boolean) => active
  ? 'System.setArgument("-evalcontext","global"),System.setArgument("-unaryaster","compat"),System.setArgument("-holdalpha","yes")'
  : 'System.setArgument("-evalcontext","instance"),System.setArgument("-unaryaster","amp"),System.setArgument("-holdalpha","no")'

async function sessionCase(
  files: Record<string, string | Uint8Array>, arguments_: Map<string, string> | undefined,
  saveStore: MemorySaveStore, observe: (fixture: Fixture) => Promise<void>,
) {
  const fixture = await headless(files, { arguments: arguments_, saveStore }), failures: unknown[] = []
  try {
    await fixture.session.start()
    await observe(fixture)
  } catch (error) { failures.push(error) }
  try {
    await fixture.session.stop()
    assert.equal(fixture.session.snapshot().state, 'stopped')
    assert.equal(fixture.session.snapshot().handles, 0)
    assert.deepEqual(fixture.session.snapshot().windows, [])
    assert(Object.values(fixture.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Startup script mode control or cleanup failed', { cause: failures[0] })
}

for (const compileEnabled of [false, true]) {
  test(`bytecode compiled with ${compileEnabled ? 'global/compat/yes' : 'instance/amp/no'} keeps its unary operator in the opposite fresh Session`,
    { timeout: 60000 }, async (t) => {
      const saves = new MemorySaveStore(), producer = compileEnabled ? enabled : disabled,
        consumer = compileEnabled ? disabled : enabled,
        original = compileEnabled ? 'global:0:1|star|1|73' : 'instance:1:0|amp|0|255',
        // These mixed results cannot be produced by simply retaining every
        // producer option or by recompiling the file under the consumer mode.
        transferred = compileEnabled ? 'instance:1:0|star|0|255' : 'global:0:1|amp|1|73',
        fresh = compileEnabled ? 'instance:1:0|amp|0|255' : 'global:0:1|star|1|73'
      let bytes!: Uint8Array
      await sessionCase({
        'startup.tjs': keepAlive + 'Scripts.compileStorage("modes.tjs",System.dataPath+"modes.cjs",false,true,false);' +
          loadCompiled + ';var observed=startupScriptModes();',
        'modes.tjs': startupScriptModesSource,
      }, producer, saves, async ({ session }) => {
        assert.equal(await session.evaluate('observed'), original)
        const file = session.exportSaves().find((entry) => entry.path === compiledPath)
        assert(file)
        bytes = Uint8Array.from(file.bytes)
        assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'TJS2')
      })
      assert.deepEqual((await saves.load()).find((entry) => entry.path === compiledPath)?.bytes, bytes)
      t.diagnostic(JSON.stringify({ compiledWith: [...producer], loadedWith: [...consumer], bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), expected: transferred }))

      await sessionCase({
        // No modes.tjs is imported in the second Session. The bytecode comes
        // solely from the persistent SaveStore owned by the previous Session.
        'startup.tjs': keepAlive + loadCompiled + ';var observed=startupScriptModes();',
        'fresh.tjs': startupScriptModesSource,
      }, consumer, saves, async ({ session }) => {
        assert.equal(await session.evaluate('Storages.isExistentStorage("modes.tjs")'), '0')
        assert.equal(await session.evaluate('observed'), transferred)
        assert.equal(await session.evaluate('startupScriptModes()'), transferred)
        assert.deepEqual(session.exportSaves().find((entry) => entry.path === compiledPath)?.bytes, bytes)

        // The public argument table remains mutable. All three engine choices
        // were fixed at Session startup, including later source compilation
        // and new Layers, rather than being reread by setArgument.
        assert.equal(await session.evaluate(changedArguments(compileEnabled) + ',' + argumentsExpression),
          compileEnabled ? 'global|compat|yes' : 'instance|amp|no')
        assert.equal(await session.evaluate('startupScriptModes()'), transferred)
        assert.equal(await session.evaluate('Scripts.execStorage("fresh.tjs"),startupScriptModes()'), fresh)
        assert.equal(await session.evaluate(loadCompiled + ',startupScriptModes()'), transferred)
        assert.deepEqual(session.exportSaves().find((entry) => entry.path === compiledPath)?.bytes, bytes)
      })
      assert.deepEqual((await saves.load()).find((entry) => entry.path === compiledPath)?.bytes, bytes)
    })
}

for (const unmatched of [false, true]) {
  test(`${unmatched ? 'Nonmatching option literals' : 'Absent startup options'} keep native defaults after live argument changes and fresh compilation`,
    { timeout: 60000 }, async () => {
      const saves = new MemorySaveStore(), options = unmatched
        ? new Map([['-evalcontext', 'GLOBAL'], ['-unaryaster', 'COMPAT'], ['-holdalpha', 'YES']]) : undefined
      await sessionCase({
        'startup.tjs': keepAlive + 'Scripts.execStorage("modes.tjs");var observed=startupScriptModes();',
        'modes.tjs': startupScriptModesSource,
      }, options, saves, async ({ session }) => {
        assert.equal(await session.evaluate('observed'), 'instance:1:0|amp|0|255')
        assert.equal(await session.evaluate(unmatched ? argumentsExpression :
          '[System.getArgument("-evalcontext")===void,System.getArgument("-unaryaster")===void,System.getArgument("-holdalpha")===void].join("|")'),
        unmatched ? 'GLOBAL|COMPAT|YES' : '1|1|1')
        assert.equal(await session.evaluate(changedArguments(true) + ',' + argumentsExpression), 'global|compat|yes')
        assert.equal(await session.evaluate('startupScriptModes()'), 'instance:1:0|amp|0|255')
        assert.equal(await session.evaluate('Scripts.execStorage("modes.tjs"),startupScriptModes()'), 'instance:1:0|amp|0|255')
        await session.evaluate('Scripts.compileStorage("modes.tjs",System.dataPath+"modes.cjs",false,true,false)')
        assert.equal(await session.evaluate(loadCompiled + ',startupScriptModes()'), 'instance:1:0|amp|0|255')
        const bytes = session.exportSaves().find((entry) => entry.path === compiledPath)?.bytes
        assert(bytes)
        assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'TJS2')
      })
    })
}
