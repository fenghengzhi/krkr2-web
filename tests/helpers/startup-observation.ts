import type { Page, TestInfo } from '@playwright/test'
import { installWorkerRpcObservation, observeWorkerRpc } from './worker-rpc-observation.ts'

interface StartupObservation {
  events: Record<string, unknown>[]
  dropped: number
  errors: string[]
}
declare global { interface Window { startupObservation: StartupObservation } }

/** Passive metadata at the real surface and Session event ports. No request,
 * reply, canvas transfer, scheduling callback or renderer result is replaced. */
export async function observeStartup(page: Page): Promise<void> {
  await installWorkerRpcObservation(page)
  await page.addInitScript(() => {
    const proof: StartupObservation = { events: [], dropped: 0, errors: [] },
      NativeChannel = MessageChannel, nativePost = MessagePort.prototype.postMessage,
      transfer = HTMLCanvasElement.prototype.transferControlToOffscreen,
      ports = new WeakMap<MessagePort, string>()
    let channels = 0
    window.startupObservation = proof
    const record = (value: Record<string, unknown>) => {
      if (proof.events.length >= 512) { proof.dropped++; return }
      proof.events.push({ at: performance.now(), ...value })
    }
    const packet = (direction: string, port: MessagePort, data: unknown) => {
      try {
        if (!data || typeof data !== 'object') return
        const value = data as Record<string, unknown>
        if (value.type === 'state') {
          const snapshot = value.snapshot as Record<string, unknown> | undefined
          if (!snapshot) return
          record({ direction, port: ports.get(port), type: 'state', generation: value.generation,
            sequence: value.sequence, revision: snapshot.revision, state: snapshot.state,
            resources: snapshot.resources, layers: snapshot.layers,
            graphics: structuredClone(snapshot.graphics), activity: structuredClone(snapshot.activity) })
        } else if (typeof value.windowId === 'number' && typeof value.surfaceEpoch === 'number') {
          record({ direction, port: ports.get(port), type: value.type, generation: value.generation,
            windowId: value.windowId, surfaceEpoch: value.surfaceEpoch, message: value.message })
        }
      } catch (error) { if (proof.errors.length < 16) proof.errors.push(String(error)) }
    }
    window.MessageChannel = new Proxy(NativeChannel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel, id = ++channels
        for (const [index, port] of [channel.port1, channel.port2].entries()) {
          ports.set(port, `${id}:${index}`)
          port.addEventListener('message', ({ data }) => packet('receive', port, data))
          port.addEventListener('messageerror', () => record({ type: 'messageerror', port: ports.get(port) }))
          // Only the actual owner starts the port.
        }
        return channel
      },
    })
    MessagePort.prototype.postMessage = new Proxy(nativePost, {
      apply(target, receiver: MessagePort, args) {
        const result = Reflect.apply(target, receiver, args)
        packet('send', receiver, args[0])
        return result
      },
    })
    HTMLCanvasElement.prototype.transferControlToOffscreen = new Proxy(transfer, {
      apply(target, receiver: HTMLCanvasElement, args) {
        const result = Reflect.apply(target, receiver, args)
        record({ type: 'canvas-transfer', windowId: receiver.dataset.windowId,
          width: receiver.width, height: receiver.height, connected: receiver.isConnected })
        return result
      },
    })
  })
}

/** Read evidence without entering the game VM, which may be awaiting graphics. */
export async function attachStartup(page: Page, info: TestInfo, label: string, errors: readonly string[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const state = await Promise.race([
      Promise.all([observeWorkerRpc(page), page.evaluate(() => ({
        observation: window.startupObservation,
        status: document.querySelector('#status')?.textContent,
        statusData: { ...document.querySelector<HTMLElement>('#status')?.dataset },
        runtime: document.querySelector('#runtime-info')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        stage: { graphics: document.querySelector<HTMLElement>('#stage')?.dataset.graphics,
          activity: document.querySelector<HTMLElement>('#stage')?.dataset.activity },
        windows: [...document.querySelectorAll<HTMLElement>('.game-window')].map((element) => ({
          id: element.dataset.windowId, epoch: element.dataset.surfaceEpoch, hidden: element.hidden,
          geometry: element.dataset.geometryRevision, box: element.getBoundingClientRect().toJSON(),
        })),
      }))]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Startup evidence read timed out')), 3000) }),
    ])
    await info.attach('startup-' + label, { contentType: 'application/json', body: JSON.stringify({
      scope: 'Passive real RPC/surface metadata; no VM evaluation or replacement renderer',
      pageErrors: errors, rpc: state[0], page: state[1],
    }, null, 2) })
  } finally { clearTimeout(timer) }
}
