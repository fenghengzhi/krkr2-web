import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { mouseButtonChoiceSource, mouseButtonSteps, mouseButtonTrace } from '../helpers/mouse-button-choice.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: choice, menu and history keep separate mouse actions and native hit arbitration`, async () => {
    const f = await headless({ 'buttons.tjs': mouseButtonChoiceSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("buttons.tjs","savedata/buttons.cjs",false,true,false);Scripts.execStorage("savedata/buttons.cjs");'
      : 'Scripts.execStorage("buttons.tjs");' }), failures: unknown[] = []
    try {
      await f.session.start()
      const windowId = Number(await f.session.evaluate('buttonWindow.__windowId'))
      for (const step of mouseButtonSteps) {
        // These are the already-normalized input packets. The coordinator
        // test separately checks actual DOM button/detail normalization.
        await f.session.input({ type: 'down', windowId, x: step.x, y: 40, button: step.button,
          shift: [8, 16, 32][step.button]!, clicks: 0 })
        await f.session.input({ type: 'up', windowId, x: step.x, y: 40, button: step.button,
          shift: 0, clicks: step.clicks })
        assert.equal(await f.session.evaluate('buttonState()'), step.state)
        assert.equal(await f.session.evaluate('buttonTrace.join("|")'), mouseButtonTrace(step.button, step.kind, step.x))
        assert.equal(await f.session.evaluate('buttonRoot.getMainPixel(80,140)'),
          String((step.color[0] << 16) | (step.color[1] << 8) | step.color[2]))
      }
      // Direct native base calls still reject missing arguments with the
      // mutable TJS holder; valid bool conversions remain action-free.
      await f.session.evaluate(`Scripts.exec(${JSON.stringify(String.raw`
System.assignMessage("TJSBadParamCount","button-hit:arguments");
var hitErrors=[];
try{(Layer.onHitTest incontextof buttonChoice)();}catch(error){hitErrors.add(error.message);}
try{(Layer.onHitTest incontextof buttonChoice)(1,2);}catch(error){hitErrors.add(error.message);}
(Layer.onHitTest incontextof buttonChoice)(1,2,[]);
(Layer.onHitTest incontextof buttonChoice)(1,2,<%00%>);
`)})`)
      assert.equal(await f.session.evaluate('hitErrors.join("|")'), 'button-hit:arguments|button-hit:arguments')
      assert.equal(await f.session.evaluate('buttonOwnerHits'), '0')
    } catch (error) { failures.push(error) }
    try {
      await f.session.stop()
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Button choices or cleanup failed', { cause: failures[0] })
  })
