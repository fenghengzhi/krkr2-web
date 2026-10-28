import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { imageSelectionFiles, imageSelectionSource, imageSelectionErrors } from '../helpers/image-selection.ts'

async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof headless>>) => Promise<void>) {
  const f = await headless({ ...imageSelectionFiles(), 'selection.tjs': imageSelectionSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("selection.tjs","savedata/selection.cjs",false,true,false);Scripts.execStorage("savedata/selection.cjs");'
      : 'Scripts.execStorage("selection.tjs");' }), failures: unknown[] = []
  try {
    await f.session.start()
    if (binary) {
      const bytes = f.session.exportSaves().find((file) => file.path === 'savedata/selection.cjs')!.bytes
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'TJS2')
    }
    assert.equal(await f.session.evaluate('imageSelectionMessages()'), '1')
    await run(f)
  } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().state, 'stopped')
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Image selection scenario or cleanup failed', { cause: failures[0] })
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  for (const [name, expression, expected] of [
    ['built-in priority and ASCII extension aliases', 'imageSelectionOrder()', '1'],
    ['normalized unknown/missing names and registered unavailable ERI', 'imageSelectionErrors()', imageSelectionErrors],
    ['selected format rejects differently encoded bytes', 'imageSelectionWrongFormat()', '1'],
    ['normal cache cannot bypass province/mask/rule modes', 'imageSelectionModes()', '1'],
    ['companions use the requested stem across AutoPaths', 'imageSelectionCompanions()', '1'],
    ['compressed XP3 lookup retains mode and mask errors', 'imageSelectionArchive()', '1'],
  ]) test(`${mode}: image handler ${name}`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }) => { assert.equal(await session.evaluate(expression!), expected) })
  })
  test(`${mode}: selected image cache observes a saved replacement without changing its handler`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }) => {
      assert.equal(await session.evaluate('imageSelectionCompanions()'), '1')
      await session.evaluate('(function(){selectionBack.setImageSize(2,1);selectionBack.fillRect(0,0,2,1,0xff112233);selectionBack.saveLayerImage("art/hero.PNG","png");return 0;})()')
      assert.equal(await session.evaluate('(function(){selectionLayer.loadImages("hero");return selectionLayer.getMainPixel(1,0)==0x112233 && selectionLayer.getMaskPixel(1,0)==128 && selectionLayer.getProvincePixel(1,0)==1;})()'), '1')
    })
  })
}
