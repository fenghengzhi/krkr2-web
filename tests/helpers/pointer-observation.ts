import { expect, type Page } from '@playwright/test'

export interface CanvasPointerObservation {
  type: 'mousemove' | 'mouseleave'
  windowId: number
  trusted: boolean
  visibility: DocumentVisibilityState
  clientX: number
  clientY: number
  x: number
  y: number
  width: number
  height: number
}
declare global { interface Window {
  canvasPointerProof: { events: CanvasPointerObservation[]; overflow: number }
} }

/** Passive DOM evidence, including the real departure sample. No game input
 * is generated and no production projection helper supplies the oracle. */
export async function observeCanvasPointers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.canvasPointerProof = { events: [], overflow: 0 }
    for (const type of ['mousemove', 'mouseleave'] as const)
      window.addEventListener(type, (event) => {
        const canvas = event.target
        if (!(canvas instanceof HTMLCanvasElement) || !canvas.dataset.windowId) return
        const box = canvas.getBoundingClientRect()
        if (!box.width || !box.height) return
        const proof = window.canvasPointerProof
        if (proof.events.length >= 512) { proof.overflow++; return }
        proof.events.push({ type, windowId: Number(canvas.dataset.windowId), trusted: event.isTrusted,
          visibility: document.visibilityState,
          clientX: event.clientX, clientY: event.clientY,
          x: (event.clientX - box.left) * canvas.width / box.width,
          y: (event.clientY - box.top) * canvas.height / box.height,
          width: canvas.width, height: canvas.height })
      }, { capture: true, passive: true })
  })
}

let sequence = 0
/** Submit through the actual console UI without moving the physical pointer.
 * This programmatic button activation is only a query/control mechanism, not
 * evidence of physical game input. Pre-focusing with preventScroll also keeps
 * app.ts's normal console focus from moving the canvas under the pointer. */
export async function evaluateAtPointer(page: Page, expression: string, result: string): Promise<void> {
  const marker = `pointer-result-${++sequence}:`,
    value = /[\r\n]/.test(expression) ? `Scripts.eval(${JSON.stringify(expression)})` : expression,
    source = `${JSON.stringify(marker)}+string(${value})`
  await expect(page.locator('#evaluate')).toBeEnabled()
  const before = await page.evaluate((source) => {
    const input = document.querySelector<HTMLInputElement>('#expression')!,
      button = document.querySelector<HTMLButtonElement>('#evaluate')!,
      layout = { x: scrollX, y: scrollY, canvases: [...document.querySelectorAll<HTMLCanvasElement>('#stage canvas')]
        .map((canvas) => ({ id: canvas.dataset.windowId, box: canvas.getBoundingClientRect().toJSON(),
          width: canvas.width, height: canvas.height })) }
    if (button.disabled) throw new Error('Pointer query console is not ready')
    input.focus({ preventScroll: true })
    input.value = source
    button.click()
    return layout
  }, source)
  await expect(page.getByText(marker + result, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY,
    canvases: [...document.querySelectorAll<HTMLCanvasElement>('#stage canvas')]
      .map((canvas) => ({ id: canvas.dataset.windowId, box: canvas.getBoundingClientRect().toJSON(),
        width: canvas.width, height: canvas.height })) })),
  'A pointer-state query must not scroll or move the measured canvases').toEqual(before)
}
