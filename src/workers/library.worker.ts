import { exposeRpc } from 'vite-plugin-worker-rpc/runtime'
import { LibraryService } from '../player/library/service.ts'
import type { LibraryApi, LibraryStatus } from '../protocol/library.ts'

let service: Promise<LibraryService> | undefined
let events: MessagePort | undefined
let operation: { id: string; abort: AbortController; done: Promise<unknown> } | undefined
const active = () =>
  (service ??= LibraryService.open().catch((error) => {
    service = undefined
    throw error
  }))
async function list(): Promise<LibraryStatus> {
  try {
    return await (await active()).list()
  } catch (error) {
    return {
      available: false,
      games: [],
      persisted: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
const api: LibraryApi = {
  async connect(port) {
    events?.close()
    events = port
    return list()
  },
  list,
  async importGame(request) {
    if (operation) throw new Error('A library import is already in progress')
    const abort = new AbortController()
    const done = (async () =>
      (await active()).importGame(request, abort.signal, (progress) =>
        events?.postMessage(progress),
      ))()
    operation = { id: request.operation, abort, done }
    try {
      return await done
    } finally {
      operation = undefined
    }
  },
  async cancel(id) {
    if (operation?.id !== id) return
    const current = operation
    current.abort.abort(new DOMException('Library import cancelled', 'AbortError'))
    await current.done.catch(() => {})
  },
  async remove(id) {
    await (await active()).remove(id)
  },
  async update(id, settings) {
    await (await active()).update(id, settings)
  },
}
exposeRpc(api, self)
