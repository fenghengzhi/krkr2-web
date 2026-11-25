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
    ![floor, ceil].every((value) => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) ||
    Math.abs(ceil - floor) > 0x7fffffff
  )
    throw new Error('Gamma parameters are outside their supported range')
  // Native tTVPGLGammaAdjustData stores gamma as float and black/white points
  // as signed integers. Its table clamps the transformed result, not these
  // points: e.g. -64..319 is a valid contrast expansion, and 9.5 is supported.
  const nativeGamma = Math.fround(gamma),
    exponent = nativeGamma === 0 ? Number.MAX_VALUE : 1 / nativeGamma
  return Uint8Array.from({ length: 256 }, (_, value) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.trunc(Math.pow(value / 255, exponent) * (ceil - floor) + floor + 0.5),
      ),
    ),
  )
}
