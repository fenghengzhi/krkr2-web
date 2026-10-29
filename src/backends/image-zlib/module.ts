import { ExecutionCancelled, type ExecutionControl } from '../../engine/scheduler/control.ts'
import { ImageZlibKernel, type ImageZlibModule } from './kernel.ts'

export type ImageZlibFactory = (options: {
  wasmBinary: Uint8Array
  locateFile?: (name: string) => string
}) => Promise<ImageZlibModule>

export interface ImageZlibManifest {
  abi: 1
  library: 'zlib'
  version: '1.3.2'
  toolchain: '6.0.9'
  source: {
    url: string
    archiveSha512: string
    kernelSha256: string
    portSha256: string
    files: Record<string, { bytes: number; sha256: string }>
  }
  assets: Record<'mjs' | 'wasm', { file: string; bytes: number; sha256: string }>
}

export const imageZlibSourceSha512 = '16fea4df307a68cf0035858abe2fd550250618a97590e202037acd18a666f57afc10f8836cbbd472d54a0e76539d0e558cb26f059d53de52ff90634bbf4f47d4'

export function validateImageZlibManifest(manifest: ImageZlibManifest): void {
  if (manifest?.abi !== 1 || manifest.library !== 'zlib' || manifest.version !== '1.3.2' ||
      manifest.toolchain !== '6.0.9' || manifest.source?.archiveSha512 !== imageZlibSourceSha512)
    throw new Error('Image zlib manifest ABI/source mismatch')
  for (const kind of ['mjs', 'wasm'] as const) {
    const asset = manifest.assets?.[kind]
    if (!asset || !new RegExp(`^image-zlib-[a-f0-9]{16}\\.${kind}$`).test(asset.file) ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 4 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.file.includes(asset.sha256.slice(0, 16)))
      throw new Error('Invalid image zlib asset manifest')
  }
}

function cancelable<T>(work: Promise<T>, control: ExecutionControl): Promise<T> {
  return new Promise((resolve, reject) => {
    const off = control.onCancel(() => reject(new ExecutionCancelled()))
    // Keep both handlers attached even when cancellation won already.
    work.then((value) => { off(); resolve(value) }, (error: unknown) => { off(); reject(error) })
  })
}

/** The ready promise remains observed after cancellation, and any module that
 * arrives late is closed before it can escape to a Session. */
export function instantiateImageZlibKernel(
  factory: ImageZlibFactory,
  options: Parameters<ImageZlibFactory>[0],
  control: ExecutionControl,
): Promise<ImageZlibKernel> {
  control.check()
  const work = Promise.resolve().then(() => { control.check(); return factory(options) }).then((module) => {
    const kernel = new ImageZlibKernel(module)
    if (control.cancelled) {
      kernel.dispose()
      control.check()
    }
    return kernel
  })
  return cancelable(work, control)
}

/** Each call creates a separate module; the Session/provider owns its lifetime. */
export async function loadImageZlibKernel(url: string, control: ExecutionControl): Promise<ImageZlibKernel> {
  const controller = new AbortController(), off = control.onCancel(() => controller.abort())
  try {
    control.check()
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' })
    if (!response.ok) throw new Error('Image zlib assets are missing; build image-zlib first')
    const manifest = await response.json() as ImageZlibManifest
    validateImageZlibManifest(manifest)
    const assetUrl = (kind: 'mjs' | 'wasm') => new URL(manifest.assets[kind].file, url).href
    const assets = await Promise.all((['mjs', 'wasm'] as const).map(async (kind) => {
      const loaded = await fetch(assetUrl(kind), { signal: controller.signal })
      if (!loaded.ok) throw new Error(`Image zlib ${kind} could not be loaded`)
      const bytes = new Uint8Array(await loaded.arrayBuffer()), expected = manifest.assets[kind]
      if (bytes.byteLength !== expected.bytes) throw new Error(`Image zlib ${kind} size mismatch`)
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0')).join('')
      if (hash !== expected.sha256) throw new Error(`Image zlib ${kind} hash mismatch`)
      return bytes
    }))
    control.check()
    const imported = await cancelable(import(/* @vite-ignore */ assetUrl('mjs')), control) as { default: ImageZlibFactory }
    control.check()
    if (typeof imported.default !== 'function') throw new Error('Invalid image zlib module factory')
    return await instantiateImageZlibKernel(imported.default,
      { wasmBinary: assets[1]!, locateFile: () => assetUrl('wasm') }, control)
  } finally {
    off()
    controller.abort()
  }
}
