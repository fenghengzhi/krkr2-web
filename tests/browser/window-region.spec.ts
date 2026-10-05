import { test, expect, type Locator, type Page } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var back=new Window();back.caption="Region back";back.borderStyle=bsNone;
back.setInnerSize(200,120);back.left=30;back.top=30;back.visible=true;
var backRoot=new Layer(back,null);backRoot.setSize(200,120);backRoot.setImageSize(200,120);
backRoot.fillRect(0,0,200,120,0xff164b83);
var front=new Window();front.caption="Region front";front.borderStyle=bsNone;
front.setInnerSize(200,120);front.left=30;front.top=30;front.stayOnTop=true;front.visible=true;
var frontRoot=new Layer(front,null);frontRoot.setSize(200,120);frontRoot.setImageSize(200,120);
frontRoot.type=ltAlpha;frontRoot.fillRect(0,0,200,120,0x00ffffff);
frontRoot.fillRect(0,0,60,120,0xffe87932);
var frontDowns=0,backDowns=0;
front.onMouseDown=function(x,y,button,shift){frontDowns++;Debug.message("region:front:"+frontDowns);};
back.onMouseDown=function(x,y,button,shift){backDowns++;Debug.message("region:back:"+backDowns);};
front.setMaskRegion(1);
`

async function run(page: Page, script: string, marker: string) {
  await page.locator('#expression').fill(`${script};Debug.message("${marker}")`)
  await page.locator('#evaluate').click()
  await expect(page.locator('#logs')).toContainText(marker)
}
async function point(surface: Locator, x: number, y: number) {
  return surface.evaluate((element, point) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left + point.x, y: rect.top + point.y }
  }, { x, y })
}
async function expectTarget(page: Page, front: Locator, x: number, y: number, caption: string) {
  await front.scrollIntoViewIfNeeded()
  const at = await point(front, x, y)
  await expect.poll(() => page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('.game-window')?.getAttribute('aria-label'), at)).toBe(caption)
  return at
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: TJS region snapshots drive real overlapping Window hit testing through repaint, empty and remove`, async ({ page }, info) => {
    const game = await launchWindowAttention(page, backend, binary, source), front = game.surface('Region front')
    try {
      await expect(front).toBeVisible()
      await expect.poll(() => front.evaluate((element) => getComputedStyle(element).clipPath)).not.toBe('none')
      await expect(page.locator('clipPath')).toHaveCount(1)
      // bsNone aligns the Window outer origin with its canvas. The two host
      // rectangles overlap exactly, so a hole must expose the other live VM Window.
      const kept = await expectTarget(page, front, 30, 50, 'Region front')
      await page.mouse.click(kept.x, kept.y)
      await expect(page.locator('#logs')).toContainText('region:front:1')
      const hole = await expectTarget(page, front, 100, 50, 'Region back')
      await page.mouse.click(hole.x, hole.y)
      await expect(page.locator('#logs')).toContainText('region:back:1')
      await info.attach('window-region-hole', { body: await page.screenshot(), contentType: 'image/png' })

      // MainImage drawing and game zoom do not implicitly rebuild the captured region.
      await run(page, 'frontRoot.fillRect(0,0,200,120,0xffe87932);front.setZoom(2,1)', 'region:repainted')
      await expectTarget(page, front, 30, 50, 'Region front')
      await expectTarget(page, front, 100, 50, 'Region back')
      await run(page, 'front.setMaskRegion(1)', 'region:recaptured')
      const filled = await expectTarget(page, front, 100, 50, 'Region front')
      await page.mouse.click(filled.x, filled.y)
      await expect(page.locator('#logs')).toContainText('region:front:2')

      // No alpha byte reaches 256. Empty clips everything; null removes the clip.
      await run(page, 'front.setMaskRegion(256)', 'region:empty')
      const empty = await expectTarget(page, front, 30, 50, 'Region back')
      await page.mouse.click(empty.x, empty.y)
      await expect(page.locator('#logs')).toContainText('region:back:2')
      await run(page, 'front.removeMaskRegion()', 'region:removed')
      await expectTarget(page, front, 100, 50, 'Region front')
      await expect.poll(() => front.evaluate((element) => getComputedStyle(element).clipPath)).toBe('none')
      await expect(page.locator('clipPath')).toHaveCount(0)

      // Stop is exercised while a real region is installed, not only after null.
      await run(page, 'front.setMaskRegion(1)', 'region:stop-with-mask')
      await expect(page.locator('clipPath')).toHaveCount(1)
    } finally { await game.stop() }
    await expect(page.locator('clipPath')).toHaveCount(0)
    await expect(page.locator('.game-window')).toHaveCount(0)
  })
