// Web colors for the legacy system indices, not a Win32 desktop palette.
// The page supplies computed CSS colors; engines without a DOM use this table.
const webColors = {
  Canvas: 0xffffff,
  CanvasText: 0x000000,
  ButtonBorder: 0x767676,
  ButtonFace: 0xf0f0f0,
  ButtonText: 0x000000,
  Highlight: 0x3399ff,
  HighlightText: 0xffffff,
  GrayText: 0x787878,
  LinkText: 0x0000ee,
} as const

/** Legacy indices 0..30; 25 is reserved. Roles follow CSS Color 4 mappings. */
export const systemColorCssNames = Object.freeze([
  'Canvas', // 0: scrollbar
  'Canvas', // 1: desktop background
  'Canvas', // 2: active caption
  'Canvas', // 3: inactive caption
  'Canvas', // 4: menu
  'Canvas', // 5: window
  'ButtonBorder', // 6: window frame
  'CanvasText', // 7: menu text
  'CanvasText', // 8: window text
  'CanvasText', // 9: caption text
  'ButtonBorder', // 10: active border
  'ButtonBorder', // 11: inactive border
  'Canvas', // 12: application workspace
  'Highlight', // 13
  'HighlightText', // 14
  'ButtonFace', // 15
  'ButtonFace', // 16: button shadow
  'GrayText', // 17
  'ButtonText', // 18
  'GrayText', // 19: inactive caption text
  'ButtonFace', // 20: button highlight
  'ButtonBorder', // 21: dark 3D shadow
  'ButtonBorder', // 22: light 3D shadow
  'CanvasText', // 23: tooltip text
  'Canvas', // 24: tooltip background
  null, // 25: reserved
  'LinkText', // 26: hot-tracked item
  'Canvas', // 27: active caption gradient
  'Canvas', // 28: inactive caption gradient
  'Highlight', // 29: menu highlight
  'Canvas', // 30: menu bar
] as const)

/** Stable fallback for a non-DOM engine. Never described as GetSysColor. */
export const defaultSystemColorPalette: readonly number[] = Object.freeze(
  systemColorCssNames.map((name) => (name === null ? 0 : webColors[name])),
)

/** Validate before allocating ports/runtimes and detach from the caller's array. */
export function copySystemColorPalette(
  colors: readonly number[] = defaultSystemColorPalette,
): readonly number[] {
  if (!Array.isArray(colors) || colors.length !== 31)
    throw new Error('System colors require an array of 31 RGB integers')
  const copy: number[] = []
  for (let index = 0; index < 31; index++) {
    const color = colors[index]
    if (
      !Object.hasOwn(colors, index) ||
      !Number.isInteger(color) ||
      color! < 0 ||
      color! > 0xffffff
    )
      throw new Error('System colors must be 24-bit RGB integers')
    copy.push(color!)
  }
  if (copy[25] !== 0) throw new Error('System color index 25 is reserved and must be zero')
  return Object.freeze(copy)
}

/** One immutable palette shared by System and the selected Layer entry points. */
export class SystemColors {
  private readonly palette: readonly number[]
  constructor(colors?: readonly number[]) {
    this.palette = copySystemColorPalette(colors)
  }
  toActualColor(color: number): number {
    // TJS int64 narrowing happens at the host boundary before Number conversion.
    const value = color >>> 0
    if (!(value & 0xff000000)) return value
    if (value & 0x80000000) return this.palette[value & 0xff] ?? 0
    // Positive VCL-tagged values carry BGR, unlike ordinary KRKR 0xRRGGBB.
    // Original SDK run 35017080903 observed 01/02/03/04/7f and negative aliases.
    return ((value & 0xff) << 16) | (value & 0xff00) | ((value >>> 16) & 0xff)
  }
}
