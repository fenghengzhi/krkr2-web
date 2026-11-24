import {
  IMAGE_JPEG_MAX_DIMENSION, IMAGE_JPEG_MAX_INPUT, IMAGE_JPEG_MAX_OUTPUT, IMAGE_JPEG_MAX_STREAMS,
  type ImageJpegDecoder, type ImageJpegKernel as KernelPort, type ImageJpegMode,
  type ImageJpegPhase, type ImageJpegPrecision, type ImageJpegStep,
} from '../../engine/ports/image-jpeg.ts'

export interface ImageJpegModule {
  HEAPU8: Uint8Array
  _image_jpeg_abi(): number
  _image_jpeg_version(): number
  _image_jpeg_version_string(): number
  _image_jpeg_input(): number
  _image_jpeg_output(): number
  _image_jpeg_open(mode: number, precision: number, limit: number): number
  _image_jpeg_open_reason(): number
  _image_jpeg_step(handle: number, inputSize: number, eof: number): number
  _image_jpeg_value(handle: number, kind: number): number
  _image_jpeg_reason(handle: number): number
  _image_jpeg_close(handle: number): number
  _image_jpeg_dispose(): void
  _image_jpeg_stat(kind: number): number
}

const exports = ['abi', 'version', 'version_string', 'input', 'output', 'open', 'open_reason',
  'step', 'value', 'reason', 'close', 'dispose', 'stat'] as const
const statuses: readonly ImageJpegStep['status'][] = ['progress', 'size', 'rows', 'done', 'codec-error', 'budget-error']
const phases: readonly ImageJpegPhase[] = ['header', 'start', 'rows', 'finish', 'complete']
const owners = new WeakSet<ImageJpegModule>()
const allocationBudget = 128 * 1024 * 1024

function text(module: ImageJpegModule, pointer: number): string {
  const heap = module.HEAPU8
  if (!Number.isInteger(pointer) || pointer < 1 || pointer >= heap.length) throw new Error('Invalid image JPEG string')
  let value = ''
  for (let at = pointer; at < heap.length && at < pointer + 256; at++) {
    const byte = heap[at]!
    if (!byte) return value
    value += String.fromCharCode(byte)
  }
  throw new Error('Unterminated image JPEG string')
}

/** One independently instantiated module belongs to one kernel owner. Native
 * steps never await or invoke JS; every published row group is an owned copy. */
export class ImageJpegKernel implements KernelPort {
  private readonly streams = new Set<ImageJpegDecoder>()
  private readonly input: number
  private readonly output: number
  private readonly allocationLimit: number
  private stepping = false
  private disposed = false

  constructor(private readonly module: ImageJpegModule, options: { allocationLimit?: number } = {}) {
    for (const name of exports)
      if (typeof module[`_image_jpeg_${name}`] !== 'function') throw new Error(`Image JPEG export missing: ${name}`)
    if (module._image_jpeg_abi() !== 1 || module._image_jpeg_version() !== 62 ||
        text(module, module._image_jpeg_version_string()) !== '6b  27-Mar-1998')
      throw new Error('Image JPEG ABI/version mismatch')
    this.input = module._image_jpeg_input()
    this.output = module._image_jpeg_output()
    if (!Number.isInteger(this.input) || this.input < 1 || !Number.isInteger(this.output) || this.output < 1 ||
        this.input + IMAGE_JPEG_MAX_INPUT > module.HEAPU8.length || this.output + IMAGE_JPEG_MAX_OUTPUT > module.HEAPU8.length)
      throw new Error('Invalid image JPEG scratch bounds')
    this.allocationLimit = options.allocationLimit ?? allocationBudget
    if (!Number.isSafeInteger(this.allocationLimit) || this.allocationLimit < 0 || this.allocationLimit > allocationBudget)
      throw new RangeError('Invalid image JPEG allocation limit')
    if (owners.has(module)) throw new Error('Image JPEG module already has a kernel owner')
    owners.add(module)
  }

  open(mode: ImageJpegMode, precision: ImageJpegPrecision): ImageJpegDecoder {
    if (this.disposed) throw new Error('Image JPEG kernel is disposed')
    if (mode !== 'normal' && mode !== 'grayscale') throw new Error('Invalid image JPEG decode mode')
    const precisionCode = ['low', 'normal', 'high'].indexOf(precision)
    if (precisionCode < 0) throw new Error('Invalid image JPEG precision')
    if (this.streams.size >= IMAGE_JPEG_MAX_STREAMS) throw new Error('Image JPEG exceeds 64 active decoders')
    const token = this.module._image_jpeg_open(Number(mode === 'grayscale'), precisionCode, this.allocationLimit) >>> 0
    if (!token) {
      const reason = this.module._image_jpeg_open_reason()
      throw new Error(reason ? text(this.module, reason) : 'Image JPEG initialization failed')
    }
    let closed = false
    const stream: ImageJpegDecoder = {
      step: (input, eof) => {
        if (closed || this.disposed) throw new Error('Image JPEG decoder is closed')
        if (!(input instanceof Uint8Array) || input.byteLength > IMAGE_JPEG_MAX_INPUT || typeof eof !== 'boolean')
          throw new RangeError('Invalid image JPEG input window')
        if (input.buffer === this.module.HEAPU8.buffer) throw new Error('Image JPEG input must be caller-owned')
        if (this.stepping) throw new Error('Image JPEG cannot reenter a synchronous step')
        this.stepping = true
        try {
          this.module.HEAPU8.set(input, this.input)
          const statusCode = this.module._image_jpeg_step(token, input.length, Number(eof)), status = statuses[statusCode]
          if (!status) throw new Error(`Invalid image JPEG input/state (${statusCode})`)
          const read = (kind: number) => {
            const value = this.module._image_jpeg_value(token, kind)
            if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid image JPEG result counter')
            return value
          }, inputUsed = read(0), needsInput = read(1), phase = phases[read(2)], width = read(3), height = read(4),
            startRow = read(5), rowCount = read(6), code = read(7), count = read(8), lastCode = read(9), outputBytes = read(10)
          if (inputUsed > input.length || needsInput > 1 || !phase || width > IMAGE_JPEG_MAX_DIMENSION || height > IMAGE_JPEG_MAX_DIMENSION ||
              outputBytes > IMAGE_JPEG_MAX_OUTPUT || (status !== 'rows' && outputBytes !== 0))
            throw new Error('Invalid image JPEG result bounds')
          const result: ImageJpegStep = { inputUsed, needsInput: !!needsInput, phase, status,
            warnings: { count, ...(lastCode ? { lastCode } : {}) } }
          if (status === 'size' || status === 'rows') {
            if (!width || !height) throw new Error('Image JPEG omitted its output dimensions')
            result.width = width; result.height = height
          }
          if (status === 'rows') {
            if (!rowCount || rowCount > 2 || startRow + rowCount > height || outputBytes !== width * 4 * rowCount)
              throw new Error('Invalid image JPEG row group')
            result.startRow = startRow; result.rowCount = rowCount
            // The JPEG pools may have grown linear memory during this step.
            // Read the fresh view, then copy before any later call mutates it.
            result.data = new Uint8Array(this.module.HEAPU8.subarray(this.output, this.output + outputBytes))
          } else if (status === 'codec-error') {
            if (!code) throw new Error('Image JPEG omitted its native error code')
            result.code = code
          } else if (status === 'budget-error') {
            const reason = this.module._image_jpeg_reason(token)
            result.budgetReason = reason ? text(this.module, reason) : 'JPEG native budget exceeded'
          }
          return result
        } finally { this.stepping = false }
      },
      close: () => {
        if (closed) return
        if (this.stepping) throw new Error('Image JPEG cannot close during a synchronous step')
        closed = true; this.streams.delete(stream)
        if (this.module._image_jpeg_close(token) !== 0) throw new Error('Image JPEG native cleanup failed')
      },
    }
    this.streams.add(stream)
    return stream
  }

  inspect() {
    return { active: this.module._image_jpeg_stat(0), allocatedBytes: this.module._image_jpeg_stat(1),
      peakAllocatedBytes: this.module._image_jpeg_stat(2) }
  }

  dispose(): void {
    if (this.disposed) return
    if (this.stepping) throw new Error('Image JPEG cannot dispose during a synchronous step')
    this.disposed = true
    const failures: unknown[] = []
    for (const stream of [...this.streams]) try { stream.close() } catch (error) { failures.push(error) }
    try { this.module._image_jpeg_dispose() } catch (error) { failures.push(error) }
    owners.delete(this.module)
    if (failures.length) throw new AggregateError(failures, 'Image JPEG cleanup failed', { cause: failures[0] })
  }
}
