const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
export function* crc32(bytes: Uint8Array): Generator<void, number> {
  let crc = 0xffffffff
  for (let at = 0; at < bytes.length; at++) {
    crc = table[(crc ^ bytes[at]!) & 255]! ^ (crc >>> 8)
    if (at % 4096 === 4095) yield
  }
  return (crc ^ 0xffffffff) >>> 0
}
