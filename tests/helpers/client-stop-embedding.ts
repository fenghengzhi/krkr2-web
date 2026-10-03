import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'

/** Hosted-only compilation of actual clients and their unmodified RPC Workers. */
export async function buildClientStopEmbedding() {
  const base = '/client-stop-assets/',
    id = 'virtual:client-stop-embedding',
    resolvedId = '\0client-stop-embedding',
    wasmHash = createHash('sha256')
      .update(await readFile(resolve('.generated/wasm/manifest.json')))
      .digest('hex'),
    fontHash = createHash('sha256')
      .update(await readFile(resolve('.generated/fonts/manifest.json')))
      .digest('hex'),
    result = await build({
      configFile: false,
      publicDir: false,
      base,
      logLevel: 'error',
      plugins: [
        workerRpc({ pool: 1 }),
        {
          name: 'client-stop-embedding',
          resolveId(value) {
            if (value === id || value === resolve(id)) return resolvedId
          },
          load(value) {
            if (value !== resolvedId) return
            return [
              `export { SessionClient } from ${JSON.stringify(resolve('src/player/session-client.ts'))};`,
              `export { LibraryClient } from ${JSON.stringify(resolve('src/player/library-client.ts'))};`,
            ].join('\n')
          },
        },
      ],
      define: {
        __KRKR_WASM_MANIFEST_FILE__: JSON.stringify(`wasm/manifest-${wasmHash.slice(0, 16)}.json`),
        __KRKR_FONT_MANIFEST_FILE__: JSON.stringify(`fonts/manifest-${fontHash.slice(0, 16)}.json`),
      },
      worker: { format: 'es' },
      build: {
        write: false,
        minify: false,
        target: 'es2022',
        rollupOptions: { input: { embedding: id }, preserveEntrySignatures: 'strict' },
      },
    }),
    bundles = new Map<string, { body: Buffer; contentType: string }>(),
    hashes: { file: string; sha256: string }[] = []
  let entry = ''
  for (const output of (Array.isArray(result) ? result : [result]).flatMap((item) =>
    'output' in item ? item.output : [],
  )) {
    const source = output.type === 'chunk' ? output.code : output.source,
      body = typeof source === 'string' ? Buffer.from(source) : Buffer.from(source)
    bundles.set(output.fileName, { body, contentType: 'text/javascript' })
    hashes.push({ file: output.fileName, sha256: createHash('sha256').update(body).digest('hex') })
    if (output.type === 'chunk' && output.isEntry) entry = base + output.fileName
  }
  if (
    !entry ||
    ![...bundles.keys()].some((name) => /session\.worker-.*\.js$/.test(name)) ||
    ![...bundles.keys()].some((name) => /library\.worker-.*\.js$/.test(name))
  )
    throw new Error('Client shutdown fixture must emit both real RPC Workers')
  return { base, entry, bundles, hashes }
}

export async function openClientStopEmbedding(
  page: Page,
  bundle: Awaited<ReturnType<typeof buildClientStopEmbedding>>,
) {
  await page.route('**/client-stop-assets/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(bundle.base.length),
      asset = bundle.bundles.get(name)
    return asset
      ? route.fulfill(asset)
      : route.fulfill({ status: 404, body: 'Missing client shutdown fixture asset' })
  })
  await page.route('**/client-stop-embedding.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>RPC shutdown watchdog boundary</title>',
    }),
  )
  await page.goto('/client-stop-embedding.html')
}

interface StopBoundaryObservation {
  workers: {
    name: string
    terminated: number
    sent: { id: string; operation: string }[]
    held: { id: string; operation: string; type: string }[]
  }[]
  channels: { closed: [number, number] }[]
}
declare global {
  interface Window {
    clientStopBoundary: {
      arm(operation: 'stop' | 'cancel'): void
      read(): StopBoundaryObservation
    }
  }
}

/** Explicit fault: withhold one real reply, after the actual Worker produced it.
 * All requests, other responses, Worker construction/termination and port closes
 * call the native implementation exactly once. No runtime or save result is faked. */
export async function observeClientStopBoundary(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = Worker,
      nativePost = NativeWorker.prototype.postMessage,
      nativeTerminate = NativeWorker.prototype.terminate,
      NativeChannel = MessageChannel,
      nativeClose = MessagePort.prototype.close,
      workers: StopBoundaryObservation['workers'] = [],
      records = new WeakMap<Worker, StopBoundaryObservation['workers'][number]>(),
      channels: StopBoundaryObservation['channels'] = [],
      ports = new WeakMap<MessagePort, { channel: number; index: 0 | 1 }>()
    let armed: 'stop' | 'cancel' | undefined,
      held: { worker: Worker; id: string; operation: string } | undefined
    window.clientStopBoundary = {
      arm(operation) {
        if (armed || held) throw new Error('Only one reply may be withheld per fixture')
        armed = operation
      },
      read: () => structuredClone({ workers, channels }),
    }
    window.MessageChannel = new Proxy(NativeChannel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel,
          index = channels.length
        channels.push({ closed: [0, 0] })
        ports.set(channel.port1, { channel: index, index: 0 })
        ports.set(channel.port2, { channel: index, index: 1 })
        return channel
      },
    })
    MessagePort.prototype.close = function () {
      const result = Reflect.apply(nativeClose, this, []),
        owner = ports.get(this)
      if (owner) channels[owner.channel]!.closed[owner.index]++
      return result
    }
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker,
          record: StopBoundaryObservation['workers'][number] = {
            name: (args[1] as WorkerOptions | undefined)?.name ?? '',
            terminated: 0,
            sent: [],
            held: [],
          }
        workers.push(record)
        records.set(worker, record)
        worker.addEventListener(
          'message',
          (event: MessageEvent<{ id?: string; type?: string }>) => {
            if (
              held?.worker === worker &&
              event.data?.id === held.id &&
              event.data.type === 'RAW'
            ) {
              record.held.push({ id: held.id, operation: held.operation, type: event.data.type })
              // Registered before RPC's receive listener. This explicit boundary
              // fault does not alter or execute the already-completed Worker task.
              event.stopImmediatePropagation()
            }
          },
        )
        return worker
      },
    })
    NativeWorker.prototype.postMessage = function (
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const packet = message as {
          id?: string
          type?: string
          argumentList?: { value?: unknown }[]
        },
        operation = packet?.argumentList?.[0]?.value,
        result = Reflect.apply(nativePost, this, [message, options])
      if (
        packet?.type === 'APPLY' &&
        typeof packet.id === 'string' &&
        typeof operation === 'string'
      ) {
        records.get(this)?.sent.push({ id: packet.id, operation })
        if (operation === armed) {
          held = { worker: this, id: packet.id, operation }
          armed = undefined
        }
      }
      return result
    }
    NativeWorker.prototype.terminate = function () {
      const result = Reflect.apply(nativeTerminate, this, []),
        record = records.get(this)
      if (record) record.terminated++
      return result
    }
  })
}
