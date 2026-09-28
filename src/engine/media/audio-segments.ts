/**
 * Adapted from KRKR2 2.32stable / Risa WaveSegmentQueue.
 * Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors.
 * Kirikiri original license: public/licenses/phase-vocoder/.
 * The TypeScript adaptation uses bounded queues; original bytes and provenance
 * are retained in third_party/phase-vocoder/.
 */
export interface WaveSegment {
  start: number
  length: number
  filteredLength: number
}
export interface WaveLabel {
  offset: number
  name: string
}
// At most 16 live stages, each with a fixed number of queues. This separate
// metadata ceiling is not part of the typed-array/DSP byte reservation.
const maximumEntries = 4096
export class WaveSegmentQueue {
  private segments: WaveSegment[] = []
  private labels: WaveLabel[] = []
  private segmentHead = 0
  private labelHead = 0
  private labelBase = 0
  length = 0
  clear(): void {
    this.segments = []
    this.labels = []
    this.segmentHead = this.labelHead = this.labelBase = this.length = 0
  }
  appendSegment(segment: WaveSegment): void {
    if (segment.length <= 0 || segment.filteredLength <= 0) return
    const previous = this.segments.at(-1)
    if (
      previous &&
      this.segmentHead < this.segments.length &&
      previous.start + previous.length === segment.start &&
      previous.filteredLength / previous.length === segment.filteredLength / segment.length
    ) {
      previous.length += segment.length
      previous.filteredLength += segment.filteredLength
    } else {
      if (this.segments.length - this.segmentHead >= maximumEntries)
        throw new Error('Audio filter segment budget exceeded')
      this.segments.push({ ...segment })
    }
    this.length += segment.filteredLength
  }
  appendSourceFrame(position: number): void {
    const previous = this.segments.at(-1)
    if (
      previous &&
      this.segmentHead < this.segments.length &&
      previous.start + previous.length === position &&
      previous.length === previous.filteredLength
    ) {
      previous.length++
      previous.filteredLength++
      this.length++
    } else this.appendSegment({ start: position, length: 1, filteredLength: 1 })
  }
  appendLabel(name: string, offset = this.length): void {
    if (this.labels.length - this.labelHead >= maximumEntries)
      throw new Error('Audio filter label budget exceeded')
    this.labels.push({ name, offset: offset + this.labelBase })
  }
  append(queue: WaveSegmentQueue): void {
    for (let i = queue.labelHead; i < queue.labels.length; i++) {
      const label = queue.labels[i]!
      this.appendLabel(label.name, this.length + label.offset - queue.labelBase)
    }
    for (let i = queue.segmentHead; i < queue.segments.length; i++)
      this.appendSegment(queue.segments[i]!)
  }
  /** Boundary labels stay in this queue, as in tTVPWaveSegmentQueue::Dequeue. */
  take(frames: number, destination: WaveSegmentQueue): void {
    destination.clear()
    let remaining = frames
    while (this.segmentHead < this.segments.length && remaining > 0) {
      const segment = this.segments[this.segmentHead]!
      if (segment.filteredLength <= remaining) {
        destination.appendSegment(segment)
        remaining -= segment.filteredLength
        this.length -= segment.filteredLength
        this.segmentHead++
      } else {
        const sourceFrames = Math.trunc((segment.length / segment.filteredLength) * remaining)
        destination.appendSegment({
          start: segment.start,
          length: sourceFrames,
          filteredLength: remaining,
        })
        segment.start += sourceFrames
        segment.length -= sourceFrames
        segment.filteredLength -= remaining
        this.length -= remaining
        if (!segment.length || !segment.filteredLength) this.segmentHead++
        remaining = 0
      }
    }
    const boundary = this.labelBase + frames
    while (this.labelHead < this.labels.length && this.labels[this.labelHead]!.offset < boundary) {
      const label = this.labels[this.labelHead++]!
      destination.appendLabel(label.name, label.offset - this.labelBase)
    }
    this.labelBase = boundary
    this.compact()
  }
  /** Scale cumulative ends, rather than rounding every segment independently. */
  scale(frames: number): void {
    if (!this.length) return
    const previousLength = this.length
    let oldEnd = 0,
      newEnd = 0
    const scaled: WaveSegment[] = []
    for (let i = this.segmentHead; i < this.segments.length; i++) {
      const segment = this.segments[i]!
      oldEnd += segment.filteredLength
      const end = Math.trunc((oldEnd / previousLength) * frames)
      if (end > newEnd && segment.length) scaled.push({ ...segment, filteredLength: end - newEnd })
      newEnd = end
    }
    this.segments = scaled
    this.segmentHead = 0
    this.length = frames
    for (let i = this.labelHead; i < this.labels.length; i++) {
      const label = this.labels[i]!
      label.offset = Math.trunc(((label.offset - this.labelBase) * frames) / previousLength)
    }
    if (this.labelHead) this.labels = this.labels.slice(this.labelHead)
    this.labelHead = this.labelBase = 0
  }
  positionAt(frame: number): number {
    let offset = 0
    for (let i = this.segmentHead; i < this.segments.length; i++) {
      const segment = this.segments[i]!
      if (frame >= offset && frame < offset + segment.filteredLength)
        return Math.trunc(
          segment.start + ((frame - offset) * segment.length) / segment.filteredLength,
        )
      offset += segment.filteredLength
    }
    if (frame < 0 || this.segmentHead >= this.segments.length) return 0
    const last = this.segments.at(-1)!
    return last.start + last.length
  }
  emitThrough(frame: number, inclusive: boolean, emit: (label: WaveLabel) => void): void {
    while (this.labelHead < this.labels.length) {
      const label = this.labels[this.labelHead]!,
        offset = label.offset - this.labelBase
      if (offset > frame || (!inclusive && offset === frame)) break
      this.labelHead++
      emit({ name: label.name, offset })
    }
  }
  private compact(): void {
    if (this.segmentHead > 1024 && this.segmentHead * 2 >= this.segments.length) {
      this.segments = this.segments.slice(this.segmentHead)
      this.segmentHead = 0
    }
    if (this.labelHead > 1024 && this.labelHead * 2 >= this.labels.length) {
      this.labels = this.labels.slice(this.labelHead)
      this.labelHead = 0
    }
  }
}
