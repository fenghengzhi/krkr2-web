export interface GammaChannel {
  gamma: number
  floor: number
  ceil: number
}
export function gammaTable(channel: GammaChannel): Uint8Array {
  const { gamma, floor, ceil } = channel
  if (
    !Number.isFinite(gamma) ||
    gamma < 0 ||
    gamma > 9 ||
    ![floor, ceil].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  )
    throw new Error('Gamma parameters are outside their supported range')
  const exponent = gamma === 0 ? Number.MAX_VALUE : 1 / gamma
  return Uint8Array.from({ length: 256 }, (_, value) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.trunc(Math.exp(Math.log(value / 255) * exponent) * (ceil - floor) + floor + 0.5),
      ),
    ),
  )
}
