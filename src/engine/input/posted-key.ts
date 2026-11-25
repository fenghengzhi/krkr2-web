/** WindowForm accumulates byte-sized posted character codes independently per
 * Window. The Web platform chooses CP932; this is independent of script-file
 * encoding and does not claim to discover another platform's Win32 CP_ACP. */
export class PostedKeyBytes {
  private pending = new Map<number, number>()
  push(window: number, key: number): Uint8Array | undefined {
    const byte = key & 255
    if (!byte) return undefined // FormKeyPress ignores NUL before its pending buffer.
    const lead = this.pending.get(window)
    if (lead === undefined && ((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc))) {
      this.pending.set(window, byte); return undefined
    }
    this.pending.delete(window)
    // Decode failures propagate. Never emulate the original invalid-pair path
    // that could read an uninitialized wchar_t, or grow pending data forever.
    return Uint8Array.from(lead === undefined ? [byte] : [lead, byte])
  }
  retire(window: number): void { this.pending.delete(window) }
  clear(): void { this.pending.clear() }
}
