import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { EngineEvent, SessionDependencies } from '../../src/engine/session.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(20,20);win.visible=true;
var root=new Layer(win,null);root.setSize(4,3);root.setImageSize(4,3);
root.fillRect(0,0,4,3,0x00ffffff);
root.setMaskPixel(1,0,1);root.setMaskPixel(2,0,255);
root.setMaskPixel(1,1,127);root.setMaskPixel(2,1,255);
root.setMaskPixel(0,2,128);root.setMaskPixel(3,2,255);
`
type RegionEvent = Extract<EngineEvent, { type: 'window-region' }>
function regionEvents(events: EngineEvent[], windowId: number): RegionEvent[] {
  return events.filter((event): event is RegionEvent => event.type === 'window-region' && event.windowId === windowId)
}
async function fixture(binary: boolean, overrides: Partial<SessionDependencies> = {}) {
  const f = await headless({ 'startup.tjs': binary
    ? 'Scripts.compileStorage("window-region.tjs","savedata/window-region.cjs",false,true,false);Scripts.execStorage("savedata/window-region.cjs");'
    : 'Scripts.execStorage("window-region.tjs");', 'window-region.tjs': source }, overrides)
  try {
    await f.session.start()
    const id = Number(await f.session.evaluate('win.__windowId'))
    if (binary) {
      const bytes = f.session.exportSaves().find((entry) => entry.path === 'savedata/window-region.cjs')?.bytes
      assert(bytes)
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'TJS2')
    }
    const execute = (source: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
    return { ...f, id, execute, regions: () => regionEvents(f.events, id) }
  } catch (error) { await f.session.stop(); throw error }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: Window mask uses a primary-image snapshot independently of display geometry and later drawing`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('win.setMaskRegion()')
      const first = f.regions().at(-1)!
      assert(first.region)
      assert.deepEqual([...first.region.rectangles], [1, 0, 2, 2, 0, 2, 1, 1, 3, 2, 1, 1])
      assert.equal(first.region.width, 4)
      assert.equal(first.region.height, 3)
      await f.execute(String.raw`
root.setSize(2,2);root.setImageSize(4,3);root.setImagePos(7,9);root.setClip(0,0,4,3);
root.fillRect(0,0,4,3,0xffffffff);root.opacity=0;root.setClip(0,0,1,1);
var child=new Layer(win,root);child.setSize(20,20);child.fillRect(0,0,20,20,0xffffffff);child.visible=true;
win.setZoom(3,2);win.setLayerPos(5,7);win.setInnerSize(30,40);
`)
      assert.equal(await f.session.evaluate('root.getMaskPixel(0,0)+","+root.getMaskPixel(3,2)'), '255,255')
      assert.equal(await f.session.evaluate('root.opacity+","+win.layerLeft+","+win.layerTop'), '0,5,7')
      assert.equal(f.regions().length, 1, 'Bitmap and geometry changes do not recreate an installed native region')
      assert.deepEqual([...first.region.rectangles], [1, 0, 2, 2, 0, 2, 1, 1, 3, 2, 1, 1])
      await f.session.evaluate('win.setMaskRegion(void)')
      const second = f.regions().at(-1)!
      assert(second.region)
      assert.deepEqual([...second.region.rectangles], [0, 0, 4, 3], 'Mask creation reads all MainImage pixels, ignoring drawing clip and image/display offsets')
      assert(second.revision > first.revision)
      assert.equal(f.session.snapshot().windows!.find((window) => window.id === f.id)!.view.regionRevision, second.revision)
      await f.session.evaluate('win.removeMaskRegion()')
      assert.equal(f.regions().at(-1)!.region, null)
      assert(f.regions().at(-1)!.revision > second.revision)
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: mask threshold uses native integer conversion and unsigned low 32 bits`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      for (const [expression, rectangles] of [
        ['128.9', [2, 0, 1, 2, 0, 2, 1, 1, 3, 2, 1, 1]],
        ['0', [0, 0, 4, 3]], ['256', []], ['-1', []],
        ['4294967297', [1, 0, 2, 2, 0, 2, 1, 1, 3, 2, 1, 1]],
      ] as const) {
        await f.session.evaluate(`win.setMaskRegion(${expression})`)
        const region = f.regions().at(-1)!.region
        assert(region)
        assert.deepEqual([...region.rectangles], [...rectangles])
      }
      await f.execute('win.setMaskRegion(256);win.removeMaskRegion();')
      assert(f.regions().at(-2)!.region)
      assert.equal(f.regions().at(-2)!.region!.rectangles.length, 0)
      assert.equal(f.regions().at(-1)!.region, null)
    } finally { await f.session.stop() }
  })

  test(`${mode}: missing primary/image and complexity failure preserve the previous installed region`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('win.setMaskRegion();var blank=new Window();blank.visible=true;')
      const previous = f.regions().at(-1)!, count = f.regions().length
      await assert.rejects(f.session.evaluate('blank.setMaskRegion()'), /primary Layer/)
      await f.execute('blank.removeMaskRegion();root.hasImage=false;')
      assert.equal(await f.session.evaluate('root.hasImage'), '0')
      await assert.rejects(f.session.evaluate('win.setMaskRegion()'), /drawable image/)
      assert.equal(f.regions().length, count)
      assert.deepEqual([...f.regions().at(-1)!.region!.rectangles], [...previous.region!.rectangles])
      // Image operations construct >65,536 distinct native runs without a
      // giant script loop or a product-only test hook.
      await f.execute(String.raw`
root.hasImage=true;root.setImageSize(512,257);root.setClip(0,0,512,257);
root.fillRect(0,0,512,257,0x00ffffff);
for(var x=0;x<512;x+=2)root.setMaskPixel(x,0,255);
for(var x=1;x<512;x+=2)root.setMaskPixel(x,1,255);
for(var y=2;y<257;y++)root.copyRect(0,y,root,0,y%2,512,1);
`)
      await assert.rejects(f.session.evaluate('win.setMaskRegion()'), /rectangle budget exceeded/)
      assert.equal(f.regions().length, count)
      assert.deepEqual([...f.regions().at(-1)!.region!.rectangles], [...previous.region!.rectangles])
    } finally { await f.session.stop() }
  })

  test(`${mode}: region snapshots survive primary image lifetime and retire with their owning Window`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('win.setMaskRegion();invalidate root;')
      const first = f.regions().at(-1)!
      assert(first.region)
      await assert.rejects(f.session.evaluate('win.setMaskRegion()'), /primary Layer/)
      assert.equal(f.regions().length, 1)
      await f.execute('win.removeMaskRegion();invalidate win;')
      assert.equal(f.regions().at(-1)!.region, null)
      assert(f.events.some((event) => event.type === 'window-closed' && event.windowId === f.id))
      await f.execute('var replacement=new Window();replacement.visible=true;')
      const replacementId = Number(await f.session.evaluate('replacement.__windowId'))
      assert.notEqual(replacementId, f.id)
      assert.equal(f.session.snapshot().windows!.find((window) => window.id === replacementId)!.view.regionRevision, 0)
    } finally { await f.session.stop() }
    assert(f.events.some((event) => event.type === 'window-regions-clear'))
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: Stop cancels a yielding region replacement before its host work returns and ignores its late result`, { timeout: 60000 }, async () => {
    let armed = false, enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve }),
      gate = new Promise<void>((resolve) => { release = resolve }),
      f = await fixture(binary, {
        // No elapsed-time background checkpoint can consume the gate. Region
        // preparation deliberately yields at row zero independently of time.
        now: () => 0,
        yieldToHost: async () => {
          if (armed) { armed = false; enter(); await gate }
          else await new Promise<void>((resolve) => setTimeout(resolve, 0))
        },
      })
    let pending: Promise<string> | undefined
    try {
      await f.session.evaluate('win.setMaskRegion()')
      const installed = f.regions().length
      armed = true
      pending = f.execute('win.setMaskRegion(128);Debug.message("region-after-cancel");')
      const failed = pending.then(() => { throw new Error('Mask completed without its controlled yield') },
        (error: unknown) => { throw error })
      // Whichever branch loses still has a rejection observer through race.
      await Promise.race([entered, failed])
      await f.session.stop()
      await assert.rejects(pending)
      assert.equal(f.regions().length, installed)
      assert(f.events.some((event) => event.type === 'window-regions-clear'))
      release()
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(f.regions().length, installed, 'A late builder cannot install a retired mask')
      assert.equal(f.logs.includes('region-after-cancel'), false)
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    } finally {
      release()
      await pending?.catch(() => {})
      await f.session.stop()
    }
  })
}
