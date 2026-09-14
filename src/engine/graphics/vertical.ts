import type { FontSpec } from '../ports/graphics.ts'
import { verticalRanges, verticalFallbacks } from '../../formats/font/vertical-data.ts'

/** FontSpec can explicitly suppress the vertical face for horizontal UI previews. */
export const isVerticalFace = (font: FontSpec) =>
  font.verticalFace ?? (!font.faceIsFileName && font.face.startsWith('@'))

export function verticalOrientation(code: number): 'U' | 'Tu' | 'Tr' | 'R' {
  if (!Number.isInteger(code) || code < 0 || code > 65535) return 'R'
  let low = 0,
    high = verticalRanges.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1,
      range = verticalRanges[mid]!
    if (code < range[0]) high = mid - 1
    else if (code > range[1]) low = mid + 1
    else return range[2]
  }
  return 'R'
}
export function browserVerticalGlyph(character: string) {
  const code = character.charCodeAt(0),
    orientation = verticalOrientation(code),
    alternate = verticalFallbacks.get(code)
  return {
    character: alternate === undefined ? character : String.fromCharCode(alternate),
    upright: alternate !== undefined || orientation === 'U' || orientation === 'Tu',
  }
}
export const verticalPresentationForm = (code: number) => verticalFallbacks.get(code)
