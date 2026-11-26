/** A layer owns its dimensions and a reference to the pixel allocation.
 * Only assigned images need a first-write check against other live layers. */
export type CheckImageShare = (data: Uint8Array, writer: ImagePlane) => boolean
// A raw mutable view may outlive the call that borrowed it. Preserve that
// owner's writes while keeping future assigned images isolated.
const mutableViews = new WeakSet<Uint8Array>()
export class ImagePlane {
  protected storage: { width: number; height: number; data: Uint8Array }
  private checkShare?: CheckImageShare
  constructor(width: number, height: number, data: Uint8Array) {
    this.storage = { width, height, data }
  }
  get width(): number { return this.storage.width }
  get height(): number { return this.storage.height }
  get bytes(): number { return this.storage.data.length }
  get hasMutableView(): boolean { return mutableViews.has(this.storage.data) }
  protected expose() {
    this.independ()
    mutableViews.add(this.storage.data)
    return this.storage
  }
  protected shareWith(other: ImagePlane, check: CheckImageShare): void {
    if (this.hasMutableView) {
      other.storage = { ...this.storage, data: this.storage.data.slice() }
      return
    }
    other.storage = this.storage
    other.checkShare = this.checkShare = check
  }
  independ(copy = true): boolean {
    if (!this.checkShare) return false
    const { width, height, data } = this.storage
    const shared = this.checkShare(data, this)
    if (shared) this.storage = { width, height, data: copy ? data.slice() : new Uint8Array(data.length) }
    this.checkShare = undefined
    return shared
  }
}
