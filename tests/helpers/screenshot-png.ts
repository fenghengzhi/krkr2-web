import { inflateSync } from 'node:zlib'

/** Independent decoding for Playwright's RGB/RGBA8, noninterlaced screenshots.
 * Do not use the image decoder under test or the browser's canvas readback. */
export function readScreenshotPng(png: Buffer): {
  width: number
  height: number
  rgba: Uint8Array
} {
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Invalid screenshot PNG signature')
  let width = 0,
    height = 0,
    channels = 0,
    ended = false,
    dataEnded = false,
    offset = 8
  const compressed: Buffer[] = []
  while (offset < png.length) {
    if (png.length - offset < 12) throw new Error('Truncated screenshot PNG chunk')
    const size = png.readUInt32BE(offset)
    if (size > png.length - offset - 12) throw new Error('Truncated screenshot PNG data')
    const type = png.toString('ascii', offset + 4, offset + 8),
      chunk = png.subarray(offset + 8, offset + 8 + size)
    let crc = 0xffffffff
    for (const byte of png.subarray(offset + 4, offset + 8 + size)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    if ((crc ^ 0xffffffff) >>> 0 !== png.readUInt32BE(offset + 8 + size))
      throw new Error('Screenshot PNG checksum mismatch')
    offset += size + 12
    if (!width && type !== 'IHDR') throw new Error('Screenshot PNG must start with IHDR')
    if (type === 'IHDR') {
      if (width || size !== 13) throw new Error('Invalid screenshot PNG header')
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      channels = chunk[9] === 2 ? 3 : chunk[9] === 6 ? 4 : 0
      if (
        !width ||
        !height ||
        width * height > 16 * 1024 * 1024 ||
        !channels ||
        chunk[8] !== 8 ||
        chunk[10] !== 0 ||
        chunk[11] !== 0 ||
        chunk[12] !== 0
      )
        throw new Error('Expected a bounded RGB/RGBA8 noninterlaced screenshot PNG')
    } else if (type === 'IDAT') {
      if (dataEnded) throw new Error('Nonconsecutive screenshot PNG image data')
      compressed.push(chunk)
    } else {
      if (compressed.length) dataEnded = true
      if (type === 'IEND') {
        if (size || !compressed.length) throw new Error('Invalid screenshot PNG end')
        ended = true
        break
      }
      if (type === 'tRNS') throw new Error('Unexpected screenshot PNG transparency chunk')
      if (type !== 'PLTE' && !(png[offset - size - 8]! & 32))
        throw new Error(`Unsupported critical screenshot PNG chunk: ${type}`)
    }
  }
  if (!ended || offset !== png.length) throw new Error('Incomplete screenshot PNG')
  const stride = width * channels,
    expandedLength = (stride + 1) * height,
    expanded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expandedLength }),
    rgba = new Uint8Array(width * height * 4)
  if (expanded.length !== expandedLength) throw new Error('Screenshot PNG scanline size mismatch')
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1),
      filter = expanded[start]!,
      row = new Uint8Array(expanded.subarray(start + 1, start + 1 + stride))
    if (filter > 4) throw new Error('Invalid screenshot PNG filter')
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels]! : 0,
        above = previous[x]!,
        upperLeft = x >= channels ? previous[x - channels]! : 0,
        predictor = left + above - upperLeft,
        leftDistance = Math.abs(predictor - left),
        aboveDistance = Math.abs(predictor - above),
        upperLeftDistance = Math.abs(predictor - upperLeft),
        paeth =
          leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
            ? left
            : aboveDistance <= upperLeftDistance
              ? above
              : upperLeft,
        correction =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? above
                : filter === 3
                  ? Math.floor((left + above) / 2)
                  : paeth
      row[x] = (row[x]! + correction) & 255
    }
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4,
        source = x * channels
      rgba[target] = row[source]!
      rgba[target + 1] = row[source + 1]!
      rgba[target + 2] = row[source + 2]!
      rgba[target + 3] = channels === 4 ? row[source + 3]! : 255
    }
    previous = row
  }
  return { width, height, rgba }
}
