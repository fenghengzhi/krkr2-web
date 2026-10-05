import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'

export interface GeometryRect { x: number; y: number; width: number; height: number }
interface GeometryEvidence {
  revision: number
  surfaceEpoch: number
  platform: string
  outer: GeometryRect
  client: GeometryRect
  inner: GeometryRect
  viewport: GeometryRect
  paintBox: GeometryRect
  actualZoom: { numer: number; denom: number }
  scrollbars: { horizontal: number; vertical: number }
  scroll: { x: number; y: number; maxX: number; maxY: number }
}
interface GeometryTrace {
  replies: Array<{ windowId: number; geometry: GeometryEvidence }>
  scrolls: Array<{ windowId: number; x: number; y: number; sequence: number }>
}
type ObservedWindow = Window & { __geometryTrace: GeometryTrace }

/** Passive copies of the real host channel, never substituted replies. DOM
 * measurements and fixture pixels below independently check these outputs. */
export async function observeWindowGeometry(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const trace: GeometryTrace = { replies: [], scrolls: [] }, native = MessagePort.prototype.postMessage
    ;(window as unknown as ObservedWindow).__geometryTrace = trace
    MessagePort.prototype.postMessage = function(this: MessagePort, ...args: unknown[]) {
      const result = Reflect.apply(native, this, args), data = args[0] as {
        type?: string; ok?: boolean; windowId?: number; geometry?: GeometryEvidence
        observation?: GeometryTrace['scrolls'][number]
      } | undefined
      if (data?.type === 'reply' && data.ok && data.geometry?.outer && data.geometry.paintBox && data.windowId) {
        trace.replies.push({ windowId: data.windowId, geometry: structuredClone(data.geometry) })
        if (trace.replies.length > 256) trace.replies.shift()
      } else if (data?.type === 'scroll' && data.observation?.windowId) {
        trace.scrolls.push(structuredClone(data.observation))
        if (trace.scrolls.length > 256) trace.scrolls.shift()
      }
      return result
    }
  })
}

export async function readWindowGeometry(surface: Locator) {
  await expect(surface).toHaveClass(/game-window-measured/)
  await expect.poll(() => surface.evaluate((element) => {
    const trace = (window as unknown as ObservedWindow).__geometryTrace,
      last = trace.replies.filter((item) => item.windowId === Number(element.getAttribute('data-window-id'))).at(-1)
    return last?.geometry.revision === Number(element.getAttribute('data-geometry-revision'))
  })).toBe(true)
  return surface.evaluate((element) => {
    const outer = element as HTMLElement, bounds = outer.getBoundingClientRect(),
      scaleX = bounds.width / outer.offsetWidth, scaleY = bounds.height / outer.offsetHeight,
      rectangle = (node: Element): GeometryRect => {
        const box = node.getBoundingClientRect()
        return { x: (box.x - bounds.x) / scaleX, y: (box.y - bounds.y) / scaleY,
          width: box.width / scaleX, height: box.height / scaleY }
      }, body = outer.querySelector<HTMLElement>('.game-window-body')!,
      scroll = outer.querySelector<HTMLElement>('.game-window-scrollbox')!,
      header = outer.querySelector<HTMLElement>('.game-window-header')!,
      menu = outer.querySelector<HTMLElement>('.game-window-menu')!,
      canvas = outer.querySelector<HTMLCanvasElement>('canvas[data-window-id]')!,
      style = getComputedStyle(outer), trace = (window as unknown as ObservedWindow).__geometryTrace,
      id = Number(outer.dataset.windowId), reply = trace.replies.filter((item) => item.windowId === id).at(-1)!
    return {
      geometry: reply.geometry, fullScreen: outer.classList.contains('game-window-fullscreen'),
      scaleX, scaleY, outer: { x: 0, y: 0, width: outer.offsetWidth, height: outer.offsetHeight },
      body: rectangle(body), scrollbox: rectangle(scroll), canvas: rectangle(canvas),
      backing: { width: canvas.width, height: canvas.height },
      border: { left: parseFloat(style.borderLeftWidth), right: parseFloat(style.borderRightWidth),
        top: parseFloat(style.borderTopWidth), bottom: parseFloat(style.borderBottomWidth) },
      headerHeight: header.offsetHeight, menuHeight: menu.hidden ? 0 : menu.offsetHeight,
      menuRows: new Set([...menu.querySelectorAll('.game-menu-group > *')].map((node) => node.getBoundingClientRect().top)).size,
      scroll: { x: scroll.scrollLeft, y: scroll.scrollTop, clientWidth: scroll.clientWidth,
        clientHeight: scroll.clientHeight, width: scroll.scrollWidth, height: scroll.scrollHeight },
      viewport: { width: innerWidth, height: innerHeight },
      scrollEvents: trace.scrolls.filter((item) => item.windowId === id),
    }
  })
}
export type GeometryReading = Awaited<ReturnType<typeof readWindowGeometry>>
export function expectGeometryRect(actual: GeometryRect, expected: GeometryRect): void {
  for (const field of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(actual[field] - expected[field]), field).toBeLessThanOrEqual(0.51)
}

/** The browser's actual border/header/menu and scrollbar extents form the
 * oracle. No Window geometry function or CSS left/top assignment is reused. */
export function expectWindowedGeometry(reading: GeometryReading, sunken: boolean): void {
  expect(reading.fullScreen).toBe(false)
  expect(reading.geometry.platform).toBe('dom')
  expect(reading.geometry.surfaceEpoch).toBeGreaterThan(0)
  const { outer, border } = reading,
    client = { x: border.left, y: border.top + reading.headerHeight + reading.menuHeight,
      width: outer.width - border.left - border.right,
      height: outer.height - border.top - border.bottom - reading.headerHeight - reading.menuHeight },
    inset = sunken ? 2 : 0,
    inner = { x: client.x + inset, y: client.y + inset,
      width: client.width - 2 * inset, height: client.height - 2 * inset },
    viewport = { x: inner.x, y: inner.y, width: reading.scroll.clientWidth, height: reading.scroll.clientHeight }
  expectGeometryRect(reading.geometry.outer, outer)
  expectGeometryRect(reading.geometry.client, client)
  expectGeometryRect(reading.geometry.inner, inner)
  expectGeometryRect(reading.geometry.viewport, viewport)
  expectGeometryRect(reading.body, client)
  expectGeometryRect(reading.scrollbox, inner)
  expectGeometryRect(reading.canvas, viewport)
  expect(reading.backing).toEqual({ width: viewport.width, height: viewport.height })
  expect(reading.geometry.scrollbars).toEqual({ horizontal: inner.height - reading.scroll.clientHeight,
    vertical: inner.width - reading.scroll.clientWidth })
  expect(reading.geometry.scroll.maxX).toBe(reading.scroll.width - reading.scroll.clientWidth)
  expect(reading.geometry.scroll.maxY).toBe(reading.scroll.height - reading.scroll.clientHeight)
  expect(Math.abs(reading.scaleX - reading.scaleY)).toBeLessThan(0.001)
}

export async function clickViewport(page: Page, surface: Locator, x: number, y: number): Promise<void> {
  const canvas = surface.locator('canvas[data-window-id]')
  await canvas.scrollIntoViewIfNeeded()
  const point = await canvas.evaluate((node, point) => {
    const canvas = node as HTMLCanvasElement, box = canvas.getBoundingClientRect()
    return { x: box.x + (point.x + 0.25) * box.width / canvas.width,
      y: box.y + (point.y + 0.25) * box.height / canvas.height }
  }, { x, y })
  await page.mouse.click(point.x, point.y)
}

/** Sample a screenshot of the actual presented canvas, not another renderer. */
export async function geometryPixel(page: Page, surface: Locator, x: number, y: number): Promise<number[]> {
  const canvas = surface.locator('canvas[data-window-id]'), png = await canvas.screenshot(),
    size = await canvas.evaluate((node) => ({ width: (node as HTMLCanvasElement).width, height: (node as HTMLCanvasElement).height }))
  return page.evaluate(async ({ url, x, y, size }) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
      context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    try {
      context.drawImage(bitmap, 0, 0)
      return [...context.getImageData(Math.floor(x * bitmap.width / size.width), Math.floor(y * bitmap.height / size.height), 1, 1).data]
    } finally { bitmap.close() }
  }, { url: 'data:image/png;base64,' + png.toString('base64'), x, y, size })
}

export async function finishGeometry(page: Page, info: TestInfo, stop: () => Promise<void>,
  records: unknown[], failures: unknown[]): Promise<void> {
  try { await info.attach('window-five-rectangles', { contentType: 'application/json', body: JSON.stringify({
    records, trace: await page.evaluate(() => (window as unknown as ObservedWindow).__geometryTrace),
    logs: await page.locator('#logs').innerText(),
  }, null, 2) }) } catch (error) { failures.push(error) }
  try {
    const exit = page.getByRole('button', { name: '退出全屏', exact: true })
    if (await exit.count()) await exit.first().click()
  } catch (error) { failures.push(error) }
  try {
    await stop()
    await expect(page.locator('.game-window-measure,.game-window-scrollbox,.game-window-content')).toHaveCount(0)
    await expect.poll(() => page.workers().filter((worker) => worker.url().includes('/assets/session.worker-')).length).toBe(0)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Window geometry and cleanup failed', { cause: failures[0] })
}

/** Also usable if startup fails before launchWindowAttention returns. */
export async function stopGeometryPage(page: Page): Promise<void> {
  if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
  await expect(page.locator('#status')).toHaveText('待机')
  await expect(page.locator('.game-window[data-window-id],.game-text-input')).toHaveCount(0)
}
