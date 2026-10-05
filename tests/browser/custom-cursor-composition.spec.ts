import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { animatedCursor, cursorDib, cursorFile } from '../helpers/cursor-fixtures.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { gpuWorker, injectGpu, loseGpu, restoreGpu } from '../helpers/gpu-browser.ts'

// Four adjacent native AND/XOR operations: black, white, destination, inverse.
const monochrome = cursorFile([{ width: 8, height: 4, hotspot: [2, 1], payload: cursorDib({
  width: 8, height: 4, depth: 1, palette: [[0, 0, 0], [255, 255, 255]],
  xorRows: [[0x33], [0x33], [0x33], [0x33]],
  andRows: [[0x0f], [0x0f], [0x0f], [0x0f]],
}) }])
const coloredXor = cursorFile([{ width: 8, height: 4, hotspot: [2, 1], payload: cursorDib({
  width: 8, height: 4, depth: 24,
  xorRows: Array.from({ length: 4 }, () => Array.from({ length: 8 }, () => [0xf0, 0xaa, 0x55]).flat()),
  andRows: [[0xff], [0xff], [0xff], [0xff]],
}) }])
function solid(color: readonly [number, number, number], hotspot: readonly [number, number]) {
  return cursorFile([{ width: 8, height: 4, hotspot, payload: cursorDib({
    width: 8, height: 4, depth: 24,
    xorRows: Array.from({ length: 4 }, () => Array.from({ length: 8 }, () =>
      [color[2], color[1], color[0]]).flat()),
  }) }])
}
const animationColors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]] as const,
  animationHotspots = [[0, 0], [7, 3], [2, 1]] as const,
  animationSequence = [2, 0, 2, 1],
  animation = animatedCursor(animationColors.map((color, index) => solid(color, animationHotspots[index]!)), {
    sequence: animationSequence, rates: [6, 3, 9, 12],
  })
const directoryImages = [
  { size: 16, color: [255, 0, 255], hotspot: [4, 4] },
  { size: 32, color: [150, 60, 190], hotspot: [11, 9] },
  { size: 64, color: [0, 255, 255], hotspot: [16, 16] },
].map(({ size, color, hotspot }) => ({ width: size, height: size,
  hotspot: hotspot as [number, number], payload: cursorDib({ width: size, height: size, depth: 24,
    xorRows: Array.from({ length: size }, () => Array.from({ length: size }, () =>
      [color[2]!, color[1]!, color[0]!]).flat()),
  }) }))
const source = String.raw`
System.exitOnWindowClose=false;
var cursorWindow=new Window();cursorWindow.caption="Custom cursor";cursorWindow.setInnerSize(200,120);cursorWindow.visible=true;
var cursorRoot=new Layer(cursorWindow,null);cursorRoot.type=ltOpaque;cursorRoot.setSize(200,120);cursorRoot.fillRect(0,0,200,120,0xff123456);
cursorRoot.focusable=true;cursorRoot.focus();cursorRoot.cursor="mono.cur";
cursorRoot.onKeyDown=function(key,shift,process){if(key==117)global.cursorRoot.setCursorPos(60,50);};
var cursorMovie=new VideoOverlay(cursorWindow);cursorMovie.mode=vomMixer;cursorMovie.setBounds(20,20,160,80);cursorMovie.visible=false;cursorMovie.open("colors.mp4");
var cursorMixParent=new Layer(cursorWindow,cursorRoot);cursorMixParent.visible=false;
var cursorMix=new Layer(cursorWindow,cursorMixParent);cursorMix.setSize(160,80);cursorMix.setImageSize(160,80);cursorMix.fillRect(0,0,160,80,0xff00ffff);cursorMix.opacity=64;cursorMix.visible=true;
cursorRoot.setCursorPos(60,50);
`

async function pixels(marker: Locator): Promise<number[][]> {
  return marker.evaluate((node) => {
    const canvas = node as HTMLCanvasElement, context = canvas.getContext('2d')!
    return [2, 10, 18, 26].map((x) => [...context.getImageData(x, 8, 1, 1).data])
  })
}
async function hotspot(surface: Locator, x: number, y: number, hx = 8, hy = 8) {
  await expect.poll(() => surface.evaluate((element, point) => {
    const canvas = element.querySelector<HTMLCanvasElement>('canvas[data-window-id]')!,
      marker = element.querySelector<HTMLCanvasElement>('.game-custom-cursor')
    if (!marker) return Infinity
    const c = canvas.getBoundingClientRect(), m = marker.getBoundingClientRect()
    return Math.max(Math.abs(m.left + point.hx - c.left - point.x * c.width / 200),
      Math.abs(m.top + point.hy - c.top - point.y * c.height / 120))
  }, { x, y, hx, hy })).toBeLessThanOrEqual(0.6)
}
async function screenshotPixels(page: Page, png: Buffer, points: { x: number; y: number }[]) {
  return page.evaluate(async ({ data, points }) => {
    const bitmap = await createImageBitmap(await (await fetch(data)).blob()),
      context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    try {
      context.drawImage(bitmap, 0, 0)
      return points.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data])
    } finally { bitmap.close() }
  }, { data: 'data:image/png;base64,' + png.toString('base64'), points })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: custom CUR and full ANI compose the committed canvas and real video background`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await injectGpu(page)
    const game = await launchWindowAttention(page, backend, binary, source, [
      { name: 'mono.cur', mimeType: 'application/octet-stream', buffer: monochrome },
      { name: 'full.ani', mimeType: 'application/octet-stream', buffer: animation },
      { name: 'colored.cur', mimeType: 'application/octet-stream', buffer: coloredXor },
      { name: 'directory.cur', mimeType: 'application/octet-stream', buffer: cursorFile(directoryImages) },
      { name: 'reverse.cur', mimeType: 'application/octet-stream', buffer: cursorFile([...directoryImages].reverse()) },
      { name: 'colors.mp4', mimeType: 'video/mp4', buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)) },
    ]), surface = game.surface('Custom cursor'), marker = surface.locator('.game-custom-cursor'),
      canvas = surface.locator('canvas[data-window-id]'), primary: unknown[] = []
    try {
      await expect(marker).toBeVisible()
      await expect(marker).toHaveClass(/game-virtual-cursor/)
      await expect(marker).toHaveCSS('pointer-events', 'none')
      await expect(canvas).toHaveCSS('cursor', 'none')
      await expect(marker).toHaveAttribute('width', '32')
      await expect(marker).toHaveAttribute('height', '32')
      await hotspot(surface, 60, 50)
      await expect.poll(() => pixels(marker)).toEqual([
        [0, 0, 0, 255], [255, 255, 255, 255], [18, 52, 86, 255], [237, 203, 169, 255],
      ])
      // Samples below are CSS-pixel coordinates. Device-scale screenshots on
      // macOS can be 64x64 for this 32x32 marker, addressing different stripes.
      const committed = await marker.screenshot({ scale: 'css' })
      await info.attach('committed-canvas-and-xor', { body: committed, contentType: 'image/png' })
      await info.attach('committed-canvas-geometry', { contentType: 'application/json',
        body: JSON.stringify(await marker.evaluate((node) => {
          const marker = node as HTMLCanvasElement, rect = marker.getBoundingClientRect()
          return { screenshotScale: 'css', devicePixelRatio,
            bitmap: { width: marker.width, height: marker.height },
            rectangle: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
        })) })
      expect(await screenshotPixels(page, committed, [{ x: 18, y: 8 }, { x: 26, y: 8 }]))
        .toEqual([[18, 52, 86, 255], [237, 203, 169, 255]])

      // The same static CUR must resample a newly committed game frame.
      await evaluate(page, '(cursorRoot.fillRect(0,0,200,120,0xff2468ac),cursorRoot.setCursorPos(60,50),0)', '0')
      await expect.poll(() => pixels(marker)).toEqual([
        [0, 0, 0, 255], [255, 255, 255, 255], [36, 104, 172, 255], [219, 151, 83, 255],
      ])
      await canvas.scrollIntoViewIfNeeded()
      const box = (await canvas.boundingBox())!, requested = {
        x: box.x + box.width * 80 / 200, y: box.y + box.height * 70 / 120,
      }
      // Observe the browser's actual input coordinates independently of the
      // presenter. MouseEvent may quantize a fractional automation request;
      // its client point, rather than that request, is the physical hotspot.
      await canvas.evaluate((node) => {
        node.addEventListener('mousemove', (event) => {
          const mouse = event as MouseEvent, target = node as HTMLCanvasElement,
            rect = target.getBoundingClientRect()
          target.dataset.cursorObservedMouse = JSON.stringify({
            x: mouse.clientX, y: mouse.clientY, trusted: mouse.isTrusted,
            timeStamp: mouse.timeStamp, devicePixelRatio, scrollX, scrollY,
            rectangle: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          })
        }, { once: true, capture: true, passive: true })
      })
      await page.mouse.move(requested.x, requested.y)
      const observedMouse = await canvas.evaluate((node) => {
        const value = (node as HTMLElement).dataset.cursorObservedMouse
        delete (node as HTMLElement).dataset.cursorObservedMouse
        if (!value) throw new Error('The requested physical move did not reach the canvas')
        return JSON.parse(value) as { x: number; y: number; trusted: boolean; timeStamp: number;
          devicePixelRatio: number; scrollX: number; scrollY: number;
          rectangle: { left: number; top: number; width: number; height: number } }
      })
      await expect(marker).not.toHaveClass(/game-virtual-cursor/)
      await info.attach('physical-cursor-observation', { contentType: 'application/json',
        body: JSON.stringify({ requested, observedMouse, marker: await marker.evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        }) }) })
      expect(observedMouse.trusted).toBe(true)
      await expect.poll(() => marker.evaluate((node, point) => {
        const rect = node.getBoundingClientRect()
        return Math.max(Math.abs(rect.left + 8 - point.x), Math.abs(rect.top + 8 - point.y))
      }, observedMouse)).toBeLessThanOrEqual(0.6)
      expect(await marker.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return document.elementFromPoint(rect.left + 2, rect.top + 1)?.matches('canvas[data-window-id]')
      })).toBe(true)
      await evaluate(page, '(cursorRoot.cursor="colored.cur",cursorRoot.setCursorPos(60,50),0)', '0')
      await expect.poll(() => pixels(marker)).toEqual(Array.from({ length: 4 }, () => [113, 194, 92, 255]))
      await evaluate(page, '(cursorWindow.setZoom(3,2),cursorWindow.setLayerPos(7,11),cursorRoot.setCursorPos(10,12),0)', '0')
      await hotspot(surface, 26, 35)
      await evaluate(page, '(cursorWindow.setZoom(1,1),cursorWindow.setLayerPos(0,0),cursorRoot.setCursorPos(60,50),0)', '0')

      // All repeated and nonuniform ANI steps remain observable; no first-frame fallback.
      await evaluate(page, '(cursorRoot.cursor="full.ani",cursorRoot.setCursorPos(60,50),0)', '0')
      await expect(marker).toHaveAttribute('data-cursor-id', '4')
      const observed = await marker.evaluate(async (node) => {
        const cursor = node as HTMLCanvasElement, canvas = cursor.closest('.game-window')!
          .querySelector<HTMLCanvasElement>('canvas[data-window-id]')!, records: {
            step: number; color: number[]; hotspot: number[]; time: number
          }[] = [], seen = new Set<number>(), start = performance.now()
        while (seen.size < 4 && performance.now() - start < 6000) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const step = Number(cursor.dataset.cursorStep)
          if (!seen.has(step)) {
            seen.add(step)
            const bounds = canvas.getBoundingClientRect(), rect = cursor.getBoundingClientRect()
            records.push({ step, color: [...cursor.getContext('2d')!.getImageData(0, 0, 1, 1).data],
              hotspot: [bounds.left + bounds.width * 60 / 200 - rect.left,
                bounds.top + bounds.height * 50 / 120 - rect.top], time: performance.now() - start })
          }
        }
        return records
      })
      await info.attach('complete-ani-timeline', { body: JSON.stringify(observed), contentType: 'application/json' })
      expect(observed.map((entry) => entry.step).sort()).toEqual([0, 1, 2, 3])
      for (const entry of observed) {
        const frame = animationSequence[entry.step]!
        expect(entry.color).toEqual([...animationColors[frame]!, 255])
        for (let axis = 0; axis < 2; axis++)
          expect(Math.abs(entry.hotspot[axis]! - animationHotspots[frame]![axis]! * [4, 8][axis]!)).toBeLessThanOrEqual(0.6)
      }

      // File loading selects the exact native size independently of directory
      // order. Both deliberately wrong alternatives must remain unpresented.
      for (const name of ['directory.cur', 'reverse.cur']) {
        await evaluate(page, `(cursorRoot.cursor="${name}",cursorRoot.setCursorPos(60,50),0)`, '0')
        await expect.poll(() => pixels(marker)).toEqual(Array.from({ length: 4 }, () => [150, 60, 190, 255]))
        await hotspot(surface, 60, 50, 11, 9)
        await expect(marker).toHaveAttribute('width', '32')
        await expect(marker).toHaveAttribute('height', '32')
      }

      // Compare to actual DOM composition with the cursor hidden. This covers
      // a decoded colored movie, its opaque backing and translucent mixing bitmap.
      await evaluate(page, '(cursorRoot.cursor=crNone,cursorMovie.visible=true,cursorMovie.mixingMovieAlpha=0.5,cursorMovie.mixingMovieBGColor=0x00ff00,cursorMovie.setMixingLayer(cursorMix),0)', '0')
      await expect(marker).toHaveCount(0)
      await expect.poll(() => surface.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState))
        .toBeGreaterThanOrEqual(2)
      await expect(surface.locator('.video-mixing-bitmap')).toBeVisible()
      await canvas.scrollIntoViewIfNeeded()
      const before = (await canvas.boundingBox())!,
        clip = { x: Math.round(before.x + before.width * 60 / 200 - 8),
          y: Math.round(before.y + before.height * 50 / 120 - 8), width: 32, height: 32 },
        background = await page.screenshot({ clip, scale: 'css' }),
        backdrop = await screenshotPixels(page, background, [{ x: 18, y: 8 }, { x: 26, y: 8 }])
      await info.attach('actual-video-backdrop', { body: background, contentType: 'image/png' })
      await evaluate(page, '(cursorRoot.cursor="mono.cur",cursorRoot.setCursorPos(60,50),0)', '0')
      await expect(marker).toBeVisible()
      await expect.poll(async () => {
        const current = await pixels(marker)
        return Math.max(...[0, 1, 2].flatMap((channel) => [
          Math.abs(current[2]![channel]! - backdrop[0]![channel]!),
          Math.abs(current[3]![channel]! - (255 - backdrop[1]![channel]!)),
        ]))
      }).toBeLessThanOrEqual(3)
      await info.attach('actual-video-and-xor', { body: await marker.screenshot({ scale: 'css' }), contentType: 'image/png' })

      // Pause/hidden/leave must consume the virtual position; resume does not
      // resurrect it. A new script write or real mouse sample can present again.
      await page.locator('#pause').click()
      await expect(marker).toHaveCount(0)
      await page.locator('#pause').click()
      await expect(marker).toHaveCount(0)
      await evaluate(page, '(cursorWindow.visible=false,0)', '0')
      await evaluate(page, '(cursorWindow.visible=true,0)', '0')
      await expect(marker).toHaveCount(0)
      await evaluate(page, '(cursorRoot.setCursorPos(60,50),0)', '0')
      await expect(marker).toBeVisible()
      const worker = await gpuWorker(page)
      await loseGpu(worker)
      await expect(page.locator('#status')).toHaveText('等待画面恢复')
      await expect(marker).toHaveCount(0)
      await restoreGpu(worker)
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(marker).toHaveCount(0)
      await evaluate(page, '(cursorRoot.setCursorPos(60,50),0)', '0')
      await expect(marker).toBeVisible()
      const current = (await canvas.boundingBox())!
      await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2)
      await page.mouse.move(2, 2)
      await expect(marker).toHaveCount(0)
      await evaluate(page, '(cursorRoot.setCursorPos(60,50),0)', '0')
      await expect(marker).toBeVisible()
    } catch (error) { primary.push(error); throw error }
    finally {
      try {
        await game.stop()
        await expect(page.locator('.game-custom-cursor')).toHaveCount(0)
      } catch (error) {
        if (primary.length) throw new AggregateError([...primary, error], 'Custom cursor and cleanup failed')
        throw error
      }
    }
  })
