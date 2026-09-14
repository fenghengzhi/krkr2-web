/** Growing byte output with a hard resource limit; lengths never wrap to uint32. */
export class BinaryWriter {
  private bytes: Uint8Array
  length = 0
  constructor(private readonly maximum = 64 * 1024 * 1024) {
    this.bytes = new Uint8Array(Math.min(4096, maximum))
  }
  private reserve(count: number): void {
    const length = this.length + count
    if (!Number.isSafeInteger(length) || count < 0 || length > this.maximum)
      throw new Error('Encoded image exceeds output budget')
    if (length <= this.bytes.length) return
    const next = new Uint8Array(Math.min(this.maximum, Math.max(length, this.bytes.length * 2)))
    next.set(this.bytes.subarray(0, this.length))
    this.bytes = next
  }
  u8(value: number): void {
    this.reserve(1)
    this.bytes[this.length++] = value
  }
  u16(value: number): void {
    this.u8(value)
    this.u8(value >>> 8)
  }
  u32(value: number): void {
    this.u16(value)
    this.u16(value >>> 16)
  }
  be32(value: number): void {
    this.u8(value >>> 24)
    this.u8(value >>> 16)
    this.u8(value >>> 8)
    this.u8(value)
  }
  append(bytes: Uint8Array): void {
    this.reserve(bytes.length)
    this.bytes.set(bytes, this.length)
    this.length += bytes.length
  }
  ascii(value: string): void {
    for (let i = 0; i < value.length; i++) this.u8(value.charCodeAt(i))
  }
  patch32(offset: number, value: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > this.length)
      throw new Error('Invalid encoded image patch offset')
    new DataView(this.bytes.buffer).setUint32(offset, value, true)
  }
  finish(): Uint8Array {
    return this.bytes.slice(0, this.length)
  }
}
