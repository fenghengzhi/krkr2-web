/**
 * Filtered PCM source adapted from KRKR2 2.32stable WaveLoopManager::Decode.
 * Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors.
 * Kirikiri original license: public/licenses/phase-vocoder/.
 * Request units freeze their link/crossfade boundary before evaluating labels.
 */
import type { LoopLink, PcmAccess, WaveAsset } from '../ports/audio.ts'
import type { AudioFilterBudget, FilterPcmSource } from './audio-filter-chain.ts'
import { WaveSegmentQueue } from './audio-segments.ts'

const clampFlag = (value: number) => Math.max(0, Math.min(9999, value))
const lowerBound = <T>(items: T[], position: number, key: (item: T) => number): number => {
  let left = 0,
    right = items.length
  while (left < right) {
    const mid = (left + right) >>> 1
    if (key(items[mid]!) < position) left = mid + 1
    else right = mid
  }
  return left
}
const crossfadeCapacity = (asset: WaveAsset) =>
  asset.loops.links.some((link) => link.smooth)
    ? Math.min(asset.sampleCount, Math.floor(asset.sampleRate * 0.025) * 2)
    : 0
export const filteredWaveSourceMemoryBytes = (asset: WaveAsset): number =>
  crossfadeCapacity(asset) * asset.channels * 4

/** No offline asset transformation: each read represents one upstream Decode request. */
export class FilteredWaveSource implements FilterPcmSource {
  private readonly crossfade: Float32Array[]
  private crossfadeLength = 0
  private crossfadePosition = 0
  private decoderPosition: number
  starved = false
  position: number
  constructor(
    readonly asset: WaveAsset,
    position: number,
    readonly flags: number[],
    private readonly looping: () => boolean,
    private readonly budget: () => AudioFilterBudget,
    private readonly access?: PcmAccess,
  ) {
    if (asset.kind === 'stream' && !access) throw new Error('Streaming filtered source requires PCM access')
    this.position = Math.trunc(position)
    if (!Number.isSafeInteger(this.position) || position < 0 || position > asset.sampleCount)
      throw new Error('Filtered source position is outside the stream')
    this.decoderPosition = this.position
    const capacity = crossfadeCapacity(asset)
    this.crossfade = Array.from({ length: asset.channels }, () => new Float32Array(capacity))
  }
  private step(): void {
    if (--this.budget().sourceSteps < 0)
      throw new Error('Audio filter source-control budget exceeded')
  }
  private reserveRead(frames: number): void {
    const budget = this.budget()
    if (frames > budget.sourceFrames) throw new Error('Audio filter source-read budget exceeded')
    budget.sourceFrames -= frames
  }
  private match(link: LoopLink): boolean {
    if (link.whenLooping && !this.looping()) return false
    if (link.variable === -1 || link.condition === 'no') return true
    const value = this.flags[link.variable] ?? 0
    switch (link.condition) {
      case 'eq':
        return value === link.reference
      case 'ne':
        return value !== link.reference
      case 'gt':
        return value > link.reference
      case 'ge':
        return value >= link.reference
      case 'lt':
        return value < link.reference
      case 'le':
        return value <= link.reference
    }
  }
  private nearest(position: number, ignoreConditions = false): LoopLink | undefined {
    const links = this.asset.loops.links
    for (let i = lowerBound(links, position, (link) => link.from); i < links.length; i++) {
      this.step()
      const link = links[i]!
      if (ignoreConditions || this.match(link)) return link
    }
    return undefined
  }
  private expression(name: string): void {
    const match =
      /^:\s*\[\s*(\d+)\s*\]\s*(\+\+|--|\+=|-=|=)\s*(?:(-?\d+)|\[\s*(\d+)\s*\])?\s*$/.exec(name)
    if (!match) return
    const index = Number(match[1]),
      operator = match[2]!,
      indirect = match[4] === undefined ? undefined : Number(match[4])
    if (
      index >= 16 ||
      (indirect !== undefined && indirect >= 16) ||
      (!['++', '--'].includes(operator) && match[3] === undefined && indirect === undefined)
    )
      return
    const previous = this.flags[index]!,
      operand = indirect === undefined ? Number(match[3] ?? 1) : this.flags[indirect]!
    this.flags[index] = clampFlag(
      operator === '='
        ? operand
        : operator === '+=' || operator === '++'
          ? previous + operand
          : previous - operand,
    )
  }
  private sample(channel: number, position: number): number {
    if (position < 0 || position >= this.asset.sampleCount) return 0
    if (this.access) return this.access.sample(channel, position)
    if (this.asset.kind !== 'pcm') throw new Error('Streaming filtered source requires PCM access')
    const data = this.asset.data[channel]!
    if (position < 0 || position >= data.length) return 0
    const index = Math.floor(position),
      fraction = position - index
    return data[index]! * (1 - fraction) + (data[index + 1] ?? data[index]!) * fraction
  }
  private ready(position: number, frames: number): boolean {
    const start = Math.max(0, position), end = Math.min(this.asset.sampleCount, position + frames)
    return end <= start || !this.access || this.access.ready(start, end - start)
  }
  private prepareCrossfade(link: LoopLink): boolean {
    const before = link.from - this.position,
      nearestTarget = this.nearest(link.to, true),
      after = Math.min(
        Math.floor(this.asset.sampleRate * 0.025),
        this.asset.sampleCount - link.from,
        this.asset.sampleCount - link.to,
        nearestTarget ? nearestTarget.from - link.to : Infinity,
      ),
      count = before + after
    if (count > this.crossfade[0]!.length) throw new Error('Audio filter crossfade budget exceeded')
    const firstStart = this.decoderPosition,
      secondStart = link.to - before
    // Request both sides even if the first is missing. Neither decoder cursor
    // nor the crossfade workspace is committed until both ranges are present.
    const firstReady = this.ready(firstStart, count), secondReady = this.ready(secondStart, count)
    if (!firstReady || !secondReady) return false
    this.reserveRead(count * 2)
    for (let frame = 0; frame < count; frame++) {
      this.step()
      // Original DoCrossFade is two separate 0..50 and 50..100 ramps. These
      // normalized Float32 assets use a double-precision blend before storage;
      // native integer Q32 / float32 ramp rounding is not claimed bit-identical.
      const blend = frame < before ? (frame / before) * 0.5 : 0.5 + ((frame - before) / after) * 0.5
      for (let channel = 0; channel < this.asset.channels; channel++)
        this.crossfade[channel]![frame] =
          this.sample(channel, firstStart + frame) * (1 - blend) +
          this.sample(channel, secondStart + frame) * blend
    }
    // Native preparation leaves the real decoder after the target-side read.
    // A later flag change can cancel the logical jump without undoing this read.
    this.decoderPosition = Math.min(this.asset.sampleCount, secondStart + count)
    this.crossfadeLength = count
    this.crossfadePosition = 0
    return true
  }
  read(destination: readonly Float32Array[], frames: number, segments: WaveSegmentQueue): number {
    this.starved = false
    this.reserveRead(frames)
    const base = segments.length
    let written = 0,
      jumpsWithoutProgress = 0,
      committedPosition = this.position,
      committedDecoderPosition = this.decoderPosition
    const starve = () => {
      // Zero-length link traversal belongs to the next request unit. A target
      // page miss must not commit those jumps before any PCM can be read.
      this.position = committedPosition
      this.decoderPosition = committedDecoderPosition
      this.starved = true
      return written
    }
    while (written < frames) {
      this.step()
      const link = this.nearest(this.position)
      let boundary: number | undefined
      if (link) {
        if (link.from === this.position) {
          if (++jumpsWithoutProgress >= 10)
            throw new Error('Audio filter loop makes no forward progress')
          this.position = link.to
          if (!this.crossfadeLength) this.decoderPosition = this.position
          continue
        }
        boundary = link.from
        if (link.smooth) {
          const before = Math.min(Math.floor(this.asset.sampleRate * 0.025), link.from, link.to)
          if (link.from - before > this.position) boundary = link.from - before
          else if (!this.crossfadeLength && !this.prepareCrossfade(link)) return starve()
        }
      }
      // Freeze this request unit before evaluating any flag expressions in it.
      // In particular a newly eligible link behind its end is not retroactive.
      let unit = Math.min(
        frames - written,
        boundary === undefined ? Infinity : boundary - this.position,
      )
      if (this.crossfadeLength) unit = Math.min(unit, this.crossfadeLength - this.crossfadePosition)
      if (unit <= 0) throw new Error('Audio filter loop makes no forward progress')
      if (!this.crossfadeLength && !this.ready(this.decoderPosition, unit)) return starve()
      jumpsWithoutProgress = 0
      const labels = this.asset.loops.labels,
        end = this.position + unit
      for (
        let i = lowerBound(labels, this.position, (label) => label.position);
        i < labels.length && labels[i]!.position < end;
        i++
      ) {
        this.step()
        const label = labels[i]!
        this.expression(label.name)
        // Web normalization: locate the label in actual output once. The fixed
        // native source adds both per-request written and the growing queue
        // length, double-counting earlier units; that legacy quirk is excluded.
        segments.appendLabel(label.name, base + written + label.position - this.position)
      }
      // The native source records the requested unit before Decode reports an
      // EOF-short read. Real cursor/written progress below still uses decoded frames.
      segments.appendSegment({ start: this.position, length: unit, filteredLength: unit })
      if (this.crossfadeLength) {
        for (let channel = 0; channel < this.asset.channels; channel++)
          destination[channel]!.set(
            this.crossfade[channel]!.subarray(
              this.crossfadePosition,
              this.crossfadePosition + unit,
            ),
            written,
          )
        this.crossfadePosition += unit
        this.position += unit
        written += unit
        if (this.crossfadePosition === this.crossfadeLength) {
          this.crossfadeLength = 0
          this.crossfadePosition = 0
        }
      } else {
        const decoded = Math.max(0, Math.min(unit, this.asset.sampleCount - this.decoderPosition))
        for (let frame = 0; frame < decoded; frame++) {
          this.step()
          for (let channel = 0; channel < this.asset.channels; channel++)
            destination[channel]![written + frame] = this.sample(
              channel,
              this.decoderPosition + frame,
            )
        }
        this.position += decoded
        this.decoderPosition += decoded
        written += decoded
        if (decoded !== unit) {
          if (!this.looping() || this.position === 0) break
          this.position = 0
          this.decoderPosition = 0
        }
      }
      committedPosition = this.position
      committedDecoderPosition = this.decoderPosition
    }
    return written
  }
}
