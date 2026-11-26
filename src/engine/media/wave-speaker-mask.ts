export type StereoSpeakerMix = readonly (readonly [number, number])[]

/** Stock WaveIntf preserves dwChannelMask and WaveImpl forwards it unchanged
 * to DirectSound. The Web renderer has a stereo destination: retain the named
 * speaker identity rather than guessing it from the number of input planes.
 * Coefficients retain our existing Web downmix policy, not a claim of exact
 * output from every Windows audio driver. Horizontal WAVE speaker bits are
 * ordered by increasing significance (Microsoft WAVEFORMATEXTENSIBLE). */
export function waveSpeakerMix(channels: number, mask: number | undefined): StereoSpeakerMix | undefined {
  if (mask === undefined || mask === 0) return
  if (!Number.isInteger(mask) || mask < 0 || mask > 0x7ff)
    return // Preserve the previous channel-count route for unmapped layouts.
  const mix: Array<readonly [number, number]> = [], surround = 0.70710678,
    side = mask & 0x30 ? 0.5 : surround
  for (let bit = 1; bit <= 0x400; bit *= 2) if (mask & bit) {
    switch (bit) {
      case 0x1: case 0x40: mix.push([1, 0]); break // FL, FLC
      case 0x2: case 0x80: mix.push([0, 1]); break // FR, FRC
      case 0x4: mix.push(channels === 1 ? [1, 1] : [surround, surround]); break
      case 0x8: mix.push([0, 0]); break // No stereo LFE output, as in the existing 5.1 path.
      case 0x10: mix.push([surround, 0]); break
      case 0x20: mix.push([0, surround]); break
      case 0x100: mix.push([0.5, 0.5]); break // BC contributes symmetrically.
      case 0x200: mix.push([side, 0]); break
      case 0x400: mix.push([0, side]); break
    }
  }
  if (mix.length !== channels) return
  return mix
}
