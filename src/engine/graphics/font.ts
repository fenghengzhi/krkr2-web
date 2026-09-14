import type { FontSpec } from '../ports/graphics.ts'
import type { ScriptRecord } from '../script/runtime.ts'
/** Preserve the reference's operation order before converting to pixel integers. */
export function fontGeometry(angle: number, ascent: number) {
  const radians = angle * (Math.PI / 1800),
    perpendicular = radians + Math.PI / 2,
    cos = Math.cos(radians),
    sin = Math.sin(radians)
  return {
    ascentX: Math.trunc(-Math.cos(perpendicular) * ascent) || 0,
    ascentY: Math.trunc(Math.sin(perpendicular) * ascent) || 0,
    advance(width: number) {
      return {
        x: angle === 2700 ? 0 : Math.trunc(cos * width) || 0,
        y: angle === 0 ? 0 : angle === 2700 ? width : Math.trunc(-sin * width) || 0,
      }
    },
  }
}
export function fontSpec(data: ScriptRecord): FontSpec {
  const value = data.entries,
    height = Number(value.height),
    angle = Number(value.angle)
  if (
    !Number.isFinite(height) ||
    Math.abs(height) < 1 ||
    Math.abs(height) > 256 ||
    !Number.isFinite(angle) ||
    typeof value.face !== 'string'
  )
    throw new Error('Invalid font description')
  return {
    height: Math.abs(height),
    angle: ((angle % 3600) + 3600) % 3600,
    face: value.face,
    bold: !!value.bold,
    italic: !!value.italic,
    underline: !!value.underline,
    strikeout: !!value.strikeout,
    faceIsFileName: !!value.faceIsFileName,
  }
}
