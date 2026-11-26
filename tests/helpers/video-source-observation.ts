import type { Page } from '@playwright/test'

export interface VideoSourceObservation {
  opens: { at: number; id: number | undefined; windowId: number | undefined; name: string;
    kind: 'blob' | 'array' | 'unknown'; bytes: number | undefined; buffered: boolean | undefined }[]
  dropped: number
}
type ObservedWindow = Window & { videoSourceObservation(): VideoSourceObservation }

/** Observe received metadata on the original MessagePorts. No command, Blob,
 * transfer list, handler, port start or media state is changed. */
export async function installVideoSourceObservation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeChannel = MessageChannel, opens: VideoSourceObservation['opens'] = []
    let dropped = 0
    window.MessageChannel = new Proxy(NativeChannel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel
        for (const port of [channel.port1, channel.port2]) port.addEventListener('message', ({ data }) => {
          const command = data?.command
          if (command?.op !== 'open' || typeof command.name !== 'string' || !('bytes' in command) ||
              typeof command.settings?.enabledVideoStream !== 'number') return
          if (opens.length >= 64) { dropped++; return }
          const value = command.bytes, blob = value?.blob,
            kind = blob instanceof Blob ? 'blob' : value instanceof Uint8Array ? 'array' : 'unknown'
          opens.push({ at: performance.now(), id: command.id, windowId: command.windowId,
            name: command.name, kind, bytes: kind === 'blob' ? blob.size : kind === 'array' ? value.byteLength : undefined,
            buffered: typeof value?.buffered === 'boolean' ? value.buffered : undefined })
        })
        return channel
      },
    })
    ;(window as unknown as ObservedWindow).videoSourceObservation = () => ({ opens: opens.map((row) => ({ ...row })), dropped })
  })
}

export const observeVideoSources = (page: Page): Promise<VideoSourceObservation> =>
  page.evaluate(() => (window as unknown as ObservedWindow).videoSourceObservation())
