import { imagePartialSource, partialBmp, partialPng } from './image-partial-fixtures.ts'
import { tlgSds, tlgU32 } from './tlg-fixtures.ts'

export const imageReadLiteral = 'image-short:%s:%1:%%'
export const imageReadSecondLiteral = 'changed-short:%2:%s:%%'
export const imageReadInitialGeometry = '0,0,3,2,7,19,-2,-1,1,1,2,2'
export const imageReadPartialGeometry = '0,0,3,2,5,17,-2,-1,1,1,2,2'

/** Independent raw-plane TLG5. The first row's x=0 residual is B-G/G/R-G;
 * every subsequent horizontal/vertical difference is zero. No product
 * encoder generates the byte oracle. Blocks contain eight, eight, one rows. */
function solidTlg5(): { complete: Buffer; late: Buffer } {
  const width = 5, height = 17, blockHeight = 8,
    blocks = [8, 8, 1].map((rows, block) => Buffer.concat([206, 100, 100].map((value) => {
      const plane = Buffer.alloc(width * rows)
      if (block === 0) plane[0] = value
      return Buffer.concat([Buffer.from([1]), tlgU32(plane.length), plane])
    }))),
    header = Buffer.concat([Buffer.from('TLG5.0\x00raw\x1a'), Buffer.from([3]),
      tlgU32(width), tlgU32(height), tlgU32(blockHeight), ...blocks.map((block) => tlgU32(block.length))])
  return { complete: Buffer.concat([header, ...blocks]),
    // The second block promises forty bytes for its first plane, but only ten
    // are present. Its entire row group must remain unpublished.
    late: Buffer.concat([header, blocks[0]!, blocks[1]!.subarray(0, 15)]) }
}
function shortPaletteBmp(): Buffer {
  const bytes = Buffer.alloc(58)
  bytes.write('BM'); bytes.writeUInt32LE(62 + 8 * 17, 2); bytes.writeUInt32LE(62, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(5, 18); bytes.writeInt32LE(-17, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(8, 28); bytes.writeUInt32LE(8 * 17, 34)
  bytes.writeUInt32LE(2, 46)
  // Only the first four-byte palette entry exists; native asks for both before
  // invoking the image-size callback.
  bytes.set([50, 100, 200, 0], 54)
  return bytes
}

export function imageReadFiles(): Record<string, Buffer> {
  const main = partialBmp({ width: 5, height: 17 }),
    png = partialPng({ width: 5, height: 17 }), tlg = solidTlg5(),
    idatPayload = png.indexOf(Buffer.from('IDAT')) + 4,
    badSignature = Buffer.alloc(11, 0x78)
  return {
    'read-bmp-header.bmp': Buffer.from([0x42]),
    'read-bmp-palette.bmp': shortPaletteBmp(),
    'read-bmp-late.bmp': partialBmp({ width: 5, height: 17, rows: 9 }),
    'read-tlg-header.tlg': Buffer.from('TLG5.0'),
    'read-tlg-late.tlg': tlg.late,
    'read-tlg-tags.tlg': Buffer.concat([tlgSds(tlg.complete, []), Buffer.from('tags'), tlgU32(5), Buffer.from('1:')]),
    // Original SDS uses Read(4), not ReadBuffer, for the next chunk name.
    'tlg-short-optional-name.tlg': Buffer.concat([tlgSds(tlg.complete, []), Buffer.from('tag')]),
    'read-png-signature.png': png.subarray(0, 3),
    'read-png-header.png': png.subarray(0, 23),
    'read-png-idat.png': png.subarray(0, idatPayload + 1),
    'read-png-tail.png': partialPng({ width: 5, height: 17, trailing: 'truncated' }),
    'read-mask.bmp': main,
    'read-mask_m.bmp': partialBmp({ width: 5, height: 17, rows: 9, mask: true }),
    'read-png-mask.bmp': main,
    'read-png-mask_m.png': partialPng({ width: 5, height: 17, trailing: 'truncated', mask: true }),
    'codec-bad-header.tlg': badSignature,
    'codec-bad-crc.png': partialPng({ width: 5, height: 17, earlyCrc: true }),
    'web-dimension-budget.png': partialPng({ width: 4097, height: 1 }),
    'host-read-failure.bmp': main,
    'read-valid.bmp': main,
  }
}

export const imageReadSource = imagePartialSource + String.raw`
partialWindow.caption="Image read errors";
System.assignMessage("TVPTLGLoadError","read-tlg:%1");
System.assignMessage("TVPReadError","tvp-read-must-not-handle-short-stream");
Debug.message("image-read-ready");
`
