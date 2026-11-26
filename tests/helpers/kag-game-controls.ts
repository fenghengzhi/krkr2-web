import { expect, type Page } from '@playwright/test'

/** Read the rendered link rectangle without changing selection or calling a game handler. */
export async function kagGameLinkPoint(read: (expression: string) => Promise<string>, index: number, target: string) {
  const geometry = `(function(){var m=kag.current,l=m.links[${index}];
      if(l===void || l===null)return "";
      var x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1),root=m;
      if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
      for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;root=p;}
      return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock),root.width,root.height,int(m.selClickLock)].join("|");})()`
  // Registering the hyperlink and painting its first text run occur on
  // different KAG steps. Click only the measured rectangle of this target.
  let fields: string[] = []
  await expect.poll(async () => {
    fields = (await read(geometry)).split('|')
    return [fields[4], fields[5], Number(fields[2]) > 0, Number(fields[3]) > 0]
  }, { message: `Wait for the rendered link ${target}` }).toEqual([target, '0', true, true])
  expect(fields).toHaveLength(9)
  expect(fields[4]).toBe(target)
  expect(fields[5]).toBe('0')
  const x = Number(fields[0]), y = Number(fields[1]), width = Number(fields[2]), height = Number(fields[3]),
    primaryWidth = Number(fields[6]), primaryHeight = Number(fields[7])
  expect(primaryWidth).toBeGreaterThan(0); expect(primaryHeight).toBeGreaterThan(0)
  expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
  expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(primaryWidth)
  expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(primaryHeight)
  return { x, y, width, height, primaryWidth, primaryHeight, locked: fields[8] }
}

/** A real pointer approach is required by stock MessageLayer.selClickLock.
 * endHyperLink locks newly drawn choices until the pointer moves more than
 * three layer pixels. Approach from another point in the visible primary,
 * preserving that protection when successive pages reuse a link's position. */
export function kagGameLinkClick(page: Page, read: (expression: string) => Promise<string>, observations: unknown[]) {
  const canvas = page.locator('#stage canvas[data-window-id]')
  return async (index: number, target: string) => {
    const { x, y, width, height, primaryWidth, primaryHeight, locked } = await kagGameLinkPoint(read, index, target)
    const approach = x >= 8 ? { x: x - 8, y: y }
      : x + 8 < primaryWidth ? { x: x + 8, y: y }
        : y >= 8 ? { x: x, y: y - 8 }
          : { x: x, y: Math.min(y + 8, primaryHeight - 1) }
    await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Game canvas has no visible bounds')
    observations.push({ click: target, x, y, width, height, primary: [primaryWidth, primaryHeight],
      lockedBeforeApproach: locked, approach, box })
    await canvas.hover({ position: { x: approach.x * box.width / primaryWidth, y: approach.y * box.height / primaryHeight }, timeout: 5000 })
    await canvas.hover({ position: { x: x * box.width / primaryWidth, y: y * box.height / primaryHeight }, timeout: 5000 })
    // findLink only reads the original province maps; it cannot clear the
    // click lock. Require the approached point to select this very link.
    await expect.poll(() => read(`(function(){var m=kag.current,l=m.links[${index}],
      x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
      if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
      return [int(m.selClickLock),m.findLink(x,y),l.target].join("|");})()`), { timeout: 5000 }).toBe(`0|${index}|${target}`)
    const currentBox = await canvas.boundingBox()
    if (!currentBox) throw new Error('Game canvas has no visible bounds after hover')
    await canvas.click({ position: { x: x * currentBox.width / primaryWidth, y: y * currentBox.height / primaryHeight }, timeout: 5000 })
  }
}

/** Inspect the active KAG game and click its actual rendered link rectangles. */
export function kagGameControls(page: Page, observations: unknown[], options: { firstReadTimeout?: number } = {}) {
  let sequence = 0
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
  const clickLink = kagGameLinkClick(page, read, observations)
  return { read, clickLink }
}
