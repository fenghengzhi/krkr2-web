import { BrowserInputCoordinator } from '../../src/backends/input/coordinator.ts'
import { selectCursorAsset, type CursorScene } from '../../src/backends/input/cursor.ts'
import type { CursorAsset, CursorImage } from '../../src/formats/cursor/index.ts'
import { WindowState, type WindowView } from '../../src/engine/scene/window.ts'
import type { InputPacket, InputView } from '../../src/engine/ports/input.ts'

/** This lower-level fixture explicitly selects the second image. It tests the
 * presentation API, not an asserted Windows multi-image selection policy. */
export function createCursorCompositionFixture() {
  const image = (color: number, mask: number): CursorImage => ({
    width: 8, height: 8, hotspot: { x: 3, y: 2 }, depth: 24, encoding: 'dib', mode: 'and-xor',
    data: new Uint8Array(Array.from({ length: 64 }, () =>
      [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, 255]).flat()),
    andMask: new Uint8Array(64).fill(mask),
  }), wrong = image(0xff0000, 0), chosen = image(0xffffff, 255),
    source: CursorAsset = { kind: 'cur', frames: [{ images: [wrong, chosen] }],
      sequence: [0], rates: [1], durationJiffies: 1, sourceBytes: 1, decodedBytes: 640, imageCount: 2 },
    selected = selectCursorAsset(source, () => 1), outside = image(0xffffff, 255),
    assets = new Map([[2, selected]]),
    errors: string[] = [], packets: InputPacket[] = [],
    pointers: { windowId: number; x: number; y: number; sequence?: number }[] = [],
    observed: { windowId: number; x: number; y: number }[] = [], abort = new AbortController(),
    surfaces = new Map<number, {
      epoch: number; root: HTMLDivElement; canvas: HTMLCanvasElement; plane: HTMLDivElement;
      view: WindowView; background?: string
    }>()
  // Selection owns the pixels before any future asynchronous presentation.
  chosen.data.fill(0)
  chosen.andMask.fill(0)
  outside.hotspot = { x: 11, y: 13 }
  assets.set(3, selectCursorAsset({ ...source, frames: [{ images: [outside] }],
    imageCount: 1, decodedBytes: 320 }, () => 0))
  window.addEventListener('mousemove', (event) => {
    if (!(event.target instanceof HTMLCanvasElement)) return
    const id = Number(event.target.id.match(/^cursor-surface-(\d+)$/)?.[1])
    if (id) observed.push({ windowId: id, x: event.clientX, y: event.clientY })
  }, { capture: true, passive: true, signal: abort.signal })
  const input = new BrowserInputCoordinator(async (packet) => { packets.push(packet) }, async () => {},
    (x, y, windowId, sequence) => { pointers.push({ x, y, windowId, sequence }) },
    (error) => errors.push(String(error)), {
      cursor: {
        resolve: (id) => assets.get(id),
        scene: (id, epoch): CursorScene | undefined => {
          const surface = surfaces.get(id)
          return surface?.epoch === epoch
            ? { plane: surface.plane, layers: [], background: surface.background } : undefined
        },
      },
    })
  function state(virtualCursor: InputView['virtualCursor'] = null): InputView {
    return { cursor: 2, hint: '', focused: 0, attention: null, attentionX: 0, attentionY: 0,
      imeMode: 0, virtualCursor }
  }
  function attach(id: number, epoch: number, opaque: boolean) {
    const root = document.createElement('div'), canvas = document.createElement('canvas'),
      plane = document.createElement('div'), view = Object.assign(new WindowState(), {
        width: 64, height: 48, visible: true,
      })
    root.id = `cursor-host-${id}`
    root.style.cssText = `position:absolute;left:${32 + (id - 1) * 192}px;top:32px;width:128px;height:96px`
    canvas.id = `cursor-surface-${id}`
    canvas.width = 64
    canvas.height = 48
    canvas.style.cssText = 'display:block;width:128px;height:96px'
    plane.className = 'cursor-host-plane'
    plane.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2'
    root.append(canvas, plane)
    document.body.append(root)
    surfaces.set(id, { epoch, root, canvas, plane, view })
    if (opaque) {
      canvas.getContext('2d')!.fillStyle = '#123456'
      canvas.getContext('2d')!.fillRect(0, 0, 64, 48)
    }
    input.setWindow(id, view)
    input.attach(id, epoch, canvas, root)
    input.setInput(id, state())
  }
  attach(1, 1, false)
  attach(2, 1, true)
  return {
    write(id: number, revision: number, basePhysicalSequence = 0, x = 24, y = 16) {
      input.setInput(id, state({ x, y, revision, basePhysicalSequence }))
    },
    writeOutside(id: number, revision: number, x = 24, y = 16) {
      input.setInput(id, { ...state({ x, y, revision, basePhysicalSequence: 0 }), cursor: 3 })
    },
    pixelated(id: number) {
      const canvas = surfaces.get(id)!.canvas, context = canvas.getContext('2d')!
      canvas.style.imageRendering = 'pixelated'
      for (let x = 0; x < canvas.width; x++) {
        context.fillStyle = x % 2 ? '#80a0c0' : '#204060'
        context.fillRect(x, 0, 1, canvas.height)
      }
      input.refreshCursors()
    },
    raster(id: number, scale: number, rendering: 'auto' | 'pixelated') {
      // Deliberately bounded CSS-raster observation, independent of a game's
      // cursor decoder or Windows image-size selection policy.
      if (![1.5, 2.25].includes(scale)) throw new Error('Unexpected raster fixture scale')
      const surface = surfaces.get(id)!, canvas = surface.canvas, context = canvas.getContext('2d')!
      surface.root.style.width = canvas.style.width = `${64 * scale}px`
      surface.root.style.height = canvas.style.height = `${48 * scale}px`
      canvas.style.imageRendering = rendering
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          // Both axes carry sharp edges and non-gray channels. Expected output
          // is captured from the real CSS compositor, not computed from these.
          context.fillStyle = (x + y) % 2 ? '#80a0c0' : '#204060'
          context.fillRect(x, y, 1, 1)
        }
      input.refreshCursors()
    },
    paint(id: number, color?: string) {
      const canvas = surfaces.get(id)!.canvas, context = canvas.getContext('2d')!
      context.clearRect(0, 0, canvas.width, canvas.height)
      if (color) {
        context.fillStyle = color
        context.fillRect(0, 0, canvas.width, canvas.height)
      }
      input.refreshCursors()
    },
    background(id: number, color: string) {
      const surface = surfaces.get(id)!
      surface.background = color
      surface.root.style.backgroundColor = color
      input.refreshCursors()
    },
    suspend(value: boolean) { input.setSuspended(value) },
    hidden(id: number, hidden: boolean) {
      const surface = surfaces.get(id)!
      surface.view = { ...surface.view, visible: !hidden }
      surface.root.hidden = hidden
      input.setWindow(id, surface.view)
    },
    replace(id: number) {
      const old = surfaces.get(id)!
      input.detach(id, old.epoch)
      old.root.remove()
      attach(id, old.epoch + 1, true)
      return old.epoch
    },
    detach(id: number, epoch: number) { input.detach(id, epoch) },
    retireAssets() { assets.clear(); input.refreshCursors() },
    inspect: () => ({ errors: [...errors], packets: [...packets], pointers: [...pointers], observed: [...observed] }),
    close() {
      abort.abort()
      input.close()
      for (const surface of surfaces.values()) surface.root.remove()
      surfaces.clear()
      assets.clear()
    },
  }
}
