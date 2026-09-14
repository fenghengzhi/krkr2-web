import { test, expect } from '@playwright/test'
import {
  injectActivity,
  visibility,
  lifecycle,
  loadActivity,
  activityFile,
} from '../helpers/activity-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { injectGpu, gpuWorker, loseGpu, restoreGpu, gpuStats } from '../helpers/gpu-browser.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: visibility signals freeze timers, preserve state and retain user pause`, async ({
    page,
  }) => {
    await injectActivity(page)
    await loadActivity(page, backend)
    await evaluate(page, 'value=91', '91')
    await visibility(page, 'hidden')
    await expect(page.locator('#status')).toHaveText('后台已暂停')
    const ticks = await page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count()
    await page.waitForTimeout(450) // Observe more than two actual timer intervals.
    expect(await page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count()).toBe(ticks)
    await visibility(page, 'visible')
    await evaluate(page, 'value', '91')
    await page.locator('#pause').click()
    await visibility(page, 'hidden')
    await visibility(page, 'visible')
    await expect(page.locator('#status')).toHaveText('已暂停')
    await page.locator('#pause').click()
    await evaluate(page, 'value', '91')
    await page.locator('#stop').click()
  })
  test(`${backend}: opt-out keeps scripts running while freeze and pagehide still suspend`, async ({
    page,
  }) => {
    await injectActivity(page)
    await loadActivity(page, backend)
    await page.locator('#pause-background').uncheck()
    await visibility(page, 'hidden')
    await expect(page.locator('#status')).toHaveText('运行中')
    const count = await page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count()
    await expect
      .poll(() => page.locator('#logs p').filter({ hasText: 'activity-tick=' }).count())
      .toBeGreaterThan(count)
    await lifecycle(page, 'freeze')
    await expect(page.locator('#status')).toHaveText('页面已冻结')
    await visibility(page, 'visible', 'frozen') // Visibility cannot release an outstanding freeze.
    await expect(page.locator('#status')).toHaveText('页面已冻结')
    await lifecycle(page, 'resume')
    await expect(page.locator('#status')).toHaveText('运行中')
    await lifecycle(page, 'pagehide')
    await expect(page.locator('#stage')).toHaveAttribute('data-activity', 'away')
    await lifecycle(page, 'resume')
    await expect(page.locator('#stage')).toHaveAttribute('data-activity', 'away')
    await lifecycle(page, 'pageshow')
    await expect(page.locator('#status')).toHaveText('运行中')
    await page.reload()
    await expect(page.locator('#pause-background')).not.toBeChecked()
  })
  test(`${backend}: backgrounding drops held input, composition and pointer capture before returning`, async ({
    page,
  }) => {
    await injectActivity(page)
    await loadActivity(page, backend)
    const canvas = page.locator('canvas'),
      bounds = (await canvas.boundingBox())!
    await page.mouse.move(bounds.x + 10, bounds.y + 10)
    await page.mouse.down()
    await page.keyboard.down('a')
    await page.locator('.game-text-input').evaluate((element) => {
      const input = element as HTMLTextAreaElement
      input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      input.value = '旧'
      input.dispatchEvent(new InputEvent('input', { data: '旧', isComposing: true }))
    })
    await visibility(page, 'hidden')
    await page.keyboard.up('a')
    await page.mouse.up()
    await visibility(page, 'visible')
    await page.locator('.game-text-input').evaluate((element) => {
      const input = element as HTMLTextAreaElement
      input.dispatchEvent(new CompositionEvent('compositionend', { data: '旧' }))
      input.value = '旧'
      input.dispatchEvent(
        new InputEvent('input', { data: '旧', inputType: 'insertFromComposition' }),
      )
      input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      input.dispatchEvent(new CompositionEvent('compositionend', { data: '新' }))
      input.value = '新'
      input.dispatchEvent(
        new InputEvent('input', { data: '新', inputType: 'insertFromComposition' }),
      )
    })
    // Input packets cross a separate serialized browser queue. A one-shot
    // console evaluation is not an acknowledgement that the text reached TJS.
    await expect(
      page.locator('#logs span').filter({ hasText: /^activity-text=(?:a)?新$/ }),
    ).toHaveCount(1)
    await evaluate(page, 'committed=="新" || committed=="a新"', '1')
    await evaluate(page, 'System.getKeyState(65)||System.getKeyState(1)', '0')
    await evaluate(page, 'clicks', '0')
    await canvas.click({ position: { x: 10, y: 10 } })
    await expect(page.locator('#logs')).toContainText('activity-click=1')
    await page.locator('#stop').click()
  })
  test(`${backend}: a hidden initial load can wait, resume, stop and restart cleanly`, async ({
    page,
  }) => {
    await injectActivity(page, 'hidden')
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles(activityFile)
    await expect(page.locator('#status')).toHaveText('后台已暂停')
    await expect(page.locator('#logs')).not.toContainText('activity-ready')
    await visibility(page, 'visible')
    await expect(page.locator('#logs')).toContainText('activity-ready')
    await expect(page.locator('#status')).toHaveText('运行中')
    await visibility(page, 'hidden')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    await visibility(page, 'visible')
    await page.locator('#restart').click()
    await expect(page.locator('#status')).toHaveText('运行中')
    await evaluate(page, 'value', '17')
    await page.locator('#stop').click()
  })
  test(`${backend}: returning to the page cannot override a lost GPU and hidden frames stay quiet`, async ({
    page,
  }) => {
    await injectActivity(page)
    await injectGpu(page)
    await loadActivity(page, backend)
    const worker = await gpuWorker(page)
    await visibility(page, 'hidden')
    const before = await gpuStats(worker)
    await page.waitForTimeout(350) // Observe at least one background presentation check.
    expect((await gpuStats(worker)).draws).toBe(before.draws)
    await loseGpu(worker)
    await visibility(page, 'visible')
    await expect(page.locator('#status')).toHaveText('等待画面恢复')
    await restoreGpu(worker)
    await expect(page.locator('#status')).toHaveText('运行中')
    await evaluate(page, 'value', '17')
    await page.locator('#stop').click()
  })
}
