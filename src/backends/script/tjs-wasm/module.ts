export interface NativeModule {
  HEAPU8: Uint8Array
  HEAPU16: Uint16Array
  HEAPU32: Uint32Array
  [exportName: `_${string}`]: (...args: (number | bigint)[]) => number | bigint
  ccall(
    name: string,
    returnType: 'number',
    types: string[],
    args: number[],
    options: { async: true },
  ): Promise<number>
}

export interface ModuleOptions {
  locateFile?: (name: string) => string
  wasmBinary?: Uint8Array
  hostCall: (
    vm: number,
    name: number,
    length: number,
    count: number,
    args: number,
  ) => Promise<number>
  shouldCancel: () => boolean
  onYield: () => Promise<void>
  queueWrite: (
    name: number,
    nameLength: number,
    mode: number,
    modeLength: number,
    data: number,
    length: number,
    text: number,
  ) => void
}

export type ModuleFactory = (options: ModuleOptions) => Promise<NativeModule>
export type WasmVariant = 'asyncify' | 'jspi'

export interface WasmManifest {
  abi: number
  toolchain: string
  variants: Partial<
    Record<
      WasmVariant,
      {
        mjs: { file: string; bytes: number; sha256: string }
        wasm: { file: string; bytes: number; sha256: string }
      }
    >
  >
}
