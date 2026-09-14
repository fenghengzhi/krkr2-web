export class BinaryReader {
  private readonly view: DataView
  position = 0
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  get remaining(): number {
    return this.bytes.length - this.position
  }
  private take(size: number): number {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining)
      throw new Error('Truncated or invalid binary data')
    const start = this.position
    this.position += size
    return start
  }
  u8(): number {
    return this.view.getUint8(this.take(1))
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true)
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true)
  }
  u64(): number {
    const value = this.view.getBigUint64(this.take(8), true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Binary offset exceeds the safe browser range')
    return Number(value)
  }
  slice(size: number): Uint8Array {
    const start = this.take(size)
    return this.bytes.subarray(start, start + size)
  }
  tag(): string {
    return String.fromCharCode(...this.slice(4))
  }
  utf16(units: number): string {
    const bytes = this.slice(units * 2)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let text = ''
    for (let i = 0; i < units; i++) text += String.fromCharCode(view.getUint16(i * 2, true))
    return text
  }
}
