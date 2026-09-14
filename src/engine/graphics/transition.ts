import type { Pixels } from '../ports/graphics.ts'
export interface TransitionFrame {
  token: number
  destination: number
  source: number
  children: boolean
  kind: 'crossfade' | 'universal' | 'scroll'
  phase: number
  vague: number
  rule?: Pixels
  from: number
  stay: number
}
/** Both inputs and the result contain premultiplied RGBA. */
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
  if (!progress) {
    result.data.set(before.data)
    return result
  }
  if (progress === 1) {
    result.data.set(after.data)
    return result
  }
  const horizontal = transition.from === 0 || transition.from === 2
  const length = horizontal ? width : height,
    shift = Math.floor(length * progress),
    direction = transition.from < 2 ? 1 : -1
  const oldOffset = transition.stay === 1 ? 0 : direction * shift,
    newOffset = transition.stay === 2 ? 0 : direction * (shift - length)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      if (transition.kind === 'scroll') {
        const point = horizontal ? x : y,
          oldPoint = point - oldOffset,
          newPoint = point - newOffset
        const newValid = newPoint >= 0 && newPoint < length,
          oldValid = oldPoint >= 0 && oldPoint < length
        const useNew = transition.stay === 2 ? !oldValid : newValid
        const location = useNew ? newPoint : oldPoint,
          source = useNew ? after : before
        if (location >= 0 && location < length) {
          const at = (horizontal ? y * width + location : location * width + x) * 4
          result.data.set(source.data.subarray(at, at + 4), offset)
        }
        continue
      }
      let amount = Math.floor(progress * 255) / 255
      if (transition.kind === 'universal') {
        const rule = transition.rule
        if (!rule?.width || !rule.height)
          throw new Error('Universal transition requires a rule image')
        const at = ((y % rule.height) * rule.width + (x % rule.width)) * 4
        const threshold =
          (rule.data[at]! * 54 + rule.data[at + 1]! * 183 + rule.data[at + 2]! * 19) >> 8
        const phase = Math.floor(progress * (255 + transition.vague))
        amount = transition.vague
          ? Math.max(0, Math.min(1, (phase - threshold) / transition.vague))
          : Number(threshold < phase)
      }
      for (let channel = 0; channel < 4; channel++)
        result.data[offset + channel] = Math.round(
          before.data[offset + channel]! * (1 - amount) + after.data[offset + channel]! * amount,
        )
    }
  return result
}
