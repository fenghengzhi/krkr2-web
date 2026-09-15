import { test, expect, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const source = String.raw`
var a=new Window();a.caption="IME A";a.setInnerSize(200,100);a.visible=true;
var rootA=new Layer(a,null);rootA.setSize(200,100);rootA.focusable=true;
rootA.attentionLeft=40;rootA.attentionTop=30;rootA.imeMode=imOpen;rootA.focus();
var b=new Window();b.caption="IME B";b.setInnerSize(160,80);b.setPos(420,0);b.visible=true;
var rootB=new Layer(b,null);rootB.setSize(160,80);rootB.focusable=true;
rootB.attentionLeft=80;rootB.attentionTop=20;rootB.imeMode=imOpen;rootB.focus();
Debug.message("multiwindow-ime-ready");
`

async function expectCaret(surface: Locator, x: number, y: number) {
  await expect
    .poll(() =>
      surface.evaluate(
        (element, point) => {
          const canvas = element.querySelector('canvas')!,
            text = element.querySelector('.game-text-input')!,
            image = canvas.getBoundingClientRect(),
            caret = text.getBoundingClientRect()
          return Math.max(
            Math.abs(caret.x - image.x - canvas.clientWidth * point.x),
            Math.abs(caret.y - image.y - canvas.clientHeight * point.y),
          )
        },
        { x, y },
      ),
    )
    .toBeLessThan(1.5)
}

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: each IME caret follows CSS-only window sizing and viewport changes`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/?backend=asyncify')
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          binary
            ? 'Scripts.compileStorage("ime.tjs","savedata/ime.cjs",false,true,false);Scripts.execStorage("savedata/ime.cjs");'
            : 'Scripts.execStorage("ime.tjs");',
        ),
      },
      { name: 'ime.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
    ])
    await expect(page.getByText('multiwindow-ime-ready', { exact: true })).toBeVisible()
    const a = page.locator('.game-window[aria-label="IME A"]'),
      b = page.locator('.game-window[aria-label="IME B"]')
    await expect(a.locator('.game-text-input')).toHaveCount(1)
    await expect(b.locator('.game-text-input')).toHaveCount(1)
    await expectCaret(a, 0.2, 0.3)
    await expectCaret(b, 0.5, 0.25)
    const original = await a.locator('canvas').boundingBox()
    // A stylesheet changes only the DOM boxes. No input packet, Window.set,
    // viewport event, or script evaluation can accidentally refresh the caret.
    await page.addStyleTag({
      content: `
      .game-window[aria-label="IME A"] { width: 25vw !important; }
      .game-window[aria-label="IME B"] { width: 30vw !important; }
    `,
    })
    await expect
      .poll(async () => (await a.locator('canvas').boundingBox())!.width)
      .not.toBe(original!.width)
    await expectCaret(a, 0.2, 0.3)
    await expectCaret(b, 0.5, 0.25)
    await page.setViewportSize({ width: 1000, height: 700 })
    await expectCaret(a, 0.2, 0.3)
    await expectCaret(b, 0.5, 0.25)
    await evaluate(
      page,
      'a.innerWidth+","+a.innerHeight+";"+b.innerWidth+","+b.innerHeight',
      '200,100;160,80',
    )
    await page.locator('#stop').click()
    await expect(page.locator('.game-text-input')).toHaveCount(0)
    await page.setViewportSize({ width: 1100, height: 720 })
    expect(errors).toEqual([])
  })
