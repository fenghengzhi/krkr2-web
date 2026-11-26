import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { mouseClickOriginExpected, mouseClickOriginSource } from '../helpers/mouse-click-origin.ts'
import type { InputPacket } from '../../src/engine/ports/input.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: a native Click retains down coordinates while release and physical cursor keep their current point`, async () => {
    const f = await headless({ 'choice.tjs': mouseClickOriginSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("choice.tjs","savedata/choice.cjs",false,true,false);Scripts.execStorage("savedata/choice.cjs");'
        : 'Scripts.execStorage("choice.tjs");' }), failures: unknown[] = []
    try {
      await f.session.start()
      const windowId = Number(await f.session.evaluate('clickWindow.__windowId'))
      for (const [index, downX, upX, selected] of [[0, 40, 240, 'left'], [1, 240, 40, 'right']] as const) {
        await f.session.input({ type: 'down', windowId, x: downX, y: 30, button: 0, clicks: 0, shift: 8 })
        await f.session.input({ type: 'move', windowId, x: upX, y: 90, button: 0, clicks: 0, shift: 8 })
        await f.session.input({ type: 'up', windowId, x: upX, y: 90, button: 0, clicks: 1, shift: 0,
          clickPaintBoxPoint: { x: downX, y: 30 } })
        assert.equal(await f.session.evaluate('clickTrace.join("|")'), mouseClickOriginExpected[index])
        assert.equal(await f.session.evaluate('clickChoice'), selected)
        assert.equal(await f.session.evaluate('clickRoot.cursorX+","+clickRoot.cursorY'), `${upX},90`)
      }
      // Admission owns the nested coordinates, even while disabled delivery
      // leaves the external caller free to reuse its packet object.
      await f.session.evaluate('System.eventDisabled=true')
      const down = f.session.acceptInput({ type: 'down', windowId, x: 40, y: 30, button: 0, clicks: 0, shift: 8 }),
        point = { x: 40, y: 30 }, up = f.session.acceptInput({ type: 'up', windowId, x: 240, y: 90,
          button: 0, clicks: 1, shift: 0, clickPaintBoxPoint: point }),
        deliveries = Promise.all([down.completion, up.completion])
      void deliveries.catch(() => {})
      point.x = 240; point.y = 90
      await f.session.evaluate('System.eventDisabled=false')
      await deliveries
      assert.equal(await f.session.evaluate('clickTrace.join("|")'), mouseClickOriginExpected[0])
      const before = await f.session.evaluate('clickTrace.join("|")')
      for (const invalid of [NaN, Infinity, .5, -2147483649, 2147483648])
        assert.throws(() => f.session.acceptInput({ type: 'up', windowId, x: 0, y: 0, button: 0,
          shift: 0, clicks: 1, clickPaintBoxPoint: { x: invalid, y: 0 } }), /Invalid PaintBox click coordinates/)
      for (const packet of [
        { type: 'down', clicks: 1 }, { type: 'up', clicks: 2 },
      ]) assert.throws(() => f.session.acceptInput({ ...packet, windowId, x: 0, y: 0, button: 0,
        shift: 0, clickPaintBoxPoint: { x: 0, y: 0 } } as InputPacket), /Invalid PaintBox click coordinates/)
      assert.equal(await f.session.evaluate('clickTrace.join("|")'), before)
      // Existing embedders without the optional Form snapshot keep their
      // already-normalized Click coordinates and existing packet shape.
      await f.session.input({ type: 'down', windowId, x: 40, y: 30, button: 0, clicks: 0, shift: 8 })
      await f.session.input({ type: 'up', windowId, x: 80, y: 90, button: 0, clicks: 1, shift: 0 })
      assert.equal(await f.session.evaluate('clickTrace.join("|")'),
        'window-down:40,30|left-down:40,30|window-click:80,90|left-click:80,90|window-up:80,90|left-up:80,90')
    } catch (error) { failures.push(error) }
    try {
      await f.session.stop()
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Click origin or cleanup failed', { cause: failures[0] })
  })
