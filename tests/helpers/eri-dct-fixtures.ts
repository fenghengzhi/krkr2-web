// Author recognizable constant-color quadrants directly in frequency space.
// Chroma U=8 and V=-8 give exact RGB offsets +14,+3,-12. A separate
// first-horizontal-AC case has a closed-form cosine independent of the decoder.
import { EriFixtureBits, eriFixtureContainer, eriFixtureWords } from './eri-truecolor-fixtures.ts'
import { ForwardTree, statsFor } from './eri-huffman-fixtures.ts'

interface DctFixture {
  name: string; width: number; height: number; degree: number; sampling: number
  alpha?: boolean; positive?: boolean; inline?: boolean; ac?: boolean; chromaAC?: boolean; huffman?: boolean
}

const shapes: DctFixture[] = [
  { name: 'dct-444.eri', width: 19, height: 18, degree: 3, sampling: 0x40404 },
  { name: 'dct-422-alpha.eri', width: 18, height: 17, degree: 4, sampling: 0x40202, positive: true, alpha: true },
  { name: 'dct-411-ac.eri', width: 9, height: 5, degree: 5, sampling: 0x40101, ac: true },
  { name: 'dct-422-chroma.eri', width: 17, height: 16, degree: 3, sampling: 0x40202, chromaAC: true, huffman: true },
  { name: 'dct-inline-gamma.eri', width: 17, height: 9, degree: 3, sampling: 0x40101, ac: true, inline: true },
  { name: 'dct-inline.eri', width: 18, height: 9, degree: 3, sampling: 0x40101, ac: true, inline: true, huffman: true },
]

function build(shape: DctFixture) {
  const { width, height, degree, sampling, alpha, inline, positive, ac } = shape
  const size = 2 ** degree, macro = size * 2, across = Math.ceil(width / macro), down = Math.ceil(height / macro),
    colors = sampling === 0x40404 ? 12 : sampling === 0x40202 ? 8 : 6, count = colors + (alpha ? 4 : 0),
    bits = new EriFixtureBits(), stats = statsFor(across * down), tree = new ForwardTree(stats)
  const dc: number[][] = [], spectra: number[][] = []
  const luma = (blockX: number, blockY: number, quadrant: number) => 32 + blockX * 16 + blockY * 24 + quadrant * 8
  for (let by = 0; by < down; by++) {
    const previous = Array<number>(count).fill(0)
    for (let bx = 0; bx < across; bx++) {
      const values = Array.from({ length: count }, (_, p) => p < 4 ? luma(bx, by, p)
        : p < 4 + (colors - 4) / 2 ? 8 : p < colors ? -8 : 128 + 8 * (p - colors))
      // In the last 444 quadrant choose U=2, V=1. The even-valued Y then
      // makes all three native channels exact ties before the byte store.
      if (sampling === 0x40404) { values[7] = 2; values[11] = 1 }
      dc.push(values.map((value, p) => {
        const delta = value - previous[p]!
        previous[p] = value
        return delta
      }))
      const frequencies = Array<number>((size * size - 1) * count).fill(0)
      if (ac) for (let q = 0; q < 4; q++) frequencies[q] = 16
      // Frequency (0,1) varies the V signal vertically. The 422 layout packs
      // the two horizontal quadrants into successive halves of one plane.
      if (shape.chromaAC) frequencies[count + 6] = frequencies[count + 7] = 12
      spectra.push(frequencies)
    }
  }
  const scaleCode = 512 / size - 1 // 2/N * 256/(code+1) == 1
  bits.put(9, 8); bits.put(0, 8); bits.put(inline ? 0 : 1, 8); bits.put(8, 8)
  bits.put(0, 1); bits.put(scaleCode, 8); bits.put(scaleCode, 8)
  function writeScales() { for (let i = 0; i < 4; i++) tree.write(scaleCode, bits, false, stats) }
  const acTrees = new Map<number, ForwardTree>()
  let context = 0
  function treeFor(id: number) {
    let value = acTrees.get(id)
    if (!value) acTrees.set(id, value = new ForwardTree(stats))
    return value
  }
  function writeAC(samples: number[]) {
    if (!shape.huffman) { bits.runs(samples); return }
    for (let at = 0; at < samples.length;) {
      const value = samples[at++]! & 255
      treeFor(context).write(value, bits, false, stats)
      context = value
      if (value === 0) {
        const start = at - 1
        while (at < samples.length && samples[at] === 0) at++
        treeFor(256).write(at - start, bits, true, stats)
      }
    }
  }
  if (inline) for (let i = 0; i < dc.length; i++) {
    bits.runs(dc[i]!); writeScales(); writeAC(spectra[i]!)
  } else {
    bits.runs(dc.flat())
    for (let i = 0; i < dc.length; i++) writeScales()
    writeAC(spectra.flat())
  }
  const info = eriFixtureWords(shape.huffman ? 0x20200 : 0x20100, 1, shape.huffman ? 0xfffffffc : 0xffffffff, alpha ? 0x04000001 : 1, width, positive ? height : -height,
    alpha ? 32 : 24, 0, sampling, 0, 0, 0, 0, degree, 0, 0, 0)
  const rgba: number[] = [], gray: number[] = []
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const physicalY = positive ? height - 1 - y : y, q = 2 * Math.floor((physicalY % macro) / size) + Math.floor((x % macro) / size)
    const brightness = luma(Math.floor(x / macro), Math.floor(physicalY / macro), q) +
      (ac ? Math.round(16 * Math.cos((2 * (x % size) + 1) * Math.PI / (2 * size))) : 0)
    const chromaY = (q & 1) * (size / 2) + Math.floor((physicalY % size) / 2)
    const v = -8 + (shape.chromaAC ? 12 * Math.cos((2 * chromaY + 1) * Math.PI / (2 * size)) : 0)
    const raw = sampling === 0x40404 && q === 3 ? [brightness + 4, brightness - 2, brightness + 2]
      : [brightness + 14, Math.round(brightness - 3 - 0.75 * v), Math.round(brightness + 1.5 * v)],
      opacity = alpha ? 128 + q * 8 : 255
    rgba.push(...raw.map((v) => Math.min(255, Math.floor(v * 255 / opacity))), opacity)
    const intensity = (raw[0]! * 54 + raw[1]! * 183 + raw[2]! * 19) >> 8
    gray.push(intensity, intensity, intensity, 255)
  }
  return { ...shape, bytes: eriFixtureContainer(info, bits.bytes()), rgba, gray }
}

export const eriDctCases = shapes.map(build)
export function eriDctFiles(): Record<string, Uint8Array> {
  return Object.fromEntries(eriDctCases.map(({ name, bytes }) => [name, bytes]))
}
