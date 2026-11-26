export interface WaveFocusOptions { mode: number; volume: number }

/** Fixed WaveImpl::TVPInitSoundOptions. These are frozen with the first Wave
 * instance; script globalFocusMode remains a separate, stricter-only control. */
export function readWaveFocusOptions(rawMode: string | undefined, percent: number | undefined): WaveFocusOptions {
  // ttstr's literal comparison uses TJS_strcmp, including its first-NUL end.
  const option = rawMode?.split('\0', 1)[0],
    mode = option === 'minimize' ? 1 : option === 'yes' || option === 'deactive' ? 2 : 0
  let volume = 0
  if (percent !== undefined) {
    if (!Number.isInteger(percent) || percent < -0x80000000 || percent > 0x7fffffff)
      throw new Error('Invalid native startup integer result')
    if (percent >= 0 && percent <= 100) volume = percent * 1000
  }
  return { mode, volume }
}
