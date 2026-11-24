import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { LazyImageJpegProvider } from '../../src/engine/graphics/image-jpeg-provider.ts'
import { instantiateImageJpegKernel, validateImageJpegManifest,
  type ImageJpegFactory, type ImageJpegManifest } from '../../src/backends/image-jpeg/module.ts'

const directory = resolve('.generated/image-jpeg'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as ImageJpegManifest
validateImageJpegManifest(manifest)
const { default: factory } = await import(pathToFileURL(resolve(directory, manifest.assets.mjs.file)).href) as { default: ImageJpegFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, manifest.assets.wasm.file)))

export function createHeadlessImageJpegProvider(control: ExecutionControl | (() => ExecutionControl) = new ExecutionControl()) {
  const current = typeof control === 'function' ? control : () => control
  return new LazyImageJpegProvider(() => instantiateImageJpegKernel(factory, { wasmBinary }, current()), current)
}
