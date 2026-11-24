import type { Pixels } from '../ports/graphics.ts'
import { autoFace } from './blend.ts'
import { blendTransitionPixel, universalOpacity } from './transition-blend.ts'
export interface TransitionFrame {
  token: number
  destination: number
  source: number
  /** DisplayType captured when the native transition handler is created. */
  destinationType: number
  children: boolean
  kind: 'crossfade' | 'universal' | 'scroll'
  phase: number
  /** Integer phase computed before elapsed time is normalized for layout. */
  pixelPhase?: number
  vague: number
  rule?: Pixels
  from: number
  stay: number
}
/** Copy the clipped rectangle from one scrolling plane. Vertical moves
 * cover complete rows, so their complete span fits in a single typed copy. */
function copyScrollPlane(source: Pixels, target: Uint8Array, horizontal: boolean, offset: number): void {
  const extent = horizontal ? source.width : source.height
  const count = extent - Math.abs(offset)
  if (count <= 0) return
  if (!offset) { target.set(source.data); return }
  const from = Math.max(-offset, 0), to = Math.max(offset, 0), stride = source.width * 4
  if (!horizontal) {
    target.set(source.data.subarray(from * stride, (from + count) * stride), to * stride)
    return
  }
  for (let row = 0; row < source.data.length; row += stride)
    target.set(source.data.subarray(row + from * 4, row + (from + count) * 4), row + to * 4)
}
/** TVP handlers consume raw source planes and select the kernel from the
 * captured destination display type. Presentation converts the resulting plane. */
export function transitionPixels(
  before: Pixels,
  after: Pixels,
  transition: TransitionFrame,
): Pixels {
  if (before.width !== after.width || before.height !== after.height)
    throw new Error('Transition image sizes differ')
  const { width, height } = before,
    result = { width, height, data: new Uint8Array(before.data.length) }
  const progress = Math.max(0, Math.min(1, transition.phase))
  const horizontal = transition.from === 0 || transition.from === 2, length = horizontal ? width : height,
    phaseMax = transition.kind === 'scroll' ? length : 255 + (transition.kind === 'universal' ? transition.vague : 0),
    phase = transition.pixelPhase ?? Math.floor(progress * phaseMax), face = autoFace(transition.destinationType)
  if (!phase) {
    result.data.set(before.data)
    return result
  }
  if (progress === 1) {
    result.data.set(after.data)
    return result
  }
  if (transition.kind === 'scroll') {
    const direction = transition.from < 2 ? 1 : -1
    const oldOffset = transition.stay === 1 ? 0 : direction * phase
    const newOffset = transition.stay === 2 ? 0 : direction * (phase - length)
    // The moving layer covers the stationary one in the two stay modes.
    if (transition.stay === 2) {
      copyScrollPlane(after, result.data, horizontal, newOffset)
      copyScrollPlane(before, result.data, horizontal, oldOffset)
    } else {
      copyScrollPlane(before, result.data, horizontal, oldOffset)
      copyScrollPlane(after, result.data, horizontal, newOffset)
    }
    return result
  }
  const switchRule = transition.kind === 'universal' && transition.vague < 512
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      let opacity = phase
      if (transition.kind === 'universal') {
        const rule = transition.rule
        if (!rule?.width || !rule.height)
          throw new Error('Universal transition requires a rule image')
        const at = ((y % rule.height) * rule.width + (x % rule.width)) * 4
        const threshold =
          (rule.data[at]! * 54 + rule.data[at + 1]! * 183 + rule.data[at + 2]! * 19) >> 8
        opacity = universalOpacity(phase, transition.vague, threshold)
      }
      blendTransitionPixel(result.data, offset, before.data, after.data, opacity, face,
        transition.kind, switchRule)
    }
  return result
}
