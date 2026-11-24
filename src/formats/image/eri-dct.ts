// ERINA-Library 1.0A, common/experi.cpp and cpp/experib.cpp. Copyright (C)
// 2000-2002 Leshade Entis, Entis-soft. Attribution and distribution terms in
// docs/decisions/119-eri-png-and-hosted-codecs.md.
import { EriHuffmanData, EriHuffmanTree, readEriOperation } from './eri-huffman.ts'
import { EriInverseDct } from './eri-idct.ts'
import { GammaRuns, type EriBitSource } from './eri-truecolor.ts'
import { ImageDecodeError } from './selection.ts'

const sampling444 = 0x40404, sampling422 = 0x40202, sampling411 = 0x40101
const f32 = Math.fround

function zigzag(size: number): Uint16Array {
  const map = new Uint16Array(size * size)
  let at = 0
  for (let diagonal = 0; diagonal <= 2 * (size - 1); diagonal++) {
    const min = Math.max(0, diagonal - size + 1), max = Math.min(size - 1, diagonal)
    for (let i = min; i <= max; i++) {
      const x = diagonal % 2 ? max + min - i : i
      map[at++] = (diagonal - x) * size + x
    }
  }
  return map
}

// The original x86 byte store rounds to nearest with even ties before saturating.
function byte(value: number): number {
  if (value <= 0) return 0
  if (value >= 255) return 255
  const lower = Math.floor(value)
  return value - lower === 0.5 ? lower + (lower & 1) : Math.round(value)
}

interface DctShape {
  width: number; height: number; degree: number; sampling: number; alpha: boolean; huffman: boolean
}

function storeBlock(image: Uint8Array, planes: Float32Array[], shape: DctShape, size: number,
  left: number, top: number, colorPlanes: number): void {
  const { width, height, sampling, alpha } = shape
  const chromaPlanes = (colorPlanes - 4) / 2, mask = size - 1
  for (let y = 0; y < Math.min(2 * size, height - top); y++) {
    for (let x = 0; x < Math.min(2 * size, width - left); x++) {
      const quadrant = (y >= size ? 2 : 0) + (x >= size ? 1 : 0)
      const index = (y & mask) * size + (x & mask)
      let chromaPlane = 4, chromaIndex = index
      if (sampling === sampling444) chromaPlane += quadrant
      else if (sampling === sampling422) {
        chromaPlane += quadrant >> 1
        chromaIndex = ((quadrant & 1) * (size / 2) + ((y & mask) >> 1)) * size + (x & mask)
      } else chromaIndex = (y >> 1) * size + (x >> 1)
      const luma = planes[quadrant]![index]!, u = planes[chromaPlane]![chromaIndex]!,
        v = planes[chromaPlane + chromaPlanes]![chromaIndex]!, at = ((top + y) * width + left + x) * 4
      image[at] = byte(f32(luma + f32(1.5 * v)))
      image[at + 1] = byte(f32(f32(luma - f32(0.75 * v)) - f32(0.375 * u)))
      image[at + 2] = byte(f32(luma + f32(1.75 * u)))
      image[at + 3] = alpha ? byte(planes[colorPlanes + quadrant]![index]!) : 255
    }
  }
}

export function* decodeEriDct(bits: EriBitSource, shape: DctShape): Generator<void, Uint8Array> {
  const { width, height, degree, sampling, alpha, huffman } = shape
  const colorPlanes = sampling === sampling444 ? 12 : sampling === sampling422 ? 8 : sampling === sampling411 ? 6 : 0
  if (!colorPlanes || degree < 3 || degree > 5) throw new ImageDecodeError('eri', 'ERIDecoder::Initialize failed.')
  const version = bits.take(8), operations = bits.take(8), encoding = bits.take(8), bitCount = bits.take(8)
  if (version !== 9 || operations !== 0 || encoding > 1 || bitCount !== 8 || bits.next() !== 0)
    throw new ImageDecodeError('eri', 'ERIDecoder::DecodeImage failed.')
  const size = 2 ** degree, area = size * size, planeCount = colorPlanes + (alpha ? 4 : 0),
    across = Math.ceil(width / (2 * size)), down = Math.ceil(height / (2 * size)), blocks = across * down,
    matrixScale = 2 / size, scale = (code: number) => f32(matrixScale * 256 / (code + 1)),
    lumaDC = scale(bits.take(8)), chromaDC = scale(bits.take(8)), order = zigzag(size),
    highStart = (size - 1) * size / 2, transform = new EriInverseDct(size)
  // At the outer 4096² bound the image is 64 MiB and the largest optional
  // DC/scale tables total 4.25 MiB. Only one macroblock of spectra is retained.
  const image = new Uint8Array(width * height * 4), work = { value: 0 }, gamma = new GammaRuns(bits),
    tree = new EriHuffmanTree(work), huffmanData = huffman ? new EriHuffmanData(bits, work) : undefined,
    dc = new Int32Array((encoding ? blocks : 1) * planeCount), coefficients = new Uint8Array((encoding ? blocks : 1) * 4),
    ac = new Int32Array((area - 1) * planeCount), predictor = new Int32Array(planeCount),
    planes = Array.from({ length: planeCount }, () => new Float32Array(area))
  if (encoding) {
    gamma.initialize()
    yield* gamma.read(dc)
    for (let i = 0; i < coefficients.length; i++) {
      coefficients[i] = readEriOperation(tree, bits)
      if (work.value >= 4096) { work.value = 0; yield }
    }
    if (!huffman) gamma.initialize()
  }
  for (let by = 0; by < down; by++) {
    predictor.fill(0)
    for (let bx = 0; bx < across; bx++) {
      const block = encoding ? by * across + bx : 0
      if (!encoding) {
        gamma.initialize()
        yield* gamma.read(dc)
        for (let i = 0; i < 4; i++) coefficients[i] = readEriOperation(tree, bits)
        if (!huffman) gamma.initialize()
      }
      if (huffmanData) yield* huffmanData.read(ac, !encoding || block === 0 ? gamma.pending : undefined)
      else yield* gamma.read(ac)
      const at = block * 4, lumaLow = scale(coefficients[at]!), chromaLow = scale(coefficients[at + 1]!),
        lumaHigh = scale(coefficients[at + 2]!), chromaHigh = scale(coefficients[at + 3]!)
      for (let p = 0; p < planeCount; p++) {
        const chroma = p >= 4 && p < colorPlanes, plane = planes[p]!,
          low = chroma ? chromaLow : lumaLow, high = chroma ? chromaHigh : lumaHigh
        predictor[p] = predictor[p]! + dc[block * planeCount + p]!
        plane[0] = predictor[p]! * (chroma ? chromaDC : lumaDC)
        let hasAC = false
        for (let i = 1; i < area; i++) {
          const value = ac[(i - 1) * planeCount + p]!
          plane[order[i]!] = value * (i < highStart ? low : high)
          if (value !== 0) hasAC = true
        }
        if (hasAC) transform.transform(plane)
        else plane.fill(plane[0]!)
        if (degree === 5 && (p & 3) === 3) yield
      }
      storeBlock(image, planes, shape, size, bx * size * 2, by * size * 2, colorPlanes)
      yield
    }
  }
  return image
}
