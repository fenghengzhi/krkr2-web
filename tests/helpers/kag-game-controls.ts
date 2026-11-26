import { expect, type Page } from '@playwright/test'

/** Inspect the active KAG game and click its actual rendered link rectangles. */
export function kagGameControls(page: Page, observations: unknown[], options: { firstReadTimeout?: number } = {}) {
  let sequence = 0
  const canvas = page.locator('#stage canvas[data-window-id]')
  const read = async (expression: string) => {
    const prefix = `kag-game-read-${++sequence}:`
    await expect(page.locator('#evaluate')).toBeEnabled()
    await page.evaluate((source) => {
      const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
      if (button.disabled) throw new Error('Game observer is unavailable')
      input.focus({ preventScroll: true }); input.value = source; button.click()
    }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
    const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
    await expect(line).toBeVisible({ timeout: sequence === 1 ? options.firstReadTimeout ?? 5000 : 5000 })
    const value = ((await line.textContent()) ?? '').slice(prefix.length)
    if (observations.length < 160) observations.push({ expression, value })
    return value
  }
  const clickLink = async (index: number, target: string) => {
    const fields = (await read(`(function(){var m=kag.current,l=m.links[${index}];
      var x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
      if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
      for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
      return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock)].join("|");})()`)).split('|')
    expect(fields).toHaveLength(6); expect(fields[4]).toBe(target); expect(fields[5]).toBe('0')
    const [x, y, width, height] = fields.slice(0, 4).map(Number)
    expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
    expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
    expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
    await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
    const box = await canvas.boundingBox(); expect(box).not.toBeNull()
    observations.push({ click: target, x, y, box })
    await canvas.click({ position: { x: x! * box!.width / 640, y: y! * box!.height / 480 }, timeout: 5000 })
  }
  return { read, clickLink }
}
