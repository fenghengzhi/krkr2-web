import { createRpcClient, type RpcClient } from 'vite-plugin-worker-rpc/runtime'
import { transfer } from 'vite-plugin-worker-rpc/client'
import type { LibraryApi, LibraryProgress, LibraryImport } from '../protocol/library.ts'

export class LibraryClient {
  private rpc?: RpcClient
  private channel?: MessageChannel
  private connected?: Promise<Awaited<ReturnType<LibraryApi['connect']>>>
  private importing?: { id: string; cancelled: boolean }
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
      const channel = (this.channel = new MessageChannel())
      channel.port1.onmessage = (event: MessageEvent<LibraryProgress>) => {
        if (this.rpc === rpc) this.progress(event.data)
      }
      this.connected = rpc.call('connect', [
        transfer(channel.port2, [channel.port2]),
      ]) as ReturnType<LibraryApi['connect']>
    }
    return this.connected!
  }
  async call<K extends Exclude<keyof LibraryApi, 'connect' | 'cancel'>>(
    method: K,
    ...args: Parameters<LibraryApi[K]>
  ): Promise<Awaited<ReturnType<LibraryApi[K]>>> {
    const operation =
      method === 'importGame'
        ? { id: (args[0] as LibraryImport).operation, cancelled: false }
        : undefined
    if (operation) {
      if (this.importing) throw new Error('An import is already in progress')
      this.importing = operation
    }
    const connected = this.connect(),
      rpc = this.rpc!
    try {
      await connected
      if (operation?.cancelled || this.rpc !== rpc)
        throw new DOMException('Library operation cancelled', 'AbortError')
      return (await rpc.call(method, args)) as Awaited<ReturnType<LibraryApi[K]>>
    } finally {
      if (this.importing === operation) this.importing = undefined
    }
  }
  async cancel(operation: string): Promise<void> {
    if (this.importing?.id === operation) this.importing.cancelled = true
    if (!this.rpc) return
    const rpc = this.rpc
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        rpc.call('cancel', [operation]),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (this.rpc === rpc) this.close()
            resolve()
          }, 2000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  close(): void {
    this.rpc?.dispose()
    this.channel?.port1.close()
    this.channel?.port2.close()
    this.rpc = undefined
    this.channel = undefined
    this.connected = undefined
  }
}
