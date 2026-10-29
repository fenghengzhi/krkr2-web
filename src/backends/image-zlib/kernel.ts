import {
  IMAGE_INFLATE_MAX_INPUT, IMAGE_INFLATE_MAX_OUTPUT, IMAGE_INFLATE_MAX_STREAMS,
  type ImageInflateStatus, type ImageInflateStep, type ImageInflater, type ImageInflaterKernel,
} from '../../engine/ports/image-inflater.ts'

export interface ImageZlibModule {
  HEAPU8: Uint8Array
  _image_zlib_abi(): number
  _image_zlib_version(): number
  _image_zlib_input(): number
  _image_zlib_output(): number
  _image_zlib_open(limit: number): number
  _image_zlib_open_status(): number
  _image_zlib_step(handle: number, inputSize: number, outputSize: number): number
  _image_zlib_used(handle: number, output: number): number
  _image_zlib_reason(handle: number): number
  _image_zlib_close(handle: number): number
  _image_zlib_dispose(): void
  _image_zlib_stat(kind: number): number
}

const exports = ['abi', 'version', 'input', 'output', 'open', 'open_status', 'step', 'used', 'reason',
  'close', 'dispose', 'stat'] as const
const statuses: Readonly<Record<number, ImageInflateStatus>> = {
  0: 'ok', 1: 'end', 2: 'need-dictionary', '-3': 'data-error', '-4': 'memory-error', '-5': 'buffer-error',
}
const ownedModules = new WeakSet<ImageZlibModule>()

/** ASCII zlib diagnostics; copy before another step mutates native state. */
function string(module: ImageZlibModule, pointer: number): string {
  const heap = module.HEAPU8
  if (!Number.isInteger(pointer) || pointer < 1 || pointer >= heap.length) throw new Error('Invalid image zlib string')
  let result = ''
  for (let i = pointer; i < heap.length && i < pointer + 256; i++) {
    const byte = heap[i]!
    if (!byte) return result
    result += String.fromCharCode(byte)
  }
  throw new Error('Unterminated image zlib string')
}

export class ImageZlibKernel implements ImageInflaterKernel {
  private readonly streams = new Set<{ close(): void }>()
  private disposed = false
  private stepping = false
  private readonly input: number
  private readonly output: number
  private readonly allocationLimit: number

  constructor(private readonly module: ImageZlibModule, options: { allocationLimit?: number } = {}) {
    for (const name of exports)
      if (typeof module[`_image_zlib_${name}`] !== 'function') throw new Error(`Image zlib export missing: ${name}`)
    if (module._image_zlib_abi() !== 1 || string(module, module._image_zlib_version()) !== '1.3.2')
      throw new Error('Image zlib ABI/version mismatch')
    this.input = module._image_zlib_input()
    this.output = module._image_zlib_output()
    if (!Number.isInteger(this.input) || this.input < 1 || !Number.isInteger(this.output) || this.output < 1 ||
      this.input + IMAGE_INFLATE_MAX_INPUT > module.HEAPU8.length ||
      this.output + IMAGE_INFLATE_MAX_OUTPUT > module.HEAPU8.length)
      throw new Error('Invalid image zlib scratch bounds')
    this.allocationLimit = options.allocationLimit ?? 128 * 1024
    if (!Number.isSafeInteger(this.allocationLimit) || this.allocationLimit < 0 || this.allocationLimit > 128 * 1024)
      throw new RangeError('Invalid image zlib allocation limit')
    if (ownedModules.has(module)) throw new Error('Image zlib module already has a kernel owner')
    ownedModules.add(module)
  }

  open(): ImageInflater {
    if (this.disposed) throw new Error('Image inflater kernel is disposed')
    if (this.streams.size >= IMAGE_INFLATE_MAX_STREAMS) throw new Error('Image inflater exceeds 64 active streams')
    const handle = this.module._image_zlib_open(this.allocationLimit) >>> 0
    if (!handle) throw new Error(`Image inflater initialization failed (${this.module._image_zlib_open_status()})`)
    let closed = false
    const stream: ImageInflater = {
      step: (input, output) => {
        if (closed || this.disposed) throw new Error('Image inflater is closed')
        if (!(input instanceof Uint8Array) || !(output instanceof Uint8Array) ||
          input.byteLength > IMAGE_INFLATE_MAX_INPUT || output.byteLength > IMAGE_INFLATE_MAX_OUTPUT)
          throw new RangeError('Image inflater step exceeds its input/output bounds')
        // Caller buffers must not alias the module scratch or its growing heap.
        if (input.buffer === this.module.HEAPU8.buffer || output.buffer === this.module.HEAPU8.buffer)
          throw new Error('Image inflater buffers must be caller-owned')
        if (input.buffer === output.buffer && input.byteLength && output.byteLength &&
            input.byteOffset < output.byteOffset + output.byteLength &&
            output.byteOffset < input.byteOffset + input.byteLength)
          throw new Error('Image inflater input and output must not overlap')
        if (this.stepping) throw new Error('Image inflater cannot reenter a synchronous step')
        this.stepping = true
        try {
          this.module.HEAPU8.set(input, this.input)
          const code = this.module._image_zlib_step(handle, input.length, output.length),
            status = statuses[code]
          if (!status) throw new Error(`Invalid image inflater state (${code})`)
          const inputUsed = this.module._image_zlib_used(handle, 0), outputUsed = this.module._image_zlib_used(handle, 1)
          if (!Number.isInteger(inputUsed) || inputUsed < 0 || inputUsed > input.length ||
              !Number.isInteger(outputUsed) || outputUsed < 0 || outputUsed > output.length)
            throw new Error('Invalid image inflater consumption counters')
          // Re-read HEAPU8 after inflate: its lazy window allocation can grow memory.
          output.set(this.module.HEAPU8.subarray(this.output, this.output + outputUsed))
          const result: ImageInflateStep = { inputUsed, outputUsed, status }
          if (status !== 'ok' && status !== 'end') {
            const reason = this.module._image_zlib_reason(handle)
            if (reason) result.nativeReason = string(this.module, reason)
          }
          return result
        } finally { this.stepping = false }
      },
      close: () => {
        if (closed) return
        closed = true
        this.streams.delete(stream)
        const status = this.module._image_zlib_close(handle)
        if (status !== 0) throw new Error(`Image inflater close failed (${status})`)
      },
    }
    this.streams.add(stream)
    return stream
  }

  inspect() {
    return { active: this.module._image_zlib_stat(0), allocatedBytes: this.module._image_zlib_stat(1),
      peakAllocatedBytes: this.module._image_zlib_stat(2) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const errors: unknown[] = []
    for (const stream of [...this.streams]) try { stream.close() } catch (error) { errors.push(error) }
    this.module._image_zlib_dispose()
    ownedModules.delete(this.module)
    if (errors.length) throw new AggregateError(errors, 'Image inflater cleanup failed', { cause: errors[0] })
  }
}
