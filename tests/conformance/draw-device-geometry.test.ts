import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import type { InputView } from '../../src/engine/ports/input.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const source = String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(160,120);win.setLayerPos(3,-3);win.setZoom(1,2);win.visible=true;
var root=new Layer(win,null);root.setSize(101,103);root.fillRect(0,0,101,103,0xff203040);
var child=new Layer(win,root);child.setPos(10,6);child.setSize(40,40);child.visible=true;
child.fillRect(0,0,40,40,0xff90a0b0);
function project(){
  root.setCursorPos(45,50);root.focusable=true;root.focus();
  root.setAttentionPos(45,50);root.useAttention=true;
  return [root.cursorX,root.cursorY].join(",");
}
function addSecondary(){
  var second=new Layer(win,null);second.setSize(70,80);second.fillRect(0,0,70,80,0xffff0000);
  global.savedSecondary=second;
  return second.__id;
}
function tiny(){child.parent=null;root.setSize(1,1);win.setLayerPos(0,0);win.setZoom(1,65536);root.setCursorPos(1,1);return [root.cursorX,root.cursorY].join(",");}
function swapPrimary(){
  global.replacement=new Layer(win,root);replacement.setSize(75,77);replacement.fillRect(0,0,75,77,0xff406080);
  root.exchange(replacement,false);
  return win.primaryLayer===replacement;
}
function moveReplacement(){replacement.setCursorPos(20,20);return [replacement.cursorX,replacement.cursorY].join(",");}
`

async function fixture(binary: boolean) {
  const frames: Array<Pick<FrameLayer, 'id' | 'x' | 'y' | 'width' | 'height' | 'clip'>[]> = []
  const f = await headless({ 'startup.tjs': '', 'device-geometry.tjs': source }, {
    renderer: {
      present(layers) {
        frames.push(layers.map(({ id, x, y, width, height, clip }) => ({ id, x, y, width, height, clip: { ...clip } })))
      },
      dispose() {},
    },
  })
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("device-geometry.tjs","savedata/device-geometry.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/device-geometry.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("device-geometry.tjs")')
    await f.session.idle()
    const windowId = Number(await f.session.evaluate('win.__windowId'))
    return {
      ...f, frames,
      async run(name: string) {
        const result = await f.session.evaluate(`${name}()`)
        await f.session.idle()
        return result
      },
      view(): InputView {
        for (let i = f.events.length - 1; i >= 0; i--) {
          const event = f.events[i]!
          if (event.type === 'window-input' && event.windowId === windowId) return event.input
        }
        throw new Error('Missing projected Window input view')
      },
      async stop() {
        await f.session.stop()
        assert.equal(f.session.snapshot().handles, 0)
        assert.equal(f.session.snapshot().bitmapBytes, 0)
        assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
      },
    }
  } catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Drawing fixture startup and cleanup failed') }
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: rendered geometry, script cursor and attention share the native rounded destination`, async () => {
    const f = await fixture(binary)
    try {
      const frame = f.frames.at(-1)!
      assert.equal(frame.length, 2)
      // Win32 MulDiv(101,1,2)=51, MulDiv(103,1,2)=52 and origin=(2,-2).
      assert.deepEqual([frame[0]!.x, frame[0]!.y, frame[0]!.width, frame[0]!.height], [2, -2, 51, 52])
      assert.deepEqual(frame[0]!.clip, { x: 2, y: 0, width: 51, height: 50 })
      assert(Math.abs(frame[1]!.x - (2 + 510 / 101)) < 1e-10)
      assert(Math.abs(frame[1]!.y - (-2 + 312 / 103)) < 1e-10)
      assert(Math.abs(frame[1]!.width - 2040 / 101) < 1e-10)
      assert(Math.abs(frame[1]!.height - 2080 / 103) < 1e-10)
      // Forward integer projection loses subpixel position: (45,50)->(22,25)
      // in PaintBox pixels. Reverse projection returns primary (43,49).
      assert.equal(await f.run('project'), '43,49')
      const view = f.view()
      assert(view.virtualCursor)
      assert(view.attention)
      assert.deepEqual([view.virtualCursor.x, view.virtualCursor.y], [24, 23])
      assert.deepEqual([view.attention.x, view.attention.y], [24, 23])
    } finally { await f.stop() }
  })

  test(`${mode}: an undisplayed secondary manager cannot alter the displayed destination or frame`, async () => {
    const f = await fixture(binary)
    try {
      const before = structuredClone(f.frames.at(-1))
      await f.run('addSecondary')
      assert.equal(await f.session.evaluate('savedSecondary.width'), '70')
      assert.deepEqual(f.frames.at(-1), before)
      assert.equal(await f.run('project'), '43,49')
      assert.deepEqual([f.view().virtualCursor!.x, f.view().virtualCursor!.y], [24, 23])
    } finally { await f.stop() }
  })

  test(`${mode}: a destination rounded to zero has no drawable area and integer cursor projection remains defined`, async () => {
    const f = await fixture(binary)
    try {
      assert.equal(await f.run('tiny'), '0,0')
      assert.deepEqual(f.frames.at(-1), [])
      assert.deepEqual([f.view().virtualCursor!.x, f.view().virtualCursor!.y], [0, 0])
    } finally { await f.stop() }
  })

  test(`${mode}: exchanging a primary Layer preserves its manager's display priority over an older secondary Layer`, async () => {
    const f = await fixture(binary)
    try {
      await f.run('addSecondary')
      assert.equal(await f.run('swapPrimary'), '1')
      assert.equal(await f.session.evaluate('savedSecondary.__id<replacement.__id'), '1')
      const id = Number(await f.session.evaluate('replacement.__id')),
        frame = f.frames.at(-1)!
      assert.equal(frame[0]!.id, id)
      assert.deepEqual([frame[0]!.x, frame[0]!.y, frame[0]!.width, frame[0]!.height], [2, -2, 38, 39])
      assert.equal(await f.run('moveReplacement'), '19,19')
      assert.deepEqual([f.view().virtualCursor!.x, f.view().virtualCursor!.y], [12, 8])
    } finally { await f.stop() }
  })
}
