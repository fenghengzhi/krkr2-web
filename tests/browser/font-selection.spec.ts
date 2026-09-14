import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: family styles choose the physical face without duplicate synthesis`, async ({
    page,
  }) => {
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          'var w=new Window(),a=new Layer(w,null);w.visible=true;a.font.height=20;a.font.getList(0);a.font.face="Selection Latin";Debug.message("family-style-ready");',
        ),
      },
      ...(await Promise.all(
        ['latin-bold.ttf', 'latin.ttf'].map(async (name) => ({
          name,
          mimeType: 'font/ttf',
          buffer: await readFile('tests/fixtures/font-selection/' + name),
        })),
      )),
    ])
    await expect(page.getByText('family-style-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'a.font.getTextWidth("A")', '10')
    await evaluate(page, '(function(){a.font.bold=true;return a.font.getTextWidth("A");})()', '18')
    await evaluate(page, '(function(){a.font.bold=false;return a.font.getTextWidth("A");})()', '10')
    await evaluate(page, 'a.font.getList(fsfTrueTypeOnly).join(",")', 'Selection Latin')
    await page.locator('#stop').click()
  })
  test(`${backend}: font dialog filters game faces, previews their pixels and preserves font settings`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage
      const pending: (() => void)[] = []
      let held = true
      Worker.prototype.postMessage = function (
        message: unknown,
        transferOrOptions?: Transferable[] | StructuredSerializeOptions,
      ) {
        const request = message as { type?: string; argumentList?: { value?: unknown }[] }
        const send = () => Reflect.apply(original, this, [message, transferOrOptions])
        if (held && request.type === 'APPLY' && request.argumentList?.[0]?.value === 'previewFont')
          pending.push(send)
        else send()
      }
      Object.assign(window, {
        releaseFontPreviews() {
          held = false
          for (const send of pending.splice(0)) send()
        },
      })
    })
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          'var w=new Window(),a=new Layer(w,null);w.visible=true;w.setInnerSize(96,48);a.setSize(96,48);a.type=ltAlpha;a.font.height=20;Debug.message("font-dialog-ready");',
        ),
      },
      ...(await Promise.all(
        ['latin.ttf', 'mono.ttf', 'symbol.ttf'].map(async (name) => ({
          name,
          mimeType: 'font/ttf',
          buffer: await readFile('tests/fixtures/font-selection/' + name),
        })),
      )),
    ])
    await expect(page.getByText('font-dialog-ready', { exact: true })).toBeVisible()
    await page
      .locator('#expression')
      .fill(
        '(function(){a.font.angle=300;var r=a.font.doUserSelect(fsfTrueTypeOnly|fsfNoVertical|fsfIgnoreSymbol|fsfUseFontFace,"<选择字体>","请选择用于游戏的字体。","AV");Debug.message("font-chosen:"+[r,a.font.face,a.font.height,a.font.angle,a.font.faceIsFileName].join(","));})()',
      )
    await page.locator('#evaluate').click()
    const dialog = page.getByRole('dialog', { name: '<选择字体>' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('option')).toHaveCount(2)
    await expect(dialog.locator('img')).toHaveCount(0)
    const mono = dialog.getByRole('option', { name: 'Selection Mono', exact: true })
    const before = await mono.boundingBox()
    expect(before).not.toBeNull()
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2)
    await page.mouse.down()
    await page.evaluate(() =>
      (window as unknown as { releaseFontPreviews(): void }).releaseFontPreviews(),
    )
    await expect(dialog.locator('.font-sample')).toHaveAttribute(
      'data-font-face',
      'Selection Latin',
    )
    await expect(mono.locator('canvas')).toHaveAttribute('data-font-face', 'Selection Mono')
    expect(await mono.boundingBox()).toEqual(before)
    await page.mouse.up()
    await expect(mono).toHaveAttribute('aria-selected', 'true')
    const preview = dialog.locator('.font-sample')
    await expect(preview).toHaveAttribute('data-font-face', 'Selection Mono')
    expect(
      await preview.evaluate((c) => [
        ...(c as HTMLCanvasElement).getContext('2d')!.getImageData(12, 18, 1, 1).data,
      ]),
    ).toEqual([32, 33, 36, 255])
    await expect(mono.locator('canvas')).toBeVisible()
    await dialog.getByRole('button', { name: '确定', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(
      page.getByText('font-chosen:1,Selection Mono,20,300,0', { exact: true }),
    ).toBeVisible()
    await evaluate(page, 'a.font.getTextWidth("AV")', '28')
    await evaluate(
      page,
      '(function(){a.font.face="monospace";return a.font.getTextWidth("WWWW")==a.font.getTextWidth("iiii");})()',
      '1',
    )
    await page
      .locator('#expression')
      .fill(
        'Debug.message("font-cancel:"+a.font.doUserSelect(0,"Cancel","Prompt","AV")+":"+a.font.face)',
      )
    await page.locator('#evaluate').click()
    await page
      .getByRole('dialog', { name: 'Cancel', exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await expect(page.getByText('font-cancel:0:monospace', { exact: true })).toBeVisible()
    await page.locator('#stop').click()
  })
  test(`${backend}: a font dialog during startup can stop the game and a fresh session can start`, async ({
    page,
  }) => {
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'var w=new Window(),a=new Layer(w,null);a.font.doUserSelect(0,"Startup font","Choose","AV");Debug.message("must-not-resume-font");',
      ),
    })
    const dialog = page.getByRole('dialog', { name: 'Startup font', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '停止游戏', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('#stop')).toBeDisabled()
    await expect(page.getByText('must-not-resume-font', { exact: true })).toHaveCount(0)
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from('var w=new Window();w.visible=true;Debug.message("font-new-session");'),
    })
    await expect(page.getByText('font-new-session', { exact: true })).toBeVisible()
    await page.locator('#stop').click()
  })
}

test('local font access is requested by a click and refreshes the pending filtered dialog', async ({
  page,
}) => {
  const bytes = [...(await readFile('tests/fixtures/font-selection/latin.ttf'))]
  await page.addInitScript((bytes) => {
    const state = window as unknown as {
      fontQueries: number
      queryLocalFonts: () => Promise<unknown[]>
    }
    state.fontQueries = 0
    state.queryLocalFonts = async () => {
      state.fontQueries++
      return [
        {
          family: 'System Fixture',
          style: 'Regular',
          postscriptName: 'Fixture-Regular',
          blob: async () => new Blob([new Uint8Array(bytes)]),
        },
      ]
    }
  }, bytes)
  await page.goto('/?backend=asyncify')
  await page.locator('#files').setInputFiles({
    name: 'startup.tjs',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'var w=new Window(),a=new Layer(w,null);a.font.doUserSelect(fsfTrueTypeOnly,"Local fonts","Prompt","AV");Debug.message("system-font:"+a.font.face);',
    ),
  })
  const dialog = page.getByRole('dialog', { name: 'Local fonts', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('option')).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as unknown as { fontQueries: number }).fontQueries),
  ).toBe(0)
  await dialog.getByRole('button', { name: '读取本机字体', exact: true }).click()
  await expect(dialog.getByRole('option', { name: 'System Fixture', exact: true })).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as { fontQueries: number }).fontQueries),
  ).toBe(1)
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByText('system-font:System Fixture', { exact: true })).toBeVisible()
  await page.locator('#stop').click()
})

test('local font denial can be retried and a late permission result cannot update a newer dialog', async ({
  page,
}) => {
  const bytes = [...(await readFile('tests/fixtures/font-selection/latin.ttf'))]
  await page.addInitScript((bytes) => {
    const state = window as unknown as {
      fontQueries: number
      finishLateFonts: () => void
      queryLocalFonts: () => Promise<unknown[]>
    }
    state.fontQueries = 0
    const font = (family: string) => ({
      family,
      style: 'Regular',
      postscriptName: 'Fixture-Regular',
      blob: async () => new Blob([new Uint8Array(bytes)]),
    })
    state.queryLocalFonts = async () => {
      state.fontQueries++
      if (state.fontQueries === 1)
        throw new DOMException('Fixture permission denied', 'NotAllowedError')
      if (state.fontQueries === 2)
        return new Promise((resolve) => {
          state.finishLateFonts = () => resolve([font('Late Fixture')])
        })
      return [font('Retried Fixture')]
    }
  }, bytes)
  await page.goto('/?backend=asyncify')
  await page.locator('#files').setInputFiles({
    name: 'startup.tjs',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'var w=new Window(),a=new Layer(w,null);w.visible=true;Debug.message("font-permission-ready");',
    ),
  })
  await expect(page.getByText('font-permission-ready', { exact: true })).toBeVisible()
  const open = async (caption: string) => {
    await page
      .locator('#expression')
      .fill(
        `Debug.message("font-permission-result:"+a.font.doUserSelect(fsfTrueTypeOnly,"${caption}","Prompt","AV"))`,
      )
    await page.locator('#evaluate').click()
    const dialog = page.getByRole('dialog', { name: caption, exact: true })
    await expect(dialog).toBeVisible()
    return dialog
  }
  const first = await open('First permission')
  await first.getByRole('button', { name: '读取本机字体', exact: true }).click()
  await expect(first.getByRole('status')).toHaveText('Fixture permission denied')
  await first.getByRole('button', { name: '读取本机字体', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { fontQueries: number }).fontQueries))
    .toBe(2)
  await first.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByText('font-permission-result:0', { exact: true })).toBeVisible()
  const next = await open('Second permission')
  await page.evaluate(() =>
    (window as unknown as { finishLateFonts: () => void }).finishLateFonts(),
  )
  // The next successful request is also a barrier after delivery of the old Promise.
  await next.getByRole('button', { name: '读取本机字体', exact: true }).click()
  await expect(next.getByRole('option', { name: 'Retried Fixture', exact: true })).toBeVisible()
  await expect(next.getByRole('option', { name: 'Late Fixture', exact: true })).toHaveCount(0)
  await expect(next.getByRole('option')).toHaveCount(1)
  await next.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByText('font-permission-result:1', { exact: true })).toBeVisible()
  await evaluate(page, 'a.font.face', 'Retried Fixture')
  await page.locator('#stop').click()
})

test('the font dialog fits a narrow screen, supports keyboard selection and isolates menu shortcuts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 650 })
  await page.goto('/?backend=asyncify')
  await page.locator('#files').setInputFiles({
    name: 'startup.tjs',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'var w=new Window(),a=new Layer(w,null),m=new MenuItem(w,"Forbidden");w.menu.add(m);w.visible=true;m.shortcut="Shift+F6";m.onClick=function(){Debug.message("font-menu-leaked");};Debug.message("font-keyboard-ready");',
    ),
  })
  await expect(page.getByText('font-keyboard-ready', { exact: true })).toBeVisible()
  await page
    .locator('#expression')
    .fill(
      'Debug.message("font-keyboard-result:"+a.font.doUserSelect(0,"Keyboard font","Prompt","AV")+":"+a.font.face)',
    )
  await page.locator('#evaluate').click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard font', exact: true })
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650)
  await dialog.getByRole('option', { name: 'sans-serif', exact: true }).focus()
  await page.keyboard.press('Shift+F6')
  await page.keyboard.press('End')
  await expect(dialog.getByRole('option', { name: 'monospace', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('font-keyboard-result:1:monospace', { exact: true })).toBeVisible()
  await evaluate(page, 'a.font.face', 'monospace')
  await expect(page.getByText('font-menu-leaked', { exact: true })).toHaveCount(0)
  await page.locator('#stage canvas').focus()
  await page.keyboard.press('Shift+F6')
  await expect(page.getByText('font-menu-leaked', { exact: true })).toBeVisible()
  await page.locator('#stop').click()
})
