import type { Page } from '@playwright/test'
import type { SessionEvent } from '../../src/protocol/session.ts'
import type { InputView } from '../../src/engine/ports/input.ts'

interface MenuCursorProof {
  events: { at: number; source: string; value: unknown }[]
  snapshots: unknown[]
  droppedEvents: number
  droppedSnapshots: number
}
type ObservedWindow = Window & {
  menuCursorProof: MenuCursorProof
  snapshotMenuCursor(phase: string): void
}

/** Observe the real event channel and DOM input without changing delivery,
 * focus, pointer position or menu state. Never start an otherwise idle port. */
export async function observeMenuCursor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof: MenuCursorProof = { events: [], snapshots: [], droppedEvents: 0, droppedSnapshots: 0 },
      latest = new Map<number, InputView>(), NativeChannel = MessageChannel,
      record = (source: string, value: unknown) => {
        if (proof.events.length === 512) { proof.events.shift(); proof.droppedEvents++ }
        proof.events.push({ at: performance.now(), source, value })
      }, label = (target: EventTarget | null) => target === window ? 'window'
        : target instanceof Element ? `${target.tagName.toLowerCase()}#${target.id}.${[...target.classList].join('.')}` : null
    ;(window as unknown as ObservedWindow).menuCursorProof = proof
    window.MessageChannel = class extends NativeChannel {
      constructor() {
        super()
        for (const port of [this.port1, this.port2]) port.addEventListener('message', ({ data }: MessageEvent<SessionEvent>) => {
          if (!Number.isSafeInteger(data?.generation) || !Number.isSafeInteger(data?.sequence)) return
          const identity = { generation: data.generation, sequence: data.sequence }
          if (data.type === 'window-input') {
            const input = structuredClone(data.input)
            latest.set(data.windowId, input)
            record(data.type, { ...identity, windowId: data.windowId, input })
          } else if (data.type === 'windows') record(data.type, { ...identity, windows: data.windows.map(({ id, active, view }) => ({
            id, active, visible: view.visible, blocked: view.blocked, fullScreen: view.fullScreen,
            mouseCursorState: view.mouseCursorState, geometry: structuredClone(view.geometry),
          })) })
          else if (data.type === 'window-menus') record(data.type, { ...identity,
            windows: data.windows.map(({ windowId, menus }) => ({ windowId, popup: structuredClone(menus.popup) })) })
          else if (data.type === 'state') record(data.type, { ...identity, state: data.snapshot.state,
            activity: structuredClone(data.snapshot.activity), graphics: data.snapshot.graphics })
          else if (data.type === 'cursor-asset') record(data.type, { ...identity, id: data.id,
            frames: data.asset.frames.map((frame) => frame.images.map((image) => ({
              width: image.width, height: image.height, hotspot: { ...image.hotspot },
            }))) })
          else if (data.type === 'cursor-assets-clear') record(data.type, identity)
        })
      }
    }
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = new Proxy(post, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args),
          packet = args[0] as { type?: string; argumentList?: { value?: unknown }[] } | undefined,
          method = packet?.argumentList?.[0]?.value
        if (packet?.type === 'APPLY' && typeof method === 'string' &&
          ['pointerState', 'screenPointerState', 'input', 'menuDismiss', 'setActivity'].includes(method))
          record('rpc', { method, arguments: structuredClone(packet.argumentList!.slice(1).map((argument) => argument.value)) })
        return result
      },
    })
    for (const type of ['mousemove', 'mouseleave', 'mouseenter', 'keydown', 'keyup', 'focus', 'blur', 'scroll'])
      window.addEventListener(type, (event) => record('dom', {
        type, target: label(event.target), trusted: event.isTrusted, focused: document.hasFocus(),
        activeElement: label(document.activeElement), visibility: document.visibilityState,
        ...(event instanceof MouseEvent ? { clientX: event.clientX, clientY: event.clientY,
          relatedTarget: label(event.relatedTarget) } : {}),
        ...(event instanceof KeyboardEvent ? { key: event.key, code: event.code } : {}),
      }), { capture: true, passive: true })
    ;(window as unknown as ObservedWindow).snapshotMenuCursor = (phase) => {
      const windows = [...document.querySelectorAll<HTMLElement>('.game-window[data-window-id]')].map((surface) => {
        const canvas = surface.querySelector<HTMLCanvasElement>('canvas[data-window-id]'),
          input = latest.get(Number(surface.dataset.windowId)), virtual = input?.virtualCursor,
          bounds = canvas?.getBoundingClientRect()
        let backdrop: unknown = null
        // A bounded read of the actual committed bitmap, not a second render
        // or a substituted backdrop. Read failure remains diagnostic evidence.
        if (canvas && bounds && bounds.width > 0 && bounds.height > 0 && virtual) {
          try {
            const scratch = new OffscreenCanvas(32, 32), context = scratch.getContext('2d')!
            context.drawImage(canvas, virtual.x - 4, virtual.y - 5, 32, 32, 0, 0, 32, 32)
            const rgba = context.getImageData(0, 0, 32, 32).data
            let minimumAlpha = 255, maximumAlpha = 0
            for (let index = 3; index < rgba.length; index += 4) {
              minimumAlpha = Math.min(minimumAlpha, rgba[index]!)
              maximumAlpha = Math.max(maximumAlpha, rgba[index]!)
            }
            backdrop = { minimumAlpha, maximumAlpha, center: [...rgba.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)] }
          } catch (error) {
            backdrop = { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) }
          }
        }
        return { id: surface.dataset.windowId, className: surface.className, active: surface.dataset.active,
          epoch: surface.dataset.surfaceEpoch, geometryRevision: surface.dataset.geometryRevision,
          bounds: surface.getBoundingClientRect().toJSON(), input: input && structuredClone(input),
          canvas: canvas && { bounds: bounds?.toJSON(), width: canvas.width, height: canvas.height,
            cursor: getComputedStyle(canvas).cursor }, backdrop,
          markers: [...surface.querySelectorAll<HTMLElement>('.game-custom-cursor,.game-virtual-cursor')]
            .map((node) => ({ className: node.className, dataset: { ...node.dataset }, bounds: node.getBoundingClientRect().toJSON() })) }
      })
      if (proof.snapshots.length === 64) { proof.snapshots.shift(); proof.droppedSnapshots++ }
      proof.snapshots.push({ phase, at: performance.now(), scroll: { x: scrollX, y: scrollY },
        activeElement: label(document.activeElement), visibility: document.visibilityState,
        popup: [...document.querySelectorAll<HTMLElement>('.game-menu-overlay,.game-menu-popup')]
          .map((node) => ({ className: node.className, bounds: node.getBoundingClientRect().toJSON() })), windows })
    }
  })
}

export async function snapshotMenuCursor(page: Page, phase: string): Promise<void> {
  await page.evaluate((phase) => (window as unknown as ObservedWindow).snapshotMenuCursor(phase), phase)
}
export async function readMenuCursorProof(page: Page): Promise<MenuCursorProof> {
  return page.evaluate(() => (window as unknown as ObservedWindow).menuCursorProof)
}
