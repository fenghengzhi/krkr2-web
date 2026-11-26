export const legacyMediaLimits = {
  inputBytes: 128 * 1024 ** 2,
  outputBytes: 128 * 1024 ** 2,
  wasmBytes: 512 * 1024 ** 2,
  assetBytes: 16 * 1024 ** 2,
  milliseconds: 5 * 60 * 1000,
} as const
export interface LegacyMediaManifest {
  abi: 1
  library: 'FFmpeg'
  version: '5.1.9'
  openh264: '2.6.0'
  toolchain: '6.0.9'
  source: { manifestSha256: string; ffmpegSha256: string; openh264Sha256: string; buildSha256: string; postSha256: string }
  assets: Record<'mjs' | 'wasm', { file: string; bytes: number; sha256: string }>
}
export function validateLegacyMediaManifest(value: LegacyMediaManifest): void {
  if (value?.abi !== 1 || value.library !== 'FFmpeg' || value.version !== '5.1.9' || value.openh264 !== '2.6.0' || value.toolchain !== '6.0.9' ||
      value.source?.ffmpegSha256 !== 'd9b593bb2ba93d4b50f74177e0cdcd41747e708596367deed0c30348a71dd176' ||
      value.source?.openh264Sha256 !== '558544ad358283a7ab2930d69a9ceddf913f4a51ee9bf1bfb9e377322af81a69')
    throw new Error('Legacy media ABI/source mismatch')
  for (const kind of ['mjs', 'wasm'] as const) {
    const asset = value.assets?.[kind]
    if (!asset || !new RegExp(`^legacy-media-[a-f0-9]{16}\\.${kind}$`).test(asset.file) ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes >= legacyMediaLimits.assetBytes ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.file.includes(asset.sha256.slice(0, 16)))
      throw new Error('Invalid legacy media asset manifest')
  }
}
export interface LegacyFsNode {
  usedBytes: number
  stream_ops: {
    read(stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number): number
    write(stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number, canOwn?: boolean): number
    [key: string]: unknown
  }
}
export interface LegacyMediaModule {
  FS: {
    mkdir(path: string): void
    mount(filesystem: unknown, options: { blobs: { name: string; data: Blob }[] }, mountpoint: string): void
    unmount(path: string): void
    open(path: string, flags: string): { node: LegacyFsNode }
    close(stream: unknown): void
    unlink(path: string): void
    writeFile(path: string, bytes: Uint8Array): void
    lookupPath(path: string): { node: LegacyFsNode }
    ErrnoError: new (errno: number) => Error
  }
  WORKERFS: unknown
  runLegacy(args: string[]): number
}
export type LegacyMediaFactory = (options: {
  wasmBinary: Uint8Array
  noInitialRun: true
  print(value: string): void
  printErr(value: string): void
  locateFile(name: string): string
}) => Promise<LegacyMediaModule>

export async function loadLegacyMedia(url: string, log: (text: string) => void): Promise<LegacyMediaModule> {
  const response = await fetch(url, { cache: 'no-cache' })
  if (!response.ok) throw new Error('Legacy media assets are unavailable')
  const manifest = await response.json() as LegacyMediaManifest
  validateLegacyMediaManifest(manifest)
  const loaded = await Promise.all((['mjs', 'wasm'] as const).map(async (kind) => {
    const asset = manifest.assets[kind], result = await fetch(new URL(asset.file, url))
    if (!result.ok) throw new Error(`Legacy media ${kind} is unavailable`)
    const bytes = new Uint8Array(await result.arrayBuffer())
    if (bytes.length !== asset.bytes) throw new Error('Legacy media asset length mismatch')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')
    if (digest !== asset.sha256) throw new Error('Legacy media asset hash mismatch')
    return bytes
  }))
  const imported = await import(/* @vite-ignore */ new URL(manifest.assets.mjs.file, url).href) as { default: LegacyMediaFactory }
  if (typeof imported.default !== 'function') throw new Error('Legacy media factory is missing')
  return imported.default({ wasmBinary: loaded[1]!, noInitialRun: true, print: log, printErr: log,
    locateFile: (name) => new URL(name, url).href })
}
