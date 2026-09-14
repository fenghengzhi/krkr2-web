import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EngineSession,
  type EngineEvent,
  type SessionDependencies,
} from '../../src/engine/session.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { readScript, readText, writeText } from '../../src/backends/files/text-codecs.ts'
import { inflateImage, deflateImage } from '../../src/backends/files/blob-source.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

export async function headless(
  files: Record<string, string | Uint8Array> = {},
  overrides: Partial<SessionDependencies> = {},
) {
  const logs: string[] = []
  const events: EngineEvent[] = []
  const session = new EngineSession({
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    inflateImage,
    deflateImage,
    createRuntime: (handler, control, options) =>
      TjsWasmRuntime.create(factory, handler, { control, wasmBinary, ...options }),
    renderer: { present() {}, dispose() {} },
    graphics: {
      decode: async () => {
        throw new Error('Unexpected image decoding')
      },
      text: () => {
        throw new Error('Unexpected text drawing')
      },
    },
    now: () => performance.now(),
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
    decodeScript: readScript,
    readText,
    writeText,
    event: (event) => {
      events.push(event)
      if (event.type === 'log') logs.push(event.text)
    },
    ...overrides,
  })
  await session.initialize()
  session.mount(
    Object.entries(files).map(([name, text]) => {
      const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text
      return { name, size: bytes.length, read: async () => bytes }
    }),
  )
  return { session, logs, events }
}
