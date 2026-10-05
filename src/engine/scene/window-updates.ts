/** Fixed KRKR2 EventIntf window-update queue. Entries already visited during a
 * delivery still count toward the two-entry limit until the whole round ends.
 * The queue owns numeric identities only, never a script Window reference. */
export class WindowUpdates {
  private entries: number[] = []
  private counts = new Map<number, number>()
  private at = 0
  delivering = false
  get pending(): boolean { return this.entries.some((id) => id !== 0) }
  post(windowId: number): void {
    const count = this.counts.get(windowId) ?? 0
    if (count >= (this.delivering ? 2 : 1)) return
    this.counts.set(windowId, count + 1)
    this.entries.push(windowId)
  }
  remove(windowId: number): void {
    this.entries = this.entries.map((id) => id === windowId ? 0 : id)
    this.counts.delete(windowId)
    if (!this.delivering) this.entries = this.entries.filter(Boolean)
  }
  begin(): boolean {
    if (this.delivering) return false
    this.delivering = true
    this.at = 0
    return true
  }
  next(): number | undefined {
    while (this.at < this.entries.length) {
      const id = this.entries[this.at++]!
      if (id) return id
    }
    return undefined
  }
  finish(): void {
    this.entries = []; this.counts.clear(); this.at = 0; this.delivering = false
  }
}
