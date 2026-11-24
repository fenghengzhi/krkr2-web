import { ExecutionCancelled, type ExecutionControl } from '../../engine/scheduler/control.ts'
import { ImageJpegKernel, type ImageJpegModule } from './kernel.ts'

export type ImageJpegFactory = (options: {
  wasmBinary: Uint8Array
  locateFile?: (name: string) => string
}) => Promise<ImageJpegModule>

export interface ImageJpegManifest {
  abi: 1
  library: 'ijg-libjpeg'
  version: '6b'
  jpegAbi: 62
  toolchain: '6.0.9'
  source: {
    url: string
    archiveSha256: string
    kernelSha256: string
    files: Record<string, { bytes: number; sha256: string }>
    originalHeaders: Record<string, { bytes: number; sha256: string }>
  }
  assets: Record<'mjs' | 'wasm', { file: string; bytes: number; sha256: string }>
}

export const imageJpegSourceSha256 = '75c3ec241e9996504fe02a9ed4d12f16b74ade713972f3db9e65ce95cd27e35d'
const headers = {
  'jconfig.h': { bytes: 1333, sha256: '1d0894775067d15163181f26d3039e24b34501ca7e5380dd2ddb8526dd05b250' },
  'jmorecfg.h': { bytes: 12637, sha256: 'fb3c11f0cbd0eb70b75a5067e9d8a23ad5bcf5ebf7f4f82e7de65d601170e1b7' },
} as const

export function validateImageJpegManifest(manifest: ImageJpegManifest): void {
  if (manifest?.abi !== 1 || manifest.library !== 'ijg-libjpeg' || manifest.version !== '6b' || manifest.jpegAbi !== 62 ||
      manifest.toolchain !== '6.0.9' || manifest.source?.archiveSha256 !== imageJpegSourceSha256 ||
      !/^[a-f0-9]{64}$/.test(manifest.source.kernelSha256))
    throw new Error('Image JPEG manifest ABI/source mismatch')
  for (const [name, expected] of Object.entries(headers))
    for (const entry of [manifest.source.originalHeaders?.[name], manifest.source.files?.[name]])
      if (!entry || entry.bytes !== expected.bytes || entry.sha256 !== expected.sha256)
        throw new Error('Image JPEG original configuration mismatch: ' + name)
  for (const kind of ['mjs', 'wasm'] as const) {
    const entry = manifest.assets?.[kind]
    if (!entry || !new RegExp(`^image-jpeg-[a-f0-9]{16}\\.${kind}$`).test(entry.file) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 4 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || !entry.file.includes(entry.sha256.slice(0, 16)))
      throw new Error('Invalid image JPEG asset manifest')
  }
}

function cancelable<T>(work: Promise<T>, control: ExecutionControl): Promise<T> {
  return new Promise((resolve, reject) => {
    const off = control.onCancel(() => reject(new ExecutionCancelled()))
    work.then((value) => { off(); resolve(value) }, (error: unknown) => { off(); reject(error) })
  })
}

/** Observe the original factory after cancellation and retire any late module.
 * No JSPI/Asyncify/TJS module instance is shared with this codec. */
export function instantiateImageJpegKernel(factory: ImageJpegFactory, options: Parameters<ImageJpegFactory>[0],
  control: ExecutionControl): Promise<ImageJpegKernel> {
  control.check()
  const work = Promise.resolve().then(() => { control.check(); return factory(options) }).then((module) => {
    const kernel = new ImageJpegKernel(module)
    if (control.cancelled) { kernel.dispose(); control.check() }
    return kernel
  })
  return cancelable(work, control)
}

export async function loadImageJpegKernel(url: string, control: ExecutionControl): Promise<ImageJpegKernel> {
  const controller = new AbortController(), off = control.onCancel(() => controller.abort())
  try {
    control.check()
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' })
    if (!response.ok) throw new Error('Image JPEG assets are missing; build image-jpeg first')
    const manifest = await response.json() as ImageJpegManifest
    validateImageJpegManifest(manifest)
    const assetUrl = (kind: 'mjs' | 'wasm') => new URL(manifest.assets[kind].file, url).href
    const assets = await Promise.all((['mjs', 'wasm'] as const).map(async (kind) => {
      const loaded = await fetch(assetUrl(kind), { signal: controller.signal })
      if (!loaded.ok) throw new Error(`Image JPEG ${kind} could not be loaded`)
      const bytes = new Uint8Array(await loaded.arrayBuffer()), expected = manifest.assets[kind]
      if (bytes.length !== expected.bytes) throw new Error(`Image JPEG ${kind} size mismatch`)
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0')).join('')
      if (hash !== expected.sha256) throw new Error(`Image JPEG ${kind} hash mismatch`)
      return bytes
    }))
    control.check()
    const imported = await cancelable(import(/* @vite-ignore */ assetUrl('mjs')), control) as { default: ImageJpegFactory }
    control.check()
    if (typeof imported.default !== 'function') throw new Error('Invalid image JPEG module factory')
    return await instantiateImageJpegKernel(imported.default,
      { wasmBinary: assets[1]!, locateFile: () => assetUrl('wasm') }, control)
  } finally { off(); controller.abort() }
}
