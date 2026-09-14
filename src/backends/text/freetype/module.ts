import { FontKernel } from './face.ts'
import type { ExecutionControl } from '../../../engine/scheduler/control.ts'
export interface FontModule {
  HEAPU8: Uint8Array
  HEAP32: Int32Array
  [name: `_${string}`]: (...args: number[]) => number
}
export type FontFactory = (options: {
  wasmBinary: Uint8Array
  locateFile?: (name: string) => string
}) => Promise<FontModule>
export interface FontManifest {
  abi: 2
  library: 'FreeType'
  version: string
  assets: Record<'mjs' | 'wasm', { file: string; bytes: number; sha256: string }>
}
export async function loadFontKernel(url: string, control: ExecutionControl): Promise<FontKernel> {
  const controller = new AbortController(),
    off = control.onCancel(() => controller.abort())
  try {
    control.check()
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' })
    if (!response.ok) throw new Error('Font assets are missing. Run npm run build:fonts.')
    const manifest = (await response.json()) as FontManifest
    if (manifest.abi !== 2 || manifest.library !== 'FreeType')
      throw new Error('Font manifest ABI mismatch')
    for (const kind of ['mjs', 'wasm'] as const) {
      const asset = manifest.assets?.[kind]
      if (
        !asset ||
        !new RegExp(`^font-[a-f0-9]{16}\\.${kind}$`).test(asset.file) ||
        !Number.isInteger(asset.bytes) ||
        asset.bytes < 1 ||
        asset.bytes > 8 * 1024 * 1024
      )
        throw new Error('Invalid font module manifest')
    }
    const wasmUrl = new URL(manifest.assets.wasm.file, url).href,
      moduleUrl = new URL(manifest.assets.mjs.file, url).href
    const binary = await fetch(wasmUrl, { signal: controller.signal })
    if (!binary.ok) throw new Error('Font WASM could not be loaded')
    const wasmBinary = new Uint8Array(await binary.arrayBuffer())
    if (wasmBinary.length !== manifest.assets.wasm.bytes) throw new Error('Font WASM size mismatch')
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', wasmBinary))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    if (hash !== manifest.assets.wasm.sha256) throw new Error('Font WASM hash mismatch')
    const imported = (await import(/* @vite-ignore */ moduleUrl)) as { default: FontFactory }
    control.check()
    const kernel = new FontKernel(await imported.default({ wasmBinary, locateFile: () => wasmUrl }))
    if (control.cancelled) kernel.dispose()
    control.check()
    return kernel
  } finally {
    off()
  }
}
