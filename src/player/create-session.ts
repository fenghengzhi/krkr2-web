import { EngineSession } from '../engine/session.ts'
import { TjsWasmRuntime } from '../backends/script/tjs-wasm/runtime.ts'
import type {
  ModuleFactory,
  WasmManifest,
  WasmVariant,
} from '../backends/script/tjs-wasm/module.ts'
import { WebGLRenderer } from '../backends/render/webgl2/renderer.ts'
import { BrowserGraphics } from '../backends/text/browser/graphics.ts'
import { readScript, readText, writeText } from '../backends/files/text-codecs.ts'
import { inflateImage, deflateImage } from '../backends/files/blob-source.ts'
import { IndexedDbSaveStore } from '../backends/files/indexeddb-saves.ts'
import { WebAppLocks } from '../backends/files/web-app-locks.ts'
import { PortAudioBackend } from '../backends/audio/port-backend.ts'
import { PortVideoBackend } from '../backends/video/port-backend.ts'
import type { InitializeRequest, SessionEvent } from '../protocol/session.ts'
import { fontManifestFile } from './build-info.ts'
import { loadFontKernel } from '../backends/text/freetype/module.ts'

export function createSession(request: InitializeRequest): EngineSession {
  let sequence = 0
  const session: EngineSession = new EngineSession({
    systemFonts: request.systemFonts,
    activity: request.activity,
    arguments: new Map(request.debugMode ? [['-debug', 'yes']] : []),
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    renderer: new WebGLRenderer(request.canvas),
    graphics: new BrowserGraphics(() =>
      loadFontKernel(new URL('../' + fontManifestFile, request.manifestUrl).href, session.control),
    ),
    inflateImage,
    deflateImage,
    now: () => performance.now(),
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
    decodeScript: readScript,
    readText,
    writeText,
    saveStore: new IndexedDbSaveStore(request.gameId),
    appLocks: new WebAppLocks(request.gameId),
    audio: new PortAudioBackend(request.audio),
    video: new PortVideoBackend(request.video),
    event: (event) => {
      const message: SessionEvent = {
        ...event,
        generation: request.generation,
        sequence: ++sequence,
      }
      request.events.postMessage(message)
    },
    async createRuntime(handler, control, options) {
      const controller = new AbortController()
      const unsubscribe = control.onCancel(() => controller.abort())
      try {
        const response = await fetch(request.manifestUrl, {
          signal: controller.signal,
          cache: 'no-cache',
        })
        if (!response.ok) throw new Error('WASM assets are missing. Run npm run build:wasm.')
        const manifest = (await response.json()) as WasmManifest
        if (manifest.abi !== 4) throw new Error('WASM manifest ABI mismatch')
        const supportsJspi = 'Suspending' in WebAssembly && 'promising' in WebAssembly
        const variant: WasmVariant =
          request.backend === 'auto'
            ? supportsJspi && manifest.variants.jspi
              ? 'jspi'
              : 'asyncify'
            : request.backend
        if (variant === 'jspi' && !supportsJspi)
          throw new Error('This browser does not support JSPI')
        const assets = manifest.variants[variant]
        if (!assets) throw new Error(`Build the ${variant} WASM variant first`)
        const moduleUrl = new URL(assets.mjs.file, request.manifestUrl).href
        const wasmUrl = new URL(assets.wasm.file, request.manifestUrl).href
        const imported = (await import(/* @vite-ignore */ moduleUrl)) as { default: ModuleFactory }
        control.check()
        return await TjsWasmRuntime.create(imported.default, handler, {
          variant,
          debugMode: options.debugMode,
          control,
          locateFile: () => wasmUrl,
        })
      } finally {
        unsubscribe()
      }
    },
  })
  return session
}
