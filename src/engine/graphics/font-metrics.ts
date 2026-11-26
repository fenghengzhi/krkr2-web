import type { Bitmap } from './bitmap.ts'

interface CachedMetrics {
  allocation: WeakRef<object>
  signature: string
  revision: number
  text: string
  width: number
  height: number
  prepared: boolean
}

/** Native BaseBitmap keeps one text measurement, initially ("",0,0).
 * Weak ownership must not retain retired bitmap allocations or Layers. */
export class BitmapFontMetrics {
  private entries = new WeakMap<Bitmap, CachedMetrics>()
  clear(): void { this.entries = new WeakMap() }
  changed(bitmap: Bitmap | undefined, signature?: string): void {
    if (!bitmap) return
    const old = this.entries.get(bitmap)
    if (old && (signature === undefined || signature !== old.signature)) this.entries.delete(bitmap)
  }
  apply(bitmap: Bitmap, signature: string, revision: number): CachedMetrics {
    let current = this.entries.get(bitmap)
    if (!current || current.signature !== signature || current.revision !== revision ||
        current.allocation.deref() !== bitmap.readPixels) {
      // Original ApplyFont detaches a shared bitmap before installing its
      // font. ImagePlane already checks the real allocation budget here.
      bitmap.independ()
      current = { allocation: new WeakRef(bitmap.readPixels), signature, revision, text: '', width: 0, height: 0, prepared: false }
      this.entries.set(bitmap, current)
    }
    return current
  }
  async measure(bitmap: Bitmap, signature: string, revision: () => number, text: string,
    load: () => Promise<{ width: number; height: number }>): Promise<{ width: number; height: number }> {
    if (text.length > 8192) throw new Error('Text exceeds measurement budget')
    const old = this.entries.get(bitmap), entry = this.apply(bitmap, signature, revision())
    if (entry === old && entry.prepared && entry.text === text) return { width: entry.width, height: entry.height }
    // Even the first empty lookup applies/prepares the real font; it simply
    // does not replace the native empty-text cache's initial zero metrics.
    const measured = await load(), result = entry.text === text
      ? { width: entry.width, height: entry.height } : measured
    if (this.entries.get(bitmap) === entry && entry.allocation.deref() === bitmap.readPixels) {
      entry.revision = revision()
      entry.text = text; entry.width = result.width; entry.height = result.height
      entry.prepared = true
    }
    return { ...result }
  }
}
