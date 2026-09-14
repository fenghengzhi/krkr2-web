import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const polygons = [
  [
    [30, 23],
    [40, 23],
    [40, 45],
    [60, 23],
    [73, 23],
    [48, 50],
    [74, 77],
    [60, 77],
    [40, 55],
    [40, 77],
    [30, 77],
  ],
]
function inside(x: number, y: number, polygon: number[][]) {
  let result = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!
    if (a[1]! > y !== b[1]! > y && x < ((b[0]! - a[0]!) * (y - a[1]!)) / (b[1]! - a[1]!) + a[0]!)
      result = !result
  }
  return result
}
function crc(bytes: Buffer) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
function chunk(name: string, data: Buffer) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  out.write(name, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc(out.subarray(4, out.length - 4)), out.length - 4)
  return out
}
export function appIcon(size: number): Buffer {
  const rgba = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const color = polygons.some((p) =>
        inside(((x + 0.5) * 100) / size, ((y + 0.5) * 100) / size, p),
      )
        ? [12, 35, 33]
        : [116, 215, 188]
      const at = y * (size * 4 + 1) + 1 + x * 4
      for (let c = 0; c < 3; c++) rgba[at + c] = color[c]!
      rgba[at + 3] = 255
    }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rgba)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
export const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="16" fill="#74d7bc"/><path d="M30 23h10v22l20-22h13L48 50l26 27H60L40 55v22H30Z" fill="#0c2321"/></svg>`
export const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
