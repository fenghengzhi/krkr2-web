import type { Page } from '@playwright/test'

export interface WorkerRpcObservation {
  workers: { name: string; url: string; calls: number; replies: number; duplicateReplies: number;
    errors: { method: string; message: string }[] }[]
}
type ObservedWindow = Window & { observeSessionWorkerRpc(): WorkerRpcObservation }

/** Passive metadata only: preserve the real Worker, Comlink payload, transfer
 * list and timing. Duplicate replies distinguish multiple RPC listeners from
 * merely downloading the same module URL twice. No media/VM state is replaced. */
export async function installWorkerRpcObservation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = Worker, observations: WorkerRpcObservation['workers'] = []
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (!options?.name?.startsWith('krkr2-session-')) return
        const record: WorkerRpcObservation['workers'][number] = {
          name: options.name, url: String(url), calls: 0, replies: 0, duplicateReplies: 0, errors: [],
        }, calls = new Map<string, { method: string; replies: number }>(), post = this.postMessage
        observations.push(record)
        this.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          const request = message as { id?: unknown; type?: unknown; argumentList?: { value?: unknown }[] }
          if (typeof request?.id === 'string' && request.type === 'APPLY') {
            record.calls++
            if (calls.size >= 2048) calls.delete(calls.keys().next().value!)
            calls.set(request.id, { method: String(request.argumentList?.[0]?.value ?? 'unknown'), replies: 0 })
          }
          Reflect.apply(post, this, transfer === undefined ? [message] : [message, transfer])
        } as Worker['postMessage']
        this.addEventListener('message', ({ data }: MessageEvent) => {
          if (typeof data?.id !== 'string') return
          const call = calls.get(data.id)
          if (!call) return
          record.replies++
          if (++call.replies > 1) record.duplicateReplies++
          if (data.type === 'HANDLER' && data.name === 'throw') {
            const value = data.value?.value
            record.errors.push({ method: call.method,
              message: typeof value?.message === 'string' ? value.message : String(value) })
            if (record.errors.length > 64) record.errors.shift()
          }
        })
      }
    }
    ;(window as unknown as ObservedWindow).observeSessionWorkerRpc = () => ({
      workers: observations.map((record) => ({ ...record, errors: record.errors.map((error) => ({ ...error })) })),
    })
  })
}

export function observeWorkerRpc(page: Page): Promise<WorkerRpcObservation> {
  return page.evaluate(() => (window as unknown as ObservedWindow).observeSessionWorkerRpc())
}
