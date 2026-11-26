import { createRpcClient, type RpcClient } from 'vite-plugin-worker-rpc/runtime'
import { transfer } from 'vite-plugin-worker-rpc/client'
import type { LibraryApi, LibraryImportRequest, LibraryProgress } from '../protocol/library.ts'

interface ImportOperation { id: string; cancelled: boolean; terminated?: boolean }
export class LibraryClient {
  private rpc?: RpcClient
  private channel?: MessageChannel
  private connected?: Promise<Awaited<ReturnType<LibraryApi['connect']>>>
  private importing?: ImportOperation
  constructor(private readonly progress: (value: LibraryProgress) => void) {}
  private connect() {
    if (!this.rpc) {
      const rpc = (this.rpc = createRpcClient(
        () =>
          new Worker(new URL('../workers/library.worker.ts', import.meta.url), {
            type: 'module',
            name: 'krkr2-library',
          }),
        { pool: 1 },
      ))
      const failed = (error: unknown): never => {
        // A late rejection from a retired connection cannot close its retry.
        if (this.rpc === rpc) {
          try { this.close() }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Library connection and cleanup failed', { cause: error }) }
        }
        throw error
      }
      try {
        const channel = (this.channel = new MessageChannel())
        channel.port1.onmessage = (event: MessageEvent<LibraryProgress>) => {
          if (this.rpc === rpc) this.progress(event.data)
        }
        this.connected = (rpc.call('connect', [
          transfer(channel.port2, [channel.port2]),
        ]) as ReturnType<LibraryApi['connect']>).catch(failed)
      } catch (error) {
        failed(error)
      }
    }
    return this.connected!
  }
  async call<K extends Exclude<keyof LibraryApi, 'connect' | 'cancel'>>(
    method: K,
    ...args: Parameters<LibraryApi[K]>
  ): Promise<Awaited<ReturnType<LibraryApi[K]>>> {
    const operation: ImportOperation | undefined =
      method === 'importGame'
        ? { id: (args[0] as LibraryImportRequest).operation, cancelled: false }
        : undefined
    if (operation) {
      if (this.importing) throw new Error('An import is already in progress')
      this.importing = operation
    }
    try {
      const connected = this.connect(), rpc = this.rpc!
      await connected
      if (operation?.cancelled || this.rpc !== rpc)
        throw new DOMException('Library operation cancelled', 'AbortError')
      return (await rpc.call(method, args)) as Awaited<ReturnType<LibraryApi[K]>>
    } catch (error) {
      if (operation?.terminated) throw new DOMException('Library operation cancelled', 'AbortError')
      throw error
    } finally {
      if (this.importing === operation) this.importing = undefined
    }
  }
  async cancel(operation: string): Promise<void> {
    const current = this.importing
    if (!current || current.id !== operation) return
    current.cancelled = true
    if (!this.rpc) return
    const rpc = this.rpc
    const timeout = Symbol('forced library cancellation')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        rpc.call('cancel', [operation]),
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => {
            // Closing RPC synchronously rejects pending cancel calls. Settle
            // this race first; cleanup failures remain part of cancel below.
            resolve(timeout)
          }, 2000)
        }),
      ])
      if (outcome === timeout && this.rpc === rpc && this.importing === current) {
        current.terminated = true
        this.close()
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  close(): void {
    const rpc = this.rpc, channel = this.channel, errors: unknown[] = []
    this.rpc = undefined
    this.channel = undefined
    this.connected = undefined
    for (const close of [() => rpc?.dispose(), () => channel?.port1.close(), () => channel?.port2.close()]) {
      try { close() } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Library client cleanup failed', { cause: errors[0] })
  }
}
