import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

test('Debug native panel classes keep identity, static members and read-only access without public names', async () => {
  const { session, logs } = await headless({
    'startup.tjs': `
var consoleObject=Debug.console,controllerObject=Debug.controller,denied=0;
try{Debug.console=%[];}catch(e){denied++;}
try{Debug.controller=null;}catch(e){denied++;}
var consoleInstance=new Debug.console(),controllerInstance=new Debug.controller();
Debug.console.visible=false;Debug.controller.visible=false;
Debug.message("still recorded while hidden");
`,
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('denied'), '2')
    assert.equal(
      await session.evaluate(`[
      consoleObject===Debug.console,controllerObject===Debug.controller,
      consoleObject!==controllerObject,consoleObject instanceof "Console",
      controllerObject instanceof "Controller",typeof global.Console,
      typeof global.Controller,typeof global.__krkrDebugAccess
    ].join("|")`),
      '1|1|1|1|1|undefined|undefined|undefined',
    )
    assert.equal(
      await session.evaluate(`[
      Debug.console instanceof "Class",Debug.controller instanceof "Class",
      consoleInstance instanceof "Console",controllerInstance instanceof "Controller",
      consoleInstance instanceof "Class",typeof consoleInstance.visible,
      typeof controllerInstance.visible,typeof consoleInstance.finalize
    ].join("|")`),
      '1|1|1|1|0|undefined|undefined|Object',
    )
    assert.deepEqual(session.snapshot().debug, { console: false, controller: false })
    assert.deepEqual(logs, ['still recorded while hidden'])
    assert.match(await session.evaluate('Debug.getLastLog(1)'), /still recorded while hidden/)
  } finally {
    await session.stop()
  }
  assert.equal(session.snapshot().handles, 0)
})

test('browser visibility updates remain available while paused and script coercion uses TJS boolean rules', async () => {
  const { session, events } = await headless({ 'startup.tjs': 'var stable=Debug.console;' })
  try {
    await session.start()
    session.pause()
    session.setDebugVisibility('console', false)
    session.setDebugVisibility('controller', false)
    assert.equal(session.snapshot().state, 'paused')
    const revision = session.snapshot().revision,
      count = events.length
    session.setDebugVisibility('console', false)
    assert.equal(session.snapshot().revision, revision)
    assert.equal(events.length, count)
    const copy = session.snapshot().debug
    copy.console = true
    assert.equal(session.snapshot().debug.console, false)
    assert.throws(() => session.setDebugVisibility('invalid' as 'console', true), /Unknown debug/)
    assert.throws(() => session.setDebugVisibility('console', 1 as unknown as boolean), /boolean/)
    assert.deepEqual(session.snapshot().debug, { console: false, controller: false })
    session.resume()
    assert.equal(
      await session.evaluate('[stable.visible,Debug.controller.visible].join("|")'),
      '0|0',
    )
    await session.evaluate('(Debug.console.visible="1",Debug.controller.visible=-7)')
    assert.deepEqual(session.snapshot().debug, { console: true, controller: true })
    await session.evaluate('(Debug.console.visible=void,Debug.controller.visible="0")')
    assert.deepEqual(session.snapshot().debug, { console: false, controller: false })
  } finally {
    await session.stop()
  }
})

test('failed-session diagnostics can be reopened and a new session starts with independent panel state', async () => {
  const first = await headless({
    'startup.tjs':
      'Debug.console.visible=false;Debug.controller.visible=false;throw new Exception("panel-failure");',
  })
  try {
    await assert.rejects(first.session.start(), /panel-failure/)
    first.session.setDebugVisibility('console', true)
    assert.equal(first.session.snapshot().state, 'failed')
    assert.equal(first.session.snapshot().debug.console, true)
    assert.match(first.logs.join('\n'), /panel-failure/)
  } finally {
    await first.session.stop()
  }
  const next = await headless({ 'startup.tjs': 'Debug.message("new panels");' })
  try {
    await next.session.start()
    assert.deepEqual(next.session.snapshot().debug, { console: true, controller: true })
  } finally {
    await next.session.stop()
  }
})
