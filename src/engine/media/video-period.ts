/** VideoOvlImpl.cpp SetPeriodEvent, SetFrame, Rewind and EC_UPDATE.
 * The cue belongs to the VideoOverlay object, independently of a media graph.
 * A millisecond seek does not change its past state. */
export class VideoPeriod {
  constructor(public frame = -1, public past = false) {}
  set(frame: number, currentFrame: number): void {
    this.frame = frame
    this.past = frame <= currentFrame
  }
  seekFrame(frame: number): void {
    if (this.frame >= frame && this.past) this.past = false
  }
  rewind(): void {
    if (this.frame >= 0 && this.past) this.past = false
  }
  take(frame: number): boolean {
    if (this.frame < 0 || this.past || frame < this.frame) return false
    this.frame = -1
    return true
  }
}
