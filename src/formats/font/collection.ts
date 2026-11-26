/** TTC and OTC use the same collection header and file-relative table offsets. */
export function collectionHeader(file: DataView, size: number) {
  if (file.byteLength < 12 || file.getUint32(0) !== 0x74746366) return undefined
  const version = file.getUint32(4), count = file.getUint32(8)
  const end = 12 + count * 4 + (version === 0x20000 ? 12 : 0)
  if ((version !== 0x10000 && version !== 0x20000) || count < 1 || count > 256 || end > size)
    throw new Error('Invalid font collection header')
  return { count, end }
}

/** Select one standalone sfnt for a single-face loader such as FontFace's
 * binary-source constructor. FreeType accepts a collection index directly. */
export function standaloneFontBytes(bytes: Uint8Array, faceIndex: number): ArrayBuffer {
  const file = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const collection = collectionHeader(file, bytes.byteLength)
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= (collection?.count ?? 1))
    throw new Error('Invalid font collection member')
  if (!collection) return Uint8Array.from(bytes).buffer
  const dir = file.getUint32(12 + 4 * faceIndex)
  if (dir < collection.end || dir + 12 > bytes.length) throw new Error('Invalid font collection directory')
  const flavor = file.getUint32(dir), count = file.getUint16(dir + 4), dirSize = 12 + 16 * count
  if (![0x10000, 0x4f54544f, 0x74727565].includes(flavor)) throw new Error('Unknown font collection member format')
  if (count < 1 || count > 128 || dir + dirSize > bytes.length) throw new Error('Invalid font collection tables')
  const tables = []
  let size = dirSize
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16
    const at = file.getUint32(dir + record + 8), length = file.getUint32(dir + record + 12)
    if (at + length > bytes.length) throw new Error('Font collection table exceeds file')
    tables.push({ record, at, length, dest: size })
    size += Math.ceil(length / 4) * 4
    if (size > 16 * 1024 * 1024) throw new Error('Font file exceeds 16 MiB')
  }
  const output = new Uint8Array(size), result = new DataView(output.buffer)
  output.set(bytes.subarray(dir, dir + dirSize))
  let adjustment: number | undefined, checksum = 0
  for (const { record, at, length, dest } of tables) {
    output.set(bytes.subarray(at, at + length), dest)
    result.setUint32(record + 8, dest)
    if (result.getUint32(record) === 0x68656164) {
      if (length < 12) throw new Error('Invalid font head table')
      adjustment = dest + 8
      result.setUint32(adjustment, 0)
    }
    let sum = 0
    for (let word = dest; word < dest + length; word += 4) sum = (sum + result.getUint32(word)) >>> 0
    result.setUint32(record + 4, sum)
    checksum = (checksum + sum) >>> 0
  }
  if (adjustment === undefined) throw new Error('Font has no head table')
  for (let i = 0; i < dirSize; i += 4) checksum = (checksum + result.getUint32(i)) >>> 0
  result.setUint32(adjustment, (0xb1b0afba - checksum) >>> 0)
  return output.buffer
}
