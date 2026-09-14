/** Only unfinished creates are retained. Removing a ticket cancels its future
 * publication without retaining a tombstone for every sound ever closed. */
export class VoiceOperations {
  private readonly pending = new Map<number, object>()
  get count(): number {
    return this.pending.size
  }
  begin(id: number): object {
    const ticket = {}
    this.pending.set(id, ticket)
    return ticket
  }
  assertCurrent(id: number, ticket: object): void {
    if (this.pending.get(id) !== ticket)
      throw new Error('Audio voice operation was closed or superseded')
  }
  finish(id: number, ticket: object): void {
    if (this.pending.get(id) === ticket) this.pending.delete(id)
  }
  cancel(id: number): void {
    this.pending.delete(id)
  }
  clear(): void {
    this.pending.clear()
  }
}
