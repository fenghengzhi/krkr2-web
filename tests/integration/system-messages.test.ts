import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { systemMessagesSource } from '../helpers/system-messages-script.ts'

async function fixture(binary: boolean) {
  const f = await headless({ 'messages.tjs': systemMessagesSource,
    'warning.tjs': 'var value=0;if(value=1){}',
    'startup.tjs': binary
      ? 'Scripts.compileStorage("messages.tjs","savedata/messages.cjs",false,true,false);Scripts.execStorage("savedata/messages.cjs");'
      : 'Scripts.execStorage("messages.tjs");' })
  try {
    await f.session.start()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/messages.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    return f
  } catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Message fixture startup and cleanup failed', { cause: error }) }
    throw error
  }
}
async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary), failures: unknown[] = []
  try { await run(f) } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().handles, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'System message scenario or cleanup failed', { cause: failures[0] })
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: assignMessage changes actual native exceptions and performs native string conversions`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }) => {
      assert.equal(await session.evaluate('missingMessage()'), 'Member "missing" does not exist')
      assert.equal(await session.evaluate('translatedMessage()'), '1|找不到『missing』 雪 😀')
      assert.equal(await session.evaluate('messageValues()'), '0,0,0,0|Copied missing|0|9007199254740993|0|1')
    })
  })
  test(`${mode}: native message registration keeps required arguments, discarded side effects and borrowed receivers`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }) => {
      assert.equal(await session.evaluate('messageCalls()'), '5|kept missing|discarded missing|1|1|bound missing|1')
    })
  })
  test(`${mode}: compiler warnings and parser errors read assigned native holders`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session, logs }) => {
      assert.equal(await session.evaluate('compilerMessages()'), '2|1')
      assert(logs.some((line) => line.includes('translated assignment warning')))
      const compiled = session.exportSaves().find((file) => file.path === 'savedata/warning.cjs')
      assert(compiled)
      assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
      assert.equal(await session.evaluate('6*7'), '42')
    })
  })
  test(`${mode}: assigned native messages remain private to each live Session and disappear after Stop`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }) => {
      await session.evaluate('translatedMessage()')
      await using(binary, async (other) => {
        assert.equal(await other.session.evaluate('missingMessage()'), 'Member "missing" does not exist')
        await other.session.evaluate('System.assignMessage("TJSMemberNotFound","second %1")')
        assert.equal(await session.evaluate('missingMessage()'), '找不到『missing』 雪 😀')
        assert.equal(await other.session.evaluate('missingMessage()'), 'second missing')
      })
    })
    await using(binary, async ({ session }) => {
      assert.equal(await session.evaluate('missingMessage()'), 'Member "missing" does not exist')
    })
  })
}
