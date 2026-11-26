/** Limits and increments of the Web mixer. VMR9 queries these from its
 * graphics device; other native drawing modes leave all readbacks at -1. */
export const videoColorRanges = {
  brightness: { RangeMin: -100, RangeMax: 100, DefaultValue: 0, StepSize: 1 },
  contrast: { RangeMin: 0, RangeMax: 2, DefaultValue: 1, StepSize: .01 },
  hue: { RangeMin: -180, RangeMax: 180, DefaultValue: 0, StepSize: 1 },
  saturation: { RangeMin: 0, RangeMax: 2, DefaultValue: 1, StepSize: .01 },
} as const
export type VideoColorControl = keyof typeof videoColorRanges
export type VideoColorValues = Record<VideoColorControl, number>
export type VideoColorRangeField = keyof typeof videoColorRanges.brightness
export const defaultVideoColors: Readonly<VideoColorValues> = { brightness: 0, contrast: 1, hue: 0, saturation: 1 }

export function videoColorSetting(name: VideoColorControl, value: number): number {
  const range = videoColorRanges[name], number = Math.fround(value)
  if (!Number.isFinite(number) || number < range.RangeMin || number > range.RangeMax)
    throw new Error('Video ' + name + ' is outside the mixer range')
  return Math.fround(Math.round(number / range.StepSize) * range.StepSize) || 0
}

/** Full-range BT.601 luma gain and black-level offset, with saturation and
 * hue applied to the Cb/Cr plane. Build one matrix for the entire picture so
 * the channels are clamped only after the combined adjustment. */
export function videoColorMatrix({ brightness, contrast, hue, saturation }: VideoColorValues): number[] | undefined {
  if (brightness === 0 && contrast === 1 && hue === 0 && saturation === 1) return
  const radians = hue * Math.PI / 180, cos = Math.cos(radians) * saturation, sin = Math.sin(radians) * saturation
  const column = (r: number, g: number, b: number) => {
    const y = .299 * r + .587 * g + .114 * b, cb = (b - y) / 1.772, cr = (r - y) / 1.402
    const red = 1.402 * (sin * cb + cos * cr), blue = 1.772 * (cos * cb - sin * cr)
    return [contrast * y + red, contrast * y - (.299 * red + .114 * blue) / .587, contrast * y + blue]
  }
  const red = column(1, 0, 0), green = column(0, 1, 0), blue = column(0, 0, 1)
  return [0, 1, 2].flatMap((row) => [red[row]!, green[row]!, blue[row]!, 0, brightness / 100])
    .concat([0, 0, 0, 1, 0])
}
