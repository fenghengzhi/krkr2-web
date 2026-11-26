const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
/** Pass the previous block's finalized CRC to continue without retaining it. */
export function* crc32(bytes: Uint8Array, previous = 0): Generator<void, number> {
  let crc = previous ^ 0xffffffff
  for (let at = 0; at < bytes.length; at++) {
    crc = table[(crc ^ bytes[at]!) & 255]! ^ (crc >>> 8)
    if (at % 4096 === 4095) yield
  }
  return (crc ^ 0xffffffff) >>> 0
}

export async function checkedCrc32(bytes: Uint8Array, checkpoint: () => void | Promise<void>, previous = 0): Promise<number> {
  const work = crc32(bytes, previous)
  try {
    for (;;) {
      const next = work.next()
      if (next.done) return next.value
      await checkpoint()
    }
  } finally { work.return(0) }
}
