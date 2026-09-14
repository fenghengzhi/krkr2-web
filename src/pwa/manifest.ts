export const SHELL_SCHEMA = 1
export const MAX_SHELL_BYTES = 32 * 1024 * 1024
export const MAX_SHELL_ASSET_BYTES = 16 * 1024 * 1024
export const MAX_SHELL_GENERATIONS = 8
export const MAX_SHELL_STORAGE_BYTES = 64 * 1024 * 1024
export interface ShellAsset {
  path: string
  bytes: number
  sha256: string
  mime: string
}
export interface ShellManifest {
  schema: 1
  build: string
  bytes: number
  assets: ShellAsset[]
}
export interface ShellRecord {
  manifest: ShellManifest
  complete: boolean
}
export function validateManifest(value: ShellManifest): ShellManifest {
  if (
    value.schema !== SHELL_SCHEMA ||
    !/^[a-f0-9]{64}$/.test(value.build) ||
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > 1024
  )
    throw new Error('Invalid offline app manifest')
  const paths = new Set<string>()
  let bytes = 0
  for (const asset of value.assets) {
    if (
      asset.path.length > 512 ||
      !/^[a-zA-Z0-9_./-]+$/.test(asset.path) ||
      asset.path.startsWith('/') ||
      asset.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(asset.path) ||
      ['sw.js', '__offline_manifest__'].includes(asset.path)
    )
      throw new Error('Invalid offline app asset path')
    if (
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0 ||
      asset.bytes > MAX_SHELL_ASSET_BYTES ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(asset.mime)
    )
      throw new Error('Invalid offline app asset metadata')
    paths.add(asset.path)
    bytes += asset.bytes
  }
  if (bytes !== value.bytes || bytes > MAX_SHELL_BYTES || !paths.has('index.html'))
    throw new Error('Offline application exceeds its cache budget')
  return value
}
