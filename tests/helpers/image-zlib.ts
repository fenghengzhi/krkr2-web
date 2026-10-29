import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { LazyImageInflaterProvider } from '../../src/engine/graphics/image-inflater-provider.ts'
import { instantiateImageZlibKernel, validateImageZlibManifest,
  type ImageZlibFactory, type ImageZlibManifest } from '../../src/backends/image-zlib/module.ts'

const directory = resolve('.generated/image-zlib'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as ImageZlibManifest
validateImageZlibManifest(manifest)
const { default: factory } = await import(pathToFileURL(resolve(directory, manifest.assets.mjs.file)).href) as { default: ImageZlibFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, manifest.assets.wasm.file)))

export function createHeadlessImageInflaterProvider(control: ExecutionControl | (() => ExecutionControl) = new ExecutionControl()) {
  const current = typeof control === 'function' ? control : () => control
  return new LazyImageInflaterProvider(() => instantiateImageZlibKernel(factory, { wasmBinary }, current()), current)
}
