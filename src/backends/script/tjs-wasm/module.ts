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
  /** VM, source preparation, parse/codegen, export, diagnostic dump, or binary input. */
  onYield: (phase?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10) => Promise<void>
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
  capabilities?: {
    cooperativeCompilation?: number
    binaryScripts?: number
    bytecodeLifecycle?: number
    executionBudgets?: number
  }
  diagnosticAllocator?: boolean
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
