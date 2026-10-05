import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { popupSource, observePopupDom, reset, sequence, point, focusGame } from '../helpers/window-popup-fixture.ts'

test.beforeEach(async ({ page }) => { await observePopupDom(page) })

async function finish(page: Page, info: TestInfo, stop: () => Promise<void>, failures: unknown[]) {
  try { await page.keyboard.up('Alt'); await page.mouse.up(); await page.mouse.up({ button: 'right' }); await stop() }
  catch (error) { failures.push(error) }
  try {
    const evidence = await page.evaluate(() => window.popupDomEvidence)
    await info.attach('window-popup-input', { body: JSON.stringify({ scope: 'Real browser pointer/key/focus events; no physical hardware claim', evidence,
      logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' })
    expect(evidence?.dropped).toBe(0)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Popup scenario and cleanup failed', { cause: failures[0] })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${variant}: popup notifications use real inside/outside and chrome downs, registration order and script-owned visibility`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, popupSource), failures: unknown[] = [],
      main = game.surface('Popup main'), old = game.surface('Popup old'), newer = game.surface('Popup new')
    try {
      await reset(page, 'inside')
      const inside = await point(newer.locator('canvas[data-window-id]'))
      await page.mouse.click(inside.x, inside.y)
      await sequence(page, 'inside', 'down:new:0')
      await expect(old).toBeVisible(); await expect(newer).toBeVisible()

      for (const button of ['left', 'right'] as const) {
        await reset(page, `outside-${button}`)
        const outside = await point(main.locator('canvas[data-window-id]'))
        await page.mouse.click(outside.x, outside.y, { button })
        await sequence(page, `outside-${button}`, `hide:new|action:old|down:main:${button === 'left' ? 0 : 1}`)
        // No engine or host auto-hide: both callbacks deliberately keep them.
        await expect(old).toBeVisible(); await expect(newer).toBeVisible()
      }

      await reset(page, 'captured-targets', 'mutate-old')
      const mainPoint = await point(main.locator('canvas[data-window-id]'))
      await page.mouse.click(mainPoint.x, mainPoint.y)
      await sequence(page, 'captured-targets', 'hide:new|action:old|down:main:0')
      await expect(old).toHaveAttribute('data-focusable', 'true')

      await reset(page, 'delivery-visible', 'hide-old')
      const visiblePoint = await point(main.locator('canvas[data-window-id]'))
      await page.mouse.click(visiblePoint.x, visiblePoint.y)
      await sequence(page, 'delivery-visible', 'hide:new|down:main:0')
      await expect(old).toBeHidden(); await expect(newer).toBeVisible()

      for (const button of ['left', 'right'] as const) {
        await reset(page, `chrome-${button}`)
        const title = await point(main.locator('.game-window-title'))
        await page.mouse.click(title.x, title.y, { button })
        await sequence(page, `chrome-${button}`, 'hide:new|action:old')
        if (button === 'right') await page.keyboard.press('Escape')
      }

      await reset(page, 'mouse-key', 'stay', 'popupMain.useMouseKey=true;')
      await focusGame(page, main)
      await page.keyboard.press('Enter')
      await sequence(page, 'mouse-key', 'hide:new|action:old|down:main:0')

      await reset(page, 'script-hides', 'hide')
      const hidePoint = await point(main.locator('canvas[data-window-id]'))
      await page.mouse.click(hidePoint.x, hidePoint.y)
      await sequence(page, 'script-hides', 'hide:new|action:old|down:main:0')
      await expect(old).toBeHidden(); await expect(newer).toBeHidden()
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await info.attach('window-popup-script-hidden', { body: await page.screenshot(), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    await finish(page, info, game.stop, failures)
  })

  test(`${variant}: system keys precede trapped or menu-consumed input and outside host controls notify once`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.goto(`/?backend=${backend}`)
    // Keep the original preference while checking page controls. Trusted
    // application deactivation has its own noDefaults browser connection.
    await page.locator('#pause-background').uncheck()
    const game = await launchWindowAttention(page, backend, binary, popupSource, [], true), failures: unknown[] = [],
      main = game.surface('Popup main')
    try {
      await reset(page, 'posted', 'stay', 'popupMain.postInputEvent("onKeyDown",%[key:121,shift:0]);')
      await sequence(page, 'posted', 'key:main:121')

      await reset(page, 'alt-trap', 'stay', 'popupNonTop.trapKey=true;')
      await focusGame(page, main)
      // Native trapKey=true resets its system-key admission gate. A real
      // ordinary key arms it and must itself leave both popups untouched.
      await page.keyboard.press('a')
      await sequence(page, 'alt-trap', 'key:non-top:65')
      await page.keyboard.down('Alt')
      try { await sequence(page, 'alt-trap', 'key:non-top:65|hide:new|action:old|key:non-top:18') }
      finally { await page.keyboard.up('Alt') }

      await reset(page, 'menu-f10')
      await focusGame(page, main)
      await page.keyboard.press('F10')
      await sequence(page, 'menu-f10', 'hide:new|action:old|menu:main')

      await reset(page, 'host-control')
      await focusGame(page, main)
      await page.locator('#expression').click()
      await sequence(page, 'host-control', 'hide:new|action:old')
      // Return without mousedown, then use an ordinary real key as the FIFO
      // barrier after any duplicate blur notification could have been queued.
      await focusGame(page, main)
      await page.keyboard.press('F8')
      await sequence(page, 'host-control', 'hide:new|action:old|key:main:119')

      // Trusted application blur/restoration runs in the matching noDefaults
      // native-activity scenario. Playwright's regular Firefox build suppresses
      // document-leaving blur and forces hasFocus() true for every top-level page.
      await expect(game.surface('Popup old')).toBeVisible()
      await expect(game.surface('Popup new')).toBeVisible()
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await info.attach('window-popup-host-focus-restored', { body: await page.screenshot(), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    await finish(page, info, game.stop, failures)
  })
}
