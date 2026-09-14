import type { Pixels } from '../ports/graphics.ts'
import { encodeBmp } from '../../formats/image/bmp.ts'
import { encodePng } from '../../formats/image/png-encoder.ts'
import { encodeTlg } from '../../formats/image/tlg/encoder.ts'

const modes: Record<number, string> = {
  1: 'opaque',
  2: 'alpha',
  3: 'add',
  4: 'sub',
  5: 'mul',
  8: 'dodge',
  9: 'darken',
  10: 'lighten',
  11: 'screen',
  12: 'addalpha',
  13: 'psnormal',
  14: 'psadd',
  15: 'pssub',
  16: 'psmul',
  17: 'psscreen',
  18: 'psoverlay',
  19: 'pshlight',
  20: 'psslight',
  21: 'psdodge',
  22: 'psdodge5',
  23: 'psburn',
  24: 'pslighten',
  25: 'psdarken',
  26: 'psdiff',
  27: 'psdiff5',
  28: 'psexcl',
}
export function layerImageMetadata(
  type: number,
  imageLeft: number,
  imageTop: number,
): Map<string, string> {
  const metadata = new Map([['mode', modes[type] ?? 'opaque']])
  // Match SaveLayerImage: these are image offsets, not the layer's position.
  if (imageLeft > 0) metadata.set('offs_x', String(imageLeft))
  if (imageTop > 0) metadata.set('offs_y', String(imageTop))
  if (imageLeft > 0 || imageTop > 0) metadata.set('offs_unit', 'pixel')
  return metadata
}
export class ImageWriter {
  constructor(
    private readonly compress: (bytes: Uint8Array) => Promise<Uint8Array>,
    private readonly finish: <T>(work: Generator<void, T>) => Promise<T>,
  ) {}
  async encode(
    image: Pixels,
    type: string,
    metadata: ReadonlyMap<string, string>,
  ): Promise<Uint8Array> {
    if (type.startsWith('.')) type = type.slice(1)
    if (['bmp', 'bmp8', 'bmp24', 'bmp32'].includes(type)) return encodeBmp(image, type)
    if (['png', 'png24', 'png32'].includes(type)) {
      const plan = await this.finish(encodePng(image, type !== 'png24', metadata))
      const compressed = await this.compress(plan.filtered)
      return this.finish(plan.finish(compressed))
    }
    if (['tlg', 'tlg5', 'tlg6', 'tlg524', 'tlg624'].includes(type))
      return this.finish(
        encodeTlg(image, type.startsWith('tlg6') ? 6 : 5, !type.endsWith('24'), metadata),
      )
    throw new Error(`Image output format is not implemented: ${type}`)
  }
}
