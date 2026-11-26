/** WaveLoopManager::TVPCrossFadeIntegerBlend / DoCrossFade, KRKR2 2.32.
 * Copyright (C) 2000 W.Dee and contributors. Original license and source:
 * public/licenses/phase-vocoder/ and third_party/phase-vocoder/.
 * The Web decoder already owns normalized Float32 planes. Integer containers
 * through 24 bits can be recovered exactly; a 32-bit source's lost low bits
 * cannot be restored. Undeclared/float64 sources retain the old normalized
 * extension, rather than pretending to know their original storage format. */
import type { PcmEncoding } from '../ports/audio.ts'

const unit = 0x100000000

/** floor(signed32 * unsigned-Q32 / 2^32), without a rounded 64-bit JS product. */
function highProduct(value: number, ratio: number): number {
  if (ratio === 0) return 0
  if (ratio === unit) return value
  const magnitude = Math.abs(value), ah = Math.floor(magnitude / 65536), al = magnitude % 65536,
    bh = Math.floor(ratio / 65536), bl = ratio % 65536, low = al * bl,
    middle = ah * bl + al * bh + Math.floor(low / 65536),
    high = ah * bh + Math.floor(middle / 65536)
  return value < 0 ? -high - (low % 65536 || middle % 65536 ? 1 : 0) : high
}

export function integerCrossfade(first: number, second: number, ratio: number, containerBits: number, validBits: number): number {
  const scale = 2 ** (containerBits - 1), padding = 2 ** (containerBits - validBits),
    a = Math.max(-scale, Math.min(scale - 1, Math.round(first * scale))),
    b = Math.max(-scale, Math.min(scale - 1, Math.round(second * scale))),
    mixed = highProduct(b, ratio) + highProduct(a, unit - ratio),
    wrapped = containerBits === 32 ? mixed | 0 : (mixed << (32 - containerBits)) >> (32 - containerBits)
  return Math.floor(wrapped / padding) / (scale / padding)
}

export function fillWaveCrossfade(destination: readonly Float32Array[], firstStart: number, secondStart: number,
  before: number, after: number, encoding: PcmEncoding | undefined, validBits: number,
  sample: (channel: number, position: number) => number, step: () => void): void {
  const integerBits = encoding === 'u8' ? 8 : encoding?.startsWith('s') ? Number(encoding.slice(1)) : undefined
  for (const half of [0, 1]) {
    const count = half ? after : before, start = half ? before : 0
    if (!count) continue
    const increment = integerBits ? Math.floor(0x80000000 / count) : Math.fround(0.5 / count)
    let ratio = integerBits ? half * 0x80000000 : half * 0.5
    for (let at = 0; at < count; at++) {
      step()
      for (let channel = 0; channel < destination.length; channel++) {
        const a = sample(channel, firstStart + start + at), b = sample(channel, secondStart + start + at)
        if (integerBits) destination[channel]![start + at] = integerCrossfade(a, b, ratio, integerBits, validBits)
        else if (encoding === 'f32') destination[channel]![start + at] = a + (b - a) * ratio
        else {
          const normalized = half * 0.5 + at / count * 0.5
          destination[channel]![start + at] = a * (1 - normalized) + b * normalized
        }
      }
      ratio = integerBits ? ratio + increment : Math.fround(ratio + increment)
    }
  }
}
