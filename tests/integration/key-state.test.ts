import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const padLeft = 0x1b5, pad1 = 0x1c0, pad2 = 0x1c1, padAny = 0x1df
const source = String.raw`
System.exitOnWindowClose=false;
var keyWindow=new Window(),otherKeyWindow=new Window(),keyTrace=[],queryDuringKeyEvent=false;
keyWindow.visible=otherKeyWindow.visible=true;
function keyCurrent(key){return System.getKeyState(key);}
function keyQuery(key,current){return System.getKeyState(key,current);}
function keyQueryDiscarded(key,current){System.getKeyState(key,current);}
function keyTraceValue(key){return queryDuringKeyEvent ? string(System.getKeyState(key)) : string(key);}
keyWindow.onKeyDown=function(key,shift){keyTrace.add("D"+keyTraceValue(key));};
keyWindow.onKeyUp=function(key,shift){keyTrace.add("U"+keyTraceValue(key));};
function keyEventsDisabled(value,query){System.eventDisabled=value;queryDuringKeyEvent=query;}
function postScriptKeys(){
  keyWindow.postInputEvent("onKeyDown",%[key:VK_A]);
  keyWindow.postInputEvent("onKeyUp",%[key:VK_A]);
  keyWindow.postInputEvent("onKeyDown",%[key:VK_PAD1]);
  keyWindow.postInputEvent("onKeyUp",%[key:VK_PAD1]);
}
function keyQueryMissing(){try{System.getKeyState();}catch(error){return true;}return false;}
function keyQueryInvalid(){try{System.getKeyState(%[],false);}catch(error){return true;}return false;}
`

async function fixture(binary: boolean) {
  const result = await headless({ 'startup.tjs': '', 'key-state.tjs': source })
  try {
    await result.session.start()
    if (binary) {
      await result.session.evaluate('Scripts.compileStorage("key-state.tjs","savedata/key-state.cjs",false,true,false)')
      await result.session.evaluate('Scripts.execStorage("savedata/key-state.cjs")')
    } else await result.session.evaluate('Scripts.execStorage("key-state.tjs")')
    await result.session.idle()
    const windowId = Number(await result.session.evaluate('keyWindow.__windowId'))
    return { ...result, windowId }
  } catch (error) {
    await result.session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: observed keyboard and mouse press flags survive release and are consumed by either query mode`, async () => {
    const { session } = await fixture(binary)
    try {
      session.keyState([65])
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0')
      assert.equal(await session.evaluate('keyCurrent(VK_A)'), '1')
      session.keyState([65])
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0', 'An unchanged physical snapshot is not a new press')
      session.keyState([])
      session.keyState([65])
      session.keyState([])
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '1', 'A complete short tap remains queryable')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0')
      session.keyState([65, 66])
      assert.equal(await session.evaluate('keyCurrent(VK_A)'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0', 'The native current-state call also consumes the keyboard low bit')
      assert.equal(await session.evaluate('keyQuery(VK_B,false)'), '1', 'Queries consume only their own key')
      session.keyState([])
      session.keyState([65])
      await session.evaluate('keyQueryDiscarded(VK_A,false)')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0', 'Discarding the return value still performs the query')
      session.keyState([1, 2, 4, 5, 6])
      session.keyState([])
      for (const key of [1, 2, 4, 5, 6]) {
        assert.equal(await session.evaluate(`keyQuery(${key},false)`), '1')
        assert.equal(await session.evaluate(`keyQuery(${key},false)`), '0')
      }
    } finally { await session.stop() }
  })

  test(`${mode}: Pad current queries preserve per-key flags and PADANY consumes only all Pad flags`, async () => {
    const { session } = await fixture(binary)
    try {
      session.keyState([padLeft, pad1, pad2, 65])
      assert.equal(await session.evaluate('keyCurrent(VK_PADANY)'), '1')
      assert.equal(await session.evaluate('keyCurrent(VK_PAD1)'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_PAD1,false)'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_PAD1,false)'), '0')
      assert.equal(await session.evaluate('keyCurrent(VK_PAD1)'), '1')
      session.keyState([padLeft, pad1, pad2, 65])
      assert.equal(await session.evaluate('keyQuery(VK_PAD1,false)'), '0')
      session.keyState([])
      assert.equal(await session.evaluate('keyCurrent(VK_PADANY)'), '0')
      assert.equal(await session.evaluate('keyQuery(VK_PADANY,false)'), '1')
      for (const key of [padLeft, pad1, pad2, padAny])
        assert.equal(await session.evaluate(`keyQuery(${key},false)`), '0')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '1', 'PADANY does not consume keyboard flags')
      session.keyState([padAny, 0x1b9, 0x1ca])
      assert.equal(await session.evaluate('keyCurrent(VK_PADANY)'), '0', 'PADANY and unmapped Pad codes are not physical buttons')
      assert.equal(await session.evaluate('keyQuery(VK_PADANY,false)'), '0')
      assert.equal(await session.evaluate('keyCurrent(0x1b9)'), '0')
      assert.equal(await session.evaluate('keyTrace.count'), '0', 'State observations do not dispatch key events')
    } finally { await session.stop() }
  })

  test(`${mode}: getKeyState preserves omitted versus void mode, TJS boolean conversion and uint32 key conversion`, async () => {
    const { session } = await fixture(binary)
    const tap = () => { session.keyState([]); session.keyState([65]); session.keyState([]) }
    try {
      tap()
      assert.equal(await session.evaluate('keyQuery(VK_A,void)'), '1', 'An explicit void second argument converts to false')
      tap()
      assert.equal(await session.evaluate('keyCurrent(VK_A)'), '0', 'An omitted argument defaults to current state')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0')
      for (const argument of ['0', '"0"', '""', 'null']) {
        tap()
        assert.equal(await session.evaluate(`keyQuery(VK_A,${argument})`), '1', argument)
      }
      for (const argument of ['1', '0.5', '"1"', '%[]']) {
        tap()
        assert.equal(await session.evaluate(`keyQuery(VK_A,${argument})`), '0', argument)
        assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0')
      }
      session.keyState([65])
      for (const key of ['4294967361', '-4294967231', '9007199254741057'])
        assert.equal(await session.evaluate(`keyCurrent(${key})`), '1', key)
      assert.equal(await session.evaluate('keyQueryMissing()'), '1')
      tap()
      assert.equal(await session.evaluate('keyQueryInvalid()'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '1', 'A failed key conversion performs no query')
    } finally { await session.stop() }
  })

  test(`${mode}: disabled events retain one observed press and key repeats never add another press flag`, async () => {
    const { session, windowId } = await fixture(binary)
    let down: Promise<void> | undefined, up: Promise<void> | undefined
    try {
      await session.evaluate('keyEventsDisabled(true,true)')
      down = session.input({ type: 'keyDown', windowId, key: 65, shift: 0 })
      up = session.input({ type: 'keyUp', windowId, key: 65, shift: 0 })
      void down.catch(() => {})
      void up.catch(() => {})
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0')
      assert.equal(await session.evaluate('keyTrace.count'), '0')
      await session.evaluate('keyEventsDisabled(false,true)')
      await Promise.all([down, up])
      assert.equal(await session.evaluate('keyTrace.join(",")'), 'D0,U0')
      await session.evaluate('keyEventsDisabled(false,false)')
      for (const key of [65, pad1]) {
        await session.input({ type: 'keyDown', windowId, key, shift: 0 })
        assert.equal(await session.evaluate(`keyQuery(${key},false)`), '1')
        await session.input({ type: 'keyDown', windowId, key, shift: 128 })
        assert.equal(await session.evaluate(`keyQuery(${key},false)`), '0')
        await session.input({ type: 'keyUp', windowId, key, shift: 0 })
      }
    } finally {
      await session.stop()
      await Promise.allSettled([down, up])
    }
  })

  test(`${mode}: posted events and Window focus changes cannot manufacture or discard global physical press flags`, async () => {
    const { session, windowId } = await fixture(binary)
    try {
      session.keyState([66])
      await session.evaluate('postScriptKeys()')
      await session.idle()
      assert.equal(await session.evaluate('keyTrace.join(",")'), `D65,U65,D${pad1},U${pad1}`)
      for (const key of [65, pad1]) {
        assert.equal(await session.evaluate(`keyQuery(${key},false)`), '0')
        assert.equal(await session.evaluate(`keyCurrent(${key})`), '0')
      }
      await session.input({ type: 'keyDown', windowId, key: 65, shift: 0 }, false)
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '0')
      assert.equal(await session.evaluate('keyQuery(VK_B,false)'), '1')
      session.keyState([65, pad1])
      await session.input({ type: 'activate', windowId })
      await session.input({ type: 'deactivate', windowId })
      assert.equal(await session.evaluate('keyCurrent(VK_A)'), '1')
      assert.equal(await session.evaluate('keyCurrent(VK_PAD1)'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_PAD1,false)'), '1')
    } finally { await session.stop() }
  })

  test(`${mode}: page inactivity and pause release current keys without consuming Pad presses, while a new Session starts empty`, async () => {
    const { session, windowId } = await fixture(binary)
    try {
      session.keyState([65, pad1])
      session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
      session.keyState([66, pad2])
      session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
      assert.equal(await session.evaluate('keyCurrent(VK_PAD1)'), '0')
      assert.equal(await session.evaluate('keyQuery(VK_PAD1,false)'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_A,false)'), '1')
      assert.equal(await session.evaluate('keyQuery(VK_B,false)'), '0')
      assert.equal(await session.evaluate('keyQuery(VK_PAD2,false)'), '0')
      session.keyState([pad2])
      session.pause()
      session.keyState([65, pad1])
      await session.input({ type: 'keyDown', windowId, key: 66, shift: 4 })
      await session.input({ type: 'keyDown', windowId, key: padLeft, shift: 0 })
      session.resume()
      for (const key of [65, 66, 17, pad1, padLeft]) {
        assert.equal(await session.evaluate(`keyQuery(${key},false)`), '0', 'Paused observations cannot create a press flag')
        assert.equal(await session.evaluate(`keyCurrent(${key})`), '0', 'Paused observations cannot restore held state')
      }
      assert.equal(await session.evaluate('keyCurrent(VK_PAD2)'), '0')
      assert.equal(await session.evaluate('keyQuery(VK_PAD2,false)'), '1')
      assert.equal(await session.evaluate('keyTrace.count'), '0', 'Paused packets are ignored before event delivery')
      session.keyState([65, pad1])
    } finally { await session.stop() }
    session.keyState([65, pad1]) // A late observation cannot repopulate retired state.
    const next = await fixture(binary)
    try {
      assert.equal(await next.session.evaluate('keyCurrent(VK_A)'), '0')
      assert.equal(await next.session.evaluate('keyQuery(VK_A,false)'), '0')
      assert.equal(await next.session.evaluate('keyCurrent(VK_PADANY)'), '0')
      assert.equal(await next.session.evaluate('keyQuery(VK_PADANY,false)'), '0')
    } finally { await next.session.stop() }
  })
}
